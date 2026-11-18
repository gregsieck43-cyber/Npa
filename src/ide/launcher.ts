import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeAtomicJson } from '../app/atomic-json.js';
import { assertLocalPath } from '../app/local-paths.js';

export interface IdeLaunchOptions {
  productRoot: string; dataDir: string; hostDirectory: string; extensionDirectory: string;
  workspace?: string; workspaceBoundary?: string; environment?: NodeJS.ProcessEnv; inspectPort?: number;
}
export interface IdeLaunchSpec { executable: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; userData: string; extensions: string; }
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function createIdeLaunchSpec(options: IdeLaunchOptions): IdeLaunchSpec {
  const productRoot = path.resolve(options.productRoot), dataDir = path.resolve(options.dataDir);
  for (const value of [productRoot, dataDir, options.hostDirectory, options.extensionDirectory]) assertLocalPath(value);
  if (!within(productRoot, dataDir)) throw new Error('IDE data must stay inside the product project.');
  const executable = path.join(options.hostDirectory, 'VSCodium.exe');
  if (!existsSync(executable) || !existsSync(path.join(options.extensionDirectory, 'package.json'))) throw new Error('Portable IDE assets are missing. Build/acquire the bundled editor first.');
  if (options.workspace) {
    assertLocalPath(options.workspace, 'IDE workspace');
    if (!within(options.workspaceBoundary ?? path.dirname(productRoot), path.resolve(options.workspace)) || !statSync(options.workspace).isDirectory()) throw new Error('IDE workspace must be an existing folder inside the configured project.');
  }
  const root = path.join(dataDir, 'ide'), userData = path.join(root, 'user-data'), extensions = path.join(root, 'extensions');
  const parent = options.environment ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) if (parent[name]) env[name] = parent[name];
  Object.assign(env, { TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp'),
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
    npm_config_cache: path.join(root, 'cache', 'npm'), npm_config_prefix: path.join(root, 'tools'),
    PIP_CACHE_DIR: path.join(root, 'cache', 'pip'), UV_CACHE_DIR: path.join(root, 'cache', 'uv'), CARGO_HOME: path.join(root, 'cache', 'cargo'),
    PSModuleAnalysisCachePath: path.join(root, 'cache', 'powershell-analysis'), NPN_IDE_DATA_DIR: dataDir, NPN_IDE_PRODUCT_ROOT: productRoot, NPN_IDE_WORKSPACE_BOUNDARY: options.workspaceBoundary ?? path.dirname(productRoot), NODE_NO_WARNINGS: '1' });
  const args = ['--new-window', '--user-data-dir', userData, '--extensions-dir', extensions,
    '--crash-reporter-directory', path.join(root, 'crashes'), '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-experiments'];
  if (options.inspectPort !== undefined) {
    if (!Number.isInteger(options.inspectPort) || options.inspectPort < 1024 || options.inspectPort > 65535) throw new Error('IDE diagnostic port must be an explicit port from 1024 to 65535.');
    args.push(`--remote-debugging-port=${options.inspectPort}`, '--remote-debugging-address=127.0.0.1');
  }
  if (options.workspace) args.push(path.resolve(options.workspace));
  return { executable, args, env, cwd: productRoot, userData, extensions };
}

function bundleDigest(directory: string): string {
  const hash = createHash('sha256');
  const visit = (relative = '') => {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = path.join(relative, entry.name), full = path.join(directory, name);
      if (name === '.npn-bundle.json') continue;
      if (entry.isSymbolicLink()) throw new Error('IDE extension bundles cannot contain links.');
      if (entry.isDirectory()) visit(name);
      else { hash.update(name.replaceAll('\\', '/')); hash.update(readFileSync(full)); }
    }
  };
  visit(); return hash.digest('hex');
}

/** Install only our immutable bundled extension; never run a marketplace or package script. */
export function installIdeExtension(source: string, extensions: string): string {
  assertLocalPath(source, 'IDE extension bundle'); assertLocalPath(extensions, 'IDE extension directory');
  const metadata = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (![metadata.publisher, metadata.name].every(value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value)) || !/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('Invalid bundled extension identity.');
  const digest = bundleDigest(source), target = path.join(extensions, `${metadata.publisher}.${metadata.name}-${metadata.version}`);
  assertLocalPath(target, 'Installed IDE extension');
  if (existsSync(target)) {
    const marker = path.join(target, '.npn-bundle.json');
    if (!existsSync(marker) || JSON.parse(readFileSync(marker, 'utf8')).digest !== digest) throw new Error('An extension with different bytes already uses this version; build a new version.');
    if (bundleDigest(target) !== digest) throw new Error('Installed NPN extension integrity changed; restore its approved bundle before reopening.');
    return target;
  }
  mkdirSync(extensions, { recursive: true });
  cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
  writeAtomicJson(path.join(target, '.npn-bundle.json'), { digest, version: metadata.version });
  return target;
}

export function prepareIde(options: IdeLaunchOptions): IdeLaunchSpec {
  const spec = createIdeLaunchSpec(options);
  for (const directory of [spec.userData, spec.extensions, ...['TEMP', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'npm_config_cache'].map(key => spec.env[key]!)]) mkdirSync(directory, { recursive: true });
  const settings = path.join(spec.userData, 'User', 'settings.json');
  mkdirSync(path.dirname(settings), { recursive: true });
  if (!existsSync(settings)) writeFileSync(settings, JSON.stringify({ 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'workbench.startupEditor': 'none',
    'task.allowAutomaticTasks': 'off', 'security.workspace.trust.enabled': true, 'npn.dataDirectory': options.dataDir,
    'files.autoSave': 'off', 'editor.formatOnSave': false, 'workbench.colorTheme': 'NPN Warm',
    'workbench.editor.enablePreview': false, 'npn.openWorkbenchOnStartup': true,
    'window.title': '${dirty}${activeEditorShort}${separator}${rootName}${separator}NPN Gamma IDE' }, null, 2));
  installIdeExtension(options.extensionDirectory, spec.extensions);
  return spec;
}

export async function launchIde(options: IdeLaunchOptions): Promise<{ pid: number; workspace?: string; host: 'NPN Gamma IDE'; }> {
  const spec = prepareIde(options);
  const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, windowsHide: false, stdio: 'ignore', shell: false });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return { pid: child.pid!, workspace: options.workspace, host: 'NPN Gamma IDE' };
}

export function ideAssets(productRoot: string, appRoot: string, packaged: boolean): { hostDirectory: string; extensionDirectory: string } {
  const hostDirectory = packaged ? path.join(productRoot, 'resources', 'ide-host') : path.resolve(productRoot, JSON.parse(readFileSync(path.join(productRoot, '.deps', 'ide-host', 'npn-host.json'), 'utf8')).directory);
  const extensionDirectory = packaged ? path.join(appRoot, 'ide-extension') : path.join(productRoot, 'build', 'ide-extension');
  return { hostDirectory, extensionDirectory };
}
