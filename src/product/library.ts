import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { Page, RequestRecordView } from '../frontend/api/types.js';
import type { ConversationExportPage, LibraryKind, LibraryPreset, LibraryScope, PromptVersion, SessionSettingsView } from '../frontend/api/library-types.js';
import type { ChatSession, Preset } from '../harness/types.js';
import { promptSettings } from '../harness/prompts.js';
import { ModelClient, validateRequestBody } from '../runtime/model.js';
import { ProductError, boundedInteger, busy, invalid, notFound, pickFields, requiredString, type ProductRuntime } from './shared.js';

const PAGE_CHARS = 256_000;
const SECRET_FIELD = /(?:api[_-]?key|authorization|secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer|private[_-]?key|password|passwd|credential|token$|^auth$|^headers$|^cookies?$|^base[_-]?url$)/i;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CAPABILITIES = ['web', 'tools', 'mcp', 'skills', 'projectInstructions'] as const;
const PROMPT_FIELDS = ['systemPrompt', 'developerPrompt', 'dynamic'] as const;
interface Target { id: string; kind: 'chat' | 'work'; workspace?: string; profileId: string; session: unknown; chat?: ChatSession }
interface Cursor { kind: string; sessionId: string; scope?: string; scopeId?: string; id?: string; before?: number }
interface ExportCursor extends Cursor {
  snapshot: string; messagesThrough: number; messagesCount: number; requestsThrough: number; requestsCount: number;
  section: 'messages' | 'requests'; after: number; offset: number; hash?: string;
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Match Inspector's bounded DTO redaction path reporting on the sanitized body. */
function redactionPaths(value: unknown, prefix = '$'): string[] {
  const paths: string[] = [];
  const visit = (item: unknown, path: string): void => {
    if (paths.length >= 50) return;
    if (typeof item === 'string') { if (item.includes('[credential redacted]')) paths.push(path); return; }
    if (Array.isArray(item)) { item.slice(0, 200).forEach((child, index) => visit(child, `${path}[${index}]`)); return; }
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item as Record<string, unknown>).slice(0, 200)) visit(child, `${path}.${key}`);
  };
  visit(value, prefix);
  return paths;
}

/** Only JSON inputs cross this boundary. Unknown ordinary provider parameters are preserved. */
function safeInput(value: unknown, depth = 0): void {
  if (depth > 40) invalid('JSON nesting exceeds 40 levels.');
  if (Array.isArray(value)) { for (const item of value) safeInput(item, depth + 1); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || SECRET_FIELD.test(key)) invalid('Credentials, secret-like fields and transport settings cannot be imported.');
    safeInput(item, depth + 1);
  }
}

/** Product library is storage and validation only; no method dispatches a model or tool. */
export class ProductLibrary {
  private readonly cursorKey: string;
  constructor(private readonly rt: ProductRuntime) {
    this.cursorKey = rt.harness.store.getSetting<string>('libraryCursorKey', '') || randomBytes(32).toString('hex');
    rt.harness.store.setSetting('libraryCursorKey', this.cursorKey);
  }
  private clean<T>(value: T): T {
    const sanitized = this.rt.harness.sanitize(value);
    return JSON.parse(JSON.stringify(sanitized, (key, item) => SECRET_FIELD.test(key) ? '[credential redacted]' : item)) as T;
  }
  private target(value: unknown): Target {
    const id = requiredString(value, 'sessionId');
    if (id.startsWith('chat-')) {
      let chat: ChatSession;
      try { chat = this.rt.harness.store.getSession(id); } catch { return notFound('Conversation not found.'); }
      return { id, kind: 'chat', workspace: chat.workspace, profileId: chat.profileId, session: chat, chat };
    }
    const task = this.rt.services.kernel.getTask(id);
    if (!task) return notFound('Conversation not found.');
    return { id, kind: 'work', workspace: task.workspace, profileId: this.rt.harness.requests.profileId({ taskId: id }), session: task };
  }
  private scope(target: Target, value: unknown): { scope: LibraryScope; scopeId: string } {
    if (value !== 'global' && value !== 'project' && value !== 'session') invalid('scope must be global, project or session.');
    if (value === 'project') {
      const projectId = this.rt.store.getSession(target.id)?.projectId;
      const registered = projectId ? this.rt.resolveProject?.(projectId) : undefined;
      if (!registered || !target.workspace || path.relative(path.resolve(registered), path.resolve(target.workspace)) !== '')
        invalid('Select a registered project for this conversation before using project scope.');
    }
    return { scope: value, scopeId: value === 'global' ? '' : value === 'session' ? target.id : target.workspace! };
  }
  private kind(value: unknown): LibraryKind {
    if (value !== 'prompt' && value !== 'request') invalid('kind must be prompt or request.');
    return value;
  }
  private limit(query: Record<string, unknown>, maximum = 20): number {
    return query.limit === undefined ? Math.min(10, maximum) : boundedInteger(Number(query.limit), 'limit', 1, maximum);
  }
  private encode(value: Cursor): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return payload + '.' + createHmac('sha256', this.cursorKey).update(payload).digest('base64url');
  }
  private decode<T extends Cursor>(value: unknown, expected: Cursor): T | undefined {
    if (value === undefined) return undefined;
    const text = requiredString(value, 'cursor', 4096), [payload, signature, extra] = text.split('.');
    if (!payload || !signature || extra) invalid('Invalid library cursor.');
    const expectedSignature = createHmac('sha256', this.cursorKey).update(payload).digest('base64url');
    if (signature.length !== expectedSignature.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) invalid('Invalid library cursor.');
    let parsed: T;
    try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as T; } catch { return invalid('Invalid library cursor.'); }
    for (const [key, item] of Object.entries(expected)) if ((parsed as unknown as Record<string, unknown>)[key] !== item) invalid('Cursor belongs to a different conversation or scope.');
    return parsed;
  }
  private editable(target: Target): ChatSession {
    if (!target.chat) throw new ProductError('unsupported', 'Session parameter and capability controls currently apply to Chat. Work uses its task permission controls.');
    if (this.rt.harness.chat.busy(target.id) || this.rt.harness.chat.pendingToolCalls(target.id).length) busy('Wait for the active request and pending tool results before changing settings.');
    return target.chat;
  }
  private assertPresetScope(target: Target, preset: Preset | undefined): LibraryPreset {
    if (!preset || (preset.kind !== 'prompt' && preset.kind !== 'request')) return notFound('Preset not found in this scope.');
    const scope = this.scope(target, preset.scope);
    if (preset.scopeId !== scope.scopeId) return notFound('Preset not found in this scope.');
    return this.clean(preset as LibraryPreset);
  }
  presets(input: Record<string, unknown>): Page<LibraryPreset> {
    const query = pickFields(input, ['sessionId', 'kind', 'scope', 'cursor', 'limit']);
    const target = this.target(query.sessionId), kind = this.kind(query.kind), scope = this.scope(target, query.scope);
    const identity = { kind: 'presets:' + kind, sessionId: target.id, ...scope };
    const cursor = this.decode(query.cursor, identity);
    const page = this.rt.harness.store.presetPage({ kind, ...scope, before: cursor?.before ?? Number.MAX_SAFE_INTEGER, limit: this.limit(query) });
    return { items: this.clean(page.items as LibraryPreset[]), ...(page.next === null ? {} : { nextCursor: this.encode({ ...identity, before: page.next }) }) };
  }
  preset(input: Record<string, unknown>): LibraryPreset {
    const query = pickFields(input, ['sessionId', 'id', 'version']);
    const target = this.target(query.sessionId), id = requiredString(query.id, 'id');
    const version = query.version === undefined ? undefined : boundedInteger(Number(query.version), 'version', 1, Number.MAX_SAFE_INTEGER);
    return this.assertPresetScope(target, this.rt.harness.store.getPreset(id, version));
  }
  presetVersions(input: Record<string, unknown>): Page<LibraryPreset> {
    const query = pickFields(input, ['sessionId', 'id', 'cursor', 'limit']);
    const target = this.target(query.sessionId), id = requiredString(query.id, 'id');
    const preset = this.assertPresetScope(target, this.rt.harness.store.getPreset(id));
    const identity = { kind: 'preset-versions', sessionId: target.id, id, scope: preset.scope, scopeId: preset.scopeId };
    const cursor = this.decode(query.cursor, identity);
    const page = this.rt.harness.store.presetPage({ kind: preset.kind, scope: preset.scope, scopeId: preset.scopeId, id, before: cursor?.before ?? Number.MAX_SAFE_INTEGER, limit: this.limit(query) });
    return { items: this.clean(page.items as LibraryPreset[]), ...(page.next === null ? {} : { nextCursor: this.encode({ ...identity, before: page.next }) }) };
  }
  savePreset(input: Record<string, unknown>): LibraryPreset {
    const value = pickFields(input, ['sessionId', 'id', 'name', 'kind', 'scope', 'value', 'expectedVersion', 'sourceRequestId']);
    const target = this.target(value.sessionId), kind = this.kind(value.kind), scope = this.scope(target, value.scope);
    const name = requiredString(value.name, 'name', 100);
    const id = value.id === undefined ? undefined : requiredString(value.id, 'id');
    const expectedVersion = value.expectedVersion === undefined ? undefined : boundedInteger(value.expectedVersion, 'expectedVersion', 0, Number.MAX_SAFE_INTEGER);
    let body: Record<string, unknown>;
    if (kind === 'request') body = this.validateRequest(target.id, value.value, value.sourceRequestId).body;
    else {
      body = pickFields(value.value, PROMPT_FIELDS, 'Prompt preset'); safeInput(body);
      if (!Object.keys(body).length) invalid('Prompt preset must contain at least one prompt field.');
      for (const field of PROMPT_FIELDS) if (body[field] !== undefined && (typeof body[field] !== 'string' || (body[field] as string).length > 64_000)) invalid('Prompt fields must be text of at most 64000 characters.');
      if (body.developerPrompt && !this.rt.harness.profiles.get(target.profileId).provider.supportsDeveloper) invalid('This model profile does not support developer messages.');
    }
    return this.rt.harness.store.transaction(() => {
      const previous = id ? this.rt.harness.store.getPreset(id) : undefined;
      if (id && !previous) notFound('Preset not found.');
      if (previous && (previous.kind !== kind || previous.scope !== scope.scope || previous.scopeId !== scope.scopeId)) invalid('A preset cannot change its kind or scope. Save a new preset instead.');
      if (expectedVersion !== undefined && expectedVersion !== (previous?.version ?? 0)) throw new ProductError('conflict', 'Preset version changed. Reload before saving.', 409);
      return this.clean(this.rt.harness.store.savePreset({ ...(id ? { id } : {}), name, kind, ...scope, value: this.clean(body) }) as LibraryPreset);
    });
  }
  promptVersions(sessionId: unknown, input: Record<string, unknown>): Page<PromptVersion> {
    const query = pickFields(input, ['scope', 'cursor', 'limit']), target = this.target(sessionId), scope = this.scope(target, query.scope);
    const identity = { kind: 'prompt-versions', sessionId: target.id, ...scope };
    const cursor = this.decode(query.cursor, identity);
    const latest = promptSettings(this.rt.harness.store, scope);
    let version = Math.min(latest.version, (cursor?.before ?? latest.version + 1) - 1);
    const limit = this.limit(query), items: PromptVersion[] = [];
    // Old installations may not have retained every historical version. Scan at most one page of
    // version numbers and continue, rather than traversing an arbitrarily long sparse history.
    for (let scanned = 0; version > 0 && scanned < limit; version--, scanned++) {
      const saved = version === latest.version ? latest : this.rt.harness.store.getSetting<PromptVersion | null>(`prompts:${scope.scope}:${scope.scopeId}:version:${version}`, null);
      if (saved) items.push(saved);
    }
    return { items: this.clean(items), ...(version > 0 ? { nextCursor: this.encode({ ...identity, before: version + 1 }) } : {}) };
  }
  requestVersions(sessionId: unknown, input: Record<string, unknown>): Page<RequestRecordView> {
    const query = pickFields(input, ['cursor', 'limit']), target = this.target(sessionId);
    const identity = { kind: 'request-versions', sessionId: target.id };
    const cursor = this.decode(query.cursor, identity);
    const page = this.rt.harness.store.listRequests({ sessionId: target.id, order: 'desc', after: cursor?.before, limit: this.limit(query, 10) });
    const items = page.requests.map(summary => {
      const record = this.clean(this.rt.harness.store.getRequest(summary.id));
      const body = record.recordContent ? record.body ?? null : null;
      return { id: record.id, kind: record.kind, status: record.status, createdAt: record.createdAt,
        bodyHash: record.bodyHash, profileId: record.profileId, recordContent: record.recordContent,
        model: record.model ?? String(record.body?.model ?? 'unknown'), endpoint: record.endpoint,
        body, redactions: redactionPaths(body),
        ...(record.parentId ? { parentId: record.parentId } : {}), ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
      } satisfies RequestRecordView;
    });
    return { items, ...(page.nextCursor === null ? {} : { nextCursor: this.encode({ ...identity, before: page.nextCursor }) }) };
  }
  sessionSettings(sessionId: unknown): SessionSettingsView {
    const target = this.target(sessionId);
    if (!target.chat) throw new ProductError('unsupported', 'Session parameter and capability controls currently apply to Chat.');
    const config = this.rt.harness.profiles.get(target.profileId).provider;
    return this.clean({ sessionId: target.id, parameters: target.chat.parameters, capabilities: target.chat.capabilities,
      supported: { web: true, tools: true, mcp: true, skills: true, projectInstructions: true },
      unsupportedReasons: {},
      model: config.model, supportsDeveloper: config.supportsDeveloper === true, maxOutputTokens: config.maxOutputTokens ?? 4096 });
  }
  saveSessionSettings(sessionId: unknown, input: Record<string, unknown>): SessionSettingsView {
    const target = this.target(sessionId), session = this.editable(target);
    const value = pickFields(input, ['parameters', 'capabilities']); safeInput(value);
    if (value.parameters !== undefined && (!value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters))) invalid('parameters must be a JSON object.');
    const parameters = value.parameters === undefined ? session.parameters : value.parameters as Record<string, unknown>;
    for (const key of ['messages', 'model', 'tools', 'tool_choice', 'functions', 'function_call', 'requestTemplate']) if (key in parameters) invalid(`${key} is not a session parameter.`);
    const capabilities = { ...session.capabilities };
    if (value.capabilities !== undefined) {
      const patch = pickFields(value.capabilities, CAPABILITIES, 'capabilities');
      for (const key of CAPABILITIES) if (patch[key] !== undefined) {
        if (typeof patch[key] !== 'boolean') invalid('Capabilities must be boolean.');
        capabilities[key] = patch[key] as boolean;
      }
    }
    const config = this.rt.harness.profiles.get(target.profileId).provider;
    const body: Record<string, any> = { ...new ModelClient(config).buildBody([{ role: 'user', content: 'validation' }]), ...session.requestTemplate, ...parameters, model: config.model, messages: [{ role: 'user', content: 'validation' }] };
    delete body.tools; delete body.tool_choice;
    if (body.stream === false) delete body.stream_options;
    this.validateRequest(target.id, body);
    this.rt.harness.store.updateSession(target.id, this.clean({ parameters, capabilities }));
    this.rt.append({ type: 'inspector.invalidated', sessionId: target.id }, target.id);
    return this.sessionSettings(target.id);
  }
  validateRequest(sessionId: unknown, value: unknown, requestId?: unknown): { body: Record<string, unknown> } {
    const target = this.target(sessionId);
    let profileId = target.profileId;
    if (requestId !== undefined) {
      const record = this.request(requiredString(requestId, 'requestId'));
      if (record.sessionId !== target.id) notFound('Request does not belong to this conversation.');
      profileId = record.profileId;
    }
    return this.validateBody(profileId, value);
  }
  private validateBody(profileId: string, value: unknown): { body: Record<string, unknown> } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Request JSON must be an object.');
    safeInput(value);
    if (JSON.stringify(value).length > 1_200_000) invalid('Request JSON exceeds the editor limit.');
    try { validateRequestBody(value, this.rt.harness.profiles.get(profileId).provider); }
    catch (error) { invalid(this.rt.harness.sanitize(error instanceof Error ? error.message : String(error))); }
    return { body: this.clean(value as Record<string, unknown>) };
  }
  private request(id: string) {
    try { return this.rt.harness.store.getRequest(id); } catch { return notFound('Request not found.'); }
  }
  validateReplay(requestId: string, body: unknown): Record<string, unknown> {
    const record = this.request(requestId);
    // Retained request audit can outlive a removed Chat; its own profile remains the replay authority.
    return this.validateBody(record.profileId, body).body;
  }
  exportConversation(sessionId: unknown, input: Record<string, unknown>): ConversationExportPage {
    const query = pickFields(input, ['cursor', 'limit']), target = this.target(sessionId), store = this.rt.harness.store;
    const identity = { kind: 'export', sessionId: target.id };
    let cursor = this.decode<ExportCursor>(query.cursor, identity);
    if (!cursor) {
      if (target.chat && this.rt.harness.chat.busy(target.id)) busy('Wait for this conversation to settle before exporting a snapshot.');
      const latest = target.kind === 'work' ? this.rt.services.kernel.tailMessages(target.id, 1)[0] : undefined;
      const messages = target.kind === 'chat' ? store.librarySnapshot(target.id, 'messages') : {
        through: latest ? this.rt.services.kernel.messageCursor(target.id, latest.id) : 0,
        count: this.rt.services.kernel.messageCount(target.id),
      };
      const requests = store.librarySnapshot(target.id, 'requests');
      if (store.libraryRequestRunning(target.id, requests.through)) busy('Wait for running requests to settle before exporting a snapshot.');
      cursor = { ...identity, snapshot: randomBytes(16).toString('hex'), messagesThrough: messages.through, messagesCount: messages.count,
        requestsThrough: requests.through, requestsCount: requests.count, section: 'messages', after: 0, offset: 0 };
    }
    if (store.librarySnapshot(target.id, 'requests', cursor.requestsThrough).count !== cursor.requestsCount
      || (target.kind === 'chat' && store.librarySnapshot(target.id, 'messages', cursor.messagesThrough).count !== cursor.messagesCount))
      throw new ProductError('stale', 'The conversation history changed or was cleared. Start a new export.', 409);
    const workOrigin = target.kind === 'work' ? this.rt.harness.workOriginLink(target.id) : undefined;
    const chatOrigin = target.kind === 'work' ? store.getSetting<{ sessionId: string; archiveSnapshot?: number } | null>('promotedChat:' + target.id, null) : undefined;
    const result: ConversationExportPage = { format: 'npn-conversation-v1', sessionId: target.id, scope: 'current-session', originArchiveIncluded: false,
      ...(workOrigin ? { origin: { kind: 'work' as const, sessionId: workOrigin.sourceTaskId, messageId: workOrigin.sourceMessageId, through: workOrigin.snapshot } }
        : chatOrigin ? { origin: { kind: 'chat' as const, sessionId: chatOrigin.sessionId, through: chatOrigin.archiveSnapshot } } : {}),
      session: this.clean(target.kind === 'chat' ? { id: target.chat!.id, title: target.chat!.title, createdAt: target.chat!.createdAt,
        parentSessionId: target.chat!.parentSessionId, branchMessageId: target.chat!.branchMessageId, profileId: target.chat!.profileId } : target.session),
      snapshot: cursor.snapshot, messages: [], requests: [], fragments: [] };
    let remaining = PAGE_CHARS, count = 0, complete = false;
    while (remaining > 0 && count < this.limit(query, 50)) {
      const workRow = cursor.section === 'messages' && target.kind === 'work'
        ? this.rt.services.kernel.messageRows(target.id, cursor.after, 1, 'main', cursor.messagesThrough)[0] : undefined;
      const row = cursor.section === 'messages' && target.kind === 'work'
        ? workRow && { seq: workRow.rowid, id: workRow.id, record: workRow.body }
        : store.libraryRow(target.id, cursor.section, cursor.after, cursor.section === 'messages' ? cursor.messagesThrough : cursor.requestsThrough);
      if (!row) {
        if (cursor.section === 'messages') { cursor.section = 'requests'; cursor.after = 0; cursor.offset = 0; continue; }
        complete = true; break;
      }
      const value = this.clean(JSON.parse(row.record) as unknown), text = JSON.stringify(value), checksum = hash(text);
      if (cursor.offset && cursor.hash !== checksum) throw new ProductError('stale', 'An exported record changed. Start a new export.', 409);
      if (!cursor.offset && text.length <= remaining) {
        result[cursor.section].push(value); remaining -= text.length; cursor.after = row.seq; count++;
      } else {
        const fragment = text.slice(cursor.offset, cursor.offset + remaining);
        result.fragments.push({ section: cursor.section, id: row.id, offset: cursor.offset, totalChars: text.length, json: fragment });
        cursor.offset += fragment.length; remaining -= fragment.length; count++;
        if (cursor.offset === text.length) { cursor.after = row.seq; cursor.offset = 0; delete cursor.hash; }
        else cursor.hash = checksum;
      }
    }
    if (!complete) result.nextCursor = this.encode(cursor);
    return result;
  }
  route(method: string, path: string, query: Record<string, unknown>, input: Record<string, unknown>): unknown {
    if (method === 'GET' && path === '/presets') return this.presets(query);
    if (method === 'POST' && path === '/presets/save') { pickFields(query, []); return this.savePreset(input); }
    if (method === 'GET' && path === '/preset') return this.preset(query);
    if (method === 'GET' && path === '/preset-versions') return this.presetVersions(query);
    const { sessionId, ...rest } = query;
    if (method === 'GET' && path === '/prompt-versions') return this.promptVersions(sessionId, rest);
    if (method === 'GET' && path === '/request-versions') return this.requestVersions(sessionId, rest);
    if (method === 'GET' && path === '/export') return this.exportConversation(sessionId, rest);
    if (path === '/session-settings') {
      pickFields(rest, []);
      if (method === 'GET') return this.sessionSettings(sessionId);
      if (method === 'POST') return this.saveSessionSettings(sessionId, input);
    }
    if (method === 'POST' && path === '/validate-request') {
      pickFields(rest, ['requestId']); const value = pickFields(input, ['body']); return this.validateRequest(sessionId, value.body, rest.requestId);
    }
    return notFound('Unknown library route.');
  }
}
