import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PluginError } from './plugin-error.js';
import { runDsh, type DshArtifact, type DshLifecycle } from './dsh-runtime.js';
export { PluginError } from './plugin-error.js';

export const PLUGIN_API_VERSION = 'npn-plugin/1';
export const DSH_COMPATIBLE_VERSION = '0.2.0-rc.2';
export const DSH_REFERENCE_COMMIT = '639ed015397290b3745d163aafe02ffee4aa3f84';
type Transform = 'trim' | 'uppercase' | 'lowercase' | 'normalize_newlines';
export interface PluginOperation { id: string; title: string; steps: Transform[]; }
export interface PluginManifest {
  api: 'npn-plugin/1'; id: string; name: string; version: string; description?: string;
  permissions: ['text.transform']; dependencies?: { id: string; version: string }[]; operations: PluginOperation[];
}
export interface PluginRecord { id: string; name: string; version: string; digest: string; adapter: 'native' | 'dsh-manifest/1' | 'dsh-runtime/1'; enabled: boolean; approvedDigest?: string; installedAt: string; manifest: PluginManifest; }
export interface PluginView extends PluginRecord { currentDigest: string; approvalValid: boolean; runtime?: { api: 'dsh-runtime/1'; packageName: string; main: string; sourceDigest: string; configDigest: string; configuration: Record<string, unknown> }; }
export interface PluginResult { output: string; digest: string; renderedContent?: { type: 'text'; text: string }[]; lifecycle?: DshLifecycle; }
interface StoredPlugin { adapter: PluginRecord['adapter']; manifest: PluginManifest; dsh?: DshArtifact; }
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const transforms = new Set<Transform>(['trim', 'uppercase', 'lowercase', 'normalize_newlines']);
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginError('INVALID_MANIFEST', `${label} must be an object.`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new PluginError('UNSUPPORTED_API', `${label}.${key} is not supported.`);
}
function validateManifest(value: unknown, allowEmptyOperations = false): PluginManifest {
  const manifest = record(value, 'manifest');
  keys(manifest, ['api', 'id', 'name', 'version', 'description', 'permissions', 'dependencies', 'operations'], 'manifest');
  if (manifest.api !== PLUGIN_API_VERSION) throw new PluginError('UNSUPPORTED_API', `Supported native API: ${PLUGIN_API_VERSION}.`);
  if (typeof manifest.id !== 'string' || !ID.test(manifest.id)) throw new PluginError('INVALID_MANIFEST', 'Plugin id must be a lowercase local identifier.');
  if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) throw new PluginError('INVALID_MANIFEST', 'Plugin version must be a concrete semantic version.');
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 200) throw new PluginError('INVALID_MANIFEST', 'Plugin name is required (maximum 200 characters).');
  if (manifest.description !== undefined && (typeof manifest.description !== 'string' || manifest.description.length > 2000)) throw new PluginError('INVALID_MANIFEST', 'Plugin description is invalid.');
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length !== 1 || manifest.permissions[0] !== 'text.transform') throw new PluginError('DENIED_PERMISSION', 'Plugins may request only text.transform. Files, commands, network, approval, audit and kernel access are unavailable.');
  if (!Array.isArray(manifest.operations) || manifest.operations.length < (allowEmptyOperations ? 0 : 1) || manifest.operations.length > 32) throw new PluginError('INVALID_MANIFEST', 'A native plugin needs 1 to 32 operations; approved DSH registrations are discovered on enable.');
  const operationIds = new Set<string>();
  const operations = manifest.operations.map((item, index): PluginOperation => {
    const operation = record(item, `operations[${index}]`);
    keys(operation, ['id', 'title', 'steps'], 'operation');
    if (typeof operation.id !== 'string' || !ID.test(operation.id) || operationIds.has(operation.id)) throw new PluginError('INVALID_MANIFEST', 'Operation ids must be valid and unique.');
    operationIds.add(operation.id);
    if (typeof operation.title !== 'string' || !operation.title.trim() || operation.title.length > 200) throw new PluginError('INVALID_MANIFEST', 'Operation title is invalid.');
    if (!Array.isArray(operation.steps) || operation.steps.length < 1 || operation.steps.length > 8 || operation.steps.some(step => !transforms.has(step as Transform))) throw new PluginError('UNSUPPORTED_API', 'Only bounded trim, uppercase, lowercase and normalize_newlines transforms are supported.');
    return { id: operation.id, title: operation.title, steps: operation.steps as Transform[] };
  });
  let dependencies: { id: string; version: string }[] | undefined;
  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length > 16) throw new PluginError('INVALID_MANIFEST', 'dependencies must contain at most 16 exact local plugin versions.');
    const seen = new Set<string>();
    dependencies = manifest.dependencies.map(value => {
      const item = record(value, 'dependency');
      keys(item, ['id', 'version'], 'dependency');
      if (typeof item.id !== 'string' || !ID.test(item.id) || item.id === manifest.id || seen.has(item.id) || typeof item.version !== 'string' || !VERSION.test(item.version)) throw new PluginError('INVALID_MANIFEST', 'Dependency needs a unique plugin id and exact version.');
      seen.add(item.id);
      return { id: item.id, version: item.version };
    });
  }
  return { api: PLUGIN_API_VERSION, id: manifest.id, name: manifest.name, version: manifest.version, ...(manifest.description ? { description: manifest.description as string } : {}), permissions: ['text.transform'], ...(dependencies ? { dependencies } : {}), operations };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function pluginDigest(value: StoredPlugin): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function valueDigest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function loadJson(path: string, limit = 131072): unknown {
  if (lstatSync(path).isSymbolicLink()) throw new PluginError('UNSAFE_SOURCE', 'Plugin manifest may not be a symbolic link.');
  const raw = readFileSync(path, 'utf8');
  if (Buffer.byteLength(raw) > limit) throw new PluginError('INVALID_MANIFEST', 'Plugin JSON artifact exceeds its storage bound.');
  try { return JSON.parse(raw); } catch { throw new PluginError('INVALID_MANIFEST', 'Plugin manifest must be valid JSON.'); }
}
function parsePackage(value: unknown, sourceDir: string, configuration: Record<string, unknown>): StoredPlugin {
  const pkg = record(value, 'package');
  const dsh = record(pkg.dsh, 'package.dsh');
  if (dsh.permissions !== undefined) throw new PluginError('DENIED_PERMISSION', 'The DSH text adapter exposes no additional permissions.');
  keys(dsh, ['manifestVersion'], 'package.dsh');
  if (dsh.manifestVersion !== 1) throw new PluginError('UNSUPPORTED_API', 'Only DSH manifestVersion 1 metadata is supported.');
  const engines = record(pkg.engines, 'package.engines');
  if (engines.dsh !== DSH_COMPATIBLE_VERSION) throw new PluginError('UNSUPPORTED_VERSION', `DSH metadata adapter supports exact engines.dsh ${DSH_COMPATIBLE_VERSION}.`);
  if (typeof pkg.name !== 'string' || !pkg.name.trim() || typeof pkg.version !== 'string' || !VERSION.test(pkg.version)) throw new PluginError('INVALID_MANIFEST', 'DSH package name and concrete version are required.');
  if (pkg.npn === undefined) return parseRuntimePackage(pkg, sourceDir, configuration);
  for (const field of ['scripts', 'main', 'exports', 'bin']) if (pkg[field] !== undefined) throw new PluginError('UNSUPPORTED_API', `Executable DSH field ${field} is not supported.`);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) if (pkg[field] && Object.keys(record(pkg[field], field)).length) throw new PluginError('UNSUPPORTED_DEPENDENCY', 'npm and Cordis runtime dependencies are not installed by the NPN adapter.');
  const manifest = validateManifest(pkg.npn);
  if (manifest.version !== pkg.version) throw new PluginError('INVALID_MANIFEST', 'NPN bridge and DSH package versions must match.');
  return { adapter: 'dsh-manifest/1', manifest };
}
const DSH_MODULES: Record<string, string> = { '@deepseek-ai/dsh-tools': DSH_COMPATIBLE_VERSION, '@deepseek-ai/schemastery': '3.18.4', '@deepseek-ai/cordis': '4.0.4' };
function validateConfiguration(value: unknown): Record<string, unknown> {
  const configuration = record(value, 'configuration');
  const prototype = Object.getPrototypeOf(configuration);
  if ((prototype !== Object.prototype && prototype !== null) || Object.keys(configuration).length > 32 || Buffer.byteLength(canonical(configuration)) > 8192 || Object.entries(configuration).some(([key, item]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !['string', 'number', 'boolean'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item)))) throw new PluginError('INVALID_CONFIG', 'DSH configuration accepts at most 32 finite scalar values and 8 KiB.');
  return JSON.parse(JSON.stringify(configuration));
}
function validateDsh(value: unknown): DshArtifact {
  const dsh = record(value, 'DSH artifact');
  keys(dsh, ['packageName', 'main', 'source', 'configuration', 'dependencies'], 'DSH artifact');
  if (typeof dsh.packageName !== 'string' || !dsh.packageName.trim() || typeof dsh.main !== 'string' || typeof dsh.source !== 'string' || Buffer.byteLength(dsh.source) > 131072) throw new PluginError('INVALID_MANIFEST', 'DSH artifact needs a contained ESM entry of at most 128 KiB.');
  const dependencies = record(dsh.dependencies, 'DSH dependencies');
  for (const [name, version] of Object.entries(dependencies)) if (DSH_MODULES[name] !== version) throw new PluginError('UNSUPPORTED_DEPENDENCY', 'Only exact virtual DSH tools, Cordis and Schemastery versions are supported.');
  return { packageName: dsh.packageName, main: dsh.main, source: dsh.source, configuration: validateConfiguration(dsh.configuration), dependencies: dependencies as Record<string, string> };
}
function parseRuntimePackage(pkg: Record<string, unknown>, sourceDir: string, configuration: Record<string, unknown>): StoredPlugin {
  keys(pkg, ['name', 'version', 'description', 'private', 'type', 'main', 'engines', 'dsh', 'dependencies', 'peerDependencies', 'license'], 'DSH package');
  if (pkg.type !== 'module' || typeof pkg.main !== 'string' || !pkg.main.endsWith('.js') || isAbsolute(pkg.main)) throw new PluginError('UNSUPPORTED_API', 'DSH runtime packages require type module and one contained main .js entry.');
  const entry = resolve(sourceDir, pkg.main); const within = relative(sourceDir, entry);
  const entryInfo = lstatSync(entry);
  if (!within || within.startsWith('..') || isAbsolute(within) || !entryInfo.isFile() || entryInfo.isSymbolicLink() || relative(sourceDir, realpathSync(entry)).startsWith('..')) throw new PluginError('UNSAFE_SOURCE', 'DSH entry must remain inside its source package.');
  if (entryInfo.size > 131072) throw new PluginError('INVALID_MANIFEST', 'DSH source exceeds 128 KiB.');
  const dependencies: Record<string, string> = {};
  for (const field of ['dependencies', 'peerDependencies']) if (pkg[field] !== undefined) {
    for (const [name, version] of Object.entries(record(pkg[field], field))) {
      if (DSH_MODULES[name] !== version) throw new PluginError('UNSUPPORTED_DEPENDENCY', 'DSH runtime dependencies must name exact supported virtual API versions; nothing is installed.');
      dependencies[name] = version as string;
    }
  }
  const packageName = pkg.name as string;
  const id = ID.test(packageName) ? packageName : `dsh_${createHash('sha256').update(packageName).digest('hex').slice(0, 24)}`;
  const manifest = validateManifest({ api: PLUGIN_API_VERSION, id, name: packageName, version: pkg.version as string, ...(pkg.description !== undefined ? { description: pkg.description } : {}), permissions: ['text.transform'], operations: [] }, true);
  const dsh = validateDsh({ packageName, main: pkg.main, source: readFileSync(entry, 'utf8'), configuration, dependencies });
  return { adapter: 'dsh-runtime/1', manifest, dsh };
}
function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.pending`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

/** Native declarations are interpreted. Digest-approved DSH code runs only in separate workers. */
export class PluginManager {
  private readonly directory: string;
  private readonly indexPath: string;
  private records: PluginRecord[];
  private activation = new Map<string, number>();
  constructor(dataDir: string) {
    this.directory = join(resolve(dataDir), 'plugins');
    this.indexPath = join(this.directory, 'registry.json');
    mkdirSync(this.directory, { recursive: true });
    const index = existsSync(this.indexPath) ? loadJson(this.indexPath, 4_194_304) : [];
    if (!Array.isArray(index)) throw new PluginError('CORRUPT_REGISTRY', 'Plugin registry must be an array. Restore a known good data backup.');
    this.records = index as PluginRecord[];
    for (const item of this.records) if (!item || !ID.test(item.id) || !['native', 'dsh-manifest/1', 'dsh-runtime/1'].includes(item.adapter) || !/^[a-f0-9]{64}$/.test(item.digest) || typeof item.enabled !== 'boolean') throw new PluginError('CORRUPT_REGISTRY', 'Plugin registry record is invalid. Restore a known good data backup.');
  }
  private save(): void { atomicJson(this.indexPath, this.records); }
  private find(id: string): PluginRecord {
    const item = this.records.find(plugin => plugin.id === id);
    if (!item) throw new PluginError('NOT_INSTALLED', `Plugin ${id} is not installed.`);
    return item;
  }
  private current(item: PluginRecord): StoredPlugin {
    const stored = record(loadJson(join(this.directory, item.id, 'plugin.json'), item.adapter === 'dsh-runtime/1' ? 1_048_576 : 131072), 'stored plugin');
    if (stored.adapter !== item.adapter) throw new PluginError('ARTIFACT_CHANGED', 'Plugin adapter changed; remove and reinstall the reviewed artifact.');
    if (item.adapter === 'dsh-runtime/1') {
      const base = record(stored.manifest, 'DSH metadata');
      keys(base, ['api', 'id', 'name', 'version', 'description', 'permissions', 'operations'], 'DSH metadata');
      // Registration is discovered only after approval; its cached catalog is not executable authority.
      if (!Array.isArray(base.operations) || base.operations.length !== 0) throw new PluginError('INVALID_MANIFEST', 'Stored DSH catalog must be derived from approved apply, not a declaration override.');
      const validated = validateManifest(base, true);
      return { adapter: item.adapter, manifest: { ...validated, operations: [] }, dsh: validateDsh(stored.dsh) };
    }
    return { adapter: item.adapter, manifest: validateManifest(stored.manifest) };
  }
  private checked(item: PluginRecord): StoredPlugin {
    const stored = this.current(item);
    if (pluginDigest(stored) !== item.digest || item.approvedDigest !== item.digest) throw new PluginError('APPROVAL_REQUIRED', 'Plugin artifact needs digest-bound approval.');
    return stored;
  }
  list(): PluginView[] {
    return this.records.map(item => {
      const stored = this.current(item); const currentDigest = pluginDigest(stored);
      const runtime = stored.dsh ? { api: 'dsh-runtime/1' as const, packageName: stored.dsh.packageName, main: stored.dsh.main, sourceDigest: createHash('sha256').update(stored.dsh.source).digest('hex'), configDigest: valueDigest(stored.dsh.configuration), configuration: stored.dsh.configuration } : undefined;
      return { ...item, currentDigest, approvalValid: currentDigest === item.digest && item.approvedDigest === item.digest, ...(runtime ? { runtime } : {}) };
    });
  }
  install(sourceDir: string, configuration: Record<string, unknown> = {}): PluginView {
    const root = realpathSync(resolve(sourceDir));
    if (!isAbsolute(root)) throw new PluginError('UNSAFE_SOURCE', 'Plugin source must be an absolute local directory.');
    const nativePath = join(root, 'plugin.json');
    const stored: StoredPlugin = existsSync(nativePath) ? { adapter: 'native', manifest: validateManifest(loadJson(nativePath)) } : parsePackage(loadJson(join(root, 'package.json')), root, configuration);
    const digest = pluginDigest(stored);
    const existing = this.records.find(plugin => plugin.id === stored.manifest.id);
    if (existing) {
      if (existing.digest !== digest) throw new PluginError('ALREADY_INSTALLED', 'A different artifact has this id. Disable and remove it before installing the replacement.');
      return this.list().find(plugin => plugin.id === existing.id)!;
    }
    const destination = join(this.directory, stored.manifest.id);
    if (existsSync(destination)) throw new PluginError('ORPHAN_ARTIFACT', 'An unregistered plugin artifact already exists; review and restore its registry before installing.');
    mkdirSync(destination);
    atomicJson(join(destination, 'plugin.json'), stored);
    const item: PluginRecord = { id: stored.manifest.id, name: stored.manifest.name, version: stored.manifest.version, digest, adapter: stored.adapter, enabled: false, installedAt: new Date().toISOString(), manifest: stored.manifest };
    this.records.push(item);
    this.save();
    return this.list().find(plugin => plugin.id === item.id)!;
  }
  approve(id: string, digest: string): PluginView {
    const item = this.find(id);
    if (digest !== item.digest || pluginDigest(this.current(item)) !== digest) throw new PluginError('ARTIFACT_CHANGED', 'Approval digest must match the installed current artifact.');
    item.approvedDigest = digest;
    this.save();
    return this.list().find(plugin => plugin.id === id)!;
  }
  enable(id: string): PluginView | Promise<PluginView> {
    const item = this.find(id);
    const stored = this.checked(item);
    for (const dependency of stored.manifest.dependencies ?? []) {
      const target = this.find(dependency.id);
      if (target.version !== dependency.version || !target.enabled) throw new PluginError('DEPENDENCY_UNAVAILABLE', `Enable approved ${dependency.id}@${dependency.version} first.`);
      this.checked(target);
    }
    if (stored.dsh) return this.enableDsh(item, stored);
    item.enabled = true;
    this.save();
    return this.list().find(plugin => plugin.id === id)!;
  }
  private async enableDsh(item: PluginRecord, stored: StoredPlugin): Promise<PluginView> {
    const epoch = (this.activation.get(item.id) ?? 0) + 1; this.activation.set(item.id, epoch);
    const result = await runDsh(stored.dsh!, dirname(this.directory));
    if (this.activation.get(item.id) !== epoch) throw new PluginError('PLUGIN_DISABLED', 'DSH activation was cancelled by a lifecycle change.');
    this.checked(item);
    item.manifest = { ...stored.manifest, operations: result.catalog.map(tool => ({ id: tool.name, title: tool.description || tool.name, steps: [] })) };
    item.enabled = true; this.save(); return this.list().find(plugin => plugin.id === item.id)!;
  }
  configure(id: string, configuration: Record<string, unknown>): PluginView {
    const item = this.find(id);
    if (item.enabled) throw new PluginError('PLUGIN_ENABLED', 'Disable the plugin before changing configuration.');
    const stored = this.current(item);
    if (!stored.dsh) throw new PluginError('UNSUPPORTED_API', 'Only DSH runtime packages have Config values.');
    stored.dsh.configuration = validateConfiguration(configuration);
    this.activation.set(id, (this.activation.get(id) ?? 0) + 1);
    item.digest = pluginDigest(stored); delete item.approvedDigest; item.manifest = stored.manifest;
    atomicJson(join(this.directory, id, 'plugin.json'), stored); this.save();
    return this.list().find(plugin => plugin.id === id)!;
  }
  disable(id: string): PluginView {
    const item = this.find(id);
    const dependent = this.records.find(plugin => plugin.enabled && plugin.manifest.dependencies?.some(dependency => dependency.id === id));
    if (dependent) throw new PluginError('DEPENDENCY_IN_USE', `Disable dependent plugin ${dependent.id} first.`);
    this.activation.set(id, (this.activation.get(id) ?? 0) + 1);
    item.enabled = false;
    this.save();
    return this.list().find(plugin => plugin.id === id)!;
  }
  remove(id: string): void {
    const item = this.find(id);
    if (item.enabled) throw new PluginError('PLUGIN_ENABLED', 'Disable the plugin before removing it.');
    const dependent = this.records.find(plugin => plugin.manifest.dependencies?.some(dependency => dependency.id === id));
    if (dependent) throw new PluginError('DEPENDENCY_IN_USE', `Remove dependent plugin ${dependent.id} first.`);
    this.activation.set(id, (this.activation.get(id) ?? 0) + 1);
    const destination = resolve(this.directory, id);
    const within = relative(this.directory, destination);
    if (!within || within.startsWith(`..${sep}`) || isAbsolute(within) || dirname(destination) !== this.directory || lstatSync(destination).isSymbolicLink()) throw new PluginError('UNSAFE_ARTIFACT', 'Plugin removal target is not a contained artifact directory.');
    rmSync(destination, { recursive: true });
    this.records = this.records.filter(plugin => plugin.id !== id);
    this.save();
  }
  execute(id: string, operationId: string, input: string, signal?: AbortSignal): PluginResult | Promise<PluginResult> {
    const item = this.find(id);
    if (!item.enabled) throw new PluginError('PLUGIN_DISABLED', 'Enable the approved plugin first.');
    const stored = this.checked(item);
    for (const dependency of stored.manifest.dependencies ?? []) { const target = this.find(dependency.id); if (!target.enabled || target.version !== dependency.version) throw new PluginError('DEPENDENCY_UNAVAILABLE', 'An enabled dependency is unavailable.'); this.checked(target); }
    if (typeof input !== 'string' || Buffer.byteLength(input) > 1_048_576) throw new PluginError('INVALID_INPUT', 'Plugin input must be text of at most 1 MiB.');
    if (stored.dsh) return this.executeDsh(item, stored, operationId, input, signal);
    const operation = stored.manifest.operations.find(entry => entry.id === operationId);
    if (!operation) throw new PluginError('UNKNOWN_OPERATION', `Operation ${operationId} is unavailable.`);
    let output = input;
    for (const step of operation.steps) {
      if (step === 'trim') output = output.trim();
      else if (step === 'uppercase') output = output.toUpperCase();
      else if (step === 'lowercase') output = output.toLowerCase();
      else output = output.replace(/\r\n?/g, '\n');
    }
    if (Buffer.byteLength(output) > 1_048_576) throw new PluginError('OUTPUT_LIMIT', 'Plugin output exceeds 1 MiB.');
    return { output, digest: item.digest };
  }
  private async executeDsh(item: PluginRecord, stored: StoredPlugin, operationId: string, input: string, signal?: AbortSignal): Promise<PluginResult> {
    if (!item.manifest.operations.some(operation => operation.id === operationId)) throw new PluginError('UNKNOWN_OPERATION', 'The requested DSH tool is not in the approved registration catalog.');
    const digest = item.digest;
    const epoch = this.activation.get(item.id) ?? 0;
    const result = await runDsh(stored.dsh!, dirname(this.directory), { name: operationId, input }, signal);
    if (!item.enabled || item.digest !== digest || (this.activation.get(item.id) ?? 0) !== epoch) throw new PluginError('PLUGIN_DISABLED', 'Plugin approval or lifecycle changed during the call.');
    this.checked(item);
    return { output: result.output!, digest, renderedContent: result.renderedContent!, lifecycle: result.lifecycle };
  }
}
