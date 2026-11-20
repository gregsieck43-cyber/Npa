/**
 * 产品 Inspector 领域适配器。
 *
 * 原生 Harness/Kernel 的请求、提示词、工具、Trace、归档和 Diff 数据都有各自的结构；
 * 前端只认 src/frontend/api/types.ts 的 Inspector DTO。本模块只做有损、可解释的映射，
 * 不修改原生执行器，也不伪造原生没有记录的事实：
 * - 请求 Body 直接来自脱敏后的真实请求快照；关闭内容记录时返回 null。
 * - Trace 的 startMs 相对会话/任务创建时间；游标是原生 trace 序号。
 * - Context/Recall 的 SHA 一律取原档记录 JSON 的 SHA-256，不把投影 SHA 当原档。
 * - Diff 只汇总真实 applied 的 write_file 回执；没有可验证 pre-image 就明确失败，不猜行号。
 *
 * 会话标识沿用产品约定：Chat 是 Harness chat-* ID，Work 是 Kernel task ID。
 */
import { createHash } from 'node:crypto';
import type {
  ContextSegment, ContextView, DiffHunk, DiffLine, FileDiff, PromptPart as PromptPartView, PromptView,
  RecallPage, RequestRecordView, TokenUsage, ToolCallView, ToolDefinitionView, ToolInventory,
  TraceSpan, TraceSpanType, TraceView, ToolResult, ToolDetailPage, ToolDetailSection,
} from '../frontend/api/types.js';
import type { ModelUsage, Task, ToolReviewRecord } from '../contracts.js';
import type { ChatSession, PromptPart as NativePromptPart, RequestContext, RequestRecord, RequestBody, ToolRecord, TraceEvent } from '../harness/types.js';
import { ModelClient } from '../runtime/model.js';
import type { ScopedMemoryPort } from '../memory/tools.js';
import type { ProductRuntime } from './shared.js';
import { ProductError, boundedInteger, invalid, notFound, requiredString } from './shared.js';
import { classifyTool } from '../kernel/permissions.js';
import { MEMORY_TOOL_NAMES } from '../memory/tools.js';
import { effectiveParts } from '../harness/prompts.js';
import { toolSource } from '../harness/requests.js';

/** 有界读取：列表、分页、单项内容与 Diff 计算都有硬上限，避免一次 Inspector 读取拖垮会话。 */
const MAX_REQUESTS = 25;
const MAX_PROMPT_PARTS = 500;
const MAX_PROMPT_CHARS = 64_000;
const MAX_TRACE_PAGE = 500;
const MAX_TRACE_EVENTS = 1_000;
const MAX_TRACE_SPANS = 200;
const MAX_CONTEXT_ITEMS = 40;
const MAX_OMITTED = 50;
const MAX_RECALL_CHARS = 6_000;
const MAX_TOOL_RESULT_CHARS = 12_000;
const MAX_TOOL_ARG_CHARS = 16_000;
const MAX_RESPONSE_CHARS = 20_000;
const MAX_REPLAY_BYTES = 1_200_000;
const MAX_DIFFS = 50;
const MAX_DIFF_CELLS = 1_000_000;
const REPLAY_SETTLE_MS = 8_000;
const SECRET_FIELD = /(?:api[_-]?key|authorization|secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer|private[_-]?key|password|passwd|credential|^auth$|^headers$|^cookies?$)/i;

const TRACE_TYPES = new Set<TraceSpanType>(['turn', 'prompt', 'context', 'model', 'tool', 'review', 'approval', 'checkpoint', 'task', 'subagent']);
const CHAT_READ_TOOLS = ['read_file', 'list_files'] as const;
const CHAT_WEB_TOOLS = ['web_search', 'web_fetch', 'web_crawl'] as const;
const PROMPT_FIELDS = ['systemPrompt', 'developerPrompt', 'dynamic'] as const;
type PromptField = typeof PROMPT_FIELDS[number];
const EDITABLE_PROMPT = /^(?:global|project|session):(systemPrompt|developerPrompt|dynamic)$/;
const DIRECT_SESSION_PROMPT = /^session:(systemPrompt|developerPrompt):direct$/;
const ONE_SHOT_PROMPT = /^request:(systemPrompt|developerPrompt|dynamic)$/;

interface InspectorTarget {
  id: string;
  kind: 'chat' | 'work';
  chat?: ChatSession;
  task?: Task;
  createdAt: string;
  workspace?: string;
  profileId: string;
  promoted: boolean;
  /** 当前会话唯一的 canonical 原始归档；缺少时该会话不能声称可回查。 */
  memory(): ScopedMemoryPort | undefined;
}

interface NativeInventory {
  registered?: unknown[];
  allowed?: unknown[];
  calls?: unknown;
}

/**
 * Display-only extensions. They are additive optional frontend fields; the backend always sends both
 * Context flags so a viewer can distinguish an unknown window and an estimated (not provider-reported)
 * prompt total from real values instead of dividing by a fake 0.
 */
type InspectorContextView = ContextView & { windowTokensKnown: boolean; usedTokensEstimated: boolean };
type InspectorTraceView = TraceView & { nextCursor?: string };

interface ContextMeta {
  omittedIds: string[];
  manifest: { id: string; chars?: number; included?: boolean }[];
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const estimateText = (value: string): number => Math.ceil(value.length / 4);
const estimateJson = (value: unknown): number => estimateText(JSON.stringify(value ?? {}));

function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + `\n…[Inspector 截断 ${value.length - limit} 个字符；原始快照/回执仍保留完整内容]`;
}

/** 只截断字符串叶子，保留对象形状，避免把 1 MB 写入内容塞进一次工具列表响应。 */
function boundedValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length <= MAX_TOOL_ARG_CHARS ? value : value.slice(0, MAX_TOOL_ARG_CHARS) + `…[截断 ${value.length - MAX_TOOL_ARG_CHARS} 字符]`;
  if (Array.isArray(value)) return depth >= 6 ? `[Inspector: 数组层级过深，共 ${value.length} 项]` : value.slice(0, 100).map(item => boundedValue(item, depth + 1));
  if (value && typeof value === 'object') {
    if (depth >= 6) return '[Inspector: 对象层级过深]';
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [key, SECRET_FIELD.test(key) ? '[credential redacted]' : boundedValue(item, depth + 1)]));
  }
  return value;
}

/** 输入边界错误统一翻译为产品错误；非预期内部错误保持原样，避免被误报成用户输入问题。 */
function inputFailure(error: unknown): ProductError {
  if (error instanceof ProductError) return error;
  const message = messageOf(error);
  if (/not found/i.test(message)) return new ProductError('not_found', message, 404);
  return new ProductError('validation', message);
}

function roleOf(role: string): PromptPartView['role'] {
  if (role === 'context' || role === 'tools') return 'system';
  return (['system', 'developer', 'user', 'assistant', 'tool'] as const).find(item => item === role) ?? 'system';
}

function mergeOf(part: NativePromptPart): PromptPartView['merge'] {
  if (part.scope === 'harness') return 'locked';
  if (DIRECT_SESSION_PROMPT.test(part.id)) return 'override';
  if (part.merge === 'override' || part.merge === 'append') return part.merge;
  return part.role === 'user' ? 'append' : 'append';
}

function isEffective(part: NativePromptPart): boolean { return part.effective !== false; }
function isHistoryPart(part: NativePromptPart): boolean {
  return part.scope === 'session' && !part.id.startsWith('session:') && !part.id.startsWith('effective:')
    && part.id !== 'archive-navigation' && part.id !== 'context-selection' && part.id !== 'context-manifest';
}

function usageView(usage: ModelUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.prompt_tokens, output = usage.completion_tokens;
  // 前端 TokenUsage 的 input/output 是必填数字；原生缺少任一真实值时省略整个 usage，绝不补 0。
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  const view: TokenUsage = { input: input as number, output: output as number };
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  if (Number.isFinite(cached)) view.cached = cached as number;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (Number.isFinite(reasoning)) view.reasoning = reasoning as number;
  return view;
}

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

function promptFieldOf(id: string): PromptField | undefined {
  const match = EDITABLE_PROMPT.exec(id) ?? DIRECT_SESSION_PROMPT.exec(id) ?? ONE_SHOT_PROMPT.exec(id);
  const field = match?.[1];
  return (PROMPT_FIELDS as readonly string[]).includes(field ?? '') ? field as PromptField : undefined;
}

function lockedPrompt(id: string): boolean {
  return id.startsWith('instruction') || id.startsWith('effective:')
    || ['chat-mode', 'work-harness', 'archive-navigation', 'context-selection', 'context-manifest'].includes(id);
}

function toolTitle(record: ToolRecord): string {
  const args = record.arguments ?? {};
  const target = args.path ?? args.query ?? args.url ?? args.command ?? args.title ?? args.id;
  return typeof target === 'string' && target.trim() ? `${record.name} · ${boundedText(target, 120)}` : record.name;
}

function toolSourceView(name: string, raw: string | undefined): ToolCallView['source'] {
  const source = raw ?? toolSource(name);
  if (source === 'MCP' || source === 'mcp') return 'mcp';
  if (source === 'integration' || source === 'collaboration' || source === 'plugin') return 'plugin';
  if (source === 'subagent') return 'subagent';
  return 'builtin';
}

function toolStatus(record: ToolRecord): ToolCallView['status'] {
  switch (record.status) {
    case 'proposed': return 'pending';
    // The Harness projection turns a Kernel-prepared call into 'awaiting_approval' once the task is
    // waiting; the persisted status itself must map to the same view instead of silently becoming pending.
    case 'prepared': case 'awaiting_approval': return 'awaiting_approval';
    case 'approved': return 'pending';
    case 'sent': case 'running': return 'running';
    case 'completed': return 'succeeded';
    case 'failed': return 'failed';
    case 'denied': return 'denied';
    case 'not_executed': return 'blocked';
    case 'unknown': return 'unknown';
    default: return 'pending';
  }
}

function toolError(record: ToolRecord): ToolCallView['error'] | undefined {
  if (record.error) {
    const stage = record.failureStage ?? (record.status === 'denied' ? 'permission' : record.status === 'unknown' ? 'reconciliation' : 'execution');
    return { stage, message: boundedText(record.error, 4_000) };
  }
  if (record.status === 'not_executed') return { stage: 'permission', message: '此请求类型（Studio/重放）只记录模型提议，不会执行工具调用。' };
  return undefined;
}

function reviewView(review: ToolReviewRecord): NonNullable<ToolCallView['review']> {
  return {
    reviewer: review.reviewerModelId || review.reviewer,
    verdict: review.verdict,
    risk: review.risk,
    reason: boundedText(review.reason, 2_000),
    checks: (review.checks ?? []).slice(0, 20).map(check => ({ label: String(check.label), ok: check.ok === true })),
    durationMs: Number.isFinite(review.durationMs) ? review.durationMs : 0,
  };
}

function toolResult(record: ToolRecord, receipt: Record<string, unknown> | undefined): ToolResult | undefined {
  if (['failed', 'denied', 'not_executed', 'unknown'].includes(record.status)) return undefined;
  const value = record.result ?? receipt;
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const exitCode = receipt?.exitCode;
    if ((record.name === 'run_shell' || record.name === 'run_command') && Number.isFinite(Number(exitCode))) {
      return { kind: 'terminal', command: String(record.arguments.command ?? record.arguments.argv ?? ''), exitCode: Number(exitCode), output: boundedText(value, MAX_TOOL_RESULT_CHARS) };
    }
    return { kind: 'text', text: boundedText(value, MAX_TOOL_RESULT_CHARS) };
  }
  return { kind: 'json', value: boundedValue(value) };
}

function traceTypeOf(type: string): TraceSpanType {
  if (type === 'prompt.assembled') return 'prompt';
  if (type === 'context.selected') return 'context';
  if (type.startsWith('request.')) return 'model';
  if (type.startsWith('tool.') || type.startsWith('effect.') || type === 'tool.proposal_owned' || type === 'chat.tools_proposed') return 'tool';
  if (type.startsWith('intent.') && type.includes('review')) return 'review';
  if (type.includes('review')) return 'review';
  if (type.startsWith('approval.')) return 'approval';
  if (type.startsWith('intent.')) return 'approval';
  if (type.startsWith('chat.') || type.startsWith('message.')) return 'turn';
  if (type.startsWith('child.') || type.startsWith('delegation.')) return 'subagent';
  if (type.startsWith('checkpoint.')) return 'checkpoint';
  return 'task';
}

function traceStatus(status: string): TraceSpan['status'] {
  if (status === 'completed' || status === 'ok' || status === 'recorded' || status === 'applied' || status === 'succeeded') return 'ok';
  if (status === 'failed' || status === 'error' || status === 'blocked' || status === 'denied') return 'error';
  if (status === 'running' || status === 'started') return 'running';
  if (status === 'waiting' || status === 'waiting_approval' || status === 'waiting_input' || status === 'waiting_children' || status === 'prepared' || status === 'reviewing' || status === 'queued') return 'waiting';
  if (status === 'cancelled') return 'cancelled';
  return 'ok';
}

const TRACE_LABELS: Record<string, string> = {
  'prompt.assembled': '提示词组装', 'context.selected': '上下文选择',
  'request.started': '模型请求开始', 'request.completed': '模型请求完成', 'request.failed': '模型请求失败', 'request.interrupted': '请求被重启中断',
  'chat.tools_proposed': '工具提议待执行', 'chat.request_settled': '对话请求结算', 'chat.branched': '会话分叉', 'chat.promoted': '会话升级为任务', 'chat.tool_round_limit': '工具轮次上限',
  'tool.proposal_owned': '工具提议已登记', 'tool.prepared': '工具已准备', 'tool.started': '工具执行中', 'tool.execution': '工具执行', 'tool.execution_finished': '工具执行结束',
  'tool.completed': '工具完成', 'tool.rejected': '工具被拒绝', 'tool.denied': '工具被拒绝', 'tool.unknown': '工具结果未知', 'tool.reconciliation_required': '工具待对账',
  'intent.prepared': '授权意图已准备', 'intent.approved': '授权已通过', 'intent.denied': '授权被拒绝', 'intent.sent': '授权已发送',
  'intent.reviewed': '独立审查完成', 'intent.review_escalated': '审查升级', 'intent.review_blocked': '审查阻止',
  'effect.receipted': '副作用回执', 'effect.reconciled': '副作用已对账', 'effect.unknown': '副作用未知',
};

function traceLabel(event: TraceEvent): string {
  const base = TRACE_LABELS[event.type] ?? event.type;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  const hint = payload.name ?? payload.model ?? payload.code ?? payload.toolCallId ?? payload.messageId ?? payload.intentId ?? payload.error;
  return typeof hint === 'string' && hint.trim() ? `${base} · ${boundedText(hint, 90)}` : base;
}

function traceAttrs(event: TraceEvent): Record<string, string | number> | undefined {
  const attrs: Record<string, string | number> = { eventType: event.type };
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  for (const [key, value] of Object.entries(payload)) {
    if (Object.keys(attrs).length >= 10) break;
    if (typeof value === 'string') attrs[key] = boundedText(value, 120);
    else if (typeof value === 'number' && Number.isFinite(value)) attrs[key] = value;
    else if (typeof value === 'boolean') attrs[key] = value ? 'true' : 'false';
  }
  return Object.keys(attrs).length ? attrs : undefined;
}

function linesOf(text: string): string[] { return text === '' ? [] : text.split(/\r?\n/); }

/** 有界 LCS 行差异；只用于能从真实回执核对前后文的内容。 */
function unifiedDiff(previous: string, next: string): { hunk: DiffHunk; additions: number; deletions: number } {
  const a = linesOf(previous), b = linesOf(next);
  if (a.length * b.length > MAX_DIFF_CELLS) throw new ProductError('unsupported', '文件行数过多，无法在 Inspector 内生成有界行级 Diff。');
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const lines: DiffLine[] = [];
  let additions = 0, deletions = 0, i = 0, j = 0, oldNo = 1, newNo = 1;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: a[i]! }); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { lines.push({ kind: 'del', oldNo: oldNo++, text: a[i]! }); deletions++; i++; }
    else { lines.push({ kind: 'add', newNo: newNo++, text: b[j]! }); additions++; j++; }
  }
  while (i < a.length) { lines.push({ kind: 'del', oldNo: oldNo++, text: a[i]! }); deletions++; i++; }
  while (j < b.length) { lines.push({ kind: 'add', newNo: newNo++, text: b[j]! }); additions++; j++; }
  return { hunk: { header: `@@ -1,${a.length} +1,${b.length} @@`, lines }, additions, deletions };
}

/** Inspector 九方法的产品领域接口。 */
export interface InspectorDomain {
  prompt(sessionId: string, requestId?: string): Promise<PromptView>;
  savePrompt(sessionId: string, partId: string, content: string, scope: 'global' | 'project' | 'session' | 'request'): Promise<PromptView>;
  requests(sessionId: string): Promise<RequestRecordView[]>;
  replay(requestId: string, body: unknown, mode: 'send' | 'branch'): Promise<RequestRecordView>;
  tools(sessionId: string): Promise<ToolInventory>;
  toolDetail(sessionId: string, callId: string, section: ToolDetailSection, offset?: number): Promise<ToolDetailPage>;
  trace(sessionId: string, query?: { text?: string; type?: string; cursor?: string }): Promise<TraceView>;
  context(sessionId: string): Promise<ContextView>;
  recall(sessionId: string, sourceId: string, offset?: number): Promise<RecallPage>;
  diffs(sessionId: string): Promise<FileDiff[]>;
}

class Inspector implements InspectorDomain {
  constructor(private readonly rt: ProductRuntime) {}

  async prompt(sessionId: string, requestId?: string): Promise<PromptView> {
    const target = this.target(sessionId);
    if (requestId !== undefined) {
      const record = this.request(requestId);
      if (record.sessionId !== target.id) notFound('请求不属于该会话。');
      return this.promptFromRecord(record);
    }
    const pending = this.rt.harness.store.pendingRequestOverrides(target.id);
    if (target.kind === 'chat') {
      // 待消费的请求级覆盖必须能在“当前提示词”里检视到，否则 savePrompt(request) 的草稿在刷新后消失；
      // preview 是只读组装，不会领取或消费覆盖，真正的一次性消费仍发生在下一次 Chat/Work 请求。
      const overrides: { systemPrompt?: string; developerPrompt?: string; dynamic?: string } = {};
      for (const edit of pending) overrides[edit.field] = edit.content;
      const { body, sources } = await this.rt.harness.chat.preview(target.id, overrides);
      return this.promptView(effectiveParts(body, sources), body, undefined, pending.length);
    }
    // Work 的“当前提示词”是只读组装：GET 预览不应每次生成 draft 请求记录（那会污染 requests 列表）。
    // 复用 runner.assembleWork + assembleWorkBody 的真实组装路径，待消费覆盖照常参与本次预览。
    const task = target.task!;
    const config = this.rt.harness.profiles.get(target.profileId).provider;
    const compiled = await this.rt.services.runner.assembleWork(task.id, config);
    const context: RequestContext = { sessionId: task.id, taskId: task.id, kind: 'studio', profileId: target.profileId, sources: compiled.sources };
    const overrides: { systemPrompt?: string; developerPrompt?: string; dynamic?: string } = {};
    for (const edit of pending) overrides[edit.field] = edit.content;
    const { body, sources } = this.rt.harness.requests.assembleWorkBody(
      context, new ModelClient(config).buildBody(compiled.context.messages, compiled.tools), overrides);
    return this.promptView(effectiveParts(body, sources), body, undefined, pending.length);
  }

  async savePrompt(sessionId: string, partId: string, content: string, scope: 'global' | 'project' | 'session' | 'request'): Promise<PromptView> {
    const target = this.target(sessionId);
    const id = requiredString(partId, 'partId', 200);
    if (typeof content !== 'string') invalid('content 必须是文本。');
    if (content.length > MAX_PROMPT_CHARS) invalid(`content 最多 ${MAX_PROMPT_CHARS} 个字符。`);
    const field = promptFieldOf(id);
    if (!field) {
      if (lockedPrompt(id) || /^session:/.test(id)) throw new ProductError('denied', '该提示词层来自 Harness 约束、运行时或历史消息，不能在 Inspector 中直接编辑。', 403);
      invalid('无法从 partId 识别可编辑的提示词字段。');
    }
    if (field === 'developerPrompt' && content && !this.rt.harness.profiles.get(target.profileId).provider.supportsDeveloper)
      invalid('当前模型配置不支持 Developer Prompt。');
    if (scope === 'request') {
      // 真实 one-shot：登记为该目标下一次真实请求的待消费覆盖，并生成一份可检视草稿。
      // 覆盖只保存 prompt 字段文本，由 Chat compile / Work assembleWorkBody 现有组装路径应用；
      // provider endpoint、工具、权限、凭据等控制字段不经过这条路径，也不接受任意 Body 注入。
      const pending = this.rt.harness.store.pendingRequestOverrides(target.id);
      const overrides: { systemPrompt?: string; developerPrompt?: string; dynamic?: string } = {};
      for (const edit of pending) overrides[edit.field] = edit.content;
      overrides[field] = content;
      // A failed model capability/body-limit validation must leave the previously saved overrides intact.
      const draft = await this.preview({ ...(target.kind === 'chat' ? { sessionId: target.id } : { taskId: target.id }), overrides });
      this.rt.harness.store.saveRequestOverride(target.id, `request:${field}`, field, content);
      return this.promptFromRecord(draft, Object.keys(overrides).length);
    }
    const direct = DIRECT_SESSION_PROMPT.exec(id);
    if (direct && scope === 'session') {
      if (target.kind !== 'chat') invalid('Work 会话没有可编辑的会话直存提示词。');
      await this.call('POST', `/v1/harness/sessions/${encodeURIComponent(target.id)}`, { [direct[1]!]: content });
      return this.prompt(target.id);
    }
    const scopeId = scope === 'global' ? '' : scope === 'project' ? target.workspace : target.id;
    if (scope === 'project' && !scopeId) invalid('该会话没有项目工作区，无法保存项目级提示词。');
    await this.call('POST', '/v1/harness/prompts', { scope, ...(scopeId ? { scopeId } : {}), [field]: content });
    return this.prompt(target.id);
  }

  async requests(sessionId: string): Promise<RequestRecordView[]> {
    const target = this.target(sessionId);
    const page = this.rt.harness.store.listRequests({ sessionId: target.id, order: 'desc', limit: MAX_REQUESTS });
    const views: RequestRecordView[] = [];
    for (const summary of page.requests) {
      try { views.push(this.requestView(this.rt.harness.store.getRequest(summary.id))); }
      catch (error) { if (/not found/i.test(messageOf(error))) continue; throw error; }
    }
    return views;
  }

  async replay(requestId: string, body: unknown, mode: 'send' | 'branch'): Promise<RequestRecordView> {
    const id = requiredString(requestId, 'requestId', 200);
    if (mode !== 'send' && mode !== 'branch') invalid("mode 必须是 'send' 或 'branch'。");
    if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('重放 Body 必须是 JSON 对象。');
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_REPLAY_BYTES) invalid('重放 Body 超过 1.2 MB 上限。');
    this.request(id);
    const record = await this.call('POST', `/v1/harness/requests/${encodeURIComponent(id)}/${mode}`, { body }) as RequestRecord;
    return this.requestView(mode === 'send' ? await this.settle(record.id) : this.request(record.id));
  }

  async tools(sessionId: string): Promise<ToolInventory> {
    const target = this.target(sessionId);
    const query = target.kind === 'chat' ? `sessionId=${encodeURIComponent(target.id)}` : `taskId=${encodeURIComponent(target.id)}`;
    const raw = await this.call('GET', `/v1/harness/tools?${query}`, {}) as NativeInventory;
    const registered: ToolDefinitionView[] = [];
    for (const item of Array.isArray(raw.registered) ? raw.registered : []) {
      const view = this.definitionView(item);
      if (view) registered.push(view);
    }
    const latest = this.rt.harness.store.latestRequest(target.id, target.kind === 'chat' ? 'chat' : 'work');
    const exposed = this.exposedNames(latest);
    const allowed = target.kind === 'chat'
      ? this.chatAllowed(registered, target.chat!)
      : (Array.isArray(raw.allowed) ? raw.allowed : []).map(item => this.definitionName(item)).filter((name): name is string => Boolean(name));
    // One authoritative page-level lookup keeps a long tool list linear; each rendered call still
    // resolves only through its own real Kernel intent id.
    const pendingApprovalIds = target.kind === 'work' ? this.actionableApprovalIds(target.id) : undefined;
    const calls = (Array.isArray(raw.calls) ? raw.calls : []).map(item => this.callView(item as ToolRecord, pendingApprovalIds));
    // Nest only an unambiguous recorded continuation. Multiple tool results can feed the
    // same request; never choose an arbitrary parent in that case or hide page-orphans.
    const parents = new Map<string, ToolCallView>();
    const continuations = new Map<string, ToolCallView[]>();
    for (const parent of calls) {
      if (!parent.requestId || !parent.receivedByRequestId) continue;
      const key = JSON.stringify([parent.requestId, parent.receivedByRequestId]);
      const list = continuations.get(key) ?? []; list.push(parent); continuations.set(key, list);
    }
    for (const call of calls) {
      const candidates = (continuations.get(JSON.stringify([call.parentRequestId, call.requestId])) ?? []).filter(parent => parent.id !== call.id);
      if (candidates.length === 1) parents.set(call.id, candidates[0]!);
    }
    const nested = new Set<string>();
    for (const call of calls) {
      const parent = parents.get(call.id);
      if (!parent) continue;
      let ancestor: ToolCallView | undefined = parent;
      const seen = new Set([call.id]);
      while (ancestor && !seen.has(ancestor.id)) { seen.add(ancestor.id); ancestor = parents.get(ancestor.id); }
      if (ancestor || seen.size > 32) continue;
      (parent.children ??= []).push(call); nested.add(call.id);
    }
    return { registered, allowed, exposed, calls: calls.filter(call => !nested.has(call.id)) };
  }

  async toolDetail(sessionId: string, callId: string, section: ToolDetailSection, offset = 0): Promise<ToolDetailPage> {
    const target = this.target(sessionId);
    if (!['schema', 'description', 'arguments', 'result', 'mcpDefinition'].includes(section)) invalid('未知的调用快照字段。');
    if (!Number.isSafeInteger(offset) || offset < 0) invalid('offset 必须是非负整数。');
    let record: ToolRecord;
    try { record = this.rt.harness.store.getTool(requiredString(callId, 'callId', 500)); }
    catch { return notFound('调用记录不存在。'); }
    if (record.sessionId !== target.id) notFound('调用记录不属于该会话。');
    const request = this.request(record.requestId);
    const definition = request.body?.tools?.find((tool: any) => tool.function?.name === record.name)?.function;
    // The observer may keep a registered-schema fallback for a refused unknown/unexposed call.
    // Only the captured request body proves which definition was actually sent to the model.
    const value = !request.recordContent ? undefined : section === 'schema' ? definition?.parameters : section === 'description' ? definition?.description
      : section === 'mcpDefinition' ? record.mcpDefinition?.available === true ? record.mcpDefinition : undefined : record[section];
    const available = value !== undefined;
    const unavailableReason = !request.recordContent ? '本次请求关闭了详细内容记录。' : section === 'mcpDefinition'
      ? record.mcpDefinition?.available === false ? '本次调用未保存 MCP 定义正文（详细内容记录已关闭）。' : '本次调用未保存历史 MCP 工具定义。'
      : '本次调用未记录此字段。';
    // Sanitize both known credential values and secret-bearing field names before slicing.
    // Read one record only: no history scan and no accumulated server/client page cache.
    const clean = available ? this.rt.harness.sanitize(value) : undefined;
    const text = !available ? '' : typeof clean === 'string' ? clean : JSON.stringify(clean, (key, item) => SECRET_FIELD.test(key) ? '[credential redacted]' : item, 2);
    if (offset > text.length) invalid('offset 超出调用快照范围。');
    const end = Math.min(offset + 6000, text.length);
    return { callId: record.id, section, available, ...(!available ? { reason: unavailableReason } : {}), text: text.slice(offset, end), offset, totalChars: text.length, sha256: sha256(text), ...(end < text.length ? { nextOffset: end } : {}) };
  }

  async trace(sessionId: string, query: { text?: string; type?: string; cursor?: string } = {}): Promise<TraceView> {
    const target = this.target(sessionId);
    if (target.kind === 'work') this.rt.harness.workTrace.sync();
    const text = typeof query.text === 'string' ? query.text.trim().slice(0, 300).toLowerCase() : '';
    const type = query.type === undefined ? undefined : String(query.type);
    if (type !== undefined && !TRACE_TYPES.has(type as TraceSpanType)) invalid(`未知的 Trace 类型：${type}`);
    let after = 0;
    if (query.cursor !== undefined) {
      if (typeof query.cursor !== 'string' || !/^\d{1,15}$/.test(query.cursor)) invalid('Trace 游标必须是原生 trace 序号。');
      after = Number(query.cursor);
    }
    const origin = Date.parse(target.createdAt);
    const spans: TraceSpan[] = [];
    const requestRoots = new Map<string, TraceEvent | undefined>();
    let consumed = after, consumedCount = 0, exhausted = false;
    while (!exhausted && consumedCount < MAX_TRACE_EVENTS && spans.length < MAX_TRACE_SPANS) {
      const page = this.rt.harness.store.traces({ sessionId: target.id, after: consumed, limit: MAX_TRACE_PAGE });
      if (!page.events.length) { exhausted = true; break; }
      let processed = 0;
      for (const event of page.events) {
        if (consumedCount >= MAX_TRACE_EVENTS || spans.length >= MAX_TRACE_SPANS) break;
        consumed = event.id; consumedCount++; processed++;
        const span = this.spanView(event, origin, requestRoots);
        if (type !== undefined && span.type !== type) continue;
        if (text && !JSON.stringify({ label: span.label, attrs: span.attrs, requestId: span.requestId, payloadRef: span.payloadRef }).toLowerCase().includes(text)) continue;
        spans.push(span);
      }
      // Only mark the scan complete after every event in this native page was processed. If the span
      // or event budget stopped us mid-page, the remaining rows are a real next page even when the
      // store reported no further native page cursor for this fetch.
      if (processed === page.events.length && page.nextCursor === null) exhausted = true;
    }
    const view: InspectorTraceView = { startedAt: target.createdAt, spans, hasMore: !exhausted };
    // Cursor is the last *scanned* native trace id, not the last returned span: a page filtered to
    // zero spans must still advance, and the next page starts strictly after every examined row.
    if (!exhausted && consumed > after) view.nextCursor = String(consumed);
    return view;
  }

  async context(sessionId: string): Promise<ContextView> {
    const target = this.target(sessionId);
    const record = this.rt.harness.store.latestRequest(target.id, target.kind === 'chat' ? 'chat' : 'work');
    // A provider may leave contextWindowTokens unset or 0; that is unknown, not a real zero window.
    const configuredWindow = record?.contextWindowTokens ?? this.rt.harness.profiles.get(target.profileId).provider.contextWindowTokens;
    const windowTokens = Number.isFinite(configuredWindow) && (configuredWindow as number) > 0 ? configuredWindow as number : 0;
    const windowTokensKnown = windowTokens > 0;
    if (!record || !record.recordContent) {
      const exact = Number.isFinite(record?.usage?.prompt_tokens);
      const empty: InspectorContextView = { windowTokens, windowTokensKnown, usedTokens: exact ? record!.usage!.prompt_tokens! : 0, usedTokensEstimated: false, segments: [], omitted: [] };
      return empty;
    }
    const memory = target.memory();
    // ContextView.sha is the canonical *Chat archive* hash. A promoted Work task also exposes its own
    // Kernel message ids; those are real sources for recall but are not Chat archive records, so blindly
    // hashing them through the dual-scope port would attach a chat-provenance hash to a kernel id.
    const archive = target.kind === 'chat' ? memory : target.promoted ? this.rt.harness.originMemory(target.id) : undefined;
    const body = record.body;
    const layers = record.sources.filter(part => !part.id.startsWith('effective:'));
    const history = target.kind === 'chat' ? layers.filter(part => isHistoryPart(part)) : [];
    const meta = this.contextMeta(layers);
    const segments: ContextSegment[] = [];
    this.pushSegment(segments, 'system', '系统与 Harness 约束', layers.filter(part => ['system', 'developer'].includes(part.role) && part.id !== 'context-selection' && part.id !== 'context-manifest').map(part => ({ part })));
    this.pushSegment(segments, 'user', '用户层提示词', layers.filter(part => part.role === 'user' && part.id !== 'archive-navigation' && !isHistoryPart(part)).map(part => ({ part })));
    const memoryPart = layers.find(part => part.id === 'archive-navigation');
    if (memoryPart && isEffective(memoryPart)) segments.push({ id: 'memory', label: '历史回查与持久记忆', kind: 'memory', tokens: memoryPart.estimatedTokens });
    if (target.kind === 'chat') {
      const items = history.filter(isEffective).slice(0, MAX_CONTEXT_ITEMS).map(part => ({
        label: part.label, tokens: Number.isFinite(part.estimatedTokens) ? part.estimatedTokens : estimateText(part.content),
        sourceId: part.id, ...(this.rawSha(memory, part.id) ? { sha: this.rawSha(memory, part.id)! } : {}),
      }));
      if (items.length) segments.push({ id: 'history', label: '对话历史', kind: 'history', tokens: items.reduce((sum, item) => sum + item.tokens, 0), items });
    } else {
      const included = meta.manifest.filter(item => item.included !== false).slice(0, MAX_CONTEXT_ITEMS);
      const items = included.map(item => {
        const message = this.rt.services.kernel.getMessage(item.id);
        const chars = Number.isFinite(item.chars) ? item.chars! : (message?.content.length ?? 0);
        const sha = this.rawSha(archive, item.id);
        return { label: message ? `${message.role} · ${message.createdAt}` : item.id, tokens: estimateText('x'.repeat(chars)), sourceId: item.id, ...(sha ? { sha } : {}) };
      });
      if (items.length) segments.push({ id: 'history', label: '任务历史', kind: 'history', tokens: items.reduce((sum, item) => sum + item.tokens, 0), items });
    }
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    if (tools.length) {
      const items = tools.slice(0, MAX_CONTEXT_ITEMS).map((tool: any) => ({ label: String(tool?.function?.name ?? 'tool'), tokens: estimateJson(tool) }));
      segments.push({ id: 'tools', label: '工具定义', kind: 'tools', tokens: items.reduce((sum, item) => sum + item.tokens, 0), items });
    }
    const reserve = body?.max_tokens ?? body?.max_completion_tokens;
    if (Number.isFinite(reserve)) segments.push({ id: 'reserve', label: '输出预留', kind: 'reserve', tokens: Number(reserve) });
    const omitted: ContextView['omitted'] = [];
    const ids = new Set<string>(meta.omittedIds);
    if (target.kind === 'chat') for (const part of history) if (!isEffective(part)) ids.add(part.id);
    for (const id of [...ids].slice(0, MAX_OMITTED)) {
      if (!archive) break;
      try {
        const page = archive.read({ id, length: 1 });
        omitted.push({ sourceId: id, label: `${page.role} · ${page.createdAt}`, tokens: estimateText('x'.repeat(page.totalChars)), sha: page.sha256 });
      } catch (error) { if (!/Source not found/i.test(messageOf(error))) throw error; }
    }
    const usageExact = Number.isFinite(record.usage?.prompt_tokens);
    const used = usageExact ? record.usage!.prompt_tokens! : segments.reduce((sum, segment) => sum + segment.tokens, 0);
    const view: InspectorContextView = { windowTokens, windowTokensKnown, usedTokens: used, usedTokensEstimated: !usageExact, segments, omitted };
    return view;
  }

  async recall(sessionId: string, sourceId: string, offset?: number): Promise<RecallPage> {
    const target = this.target(sessionId);
    const id = requiredString(sourceId, 'sourceId', 200);
    const start = offset === undefined ? 0 : boundedInteger(offset, 'offset', 0, 1_000_000_000);
    const memory = target.memory();
    if (!memory) notFound(target.promoted ? '该 Work 会话的原始 Chat 归档当前不可用。' : '该会话没有可回查的原始归档。');
    try {
      const page = memory.read({ id, offset: start, length: MAX_RECALL_CHARS });
      return { sourceId: id, sha: page.sha256, offset: page.offset, text: page.text, ...(page.nextOffset === null ? {} : { nextOffset: page.nextOffset }) };
    } catch (error) {
      if (/Source not found/i.test(messageOf(error))) notFound('原始记录不存在或不在当前会话作用域内。');
      throw error;
    }
  }

  async diffs(sessionId: string): Promise<FileDiff[]> {
    const target = this.target(sessionId);
    // Work 工具记录来自 Kernel 事件；先同步，避免把已应用的真实回执当成“尚无 Diff”。
    if (target.kind === 'work') this.rt.harness.workTrace.sync();
    const records = this.rt.harness.store.toolCalls({ sessionId: target.id, ...(target.kind === 'work' ? { taskId: target.id } : {}), limit: 500 }).reverse();
    const known = new Map<string, string>();
    const diffs: FileDiff[] = [];
    for (const record of records) {
      if (record.name === 'read_file' && record.status === 'completed' && typeof record.result === 'string') {
        const file = typeof record.arguments.path === 'string' ? record.arguments.path : '';
        if (file) known.set(file, record.result);
        continue;
      }
      if (record.name !== 'write_file' || record.status !== 'completed') continue;
      const intent = record.intentId ? this.rt.services.kernel.getIntent(record.intentId) : undefined;
      if (intent?.state !== 'applied') continue;
      const receipt = intent.receipt ?? {};
      const path = typeof record.arguments.path === 'string' ? record.arguments.path : typeof receipt.path === 'string' ? receipt.path : '';
      const content = typeof record.arguments.content === 'string' ? record.arguments.content : undefined;
      if (!path || content === undefined) throw new ProductError('unsupported', '已执行的写入缺少路径或内容回执，无法生成可审阅的 Diff。');
      if (typeof receipt.sha256 !== 'string') throw new ProductError('unsupported', `已执行的写入没有 SHA 回执，无法核对 ${path} 的实际内容。`);
      if (sha256(content) !== receipt.sha256) throw new ProductError('unsupported', `写入回执 SHA 与工具参数不一致：${path}`);
      const baseline = record.arguments.expectedSha256;
      if (baseline === undefined) throw new ProductError('unsupported', `${path} 的写入没有写入前基线 SHA，无法判断是新增还是修改。`);
      let previous = '', status: FileDiff['status'] = 'added';
      if (baseline !== null) {
        const candidate = known.get(path);
        if (candidate === undefined || sha256(candidate) !== String(baseline)) throw new ProductError('unsupported', `无法验证 ${path} 的写入前原文（只有基线 SHA，没有可核对的 read_file 回执），因此不生成行级 Diff。`);
        previous = candidate; status = 'modified';
      }
      const diff = unifiedDiff(previous, content);
      diffs.push({ path, status, additions: diff.additions, deletions: diff.deletions, hunks: [diff.hunk], toolCallId: record.toolCallId, applied: true });
      known.set(path, content);
      if (diffs.length >= MAX_DIFFS) break;
    }
    return diffs;
  }

  // ---------- prompt helpers ----------

  private promptFromRecord(record: RequestRecord, pendingEdits = 0): PromptView {
    if (!record.recordContent) return { requestId: record.id, parts: [], totalTokens: 0, pendingEdits };
    return this.promptView(record.sources, record.body, record, pendingEdits);
  }

  private promptView(sources: NativePromptPart[], body: RequestBody | undefined, record: RequestRecord | undefined, pendingEdits = 0): PromptView {
    const parts: PromptPartView[] = [];
    for (const source of sources) {
      if (parts.length >= MAX_PROMPT_PARTS) break;
      parts.push({
        id: source.id, label: source.label, role: roleOf(source.role), scope: source.scope, source: source.source,
        content: boundedText(source.content ?? '', MAX_PROMPT_CHARS),
        tokens: Number.isFinite(source.estimatedTokens) ? source.estimatedTokens : estimateText(source.content ?? ''),
        tokensExact: false, effective: isEffective(source), merge: mergeOf(source),
        editable: promptFieldOf(source.id) !== undefined && !lockedPrompt(source.id),
        ...(source.overriddenBy ? { overriddenBy: source.overriddenBy } : {}),
        ...(source.version === undefined ? {} : { version: source.version }),
      });
    }
    const exact = record?.usage?.prompt_tokens;
    let totalTokens: number;
    if (Number.isFinite(exact)) totalTokens = exact as number;
    else {
      const assembled = parts.filter(part => part.id.startsWith('effective:') && part.effective);
      totalTokens = assembled.length ? assembled.reduce((sum, part) => sum + part.tokens, 0) : estimateJson(body ?? {});
    }
    return { ...(record ? { requestId: record.id } : {}), parts, totalTokens, totalTokensExact: Number.isFinite(exact), pendingEdits };
  }

  private async preview(input: Record<string, unknown>): Promise<RequestRecord> {
    try { return await this.rt.harness.preview(input); }
    catch (error) { throw inputFailure(error); }
  }

  // ---------- request helpers ----------

  private requestView(record: RequestRecord): RequestRecordView {
    const body = record.recordContent ? record.wireBody ?? record.body ?? null : null;
    const response = record.recordContent && record.response ? {
      content: boundedText(record.response.content, MAX_RESPONSE_CHARS),
      finishReason: record.response.finishReason,
      ...(record.response.toolCalls.length ? { toolCalls: record.response.toolCalls.slice(0, 32).map(call => ({ name: call.name, arguments: boundedText(JSON.stringify(call.arguments), 4_000) })) } : {}),
    } : undefined;
    const model = record.model ?? (typeof record.body?.model === 'string' ? record.body.model : 'unknown');
    return {
      id: record.id, kind: record.kind, status: record.status, createdAt: record.createdAt,
      model, endpoint: record.endpoint, body, redactions: redactionPaths(body),
      ...(Number.isFinite(record.durationMs) ? { durationMs: record.durationMs } : {}),
      ...(usageView(record.usage) ? { usage: usageView(record.usage)! } : {}),
      ...(response ? { response } : {}),
      ...(record.error ? { error: { code: record.error.code, message: boundedText(record.error.message, 4_000) } } : {}),
      ...(record.parentId ? { parentId: record.parentId } : {}),
      ...(record.parentId ? { branchLabel: record.status === 'draft' ? '分叉草稿' : '重放' } : {}),
    };
  }

  private async settle(id: string): Promise<RequestRecord> {
    const deadline = Date.now() + REPLAY_SETTLE_MS;
    for (;;) {
      const record = this.request(id);
      if (record.status !== 'draft' && record.status !== 'running') return record;
      if (Date.now() >= deadline) return record;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  // ---------- tools helpers ----------

  private definitionView(item: unknown): ToolDefinitionView | undefined {
    if (!item || typeof item !== 'object') return undefined;
    const value = item as Record<string, unknown>;
    const fn = (value.function && typeof value.function === 'object' ? value.function : value) as Record<string, unknown>;
    const name = typeof fn.name === 'string' ? fn.name : '';
    if (!name) return undefined;
    const spec = classifyTool(name);
    const source = toolSourceView(name, typeof value.source === 'string' ? value.source : undefined);
    return {
      name, source,
      description: boundedText(typeof fn.description === 'string' ? fn.description : '', 2_000),
      capability: spec?.capability ?? (source === 'mcp' ? 'mcp' : 'read'),
      schema: fn.parameters ?? fn.schema ?? {},
    };
  }

  private definitionName(item: unknown): string | undefined {
    if (!item || typeof item !== 'object') return undefined;
    const value = item as Record<string, unknown>;
    const fn = (value.function && typeof value.function === 'object' ? value.function : value) as Record<string, unknown>;
    return typeof fn.name === 'string' ? fn.name : undefined;
  }

  private chatAllowed(registered: ToolDefinitionView[], chat: ChatSession): string[] {
    // 真实 Chat 执行器只执行 memory 工具与 capabilities 明确打开的只读工具；原生 inspectTools 的
    // allowed 在 capabilities.tools 为 true 时会列出 write_file/run_*，不能直接透传给前端。
    const executable = new Set<string>(MEMORY_TOOL_NAMES);
    if (chat.capabilities.tools) for (const name of CHAT_READ_TOOLS) executable.add(name);
    if (chat.capabilities.web) for (const name of CHAT_WEB_TOOLS) executable.add(name);
    const allowed: string[] = [];
    for (const definition of registered) if (executable.has(definition.name) && !allowed.includes(definition.name)) allowed.push(definition.name);
    return allowed;
  }

  private exposedNames(record: RequestRecord | undefined): string[] {
    if (!record) return [];
    const tools = record.body?.tools;
    const names = Array.isArray(tools) ? tools.map((tool: any) => typeof tool?.function?.name === 'string' ? tool.function.name as string : '').filter(Boolean) : [];
    if (names.length) return names;
    return Array.isArray(record.exposedToolNames) ? record.exposedToolNames.filter((name): name is string => typeof name === 'string') : [];
  }

  /**
   * Work approvals the operator surface may point at. Kernel.pendingApprovals is the authority for
   * "a human can act on this now" (prepared + policy outcome ask); this only narrows it to calls the
   * Inspector is actually rendering: same task, current generation/policy epoch and a task that is
   * really waiting. A dispatched effect cannot still be prepared (dispatch moves it to sent), so the
   * prepared check also proves no attempt was dispatched. Chat never receives an approval id.
   */
  private actionableApprovalIds(taskId: string): Set<string> {
    const ids = new Set<string>();
    for (const { intent, task } of this.rt.services.kernel.pendingApprovals({ taskId, limit: 200 })) {
      if (intent.state !== 'prepared' || intent.authorization?.decision !== 'ask') continue;
      if (task.id !== intent.taskId || intent.generation !== task.generation || intent.policyEpoch !== task.policyEpoch) continue;
      if (task.status !== 'waiting_approval') continue;
      ids.add(intent.id);
    }
    return ids;
  }

  private callView(record: ToolRecord, pendingApprovalIds?: Set<string>): ToolCallView {
    const intent = record.intentId ? this.rt.services.kernel.getIntent(record.intentId) : undefined;
    const spec = classifyTool(record.name);
    const source = toolSourceView(record.name, record.source);
    const result = toolResult(record, intent?.receipt);
    const error = toolError(record);
    const status = toolStatus(record);
    // Only the call that is currently blocked on a real, still-actionable intent gets a clickable id.
    const approvalId = status === 'awaiting_approval' && record.intentId !== undefined && pendingApprovalIds?.has(record.intentId) ? record.intentId : undefined;
    return {
      // Provider call ids are request-local and can repeat after pause/resume or a later round.
      // Keep the persisted request-qualified identity so current and historical cards cannot collide.
      id: record.id, name: record.name, title: toolTitle(record), source,
      sessionId: record.sessionId, taskId: record.taskId, runId: record.runId, toolCallId: record.toolCallId,
      ...(record.parentId ? { parentRequestId: record.parentId } : {}),
      capability: intent?.authorization?.capability ?? spec?.capability ?? (source === 'mcp' ? 'mcp' : 'read'),
      risk: intent?.authorization?.risk ?? spec?.risk ?? 'high',
      args: boundedValue(record.arguments ?? {}) as Record<string, unknown>,
      status, requestId: record.requestId, startedAt: record.createdAt,
      ...(approvalId ? { approvalId } : {}),
      ...(Number.isFinite(record.durationMs) ? { durationMs: record.durationMs } : {}),
      retries: Number.isFinite(record.retries) ? record.retries : 0,
      ...(result ? { result } : {}), ...(error ? { error } : {}),
      ...(record.receivedByRequestId ? { receivedByRequestId: record.receivedByRequestId } : {}),
      ...(record.review ? { review: reviewView(record.review) } : {}),
    };
  }

  // ---------- trace helpers ----------

  private spanView(event: TraceEvent, origin: number, roots: Map<string, TraceEvent | undefined>): TraceSpan {
    const timestamp = Date.parse(event.timestamp);
    const attrs = traceAttrs(event);
    const first = (requestId: string) => {
      if (!roots.has(requestId)) roots.set(requestId, this.rt.harness.store.traces({ sessionId: event.sessionId, requestId, limit: 1 }).events[0]);
      return roots.get(requestId);
    };
    // Parent IDs refer to real event rows. Native parentId is often a request/task ID,
    // so preserve that separately rather than pretending it is an event identifier.
    const root = event.requestId ? first(event.requestId) : undefined;
    const parent = root && root.id !== event.id ? root : event.parentId ? first(event.parentId) : undefined;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
    const child = typeof payload.childTaskId === 'string' ? this.rt.services.kernel.getTask(payload.childTaskId) : undefined;
    return {
      id: `trace-${event.id}`, type: traceTypeOf(event.type), label: traceLabel(event), status: traceStatus(event.status),
      sessionId: event.sessionId, taskId: event.taskId, runId: event.runId,
      ...(parent && parent.id !== event.id ? { parentId: `trace-${parent.id}` } : {}),
      ...(event.parentId ? { sourceParentId: event.parentId } : {}),
      ...(child && event.taskId && child.parentId === event.taskId ? { childSessionId: child.id } : {}),
      startMs: Number.isFinite(timestamp) && Number.isFinite(origin) ? Math.round(timestamp - origin) : 0,
      durationMs: typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) ? event.durationMs : 0,
      ...(event.requestId ? { requestId: event.requestId } : {}),
      ...(event.payloadReference ? { payloadRef: event.payloadReference } : {}),
      ...(attrs ? { attrs } : {}),
    };
  }

  // ---------- context helpers ----------

  private contextMeta(layers: NativePromptPart[]): ContextMeta {
    const part = layers.find(item => item.id === 'context-selection' || item.id === 'context-manifest');
    if (!part) return { omittedIds: [], manifest: [] };
    try {
      const value = JSON.parse(part.content) as { omittedIds?: unknown; sources?: unknown };
      const omittedIds = Array.isArray(value.omittedIds) ? value.omittedIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_OMITTED * 4) : [];
      const manifest = Array.isArray(value.sources) ? value.sources.flatMap((source): ContextMeta['manifest'] => {
        if (!source || typeof source !== 'object') return [];
        const item = source as Record<string, unknown>;
        if (typeof item.id !== 'string') return [];
        return [{ id: item.id, ...(typeof item.chars === 'number' ? { chars: item.chars } : {}), ...(typeof item.included === 'boolean' ? { included: item.included } : {}) }];
      }) : [];
      return { omittedIds, manifest };
    } catch { return { omittedIds: [], manifest: [] }; }
  }

  private rawSha(memory: ScopedMemoryPort | undefined, id: string): string | undefined {
    if (!memory) return undefined;
    try { return memory.read({ id, length: 1 }).sha256; }
    catch (error) { if (/Source not found/i.test(messageOf(error))) return undefined; throw error; }
  }

  private pushSegment(segments: ContextSegment[], kind: ContextSegment['kind'], label: string, entries: { part: NativePromptPart }[]): void {
    const parts = entries.map(entry => entry.part).filter(isEffective);
    if (!parts.length) return;
    const items = parts.slice(0, MAX_CONTEXT_ITEMS).map(part => ({ label: part.label, tokens: Number.isFinite(part.estimatedTokens) ? part.estimatedTokens : estimateText(part.content) }));
    segments.push({ id: kind, label, kind, tokens: items.reduce((sum, item) => sum + item.tokens, 0), items });
  }

  // ---------- target/route helpers ----------

  private target(input: string): InspectorTarget {
    const id = requiredString(input, 'sessionId', 200);
    const index = this.rt.store.getSession(id);
    let kind: 'chat' | 'work' | undefined = index?.kind;
    let chat: ChatSession | undefined;
    let task: Task | undefined;
    if (kind === 'chat') chat = this.chat(id);
    else if (kind === 'work') task = this.task(id);
    else if (id.startsWith('chat-')) { chat = this.chat(id); kind = 'chat'; }
    else { task = this.rt.services.kernel.getTask(id); if (task) kind = 'work'; }
    if (kind === 'chat') {
      if (!chat) chat = this.chat(id);
      return { id, kind, chat, createdAt: chat.createdAt, ...(chat.workspace ? { workspace: chat.workspace } : {}), profileId: chat.profileId, promoted: false,
        memory: () => this.rt.harness.store.memory(id) };
    }
    if (kind === 'work') {
      if (!task) task = this.task(id);
      // A branched Work task has an immutable origin just like a promoted one; the Harness resolves that link
      // (including branch-of-branch and branch-of-promoted chains) so Inspector does not duplicate link logic.
      const promoted = Boolean(this.rt.harness.originMemory(id));
      return { id, kind, task, createdAt: task.createdAt, workspace: task.workspace, profileId: this.rt.harness.requests.profileId({ taskId: id }), promoted,
        memory: () => this.memoryOf(id) };
    }
    return notFound('会话不存在或已被移除。');
  }

  /**
   * A branched or promoted Work task owns two canonical scopes: its live Kernel archive and the immutable origin
   * prefix (source Task at the selected message, or source Chat at promotion). Inspector recall accepts either
   * canonical source id, so a read tries the live scope and falls back to the origin only on a genuine scope miss.
   * Both ports are task-scoped, so another conversation's id is never visible. Message ids are UUIDs in both
   * archives; in the impossible collision case the live record wins deterministically instead of merging SHAs.
   */
  private memoryOf(taskId: string): ScopedMemoryPort {
    const current = this.rt.services.kernel.memory(taskId, 'main');
    const origin = this.rt.harness.originMemory(taskId);
    if (!origin) return current; // degraded but truthful: the live scope is still readable
    return {
      manifest: () => ({ ...current.manifest(), messages: current.manifest().messages + origin.manifest().messages }),
      search: input => current.search(input),
      read: input => {
        try { return current.read(input); }
        catch (error) {
          if (!/Source not found/i.test(messageOf(error))) throw error;
          return origin.read(input);
        }
      },
      remember: (input, operationId) => current.remember(input, operationId),
      notes: input => current.notes(input),
      context: (query, maxChars) => current.context(query, maxChars),
    };
  }

  private chat(id: string): ChatSession {
    try { return this.rt.harness.store.getSession(id); }
    catch (error) { if (/not found/i.test(messageOf(error))) notFound('会话不存在或已被移除。'); throw error; }
  }

  private task(id: string): Task {
    const task = this.rt.services.kernel.getTask(id);
    if (!task) notFound('会话不存在或已被移除。');
    return task;
  }

  private request(id: string): RequestRecord {
    try { return this.rt.harness.store.getRequest(id); }
    catch (error) { if (/not found/i.test(messageOf(error))) notFound('请求不存在或已被清理。'); throw error; }
  }

  private async call(method: string, path: string, input: Record<string, unknown>): Promise<unknown> {
    try { return await this.rt.harness.route(method, new URL(`http://inspector.local${path}`), input); }
    catch (error) { throw inputFailure(error); }
  }
}

/** 工厂：按产品运行时构造 Inspector 领域适配器。 */
export function ProductInspector(rt: ProductRuntime): InspectorDomain {
  return new Inspector(rt);
}
