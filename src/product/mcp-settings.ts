/**
 * MCP settings domain: persist stdio server configurations and start them only for the exact digest
 * an operator approved.
 *
 * Invariants:
 * - A save persists the configuration before any launch attempt, so a failed connection never loses
 *   it. No save ever reports "connected" on its own authority: only a real initialized process does.
 * - Only the caller-supplied approvedDigest, equal to mcpServerDigest of the current configuration,
 *   may spawn a process. Model output, older files and UI defaults are never treated as approval.
 * - An approval is bound to one exact digest: it survives unrelated saves and disabling, and any
 *   target or launch-artifact change voids it until the new digest is approved again.
 * - reconnect reuses only the persisted approval; it never approves a new digest by itself.
 * - Displayed targets and errors always pass through Configuration.redact so credentials stay out.
 */
import path from 'node:path';
import type { McpServerInput, McpServerView } from '../frontend/api/types.js';
import { mcpServerDigest, type McpServerConfig } from '../extensions/mcp-client.js';
import type { McpServerState } from '../app/external-tools.js';
import { ProductError, invalid, pickFields, requiredString, type ProductRuntime } from './shared.js';

/** root will add approvedDigest? to McpServerInput; the intersection keeps both sides compiling meanwhile. */
export type McpServerSaveInput = McpServerInput & { approvedDigest?: string };
/** root will add digest? to McpServerView; the intersection keeps both sides compiling meanwhile. */
export type McpServerSettingsView = McpServerView & { digest?: string };

const SERVER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_TARGET = 4096;
const MAX_ARGS = 64;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
/** Shell metacharacters are rejected even inside quotes: a command is never launched through a shell. */
const SHELL_SYNTAX = /[&|<>;`]/;
const NAME_LIMIT = 200;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Parse the editable target into exact argv tokens: whitespace separates, double quotes group and
 * nothing else is special. Because no escaping exists, a target can never smuggle shell syntax or an
 * argument a shell would split differently.
 */
export function parseMcpTarget(target: unknown): { command: string; args: string[] } {
  if (typeof target !== 'string' || !target.trim()) invalid('MCP target must contain a launch command.');
  if (target.length > MAX_TARGET) invalid(`MCP target must be at most ${MAX_TARGET} characters.`);
  if (CONTROL_CHARACTER.test(target)) invalid('MCP target contains a control character (for example NUL or a newline); remove it.');
  if (SHELL_SYNTAX.test(target) || target.includes('$(')) invalid('MCP target contains shell syntax (&, |, <, >, ;, a backtick or $(...)). The command is launched without a shell, so configure plain argv tokens instead.');
  const tokens: string[] = [];
  let token = ''; let quoted = false; let started = false;
  for (const character of target) {
    if (character === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(character)) { if (started) { tokens.push(token); token = ''; started = false; } continue; }
    token += character; started = true;
  }
  if (quoted) invalid('MCP target has an unterminated double-quoted argument; close the quote or remove it.');
  if (started) tokens.push(token);
  const [command, ...args] = tokens;
  if (!command) invalid('MCP target must start with the launch command.');
  if (args.length > MAX_ARGS) invalid(`MCP target may pass at most ${MAX_ARGS} arguments.`);
  return { command, args };
}

/** Serialize exact argv back into the single editable target, quoting only the tokens that need it. */
export function formatMcpTarget(config: Pick<McpServerConfig, 'command' | 'args'>): string {
  // Parsed arguments cannot contain a double quote, so quoting never needs escaping here.
  return [config.command, ...config.args].map(token => token === '' || /[\s"]/.test(token) ? `"${token}"` : token).join(' ');
}

export class ProductMcpSettings {
  constructor(private readonly rt: ProductRuntime) {}

  /** Persisted order; a record is only connected when a real process is currently initialized. */
  list(): McpServerSettingsView[] {
    return this.rt.services.external.mcpServerStates().map(record => this.view(record));
  }
  async catalog(id: string, offset = 0) {
    this.record(id);
    await this.rt.services.external.refreshMcpCatalog(id);
    return this.rt.services.configuration.sanitize(this.rt.services.external.chatMcpCatalog(id, offset));
  }

  async save(input: McpServerSaveInput): Promise<McpServerSettingsView> {
    const value = pickFields(input, ['id', 'name', 'transport', 'target', 'enabled', 'approvedDigest'], 'MCP server');
    const transport = value.transport;
    if (typeof transport !== 'string') invalid('MCP transport must be stdio.');
    if (transport === 'http' || transport === 'sse') throw new ProductError('unsupported', 'Only stdio transport is supported in this build; configure a stdio command.', 501);
    if (transport !== 'stdio') invalid('MCP transport must be stdio.');
    const name = requiredString(value.name, 'MCP server name', NAME_LIMIT);
    if (typeof value.enabled !== 'boolean') invalid('MCP server enabled must be a boolean.');
    const enabled = value.enabled;
    const requestedApproval = value.approvedDigest === undefined ? undefined : this.approval(value.approvedDigest);
    const parsed = parseMcpTarget(value.target);
    const id = value.id === undefined ? this.freeServerId(name) : this.serverId(value.id);
    const config: McpServerConfig = { id, name, command: parsed.command, args: parsed.args, cwd: path.dirname(parsed.command) };
    const digest = this.digestOf(config);
    const existing = this.rt.services.external.mcpServerStates().find(item => item.config.id === id);
    const approval = requestedApproval === digest ? digest : existing?.digest === digest ? existing.approvedDigest : undefined;
    await this.rt.services.external.saveMcpServer({ config, digest, enabled, ...(approval ? { approvedDigest: approval } : {}) });
    if (!enabled) return this.view(this.state(id));
    if (requestedApproval === undefined) return this.view(this.state(id), `The server was saved but not started: launching it requires explicit operator approval of the current digest ${digest}. Save it again with approvedDigest ${digest} to approve this exact configuration.`);
    if (requestedApproval !== digest) return this.view(this.state(id), `The server was not started: the supplied approval does not match the current digest ${digest}. Review the target and approve this exact digest.`);
    return this.launch(id, digest);
  }

  async remove(id: string): Promise<void> {
    await this.rt.services.external.removeMcpServer(this.record(id).config.id);
  }

  /** Restart a disabled-free server with its recorded approval; a changed artifact needs a new approval. */
  async reconnect(id: string): Promise<McpServerSettingsView> {
    const record = this.record(id);
    if (!record.enabled) throw new ProductError('conflict', `MCP server ${record.config.id} is disabled; enable it before reconnecting.`, 409);
    const current = this.currentDigest(record);
    if (current.digest === undefined) return this.view(this.state(record.config.id));
    const digest = current.digest;
    if (record.approvedDigest !== digest) {
      await this.fail(record, record.approvedDigest
        ? `Reconnect requires a new approval: the launch command or its files changed, so the recorded approval no longer matches the current digest ${digest}. Save the server with approvedDigest ${digest} to approve the new artifact.`
        : `Reconnect requires approval: this server has no recorded digest approval. Save it with approvedDigest ${digest} to approve the current configuration.`);
      return this.view(this.state(record.config.id));
    }
    if (record.status === 'connected') await this.rt.services.external.disconnect(record.config.id);
    return this.launch(record.config.id, digest);
  }

  /** Launch only after the digest gate passed; failures stay in the saved record as a redacted error. */
  private async launch(id: string, digest: string): Promise<McpServerSettingsView> {
    const record = this.state(id);
    try { await this.rt.services.external.connect({ ...record.config, approvedDigest: digest }); }
    catch (error) { await this.fail(record, `Connection failed: ${message(error)}`); }
    return this.view(this.state(id));
  }

  private view(record: McpServerState, surface?: string): McpServerSettingsView {
    const current = this.currentDigest(record);
    const connected = record.status === 'connected';
    const approvalHint = !connected && record.enabled && current.digest !== undefined && record.approvedDigest !== current.digest
      ? `This server is not running: launching it requires explicit operator approval of the current digest ${current.digest}. Save it with approvedDigest ${current.digest} to approve this exact configuration.`
      : undefined;
    const error = surface ?? current.error ?? (connected ? undefined : record.lastError ?? (record.enabled ? approvalHint : undefined));
    const status: McpServerSettingsView['status'] = connected ? 'connected' : current.error || record.lastError ? 'error' : 'disconnected';
    return {
      id: record.config.id,
      name: record.config.name,
      transport: 'stdio',
      status,
      tools: connected ? record.tools : 0,
      ...(error ? { error: this.redact(error) } : {}),
      target: this.redact(formatMcpTarget(record.config)),
      enabled: record.enabled,
      ...(current.digest ? { digest: current.digest } : {}),
    };
  }

  /** Recompute the launch digest for the live artifacts; a missing or changed artifact is reported. */
  private currentDigest(record: McpServerState): { digest?: string; error?: string } {
    try { return { digest: mcpServerDigest(record.config, this.rt.services.projectRoot) }; }
    catch (error) { return { error: `MCP launch artifacts are unavailable: ${message(error)}` }; }
  }

  /** Validate the configuration through the exact canonical digest the client will later approve. */
  private digestOf(config: McpServerConfig): string {
    try { return mcpServerDigest(config, this.rt.services.projectRoot); }
    catch (error) { throw new ProductError('validation', this.redact(`MCP target is not launchable: ${message(error)}`), 400); }
  }

  /** Record the redacted failure so list keeps reporting it until a later launch succeeds. */
  private async fail(record: McpServerState, failure: string): Promise<void> {
    await this.rt.services.external.saveMcpServer({
      config: record.config, digest: record.digest, enabled: record.enabled,
      ...(record.approvedDigest ? { approvedDigest: record.approvedDigest } : {}),
      lastError: this.redact(failure),
    });
  }

  private state(id: string): McpServerState {
    const record = this.rt.services.external.mcpServerStates().find(item => item.config.id === id);
    if (!record) throw new ProductError('internal', `MCP server ${id} is no longer configured.`, 500);
    return record;
  }

  private record(id: unknown): McpServerState {
    const value = requiredString(id, 'MCP server id', 64);
    const record = this.rt.services.external.mcpServerStates().find(item => item.config.id === value);
    if (!record) throw new ProductError('not_found', `MCP server ${value} is not configured.`, 404);
    return record;
  }

  private serverId(value: unknown): string {
    if (typeof value !== 'string' || !SERVER_ID.test(value)) invalid('MCP server id must be a lowercase letter followed by lowercase letters, digits, underscores or dashes (at most 64 characters).');
    return value;
  }

  private approval(value: unknown): string {
    if (typeof value !== 'string' || !DIGEST.test(value)) invalid('approvedDigest must be the 64-character lowercase hexadecimal digest of the exact launch configuration (as shown by a save without approval).');
    return value;
  }

  /** Derive a stable, unique id from the display name when a new server is created. */
  private freeServerId(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'server';
    const base = /^[a-z]/.test(slug) ? slug : `mcp-${slug}`.slice(0, 64);
    const taken = new Set(this.rt.services.external.mcpServerStates().map(item => item.config.id));
    if (!taken.has(base)) return base;
    for (let suffix = 2; suffix <= 99; suffix += 1) {
      const candidate = `${base.slice(0, 64 - String(suffix).length - 1)}-${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
    return invalid('MCP server id is unavailable; rename the server.');
  }

  /** Every user-visible string passes this boundary so credentials never reach the view. */
  private redact(text: string): string { return this.rt.services.configuration.redact(text); }
}
