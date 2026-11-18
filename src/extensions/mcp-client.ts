import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { MCP_PROTOCOL_VERSION } from './mcp.js';
import { isLocalPath } from '../app/local-paths.js';

export interface McpServerConfig { id: string; name: string; command: string; args: string[]; cwd: string; }
export interface McpDiagnostic { serverId: string; kind: 'lifecycle' | 'stderr' | 'protocol'; message: string; }
export interface McpClientOptions { dataDir: string; approvedDigest: string; projectRoot?: string; timeoutMs?: number; onDiagnostic?: (event: McpDiagnostic) => void; }
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; }
export interface McpToolResult { content: { type: string; [key: string]: unknown }[]; structuredContent?: Record<string, unknown>; isError?: boolean; }
export interface McpCallOptions { signal?: AbortSignal; timeoutMs?: number; onRequest?: (requestId: number) => void; }
export class McpClientError extends Error {
  constructor(readonly kind: 'approval' | 'configuration' | 'protocol' | 'transport' | 'server' | 'cancelled' | 'timeout', message: string, readonly effect: 'none' | 'unknown', readonly serverId: string, readonly requestId?: number) { super(message); this.name = 'McpClientError'; }
}
interface Pending { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void; }
function insideProject(path: string, label: string, projectRoot: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path inside the project.`);
  const absolute = resolve(path);
  const relation = relative(projectRoot, absolute);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation) || !isLocalPath(absolute)) throw new Error(`${label} must stay inside ${projectRoot}.`);
  return absolute;
}
function artifactSha256(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd), size = stat.isFile() ? stat.size : 0;
    // Match readFileSync's size ceiling and initial extent. A zero-size report reads to EOF.
    if (size > 2 ** 31 - 1) throw Object.assign(new RangeError(`File size (${size}) is greater than 2 GiB`), { code: 'ERR_FS_FILE_TOO_LARGE' });
    let remaining = size || Infinity;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining)), hash = createHash('sha256');
    while (remaining > 0) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      remaining -= count;
    }
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
function canonicalConfig(config: McpServerConfig, projectRoot: string): { config: McpServerConfig; files: { path: string; sha256?: string; kind?: 'directory' }[] } {
  if (!config || !/^[a-z][a-z0-9_-]{0,63}$/.test(config.id) || typeof config.name !== 'string' || !config.name.trim() || !Array.isArray(config.args) || config.args.length > 64 || config.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192)) throw new Error('MCP server configuration is invalid.');
  const command = insideProject(config.command, 'command', projectRoot);
  const cwd = insideProject(config.cwd, 'cwd', projectRoot);
  if (!lstatSync(command).isFile() || lstatSync(command).isSymbolicLink() || realpathSync(command) !== command) throw new Error('MCP command must be a regular project-local executable.');
  if (!lstatSync(cwd).isDirectory() || realpathSync(cwd) !== cwd) throw new Error('MCP cwd must be a regular project-local directory.');
  const files: { path: string; sha256?: string; kind?: 'directory' }[] = [{ path: command, sha256: artifactSha256(command) }];
  const addLocalArgument = (path: string) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || realpathSync(path) !== path) throw new Error('MCP path arguments must resolve directly inside the project.');
    if (info.isFile()) files.push({ path, sha256: artifactSha256(path) });
    else if (info.isDirectory()) files.push({ path, kind: 'directory' });
    else throw new Error('MCP path arguments must be regular project-local files or directories.');
  };
  for (const arg of config.args) {
    if (/^[a-zA-Z]:[\\/]/.test(arg) || arg.startsWith('\\\\')) {
      const path = insideProject(arg, 'argument path', projectRoot);
      if (existsSync(path)) {
        addLocalArgument(path);
      }
    } else if (arg.startsWith('../') || arg.startsWith('..\\')) throw new Error('MCP arguments may not traverse out of cwd. Use approved absolute project paths.');
    else if (!arg.startsWith('-') && existsSync(resolve(cwd, arg))) {
      const path = insideProject(resolve(cwd, arg), 'argument file', projectRoot);
      addLocalArgument(path);
    }
  }
  return { config: { id: config.id, name: config.name, command, args: [...config.args], cwd }, files };
}
/** Approval covers the exact launch configuration and current local launch artifacts. */
export function mcpServerDigest(config: McpServerConfig, projectRoot = resolve('.')): string {
  return createHash('sha256').update(JSON.stringify(canonicalConfig(config, resolve(projectRoot)))).digest('hex');
}

/** Consumes an explicitly configured, user-approved MCP stdio server. Never retries a tool call. */
export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private ready = false;
  private connected = false;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private currentTools: McpTool[] = [];
  private catalogRevision = 0;
  private loadedCatalogRevision = -1;
  get toolsCurrent(): boolean { return this.ready && this.catalogRevision === this.loadedCatalogRevision; }
  constructor(readonly config: McpServerConfig, private readonly options: McpClientOptions) {}
  private diagnostic(kind: McpDiagnostic['kind'], message: string): void { this.options.onDiagnostic?.({ serverId: this.config.id, kind, message }); }
  private failAll(kind: McpClientError['kind'], message: string): void {
    this.ready = false;
    this.connected = false;
    for (const [id, item] of this.pending) { clearTimeout(item.timer); item.cleanup(); item.reject(new McpClientError(kind, message, item.method === 'tools/call' ? 'unknown' : 'none', this.config.id, id)); }
    this.pending.clear();
  }
  private notify(method: string, params?: unknown): void {
    if (this.child && this.connected) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }
  private malformed(message: string): void {
    this.diagnostic('protocol', message);
    this.failAll('protocol', message);
    this.child?.kill();
  }
  private receive(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim() || Buffer.byteLength(line) > 1_048_576) { this.malformed('MCP stdout contains an empty or oversized protocol message.'); return; }
      let value: unknown;
      try { value = JSON.parse(line); } catch { this.malformed('MCP stdout contains non-JSON text; stdout must contain protocol messages only.'); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { this.malformed('MCP stdout contains an invalid JSON-RPC message.'); return; }
      const message = value as Record<string, unknown>;
      if (message.jsonrpc !== '2.0') { this.malformed('MCP response jsonrpc must be 2.0.'); return; }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'NPN client does not implement server-initiated sampling, roots or elicitation.' } }) })}\n`);
        } else if (message.method === 'notifications/tools/list_changed') {
          this.catalogRevision++;
          this.diagnostic('lifecycle', 'Server tool list changed; refresh before selecting tools.');
        }
        continue;
      }
      if (typeof message.id !== 'number' || !Number.isInteger(message.id) || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) { this.malformed('MCP response needs a request ID and exactly one result or error.'); return; }
      const item = this.pending.get(message.id);
      if (!item) { this.diagnostic('protocol', 'Ignored a response to a completed or cancelled MCP request.'); continue; }
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      item.cleanup();
      if (message.error !== undefined) {
        const error = message.error as { code?: unknown; message?: unknown };
        if (!error || typeof error.code !== 'number' || typeof error.message !== 'string') { item.reject(new McpClientError('protocol', 'MCP server returned an invalid error.', item.method === 'tools/call' ? 'unknown' : 'none', this.config.id, message.id)); this.malformed('MCP server returned an invalid error.'); return; }
        item.reject(new McpClientError('server', `MCP server rejected ${item.method} (code ${error.code}).`, item.method === 'tools/call' ? 'unknown' : 'none', this.config.id, message.id));
      } else item.resolve(message.result);
    }
    if (Buffer.byteLength(this.buffer) > 1_048_576) this.malformed('MCP stdout message exceeds 1 MiB.');
  }
  private request(method: string, params?: unknown, options: McpCallOptions = {}): Promise<unknown> {
    if (!this.child || !this.connected) return Promise.reject(new McpClientError('transport', 'MCP server is disconnected.', 'none', this.config.id));
    if (options.signal?.aborted) return Promise.reject(new McpClientError('cancelled', 'MCP request cancelled before dispatch.', 'none', this.config.id));
    const id = ++this.nextId;
    return new Promise((resolveRequest, rejectRequest) => {
      const abort = () => this.cancel(id);
      const timer = setTimeout(() => {
        const item = this.pending.get(id);
        if (!item) return;
        this.notify('notifications/cancelled', { requestId: id, reason: 'NPN request deadline exceeded' });
        this.pending.delete(id);
        item.cleanup();
        rejectRequest(new McpClientError('timeout', `MCP ${method} timed out. Query or reconcile external effects before retrying.`, method === 'tools/call' ? 'unknown' : 'none', this.config.id, id));
      }, options.timeoutMs ?? this.options.timeoutMs ?? 15_000);
      this.pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timer, cleanup: () => options.signal?.removeEventListener('abort', abort) });
      options.signal?.addEventListener('abort', abort, { once: true });
      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`, error => { if (error) this.failAll('transport', 'MCP stdin failed; external tool effects may be unknown.'); });
      options.onRequest?.(id);
    });
  }
  async connect(): Promise<{ serverInfo: Record<string, unknown>; tools: McpTool[] }> {
    if (this.connected || this.child) throw new McpClientError('transport', 'MCP client is already connected. Disconnect before reconnecting.', 'none', this.config.id);
    let prepared: ReturnType<typeof canonicalConfig>;
    const projectRoot = resolve(this.options.projectRoot ?? '.');
    try { prepared = canonicalConfig(this.config, projectRoot); } catch (error) { throw new McpClientError('configuration', error instanceof Error ? error.message : 'Invalid MCP config.', 'none', this.config.id); }
    const digest = createHash('sha256').update(JSON.stringify(prepared)).digest('hex');
    if (digest !== this.options.approvedDigest) throw new McpClientError('approval', 'MCP launch artifact or configuration changed; explicit approval of the current digest is required.', 'none', this.config.id);
    const runtimeDir = insideProject(resolve(this.options.dataDir, 'mcp-runtime', this.config.id), 'MCP runtime directory', projectRoot);
    const cacheDir = join(runtimeDir, 'cache');
    const temporaryDir = join(runtimeDir, 'tmp');
    const homeDir = join(runtimeDir, 'home');
    for (const path of [cacheDir, temporaryDir, homeDir]) mkdirSync(path, { recursive: true });
    this.decoder = new StringDecoder('utf8'); this.buffer = '';
    try {
      this.child = spawn(prepared.config.command, prepared.config.args, { cwd: prepared.config.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
        SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        PATH: dirname(prepared.config.command), TEMP: temporaryDir, TMP: temporaryDir,
        HOME: homeDir, USERPROFILE: homeDir, APPDATA: join(homeDir, 'appdata'), LOCALAPPDATA: join(homeDir, 'localappdata'),
        XDG_CACHE_HOME: cacheDir, npm_config_cache: join(cacheDir, 'npm'), PYTHONDONTWRITEBYTECODE: '1',
      } });
    } catch {
      throw new McpClientError('transport', 'MCP server launch was blocked. Check the local executable and process permissions.', 'none', this.config.id);
    }
    this.connected = true;
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => this.diagnostic('stderr', `Server wrote ${chunk.length} bytes to stderr. Raw child output is not logged.`));
    this.child.stdin.on('error', () => this.failAll('transport', 'MCP stdin closed; external tool effects may be unknown.'));
    this.child.once('error', () => this.failAll('transport', 'MCP server launch failed. Check the configured local executable.'));
    this.child.once('close', (code, signal) => { this.failAll('transport', `MCP server disconnected (exit ${code ?? 'unknown'}, signal ${signal ?? 'none'}). Tool effects require reconciliation.`); this.child = undefined; this.diagnostic('lifecycle', 'MCP server disconnected.'); });
    try {
      const init = await this.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'npn-gamma', version: '0.1.0' } }) as Record<string, unknown>;
      if (!init || init.protocolVersion !== MCP_PROTOCOL_VERSION || !init.serverInfo || typeof init.serverInfo !== 'object' || !init.capabilities || typeof init.capabilities !== 'object') throw new McpClientError('protocol', `MCP server must negotiate protocol ${MCP_PROTOCOL_VERSION}.`, 'none', this.config.id);
      this.notify('notifications/initialized');
      this.ready = true;
      const tools = await this.listTools();
      this.diagnostic('lifecycle', `Connected with ${tools.length} tools.`);
      return { serverInfo: init.serverInfo as Record<string, unknown>, tools };
    } catch (error) { await this.disconnect(); throw error; }
  }
  async listTools(options: { signal?: AbortSignal } = {}): Promise<McpTool[]> {
    if (!this.ready) throw new McpClientError('protocol', 'Initialize the MCP server before listing tools.', 'none', this.config.id);
    const tools: McpTool[] = [];
    const revision = this.catalogRevision;
    let catalogBytes = 0;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, options) as { tools?: unknown; nextCursor?: unknown };
      if (!result || !Array.isArray(result.tools) || result.tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.inputSchema || typeof tool.inputSchema !== 'object') || (result.nextCursor !== undefined && typeof result.nextCursor !== 'string')) throw new McpClientError('protocol', 'MCP tools/list returned an invalid tool catalog.', 'none', this.config.id);
      tools.push(...result.tools as McpTool[]);
      catalogBytes += Buffer.byteLength(JSON.stringify(result.tools));
      if (catalogBytes > 8 * 1024 * 1024) throw new McpClientError('protocol', 'MCP tool catalog exceeds 8 MiB.', 'none', this.config.id);
      cursor = result.nextCursor as string | undefined;
      if (cursor && cursors.has(cursor)) throw new McpClientError('protocol', 'MCP tool pagination repeated a cursor.', 'none', this.config.id);
      if (cursor) cursors.add(cursor);
      if (tools.length > 1000 || cursors.size > 100) throw new McpClientError('protocol', 'MCP tool catalog exceeds the supported limit.', 'none', this.config.id);
    } while (cursor);
    this.currentTools = tools;
    this.loadedCatalogRevision = revision;
    return tools;
  }
  async callTool(name: string, args: Record<string, unknown>, options: McpCallOptions = {}): Promise<McpToolResult> {
    if (!this.ready || !this.currentTools.some(tool => tool.name === name)) throw new McpClientError('protocol', 'Select a tool from the initialized server catalog.', 'none', this.config.id);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new McpClientError('configuration', 'MCP tool arguments must be an object.', 'none', this.config.id);
    const result = await this.request('tools/call', { name, arguments: args }, options) as McpToolResult;
    if (!result || !Array.isArray(result.content) || result.content.some(item => !item || typeof item.type !== 'string')) throw new McpClientError('protocol', 'MCP tools/call returned an invalid result; reconcile any external effects.', 'unknown', this.config.id);
    return result;
  }
  cancel(requestId?: number): void {
    for (const [id, item] of this.pending) {
      if (requestId !== undefined && id !== requestId) continue;
      this.notify('notifications/cancelled', { requestId: id, reason: 'NPN user cancellation' });
      clearTimeout(item.timer); item.cleanup(); this.pending.delete(id);
      item.reject(new McpClientError('cancelled', 'MCP request cancelled. A dispatched tool effect remains unknown until reconciled.', item.method === 'tools/call' ? 'unknown' : 'none', this.config.id, id));
    }
  }
  async disconnect(): Promise<void> {
    const child = this.child;
    this.cancel();
    this.ready = false;
    this.connected = false;
    if (!child) return;
    const closed = new Promise<void>(resolveClose => { child.once('close', () => resolveClose()); });
    child.stdin.end();
    child.kill();
    await closed;
  }
}
