import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digestValue, isForbiddenRelative, resolveProjectPath, ToolPolicyError } from './policy.js';
import type { PreparedTool, ToolOutcome, ToolArtifactHash } from './gateway.js';
import { prepareReadOnly, searchText, gitQuery } from './read-only.js';
import { filePathIdentity } from '../kernel/read-set.js';
import type { ReadVersion } from '../kernel/read-set.js';

interface Request { operation: 'execute' | 'query'; workspace: string; receiptDirectory: string; runtimePath: string; prepared?: PreparedTool; effectKey: string; approvedDigest?: string; digest?: string; fault?: string; }
interface ReceiptRow { digest: string; state: string; prepared: string; receipt: string | null; }
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function run(request: Request): Promise<ToolOutcome> {
  await mkdir(request.receiptDirectory, { recursive: true });
  const db = new DatabaseSync(path.join(request.receiptDirectory, 'tool-receipts.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS receipts (effect_key TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, prepared TEXT NOT NULL, receipt TEXT); CREATE TABLE IF NOT EXISTS fixture (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL); INSERT OR IGNORE INTO fixture(id,value) VALUES(1,0);');
  const lookup = (): ReceiptRow | undefined => db.prepare('SELECT digest,state,prepared,receipt FROM receipts WHERE effect_key=?').get(request.effectKey) as ReceiptRow | undefined;
  const mark = (digest: string, output: string, extra: Record<string, unknown> = {}): ToolOutcome => {
    const receipt = { effectKey: request.effectKey, digest, appliedAt: new Date().toISOString(), output, ...extra };
    db.prepare('UPDATE receipts SET state=\'applied\',receipt=? WHERE effect_key=?').run(JSON.stringify(receipt), request.effectKey);
    return { status: 'applied', output, receipt };
  };
  const reconcile = async (row: ReceiptRow | undefined): Promise<ToolOutcome> => {
    if (!row) return { status: 'unknown', output: '', error: 'No receipt exists; this effect was not confirmed.' };
    if (request.digest && request.digest !== row.digest) throw new ToolPolicyError('Effect key belongs to a different digest.');
    if (row.state === 'applied' && row.receipt) { const receipt = JSON.parse(row.receipt); return { status: 'applied', output: receipt.output, receipt }; }
    const prepared: PreparedTool = JSON.parse(row.prepared);
    if (prepared.name === 'write_file') {
      const target = await resolveProjectPath(request.workspace, String(prepared.arguments.path), true);
      try {
        const actual = await readFile(target);
        const expected = sha256(String(prepared.arguments.content));
        if (sha256(actual) === expected) return mark(row.digest, `Wrote ${prepared.arguments.path}`, { path: prepared.arguments.path, sha256: expected, bytes: actual.length, reconciled: true });
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    return { status: 'unknown', output: '', error: 'Effect is pending without conclusive evidence; do not repeat automatically.' };
  };
  try {
    if (request.operation === 'query') return await reconcile(lookup());
    const prepared = request.prepared!;
    if (prepared.digest !== digestValue({ name: prepared.name, arguments: prepared.arguments })) throw new ToolPolicyError('Worker rejected a changed prepared digest.');
    if (['write_file', 'run_command', 'run_shell', 'fixture_increment'].includes(prepared.name) && request.approvedDigest !== prepared.digest) throw new ToolPolicyError('Worker requires the exact approved digest.');
    const existing = lookup();
    if (existing) { request.digest = prepared.digest; return await reconcile(existing); }
    const args = prepared.arguments;
    if (prepared.name === 'run_command') {
      const argv = args.argv as string[];
      const files = argv[0] === '--version' ? [] : argv[0] === '--test' ? argv.slice(2) : [argv[argv[0] === '--check' ? 1 : 0]!];
      const approved = args.artifactHashes as ToolArtifactHash[];
      if (!Array.isArray(approved) || approved.length !== files.length) throw new ToolPolicyError('Approved command artifact hashes are missing.');
      for (const [index, file] of files.entries()) {
        const target = await resolveProjectPath(request.workspace, file);
        const artifact = approved[index]!;
        if (artifact.path !== target || artifact.sha256 !== sha256(await readFile(target))) {
          throw new ToolPolicyError(`Approved command artifact changed: ${path.relative(request.workspace, target)}. Prepare and approve the new bytes before execution.`);
        }
      }
    }
    db.prepare('INSERT INTO receipts(effect_key,digest,state,prepared) VALUES(?,?,\'pending\',?)').run(request.effectKey, prepared.digest, JSON.stringify(prepared));
    switch (prepared.name) {
      case 'search_text': case 'git_query': {
        const validated = await prepareReadOnly(request.workspace, prepared.name, args);
        if (prepared.name === 'search_text') {
          const result = await searchText(request.workspace, validated.arguments);
          return mark(prepared.digest, JSON.stringify(result), { matchedLines: result.matches.length, scannedFiles: result.scannedFiles, truncated: result.truncated });
        }
        const result = await gitQuery(request.workspace, validated.arguments);
        return mark(prepared.digest, result.output, { exitCode: result.exitCode, truncated: result.truncated });
      }
      case 'read_file': {
        const target = await resolveProjectPath(request.workspace, String(args.path), true);
        try {
          const info = await stat(target);
          if (!info.isFile() || info.size > 1_000_000) throw new ToolPolicyError('Read requires a regular file below 1 MB.');
          const contents = await readFile(target);
          if (contents.length > 1_000_000) throw new ToolPolicyError('File exceeds the 1 MB read limit.');
          return mark(prepared.digest, contents.toString('utf8'), { path: args.path, sha256: sha256(contents), bytes: contents.length, exists: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return mark(prepared.digest, `File does not exist: ${args.path}`, { path: args.path, sha256: null, bytes: 0, exists: false });
        }
      }
      case 'write_file': {
        const target = await resolveProjectPath(request.workspace, String(args.path), true);
        if (args.expectedSha256 !== null && (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedSha256))) throw new ToolPolicyError('File version is missing. Prepare and approve a new write.');
        const version = args.readVersion as ReadVersion | undefined;
        if (!version || version.path !== filePathIdentity(target) || version.sha256 !== args.expectedSha256
          || (version.sha256 === null ? version.sourceIntentId !== null && typeof version.sourceIntentId !== 'string' : typeof version.sourceIntentId !== 'string'))
          throw new ToolPolicyError('READ_REQUIRED: Worker requires the approved read-version binding.');
        const checkVersion = async () => {
          const info = await stat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
          if (info && (!info.isFile() || info.size > 1_048_576)) throw new ToolPolicyError('File changed since preparation. A new proposal is required.');
          const actual = info ? sha256(await readFile(target)) : null;
          if (actual !== args.expectedSha256) throw new ToolPolicyError('READ_VERSION_STALE: File changed since preparation. No Agent overwrite was performed; read again and review a new proposal.');
        };
        await checkVersion();
        await mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.npn-${sha256(request.effectKey).slice(0, 12)}.tmp`;
        const handle = await open(temp, 'wx');
        try {
          try { await handle.writeFile(String(args.content), 'utf8'); await handle.sync(); } finally { await handle.close(); }
          await checkVersion();
          await rename(temp, target);
          if (request.fault === 'after_effect_before_receipt') process.exit(86);
          return mark(prepared.digest, `Wrote ${args.path}`, { path: args.path, sha256: sha256(String(args.content)), bytes: Buffer.byteLength(String(args.content)) });
        } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      }
      case 'list_files': {
        const target = await resolveProjectPath(request.workspace, String(args.path ?? '.'));
        const entries = await readdir(target, { withFileTypes: true });
        const listing = entries.filter(entry => !entry.isSymbolicLink() && !isForbiddenRelative(path.relative(request.workspace, path.join(target, entry.name))))
          .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }));
        return mark(prepared.digest, JSON.stringify(listing), { path: args.path });
      }
      case 'fixture_increment': {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE fixture SET value=value+? WHERE id=1').run(Number(args.amount));
          const value = (db.prepare('SELECT value FROM fixture WHERE id=1').get() as { value: number }).value;
          const outcome = mark(prepared.digest, JSON.stringify({ value }), { fixtureValue: value });
          db.exec('COMMIT'); return outcome;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      case 'run_command': case 'run_shell': {
        const argv = args.argv as string[];
        const bootstrap = fileURLToPath(new URL('../fixtures/command-bootstrap.js', import.meta.url));
        const commandArgs = argv?.[0] === '--test' ? [...argv.slice(0, 2), ...argv.slice(2).map(file => path.relative(request.workspace, file))] : argv ?? [];
        const scopedArgs = ['--permission', `--allow-fs-read=${request.workspace}`, `--allow-fs-read=${bootstrap}`,
          `--allow-fs-write=${request.workspace}`, '--import', pathToFileURL(bootstrap).href, ...commandArgs];
        const shellScript = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding;\n${String(args.command ?? '')}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
        const isShell = prepared.name === 'run_shell';
        const executable = isShell ? path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : request.runtimePath;
        const executionArgs = isShell ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(shellScript, 'utf16le').toString('base64')] : scopedArgs;
        const result = await new Promise<{ code: number | null; output: string; truncated: boolean; durationMs: number }>((resolve, reject) => {
          const started = Date.now();
          const child = spawn(executable, executionArgs, { cwd: request.workspace, env: process.env, windowsHide: true });
          let output = '', truncated = false;
          const appendOutput = (chunk: string) => { output += chunk; if (output.length > 262144) { output = output.slice(-262144); truncated = true; } };
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', appendOutput); child.stderr.on('data', appendOutput);
          child.on('error', reject); child.on('close', code => resolve({ code, output, truncated, durationMs: Date.now() - started }));
        });
        return mark(prepared.digest, result.output, { exitCode: result.code, truncated: result.truncated, durationMs: result.durationMs });
      }
      default: throw new ToolPolicyError(`Unsupported tool: ${prepared.name}`);
    }
  } finally { db.close(); }
}

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += String(chunk);
try { process.stdout.write(JSON.stringify(await run(JSON.parse(input) as Request))); }
catch (error) { process.stdout.write(JSON.stringify({ status: 'failed', output: '', error: error instanceof Error ? error.message : 'Tool worker failed.' } satisfies ToolOutcome)); }
