import type { ChatSession, PromptPart, RequestBody } from './types.js';
import type { HarnessStore } from './store.js';

export const precedence = ['harness', 'global', 'project', 'session', 'request'];
type PromptField = 'systemPrompt' | 'developerPrompt' | 'dynamic';
export type PromptOverrides = Partial<Record<PromptField, string>>;
export interface PromptSettings { scope: 'global' | 'project' | 'session'; scopeId: string; systemPrompt: string; developerPrompt: string; dynamic: string; version: number; defined?: PromptField[] }
export function promptSettings(store: HarnessStore, input: Record<string, any>, save = false): PromptSettings & { precedence: string[] } {
  const scope = input.scope ?? 'global', scopeId = scope === 'global' ? '' : String(input.scopeId ?? '');
  if (!['global', 'project', 'session'].includes(scope) || (scope !== 'global' && !scopeId)) throw new Error('Choose global, project or session prompt scope and its identity.');
  const key = `prompts:${scope}:${scopeId}`;
  const old = store.getSetting<PromptSettings>(key, { scope, scopeId, systemPrompt: '', developerPrompt: '', dynamic: '', version: 0 });
  if (!save && input.version !== undefined) {
    const version = Number(input.version);
    if (!Number.isSafeInteger(version) || version < 1 || version > old.version) throw new Error('Prompt version does not exist.');
    const saved = version === old.version ? old : store.getSetting<PromptSettings | null>(`${key}:version:${version}`, null);
    if (!saved) throw new Error('This legacy prompt version was not retained. Its sent request snapshots remain available.');
    return { ...saved, precedence };
  }
  if (!save) return { ...old, precedence };
  const next = { ...old, version: old.version + 1, defined: [...(old.defined ?? (['systemPrompt', 'developerPrompt', 'dynamic'] as const).filter(field => Boolean(old[field])))] };
  for (const field of ['systemPrompt', 'developerPrompt', 'dynamic'] as const) if (input[field] !== undefined) {
    if (typeof input[field] !== 'string' || input[field].length > 64000) throw new Error(`${field} must be text of at most 64000 characters.`);
    next[field] = input[field];
    if (!next.defined.includes(field)) next.defined.push(field);
  }
  // Retaining the old body and publishing its successor are one durable operation.
  store.transaction(() => {
    if (old.version) store.setSetting(`${key}:version:${old.version}`, old);
    store.setSetting(key, next);
  });
  return { ...next, precedence };
}
export const part = (id: string, label: string, role: string, content: string, source: string, scope: PromptPart['scope'], version?: number): PromptPart =>
  ({ id, label, role, content, source, scope, version, estimatedTokens: Math.ceil(content.length / 3), effective: true });

/** Scalars override; dynamic additions accumulate. The fixed Harness layer is never replaced here. */
export function customParts(store: HarnessStore, session: Pick<ChatSession, 'id' | 'workspace' | 'systemPrompt' | 'developerPrompt'>, request: Partial<Record<PromptField, string>> = {}): PromptPart[] {
  const layers = [promptSettings(store, { scope: 'global' }), ...(session.workspace ? [promptSettings(store, { scope: 'project', scopeId: session.workspace })] : []), promptSettings(store, { scope: 'session', scopeId: session.id })];
  const parts: PromptPart[] = [];
  for (const layer of layers) for (const [field, role] of [['systemPrompt', 'system'], ['developerPrompt', 'developer'], ['dynamic', 'user']] as const) {
    if (layer[field] || layer.defined?.includes(field)) parts.push(part(`${layer.scope}:${field}`, `${layer.scope} · ${field}`, role, layer[field], `harness.sqlite / prompts:${layer.scope}:${layer.scopeId}`, layer.scope, layer.version));
  }
  for (const [field, role] of [['systemPrompt', 'system'], ['developerPrompt', 'developer']] as const) if (session[field]) parts.push(part(`session:${field}:direct`, `会话 ${field}`, role, session[field], `chat_sessions/${session.id}/${field}`, 'session'));
  for (const [field, role] of [['systemPrompt', 'system'], ['developerPrompt', 'developer'], ['dynamic', 'user']] as const) if (request[field] !== undefined) {
    if (typeof request[field] !== 'string' || request[field]!.length > 64000) throw new Error(`${field} must be text of at most 64000 characters.`);
    parts.push(part(`request:${field}`, `单次 ${field}`, role, request[field]!, 'request override', 'request'));
  }
  for (const role of ['system', 'developer']) {
    const selected = parts.findLast(item => item.role === role);
    for (const item of parts.filter(item => item.role === role && item !== selected)) { item.effective = false; item.overriddenBy = selected!.id; }
  }
  for (const item of parts) item.merge = item.role === 'user' ? 'append' : 'override';
  return parts;
}
export function effectiveParts(body: RequestBody, sources: PromptPart[] = []): PromptPart[] {
  const messages = (body.messages ?? []).map((message: any, index: number) => part(`effective:${index}`, `有效消息 ${index + 1} · ${message.role}`, message.role, typeof message.content === 'string' ? message.content : JSON.stringify(message.content), `provider body / messages/${index}`, 'request'));
  if (body.tools?.length) messages.push(part('effective:tools', '本次暴露的工具 Schema', 'tools', JSON.stringify(body.tools, null, 2), 'provider body / tools', 'request'));
  return [...sources, ...messages];
}
