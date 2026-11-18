import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocalPath } from '../app/local-paths.js';
import { PluginError } from './plugin-error.js';

export interface DshArtifact {
  packageName: string;
  main: string;
  source: string;
  configuration: Record<string, unknown>;
  dependencies: Record<string, string>;
}
export interface DshLifecycle {
  toolsRegistered: number; toolsDisposed: number; effectsRegistered: number;
  effectsDisposed: number; applyDisposed: number; disposalOrder: string[];
}
export interface DshCatalogEntry { name: string; description: string; }
export interface DshResponse {
  catalog: DshCatalogEntry[];
  lifecycle: DshLifecycle;
  output?: string;
  renderedContent?: { type: 'text'; text: string }[];
}
const OUTPUT_LIMIT = 2_097_152;
const TIMEOUT_MS = 2500;

/** One stateless mount. The child receives source/config/input as JSON, never backend credentials. */
export async function runDsh(artifact: DshArtifact, dataDir: string, operation?: { name: string; input: string }, signal?: AbortSignal): Promise<DshResponse> {
  const workerPath = fileURLToPath(new URL('./dsh-worker.js', import.meta.url));
  const runtimeRoot = join(resolve(dataDir), 'plugins', '.runtime');
  if (!isLocalPath(runtimeRoot) || !isLocalPath(process.execPath)) throw new PluginError('UNSAFE_SOURCE', 'DSH workers require the installation runtime and a data directory on the installation volume.');
  if (signal?.aborted) throw new PluginError('DSH_CANCELLED', 'Plugin call was cancelled before dispatch.');
  await mkdir(runtimeRoot, { recursive: true });
  const temporary = await mkdtemp(join(runtimeRoot, 'dsh-'));
  try {
    const home = join(temporary, 'home'); await mkdir(home);
    const cache = join(temporary, 'cache'); await mkdir(cache);
    const args = ['--permission', `--allow-fs-read=${workerPath}`, '--no-addons', '--experimental-vm-modules', '--max-old-space-size=64'];
    // Node's ESM loader may read the closest own package metadata to resolve this .js file.
    let directory = dirname(workerPath);
    while (isLocalPath(directory)) {
      const packagePath = join(directory, 'package.json');
      if (existsSync(packagePath)) { args.push(`--allow-fs-read=${packagePath}`); break; }
      const parent = dirname(directory); if (parent === directory) break; directory = parent;
    }
    args.push(workerPath);
    const env: NodeJS.ProcessEnv = {
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: dirname(process.execPath),
      TEMP: temporary, TMP: temporary, HOME: home, USERPROFILE: home,
      APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
      npm_config_cache: join(cache, 'npm'), XDG_CACHE_HOME: cache,
    };
    // Cancellation can arrive while the asynchronous staging operations are pending.
    if (signal?.aborted) throw new PluginError('DSH_CANCELLED', 'Plugin call was cancelled before dispatch.');
    return await new Promise<DshResponse>((done, reject) => {
      const child = spawn(process.execPath, args, { cwd: temporary, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let bytes = 0; let failure: PluginError | undefined;
      const stop = (error: PluginError) => { failure ??= error; child.kill(); };
      const timer = setTimeout(() => stop(new PluginError('DSH_TIMEOUT', 'DSH plugin exceeded the 2.5 second worker deadline.')), TIMEOUT_MS);
      const abort = () => stop(new PluginError('DSH_CANCELLED', 'Plugin call was cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > OUTPUT_LIMIT) stop(new PluginError('OUTPUT_LIMIT', 'DSH worker output exceeded its bound.')); else output += chunk; });
      // Untrusted stderr is deliberately not copied into audit/logs or error details.
      child.stderr.resume();
      child.once('error', () => { failure = new PluginError('DSH_RUNTIME_FAILURE', 'The isolated DSH worker could not start.'); });
      child.once('close', (code) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(new PluginError('DSH_RUNTIME_FAILURE', 'The isolated DSH worker exited without a result.')); return; }
        let response: { ok: boolean; result?: DshResponse; error?: { code: string; message: string } };
        try { response = JSON.parse(output); } catch { reject(new PluginError('DSH_RUNTIME_FAILURE', 'DSH worker returned invalid protocol output.')); return; }
        if (!response.ok || !response.result) { reject(new PluginError(response.error?.code ?? 'DSH_RUNTIME_FAILURE', response.error?.message ?? 'DSH plugin execution failed.')); return; }
        const result = response.result;
        if (!Array.isArray(result.catalog) || result.catalog.length > 32 || !result.lifecycle || (operation && (typeof result.output !== 'string' || Buffer.byteLength(result.output) > 1_048_576 || !Array.isArray(result.renderedContent) || result.renderedContent.some(block => block.type !== 'text' || typeof block.text !== 'string')))) { reject(new PluginError('DSH_RUNTIME_FAILURE', 'DSH worker result violates the supported text contract.')); return; }
        done(result);
      });
      child.stdin.on('error', () => { /* Child termination is reported by close, including timeout/cancellation. */ });
      child.stdin.end(JSON.stringify({ artifact, operation }));
    });
  } finally {
    const target = await realpath(temporary); const within = relative(await realpath(runtimeRoot), target);
    if (!within.startsWith('dsh-') || within.includes(sep) || isAbsolute(within)) throw new PluginError('UNSAFE_ARTIFACT', 'DSH worker cleanup target left its owned directory.');
    // Windows filesystem cleanup can stall for seconds after terminating a worker.
    // Await completion without blocking unrelated backend requests and deadlines.
    await rm(target, { recursive: true });
  }
}
