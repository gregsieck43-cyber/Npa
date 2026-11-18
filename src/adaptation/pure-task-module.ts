import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isLocalPath } from '../app/local-paths.js';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

export interface PureTaskFixture { input: string; expected: string }
export interface PureTaskModule {
  kind: 'pure-task-module';
  source: string;
  fixtures: PureTaskFixture[];
}
export interface PinnedTaskModule extends PureTaskModule { sourceDigest: string }
export class TaskModuleError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'TaskModuleError'; }
}
export function taskModuleDigest(source: string): string { return createHash('sha256').update(source).digest('hex'); }

/** Syntax compilation only. No candidate source executes on the backend thread. */
export function validateTaskModule(value: PureTaskModule): PureTaskModule {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'pure-task-module' ||
      Object.keys(value).some(key => !['kind', 'source', 'fixtures'].includes(key)) ||
      typeof value.source !== 'string' || value.source.length < 1 || value.source.length > 8192) {
    throw new TaskModuleError('MODULE_SCHEMA', 'Task module must be a JavaScript function expression of at most 8192 characters.');
  }
  if (/\bimport\s*(?:\(|["'{*])/.test(value.source)) throw new TaskModuleError('MODULE_IMPORT', 'Task modules cannot import dependencies.');
  try { new Script(`"use strict"; (${value.source});`); }
  catch { throw new TaskModuleError('MODULE_SYNTAX', 'Task module source is not a valid JavaScript function expression.'); }
  if (!Array.isArray(value.fixtures) || value.fixtures.length < 1 || value.fixtures.length > 8 || value.fixtures.some(fixture =>
      !fixture || typeof fixture !== 'object' || Object.keys(fixture).some(key => !['input', 'expected'].includes(key)) ||
      typeof fixture.input !== 'string' || fixture.input.length > 8192 || typeof fixture.expected !== 'string' || fixture.expected.length > 65536)) {
    throw new TaskModuleError('MODULE_FIXTURE', 'Provide 1 to 8 explicit input/expected-output fixtures within the text bounds.');
  }
  return structuredClone(value);
}

interface ModuleResponse { ok: boolean; outputs?: string[]; error?: { code: string; message: string } }

/** Trusted operator-authored candidates only. Node permissions and VM are not an OS security sandbox. */
export async function runTaskModule(module: Pick<PureTaskModule, 'source'>, inputs: string[], dataDir: string, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) throw new TaskModuleError('MODULE_CANCELLED', 'Task module call was cancelled before dispatch.');
  if (inputs.length < 1 || inputs.length > 16 || inputs.some(input => typeof input !== 'string' || input.length > 65536)) {
    throw new TaskModuleError('MODULE_INPUT', 'Task module accepts at most 16 text inputs of 65536 characters.');
  }
  const worker = fileURLToPath(new URL('./task-module-worker.js', import.meta.url));
  const runtimeRoot = join(resolve(dataDir), 'adaptation', '.runtime');
  if (!isLocalPath(runtimeRoot)) throw new TaskModuleError('MODULE_PATH', 'Task module temporary data must remain on the installation volume.');
  mkdirSync(runtimeRoot, { recursive: true });
  const temporary = mkdtempSync(join(runtimeRoot, 'module-'));
  const home = join(temporary, 'home'); mkdirSync(home);
  const args = ['--permission', `--allow-fs-read=${worker}`, '--no-addons', '--max-old-space-size=32'];
  let directory = dirname(worker);
  while (isLocalPath(directory)) {
    const packagePath = join(directory, 'package.json');
    if (existsSync(packagePath)) { args.push(`--allow-fs-read=${packagePath}`); break; }
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  args.push(worker);
  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: dirname(process.execPath),
    TEMP: temporary, TMP: temporary, HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
    npm_config_cache: join(temporary, 'cache', 'npm'), XDG_CACHE_HOME: join(temporary, 'cache'),
  };
  try {
    return await new Promise<string[]>((done, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = spawn(process.execPath, args, { cwd: temporary, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { reject(new TaskModuleError('MODULE_WORKER', 'Task module worker could not start.')); return; }
      let output = ''; let bytes = 0; let failure: TaskModuleError | undefined;
      const stop = (error: TaskModuleError) => { failure ??= error; child.kill(); };
      const timer = setTimeout(() => stop(new TaskModuleError('MODULE_TIMEOUT', 'Task module exceeded its two-second worker deadline.')), 2000);
      const abort = () => stop(new TaskModuleError('MODULE_CANCELLED', 'Task module call was cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 1_048_576) stop(new TaskModuleError('MODULE_OUTPUT', 'Task module output exceeded its bound.')); else output += chunk; });
      child.stderr.resume(); // Candidate exception text is never copied into logs or approval data.
      child.once('error', () => { failure = new TaskModuleError('MODULE_WORKER', 'Task module worker could not start.'); });
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(new TaskModuleError('MODULE_WORKER', 'Task module worker exited without a result.')); return; }
        let response: ModuleResponse;
        try { response = JSON.parse(output); } catch { reject(new TaskModuleError('MODULE_PROTOCOL', 'Task module returned invalid protocol output.')); return; }
        if (!response.ok) { reject(new TaskModuleError(response.error?.code ?? 'MODULE_EXECUTION', response.error?.message ?? 'Task module failed.')); return; }
        if (!Array.isArray(response.outputs) || response.outputs.length !== inputs.length || response.outputs.some(value => typeof value !== 'string' || value.length > 65536)) {
          reject(new TaskModuleError('MODULE_PROTOCOL', 'Task module returned invalid text outputs.')); return;
        }
        done(response.outputs);
      });
      child.stdin.on('error', () => { /* close reports worker termination and cancellation. */ });
      child.stdin.end(JSON.stringify({ source: module.source, inputs }));
    });
  } finally {
    const target = realpathSync(temporary); const owned = relative(realpathSync(runtimeRoot), target);
    if (!owned.startsWith('module-') || owned.includes(sep) || isAbsolute(owned)) throw new TaskModuleError('MODULE_PATH', 'Task module cleanup escaped its owned directory.');
    rmSync(target, { recursive: true });
  }
}
