import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolCall, ToolDefinition } from '../contracts.js';
import type { PreparedTool, ToolExecutionOptions, ToolOutcome } from '../tools/gateway.js';
import { digestValue, resolveProjectPath, ToolPolicyError } from '../tools/policy.js';
import { IntegrationStore, text } from './store.js';
import type { IntegrationStatus, ReaConfiguration } from './types.js';

export const REA_VERSION = '6.4.0' as const;
const MAX_FILES = 32, MAX_FILE_BYTES = 1_048_576, MAX_TOTAL_BYTES = 4_194_304, MAX_RESULT_BYTES = 8_388_608;
interface ManifestEntry { path: string; sha256: string; bytes: number; }
interface Effect { digest: string; outcome: ToolOutcome; raw?: string; }
interface Options { dataDir: string; projectRoot: string; dependencyRoot?: string; store: IntegrationStore; }
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Only the pinned, installed REA CLI. Never executes a target, browser, arbitrary command or native provider. */
export class IntegrationTools {
  private readonly entry: string;
  private readonly packageRoot: string;
  private readonly inFlight = new Map<string, { digest: string; promise: Promise<ToolOutcome> }>();
  constructor(private readonly options: Options) {
    this.packageRoot = path.join(options.dependencyRoot ?? path.join(options.projectRoot, '.deps', `rea-${REA_VERSION}`), 'node_modules', 'rea-agents');
    this.entry = path.join(this.packageRoot, 'scripts', 'rea.mjs');
  }
  configuration(): ReaConfiguration { return this.options.store.get('configuration', 'global', 'rea') ?? { enabled: false }; }
  configure(input: ReaConfiguration): ReaConfiguration {
    if (typeof input.enabled !== 'boolean' || Object.keys(input).some(key => key !== 'enabled')) throw new ToolPolicyError('REA configuration accepts only enabled: boolean.');
    this.options.store.put('configuration', 'global', 'rea', { enabled: input.enabled }); return this.configuration();
  }
  status(): IntegrationStatus {
    let reason: string | undefined;
    try { this.installationDigest(); } catch (error) { reason = error instanceof Error ? error.message : 'REA dependency check failed.'; }
    return { collaboration: { available: true, scheduler: 'kernel' }, rea: { ...this.configuration(), available: !reason, engine: 'rea-cli', version: REA_VERSION, entry: this.entry, ...(reason ? { reason } : {}),
      native: { available: false, reason: 'Native analysis providers are not configured or verified. This integration only runs inert JavaScript/Electron static analysis; no commercial tool is purchased or launched.' } } };
  }
  definitions(): ToolDefinition[] { return this.configuration().enabled && this.status().rea.available ? structuredClone(INTEGRATION_TOOL_DEFINITIONS) : []; }
  private installationDigest(): string {
    const files = ['package.json', 'scripts/rea.mjs', 'dist/cli.js', 'dist/composition/javascriptAnalysisWorkerProcess.js'];
    if (!files.every(file => existsSync(path.join(this.packageRoot, file)))) throw new ToolPolicyError('Pinned REA 6.4.0 CLI is not installed. Install the reviewed release locally with lifecycle scripts disabled; no automatic install occurs.');
    if (realpathSync(this.packageRoot).toLowerCase() !== path.resolve(this.packageRoot).toLowerCase()) throw new ToolPolicyError('REA installation must not contain a redirected package root.');
    const pkg = JSON.parse(readFileSync(path.join(this.packageRoot, 'package.json'), 'utf8'));
    if (pkg.name !== 'rea-agents' || pkg.version !== REA_VERSION || pkg.license !== 'MIT') throw new ToolPolicyError('REA package identity or license differs from the pinned release.');
    return digestValue(files.map(file => ({ file, sha256: sha256(readFileSync(path.join(this.packageRoot, file))) })));
  }
  async prepare(workspace: string, call: Pick<ToolCall, 'name' | 'arguments'>): Promise<PreparedTool | undefined> {
    if (call.name !== 'rea_analyze_local') return undefined;
    if (!this.configuration().enabled) throw new ToolPolicyError('REA integration is disabled. Enable it explicitly in operator settings.');
    const installation = this.installationDigest();
    const paths = call.arguments.paths;
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_FILES || paths.some(file => typeof file !== 'string')) throw new ToolPolicyError('REA needs 1–32 exact workspace-relative source files, not a URL, glob, directory or executable.');
    const manifest: ManifestEntry[] = [];
    let total = 0;
    for (const requested of [...new Set(paths as string[])]) {
      if (!requested || path.isAbsolute(requested) || /^[a-z]:|^[a-z]+:\/\//i.test(requested)) throw new ToolPolicyError('REA accepts only workspace-relative local files.');
      const filename = await resolveProjectPath(workspace, requested), relative = path.relative(workspace, filename);
      if (!/\.(?:[cm]?js|jsx|tsx?|json|html|css|map)$/i.test(relative)) throw new ToolPolicyError('REA static slice accepts JS/TS, JSON, HTML, CSS and source maps only; native executables are unavailable.');
      const info = await lstat(filename);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new ToolPolicyError('Each local source must be a regular file no larger than 1 MiB.');
      const bytes = await readFile(filename);
      total += bytes.length;
      if (bytes.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new ToolPolicyError('REA input exceeds the 4 MiB bounded sample budget.');
      manifest.push({ path: relative.replaceAll('\\', '/'), sha256: sha256(bytes), bytes: bytes.length });
    }
    const args = { paths: manifest.map(file => file.path), workspace: path.resolve(workspace), manifest, installation, version: REA_VERSION };
    if (call.arguments.manifest !== undefined && digestValue(call.arguments) !== digestValue(args)) throw new ToolPolicyError('Prepared REA request changed: workspace, sample hashes or installation no longer matches. A new request and approval are required.');
    return { name: call.name, arguments: args, digest: digestValue({ name: call.name, arguments: args }), capability: 'process.exec', mutating: true,
      resources: [this.entry, ...manifest.map(file => path.join(workspace, file.path))] };
  }
  async execute(prepared: PreparedTool, options: ToolExecutionOptions): Promise<ToolOutcome> {
    if (prepared.name !== 'rea_analyze_local' || prepared.digest !== digestValue({ name: prepared.name, arguments: prepared.arguments }) || options.approvedDigest !== prepared.digest) throw new ToolPolicyError('REA execution requires exact prepared digest approval through the Kernel.');
    text(options.effectKey, 'Effect key', 300);
    const running = this.inFlight.get(options.effectKey);
    if (running) {
      if (running.digest !== prepared.digest) throw new ToolPolicyError('Effect key belongs to another analysis.');
      return running.promise;
    }
    const existing = this.options.store.get<Effect>('effect', 'rea', options.effectKey);
    if (existing) return this.queryOutcome(options.effectKey, prepared.digest);
    if (!this.configuration().enabled) throw new ToolPolicyError('REA integration was disabled before dispatch.');
    if (prepared.arguments.installation !== this.installationDigest()) throw new ToolPolicyError('REA installation changed after approval.');
    const promise = this.run(prepared, options);
    this.inFlight.set(options.effectKey, { digest: prepared.digest, promise });
    try { return await promise; } finally { this.inFlight.delete(options.effectKey); }
  }
  async queryOutcome(effectKey: string, digest?: string): Promise<ToolOutcome> {
    const effect = this.options.store.get<Effect>('effect', 'rea', effectKey);
    if (!effect) return { status: 'unknown', output: '', error: 'No independent REA receipt exists. Do not replay automatically.' };
    if (digest && effect.digest !== digest) throw new ToolPolicyError('Effect key belongs to another analysis digest.');
    return effect.outcome;
  }
  readResult(effectKey: string, offset = 0, length = 6000) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 12000) throw new ToolPolicyError('REA result paging requires a nonnegative offset and length 1–12000.');
    const effect = this.options.store.get<Effect>('effect', 'rea', effectKey);
    if (!effect?.raw) throw new ToolPolicyError('No retained REA result for this effect.');
    return { effectKey, offset, offsetUnit: 'utf16', text: effect.raw.slice(offset, offset + length), totalChars: effect.raw.length,
      nextOffset: offset + length < effect.raw.length ? offset + length : null, sha256: sha256(effect.raw), trust: 'untrusted' };
  }
  private async run(prepared: PreparedTool, options: ToolExecutionOptions): Promise<ToolOutcome> {
    const save = (outcome: ToolOutcome, raw?: string) => { this.options.store.put('effect', 'rea', options.effectKey, { digest: prepared.digest, outcome, ...(raw ? { raw } : {}) }); return outcome; };
    if (options.signal?.aborted) return save({ status: 'failed', output: '', error: 'REA cancelled before dispatch.' });
    save({ status: 'unknown', output: '', error: 'REA dispatch started but no conclusive receipt is persisted. Never auto-replay.' });
    const tempRoot = path.join(this.options.dataDir, 'rea-tmp');
    await mkdir(tempRoot, { recursive: true });
    const temp = await mkdtemp(path.join(tempRoot, 'analysis-'));
    try {
      const sample = path.join(temp, 'sample'), home = path.join(temp, 'home');
      await mkdir(sample); await mkdir(home);
      const manifest = prepared.arguments.manifest as ManifestEntry[];
      for (const file of manifest) {
        const target = await resolveProjectPath(String(prepared.arguments.workspace), file.path);
        const bytes = await readFile(target);
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new ToolPolicyError('Authorized sample changed after approval; prepare and approve again.');
        const destination = path.join(sample, file.path);
        await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes, { flag: 'wx' });
      }
      const raw = await invokeCli(this.entry, sample, home, options.signal);
      const value = JSON.parse(raw) as Record<string, any>;
      if (value.error || value.isError || value.ok === false) return save({ status: 'failed', output: '', error: `REA reported analysis failure: ${JSON.stringify(value).slice(0, 2000)}` }, raw);
      const result = value.normalized_result;
      if (value.operation !== 'analyze_javascript_application' || !result || typeof result !== 'object' || !result.summary || !result.statistics) throw new ToolPolicyError('REA CLI returned no valid JavaScript analysis Evidence envelope.');
      const receipt = { effectKey: options.effectKey, digest: prepared.digest, tool: prepared.name, engine: 'rea-cli', version: REA_VERSION,
        inputManifest: manifest, outputSha256: sha256(raw), resultChars: raw.length, appliedAt: new Date().toISOString(), trust: 'untrusted',
        summary: result.summary ?? null, statistics: result.statistics ?? null, limitations: result.limitations ?? [],
        scope: 'Only explicitly selected copied sources. No sample execution, browser launch, network capture or native engine.' };
      return save({ status: 'applied', output: JSON.stringify(receipt), receipt }, raw);
    } catch (error) {
      return save({ status: 'failed', output: '', error: error instanceof Error ? error.message : 'REA local analysis failed.' });
    } finally {
      // Only this newly-created, inert sample and isolated CLI home; never user input or dependencies.
      await rm(temp, { recursive: true, force: true });
    }
  }
}

function invokeCli(entry: string, sample: string, home: string, signal?: AbortSignal): Promise<string> {
  const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: path.dirname(process.execPath),
    TEMP: home, TMP: home, TMPDIR: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, npm_config_cache: home, PLAYWRIGHT_BROWSERS_PATH: home, NODE_NO_WARNINGS: '1' };
  const child = spawn(process.execPath, [entry, 'analyze-javascript-application', sample, '--max-heap-mb', '256', '--analysis-timeout-ms', '30000', '--json'],
    { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', stopReason: string | undefined, spawnError: Error | undefined;
    const stop = (reason: string) => {
      if (stopReason) return; stopReason = reason;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(path.join(process.env.SystemRoot!, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { cwd: home, env, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const cancel = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed out after 60000 ms'), 60000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; if (Buffer.byteLength(stdout) > MAX_RESULT_BYTES) stop('exceeded the 8 MiB output limit'); });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', error => { spawnError = error; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (spawnError) reject(spawnError);
      else if (stopReason) reject(new Error(`REA ${stopReason}; sample was not executed.${stderr ? ` Last CLI diagnostics: ${stderr.slice(-2000)}` : ' No CLI diagnostics were received.'}`));
      else if (code !== 0) reject(new Error(`REA CLI failed (${code}): ${stderr.slice(-2000)}`));
      else resolve(stdout);
    });
  });
}

export const INTEGRATION_TOOL_DEFINITIONS: ToolDefinition[] = [
  { type: 'function', function: { name: 'rea_analyze_local', description: 'Run the installed MIT REA 6.4.0 inert JS/Electron static analyzer on 1–32 exact files in this authorized workspace. Requires exact Kernel approval; does not execute the sample, launch a browser, scan networks or use native/commercial providers. Full result retained for operator inspection.',
    parameters: { type: 'object', properties: { paths: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } } }, required: ['paths'], additionalProperties: false } } },
];
