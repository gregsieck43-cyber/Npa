import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCall, McpDefinitionSnapshot } from '../contracts.js';
import { digestValue, resolveProjectPath, ToolPolicyError } from './policy.js';
import { prepareReadOnly } from './read-only.js';
import { filePathIdentity } from '../kernel/read-set.js';
import type { ReadVersion } from '../kernel/read-set.js';

export interface PreparedTool { name: string; arguments: Record<string, unknown>; digest: string; capability: string; mutating: boolean; resources: string[]; mcpDefinition?: McpDefinitionSnapshot; }
export interface ToolOutcome { status: 'applied' | 'unknown' | 'failed'; output: string; receipt?: Record<string, unknown>; error?: string; }
export interface ToolGatewayOptions { workspace: string; receiptDirectory: string; workerPath?: string; runtimePath?: string; timeoutMs?: number; assertWritable?: (filename: string) => void; assertWorkspaceClean?: (workspace: string) => void; getReadVersion?: (absolutePath: string) => ReadVersion | undefined; }
export interface ToolExecutionOptions { effectKey: string; approvedDigest?: string; signal?: AbortSignal; fault?: 'after_effect_before_receipt'; }
export interface ToolArtifactHash { path: string; sha256: string; }

export class ToolGateway {
  private readonly standaloneReads = new Map<string, ReadVersion>();
  constructor(private readonly options: ToolGatewayOptions) {}
  async prepare(call: Pick<ToolCall, 'name' | 'arguments'>): Promise<PreparedTool> {
    const args = structuredClone(call.arguments);
    let capability: string, mutating = false;
    const resources: string[] = [];
    switch (call.name) {
      case 'search_text': case 'git_query': {
        const prepared = await prepareReadOnly(this.options.workspace, call.name, args);
        return { name: call.name, arguments: prepared.arguments, digest: digestValue({ name: call.name, arguments: prepared.arguments }), capability: 'fs.read', mutating: false, resources: prepared.resources };
      }
      case 'read_file': case 'write_file': case 'list_files': {
        if (call.name !== 'list_files' && typeof args.path !== 'string') throw new ToolPolicyError('Tool requires a project path.');
        const target = await resolveProjectPath(this.options.workspace, typeof args.path === 'string' ? args.path : '.', call.name !== 'list_files');
        args.path = path.relative(this.options.workspace, target) || '.';
        if (call.name === 'write_file' && (typeof args.content !== 'string' || args.content.length > 1_000_000)) throw new ToolPolicyError('write_file requires UTF-8 content below 1 MB.');
        if (call.name === 'write_file') {
          // Reserved provenance comes only from the trusted receipt store, never model arguments.
          delete args.expectedSha256; delete args.readVersion;
          const info = await stat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
          if (info && (!info.isFile() || info.size > 1_048_576)) throw new ToolPolicyError('Agent writes require a regular baseline file below 1 MiB.');
          const identity = filePathIdentity(target);
          const read = this.options.getReadVersion ? this.options.getReadVersion(target) : this.standaloneReads.get(identity);
          if (info && !read) throw new ToolPolicyError('READ_REQUIRED: Read the existing file before proposing a write.');
          const actual = info ? createHash('sha256').update(await readFile(target)).digest('hex') : null;
          if (read && (read.path !== identity || read.sha256 !== actual)) throw new ToolPolicyError('READ_VERSION_STALE: File changed since the task read. Read it again before proposing a write.');
          args.readVersion = read ?? { path: identity, sha256: null, sourceIntentId: null } satisfies ReadVersion;
          args.expectedSha256 = read?.sha256 ?? null;
        }
        mutating = call.name === 'write_file'; capability = mutating ? 'fs.write' : 'fs.read'; resources.push(target); break;
      }
      case 'fixture_increment':
        if (args.amount === undefined) args.amount = 1;
        if (!Number.isInteger(args.amount) || Number(args.amount) < 1 || Number(args.amount) > 100) throw new ToolPolicyError('Fixture amount must be an integer from 1 to 100.');
        capability = 'fixture.write'; mutating = true; resources.push('fixture:counter'); break;
      case 'run_command': {
        if (args.executable !== undefined && args.executable !== 'node') throw new ToolPolicyError('Only the bundled Node runtime can execute approved scripts.');
        let argv: string[];
        if (Array.isArray(args.args) && args.args.every(item => typeof item === 'string')) argv = args.args as string[];
        else if (args.command === 'node --version') argv = ['--version'];
        else if (typeof args.command === 'string' && args.command.startsWith('node --check ')) argv = ['--check', args.command.slice('node --check '.length).replace(/^"(.*)"$/, '$1')];
        else throw new ToolPolicyError('Use executable node and a concrete args array for a trusted project script.');
        if (argv[0] === '--version' && argv.length === 1) args.argv = argv;
        else if (argv[0] === '--check' && argv.length === 2) {
          const file = await resolveProjectPath(this.options.workspace, argv[1]!); args.argv = ['--check', file]; resources.push(file);
        } else if (argv[0] === '--test' && argv.length > 1) {
          const files = await Promise.all(argv.slice(1).map(file => resolveProjectPath(this.options.workspace, file)));
          args.argv = ['--test', '--test-isolation=none', ...files]; resources.push(...files); args.test = true;
        } else if (argv[0] && !argv[0].startsWith('-')) {
          const file = await resolveProjectPath(this.options.workspace, argv[0]);
          args.argv = [file, ...argv.slice(1)]; resources.push(file);
        } else throw new ToolPolicyError('Node evaluation, environment files, loaders, permissions and other options are unsupported.');
        args.artifactHashes = await Promise.all(resources.map(async file => ({
          path: file, sha256: createHash('sha256').update(await readFile(file)).digest('hex'),
        } satisfies ToolArtifactHash)));
        resources.push(this.options.workspace);
        capability = 'process.run'; mutating = true; break;
      }
      case 'run_shell': {
        if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16000) throw new ToolPolicyError('Shell command must contain 1 to 16000 characters.');
        args.shell = 'powershell'; args.timeoutMs ??= 120000;
        if (!Number.isInteger(args.timeoutMs) || Number(args.timeoutMs) < 1000 || Number(args.timeoutMs) > 600000) throw new ToolPolicyError('Shell timeout must be 1000 to 600000 ms.');
        capability = 'process.run'; mutating = true; resources.push(this.options.workspace); break;
      }
      default: throw new ToolPolicyError(`Unsupported tool: ${call.name}`);
    }
    return { name: call.name, arguments: args, digest: digestValue({ name: call.name, arguments: args }), capability, mutating, resources };
  }
  assertWritable(prepared: PreparedTool): void {
    if (prepared.name === 'write_file') this.options.assertWritable?.(path.resolve(this.options.workspace, String(prepared.arguments.path)));
    if (['run_command', 'run_shell'].includes(prepared.name)) this.options.assertWorkspaceClean?.(this.options.workspace);
  }
  async execute(prepared: PreparedTool, options: ToolExecutionOptions): Promise<ToolOutcome> {
    this.assertWritable(prepared);
    if (options.signal?.aborted) throw new ToolPolicyError('Tool execution cancelled before dispatch.');
    if (prepared.digest !== digestValue({ name: prepared.name, arguments: prepared.arguments })) throw new ToolPolicyError('Prepared tool digest has changed.');
    if (['write_file', 'run_command', 'run_shell', 'fixture_increment'].includes(prepared.name) && options.approvedDigest !== prepared.digest) throw new ToolPolicyError('An exact prepared digest approval is required.');
    const outcome = await this.request({ operation: 'execute', prepared, effectKey: options.effectKey, approvedDigest: options.approvedDigest, fault: options.fault }, options.signal, prepared.name === 'run_shell' ? Number(prepared.arguments.timeoutMs) : undefined);
    // Standalone gateways have no task store; their reads last only for this instance. Product
    // gateways always use Kernel receipts, including reopen/reconciliation and task isolation.
    if (!this.options.getReadVersion && prepared.name === 'read_file' && outcome.status === 'applied' && outcome.receipt?.effectKey === options.effectKey
      && outcome.receipt.digest === prepared.digest && (typeof outcome.receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(outcome.receipt.sha256) || outcome.receipt.sha256 === null && outcome.receipt.exists === false && outcome.receipt.bytes === 0)) {
      const target = filePathIdentity(await resolveProjectPath(this.options.workspace, String(prepared.arguments.path), true));
      this.standaloneReads.set(target, { path: target, sha256: outcome.receipt.sha256 as string | null, sourceIntentId: options.effectKey });
    }
    return outcome;
  }
  async queryOutcome(effectKey: string, digest?: string): Promise<ToolOutcome> {
    return this.request({ operation: 'query', effectKey, digest });
  }
  private async request(request: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<ToolOutcome> {
    const temp = path.join(this.options.receiptDirectory, 'tmp');
    const cache = path.join(this.options.receiptDirectory, 'cache');
    await mkdir(temp, { recursive: true }); await mkdir(cache, { recursive: true });
    if (signal?.aborted) throw new ToolPolicyError('Tool execution cancelled before dispatch.');
    const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TEMP: temp, TMP: temp, TMPDIR: temp, HOME: this.options.receiptDirectory, USERPROFILE: this.options.receiptDirectory,
      APPDATA: cache, LOCALAPPDATA: cache, npm_config_cache: cache, npm_config_prefix: path.join(this.options.workspace, '.tools'),
      PIP_CACHE_DIR: cache, UV_CACHE_DIR: cache, CARGO_HOME: path.join(cache, 'cargo'), PSModuleAnalysisCachePath: path.join(cache, 'powershell-analysis'),
      PATH: `${path.dirname(this.options.runtimePath ?? process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, NODE_NO_WARNINGS: '1' };
    const child = spawn(this.options.runtimePath ?? process.execPath, [this.options.workerPath ?? fileURLToPath(new URL('./worker.js', import.meta.url))],
      { cwd: this.options.workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return new Promise<ToolOutcome>((resolve, reject) => {
      let stdout = '', cancelled = false, settled = false;
      const finish = (outcome?: ToolOutcome, error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(outcome!);
      };
      const stopOwnedTree = () => {
        if (cancelled || settled) return;
        cancelled = true;
        if (process.platform === 'win32' && child.pid) {
          const terminator = spawn(path.join(process.env.SystemRoot!, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
            { cwd: this.options.workspace, env, windowsHide: true, stdio: 'ignore' });
          terminator.once('error', () => child.kill());
        } else child.kill();
      };
      const abort = stopOwnedTree;
      const timer = setTimeout(stopOwnedTree, this.options.timeoutMs ?? timeoutMs ?? 30_000);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (cancelled || settled) return;
        if (stdout.length + chunk.length > 2_000_000) { stdout = ''; stopOwnedTree(); return; }
        stdout += chunk;
      });
      child.stderr.resume();
      child.on('error', error => finish(undefined, error));
      child.on('close', code => {
        if (cancelled || code !== 0) { finish({ status: 'unknown', output: '', error: cancelled ? 'Worker stopped; reconcile the effect before retry.' : `Worker exited (${code}); reconcile the effect before retry.` }); return; }
        try { finish(JSON.parse(stdout) as ToolOutcome); }
        catch { finish({ status: 'unknown', output: '', error: 'Worker returned no valid receipt; reconcile before retry.' }); }
      });
      child.stdin.on('error', () => { /* A stopped worker closes input; close reconciles the outcome. */ });
      child.stdin.end(JSON.stringify({ ...request, workspace: this.options.workspace, receiptDirectory: this.options.receiptDirectory, runtimePath: this.options.runtimePath ?? process.execPath }));
    });
  }
}
