import type { RequestRecord } from '../harness/types.js';

export function parseRequestBody(text: string): Record<string, any> {
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('请求必须是 JSON 对象。');
  if (typeof value.model !== 'string' || !value.model.trim()) throw new Error('model 必须是非空模型标识。');
  if (!Array.isArray(value.messages) || !value.messages.length) throw new Error('messages 必须是非空消息数组。');
  for (const message of value.messages) {
    if (!message || typeof message.role !== 'string' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw new Error('每条消息都需要有效的 role。');
    if (message.content !== null && typeof message.content !== 'string' && !Array.isArray(message.content)) throw new Error('消息 content 必须是文本、接口支持的内容数组或 null。');
  }
  if (value.temperature !== undefined && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature))) throw new Error('temperature 必须是有限数值。');
  if (value.max_tokens !== undefined && (!Number.isInteger(value.max_tokens) || value.max_tokens < 1)) throw new Error('max_tokens 必须是正整数。');
  if (value.tools !== undefined && !Array.isArray(value.tools)) throw new Error('tools 必须是数组。');
  return value;
}

export function requestMetrics(request?: Pick<RequestRecord, 'usage' | 'durationMs' | 'body'>): string {
  if (!request) return '尚无请求记录';
  const usage = request.usage;
  const measured = usage?.total_tokens ?? (usage?.prompt_tokens !== undefined && usage.completion_tokens !== undefined ? usage.prompt_tokens + usage.completion_tokens : undefined);
  const tokens = measured === undefined ? '用量未知 · 服务商未返回' : `实际 ${measured.toLocaleString()} tokens`;
  return `${tokens} · ${request.durationMs === undefined ? '耗时未知' : `${(request.durationMs / 1000).toFixed(2)} s`}`;
}

export interface JsonDifference { path: string; before: unknown; after: unknown; }
/** Compare object keys, preserving meaningful array order and explicit removals. */
export function requestDifferences(before: unknown, after: unknown, path = '$'): JsonDifference[] {
  if (Object.is(before, after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => requestDifferences(left[key], right[key], Array.isArray(before) ? `${path}[${key}]` : `${path}.${key}`));
  }
  return [{ path, before, after }];
}

export function mergeRequestPages(current: RequestRecord[], incoming: RequestRecord[]): RequestRecord[] {
  const records = new Map(current.map(record => [record.id, record]));
  for (const record of incoming) records.set(record.id, record);
  return [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export class ConversationDrafts {
  private values = new Map<string, { text: string; attachments: string[] }>();
  get(id: string) { return this.values.get(id) ?? { text: '', attachments: [] }; }
  set(id: string, draft: { text: string; attachments: string[] }) { this.values.set(id, { text: draft.text, attachments: [...draft.attachments] }); }
  clear(id: string) { this.values.delete(id); }
  get dirty() { return [...this.values.values()].some(draft => draft.text.trim() || draft.attachments.length); }
}
