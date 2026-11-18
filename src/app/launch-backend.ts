import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { totalmem } from 'node:os';
import { assertLocalPath } from './local-paths.js';
import { initializeDataDirectory, type DataDirectoryAccess } from './data-directory.js';

export interface BackendConnection { port: number; token: string; pid: number; startedAt: string; }
export interface BackendLaunchOptions { dataDir: string; projectRoot: string; productRoot: string; runtime: string; entry: string; cwd?: string;
  /** In-process desktop startup result only; never populated from discovery or environment. */
  dataDirectoryAccess?: DataDirectoryAccess;
}
const pending = new Map<string, Promise<BackendConnection>>();

async function existing(dataDir: string): Promise<BackendConnection | undefined> {
  const filename = path.join(dataDir, 'backend.json');
  if (!existsSync(filename)) return undefined;
  let connection: BackendConnection;
  try { connection = JSON.parse(readFileSync(filename, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
  if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 || typeof connection.token !== 'string' || !connection.token) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${connection.port}/health`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(2000), redirect: 'error' });
    return response.ok && (await response.json() as { status?: string }).status === 'ready' ? connection : undefined;
  } catch (error) { if (error instanceof TypeError || error instanceof DOMException) return undefined; throw error; }
}

/** Desktop and IDE launchers discover the same native-locked authority; clients never own its lifetime. */
export async function ensureLocalBackend(options: BackendLaunchOptions): Promise<BackendConnection> {
  for (const value of [options.dataDir, options.projectRoot, options.productRoot]) assertLocalPath(value);
  const relative = path.relative(path.resolve(options.projectRoot), path.resolve(options.dataDir));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Backend data must stay inside the configured project.');
  const key = path.resolve(options.dataDir).toLowerCase();
  const active = pending.get(key);
  if (active) return active;
  const operation = start(options);
  pending.set(key, operation);
  try { return await operation; }
  finally { if (pending.get(key) === operation) pending.delete(key); }
}
async function start(options: BackendLaunchOptions): Promise<BackendConnection> {
  const connected = await existing(options.dataDir);
  if (connected) return connected;
  if (options.dataDirectoryAccess?.directory !== path.resolve(options.dataDir)) initializeDataDirectory(options.dataDir);
  const temp = path.join(options.dataDir, 'tmp'), cache = path.join(options.dataDir, 'cache'), logs = path.join(options.dataDir, 'logs');
  for (const directory of [temp, cache, logs]) mkdirSync(directory, { recursive: true });
  const log = openSync(path.join(logs, 'backend-start.log'), 'a');
  const heapMiB = Math.max(128, Math.min(2048, Math.floor(totalmem() * .12 / 1048576)));
  const child = spawn(options.runtime, [`--max-old-space-size=${heapMiB}`, '--max-semi-space-size=16', options.entry, '--backend', '--data-dir', options.dataDir], { cwd: options.cwd ?? options.productRoot, detached: true, windowsHide: true,
    stdio: ['ignore', log, log], env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH,
      TEMP: temp, TMP: temp, TMPDIR: temp, HOME: options.dataDir, USERPROFILE: options.dataDir, APPDATA: cache, LOCALAPPDATA: cache,
      NPN_PROJECT_ROOT: options.projectRoot, NPN_PRODUCT_ROOT: options.productRoot, NPN_DATA_DIR: options.dataDir, NODE_NO_WARNINGS: '1' } });
  child.unref(); closeSync(log);
  let launchError: Error | undefined;
  child.once('error', error => { launchError = error; });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const connection = await existing(options.dataDir);
    if (connection) return connection;
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Backend exited during startup (${child.exitCode ?? child.signalCode}). See ${path.join(logs, 'backend-start.log')}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Backend did not become ready. See ${path.join(logs, 'backend-start.log')}`);
}
