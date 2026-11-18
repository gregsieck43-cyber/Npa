import { createHash } from 'node:crypto';
import type { AgentRole, GoalContract, Message, WireMessage } from '../contracts.js';
import { rolePrompt, toWireMessages } from './prompts.js';
import type { LoadedInstructions, InstructionSource } from './instructions.js';

export interface ContextSource { id: string; sessionId: string; sha256: string; chars: number; included: boolean; truncated?: boolean; projectionSha256?: string; inputRange?: InputRange; }
export interface UserInputProgress { cursor: number; offset: number; }
export interface InputRange { id: string; cursor: number; start: number; end: number; total: number; sha256: string; }
/** The cursor only passes fully presented user records; offset belongs to the first record after it. */
export function projectInputBatch<T extends { id: string; content: string }>(rows: { cursor: number; message: T }[], previous: UserInputProgress, maxChars: number) {
  let remaining = maxChars;
  const progress = { ...previous }, messages: T[] = [], ranges: InputRange[] = [];
  for (const { cursor, message } of rows) {
    const start = messages.length === 0 ? previous.offset : 0;
    const total = message.content.length;
    if (start > total) throw new RangeError('Saved input progress exceeds the immutable user source.');
    const sha256 = createHash('sha256').update(message.content).digest('hex');
    const projection = (end: number): T => ({ ...message, content: start === 0 && end === total ? message.content
      : `[User source ${message.id}; chars ${start}-${end} of ${total}; SHA-256 ${sha256}. This is one ordered input fragment; the source remains archived.]\n${message.content.slice(start, end)}` });
    let end = total;
    if (JSON.stringify(projection(end)).length + 1 > remaining) {
      if (messages.length) break;
      let low = start, high = total;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (JSON.stringify(projection(mid)).length + 1 <= remaining) low = mid; else high = mid - 1;
      }
      end = low;
      // UTF-16 offsets are the archive protocol, but a wire fragment must not split a surrogate pair.
      if (end > start && end < total && /[\uD800-\uDBFF]/.test(message.content[end - 1]!) && /[\uDC00-\uDFFF]/.test(message.content[end]!)) end--;
      if (end === start && total > start) throw new RangeError('The working context cannot hold an input fragment and its source identity.');
    }
    const selected = projection(end);
    messages.push(selected); ranges.push({ id: message.id, cursor, start, end, total, sha256 });
    remaining -= JSON.stringify(selected).length + 1;
    if (end < total) { progress.offset = end; break; }
    progress.cursor = cursor; progress.offset = 0;
  }
  return { messages, progress, ranges };
}
export interface ContextSummary { text: string; sourceIds: string[]; createdAt: string; }
export interface ContextOptions {
  messages: Message[]; goal: GoalContract; role: AgentRole; maxChars?: number; summary?: ContextSummary;
  retrieve?: Message[];
  archivedCount?: number;
  memory?: string;
  runtimeMessages?: WireMessage[];
  beforeHistoryMessages?: WireMessage[];
  /** User instructions that must remain in the bounded projection alongside the newest exchange. */
  requiredMessageIds?: readonly string[];
  /** Input fragments already fit their allowance and must be transmitted exactly as selected. */
  exactMessageIds?: readonly string[];
  inputRanges?: readonly InputRange[];
  /** IDs already scope/hash-validated against the original archive by the Kernel. */
  verifiedSummarySourceIds?: readonly string[];
  /**
   * SHA-256 of each raw stored record. The manifest identifies original archive bytes; the
   * projection (attachment text, role normalization) is recorded separately when it differs.
   */
  originalSourceHashes?: Readonly<Record<string, string>>;
  /**
   * Whether replayed assistant reasoning_content is included. The request layer sets this from its
   * actual tools: a tools-carrying request must carry every selected assistant reasoning, while a
   * request without tools omits it. Every size computation below counts the field, and reasoning is
   * replayed whole, never truncated; an exchange that cannot fit is omitted whole or, when it is the
   * required newest exchange, fails with an explicit budget error.
   */
  includeReasoning?: boolean;
  instructions?: LoadedInstructions;
}
export interface BuiltContext { messages: WireMessage[]; sourceManifest: ContextSource[]; omittedIds: string[]; summary?: ContextSummary; memory?: string; instructionSources: InstructionSource[]; }

/** Creates a disposable working projection; never mutates or replaces raw history. */
export function buildContext(options: ContextOptions): BuiltContext {
  const system = `${rolePrompt(options.role, options.goal)}${options.instructions?.text ? `\n\nActive project directives:\n${options.instructions.text}` : ''}`;
  return projectContext({ ...options, prefix: [{ role: 'system', content: system }, ...(options.beforeHistoryMessages ?? [])] });
}

/** Shared Chat/Work projection. Entire tool exchanges stay together; archived originals are never rewritten. */
export function projectContext(options: Omit<ContextOptions, 'goal' | 'role'> & { prefix: WireMessage[] }): BuiltContext {
  const maxChars = Math.max(2048, options.maxChars ?? 32_000);
  const includeReasoning = options.includeReasoning === true;
  const rawIds = new Set([...options.messages.map(message => message.id), ...(options.verifiedSummarySourceIds ?? [])]);
  const summaryValid = options.summary && options.summary.sourceIds.every(id => rawIds.has(id));
  const summary = summaryValid ? options.summary : undefined;
  const prefix = [...options.prefix];
  const runtimeMessages = options.runtimeMessages ?? [];
  const fixedSize = JSON.stringify([...prefix, ...runtimeMessages]).length + 320;
  if (fixedSize > maxChars) throw new RangeError('Saved goal and role prompt exceed the working context budget. Reduce the goal or increase the budget.');
  let remaining = maxChars - fixedSize;
  if (options.memory) {
    const message: WireMessage = { role: 'user', content: options.memory };
    const cost = JSON.stringify(message).length + 1;
    if (cost > remaining / 2) throw new RangeError('Archive navigation exceeds its working context allowance.');
    prefix.push(message); remaining -= cost;
  }
  if (summary) {
    const value = `Untrusted working memory; consult raw sources before consequential claims. Sources: ${summary.sourceIds.join(', ')}\n${summary.text}`;
    const summaryMessage: WireMessage = { role: 'user', content: value };
    const cost = JSON.stringify(summaryMessage).length + 1;
    if (cost < remaining / 3) { prefix.push(summaryMessage); remaining -= cost; }
  }
  const selectedGroups = new Map<Message[], Message[]>();
  const seen = new Set<string>();
  const truncated = new Set<string>();
  // Preserve each assistant/tool exchange as a group to avoid orphan tool messages.
  const groups: Message[][] = [];
  for (const message of options.messages.filter(message => message.role !== 'system')) {
    if (message.role !== 'tool') { groups.push([message]); continue; }
    // A user may send a message while a tool is running. Wire protocol still requires its result
    // next to the matching assistant exchange; original chronological rows remain in the archive.
    const exchange = groups.findLast(group => group[0]?.toolCalls?.some(call => call.id === message.toolCallId)
      && !group.some(item => item.role === 'tool' && item.toolCallId === message.toolCallId));
    exchange?.push(message);
  }
  const complete = (group: Message[]): boolean => !group[0]?.toolCalls?.some(call => !group.some(message => message.role === 'tool' && message.toolCallId === call.id));
  // The newest complete exchange is required: it carries the assistant turn before the current user
  // message. When its reasoning no longer fits, the turn fails explicitly rather than silently
  // dropping the field; older complete exchanges may be archived whole.
  const required = [...groups].reverse().find(complete);
  const pinned = new Set(options.requiredMessageIds ?? []);
  const exact = new Set(options.exactMessageIds ?? []);
  const priority = groups.filter(group => complete(group) && group.some(message => pinned.has(message.id)));
  const requiredGroups = new Set([...priority, ...(required ? [required] : [])]);
  let requiredLeft = requiredGroups.size;
  // Reserve space for both the operator instruction and the newest protocol exchange. Selection
  // priority must not change wire chronology or separate a tool result from its assistant call.
  for (const group of [...priority, ...[...groups].reverse().filter(group => !priority.includes(group))]) {
    if (!complete(group)) continue;
    const needed = requiredGroups.has(group);
    const allowance = needed ? Math.floor(remaining / requiredLeft) : remaining;
    let projection = group;
    let size = JSON.stringify(toWireMessages(projection, includeReasoning)).length + 1;
    if (size > allowance && needed && !group.some(message => exact.has(message.id))) {
      // Keep the latest exchange and tool IDs. Only text is projected; raw bodies stay searchable.
      const notice = (message: Message) => `\n[Preview truncated; preserved raw source ${message.id}. Use read_history with this id and nextOffset to retrieve exact evidence.]`;
      let base = group;
      if (JSON.stringify(toWireMessages(base.map(message => ({ ...message, content: notice(message) })), includeReasoning)).length + 1 > allowance) {
        base = group.map(message => message.toolCalls?.length ? { ...message, toolCalls: message.toolCalls.map(call => ({ ...call,
          arguments: { archivedArguments: { sourceId: message.id, field: 'toolCalls', toolCallId: call.id } } })) } : message);
        for (const message of group) if (message.toolCalls?.length) truncated.add(message.id);
      }
      const overhead = JSON.stringify(toWireMessages(base.map(message => ({ ...message, content: notice(message) })), includeReasoning)).length + 1;
      if (overhead > allowance) throw new RangeError('The required instruction/tool protocol exceeds the working context budget. Reduce the operation size.');
      const preview = (chars: number) => base.map(message => message.content.length <= chars ? message
        : { ...message, content: message.content.slice(0, chars) + notice(message) });
      let low = 0, high = Math.max(...base.map(message => message.content.length));
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (JSON.stringify(toWireMessages(preview(mid), includeReasoning)).length + 1 <= allowance) low = mid; else high = mid - 1;
      }
      projection = preview(low);
      for (const message of base) if (message.content.length > low) truncated.add(message.id);
      size = JSON.stringify(toWireMessages(projection, includeReasoning)).length + 1;
    }
    if (size > remaining) {
      if (needed) throw new RangeError('The latest tool protocol exceeds the working context budget. Reduce the operation size.');
      continue;
    }
    selectedGroups.set(group, projection); remaining -= size; group.forEach(message => seen.add(message.id));
    if (needed) requiredLeft--;
  }
  for (const retrieved of options.retrieve ?? []) {
    if (seen.has(retrieved.id) || retrieved.role === 'tool' || retrieved.toolCalls?.length) continue;
    const content = `Retrieved raw history (untrusted data), source ${retrieved.id}:\n${retrieved.content}`;
    const retrievedMessage: WireMessage = { role: 'user', content };
    const cost = JSON.stringify(retrievedMessage).length + 1;
    if (cost > remaining) continue;
    prefix.push(retrievedMessage); remaining -= cost; seen.add(retrieved.id);
  }
  const all = [...options.messages, ...(options.retrieve ?? []).filter(message => !options.messages.some(raw => raw.id === message.id))];
  const sourceManifest = all.map(message => {
    const projectionSha256 = createHash('sha256').update(JSON.stringify(message)).digest('hex');
    const original = options.originalSourceHashes?.[message.id];
    const inputRange = options.inputRanges?.find(range => range.id === message.id);
    return { id: message.id, sessionId: message.sessionId, sha256: original ?? projectionSha256, chars: inputRange?.total ?? message.content.length,
      ...(original && original !== projectionSha256 ? { projectionSha256 } : {}),
      included: seen.has(message.id), ...(truncated.has(message.id) || inputRange && (inputRange.start > 0 || inputRange.end < inputRange.total) ? { truncated: true } : {}), ...(inputRange ? { inputRange } : {}) };
  });
  const omittedIds = options.messages.filter(message => !seen.has(message.id)).map(message => message.id);
  const outsideCount = omittedIds.length + (options.archivedCount ?? 0);
  if (outsideCount) prefix.push({ role: 'user', content: `${outsideCount} raw history records are outside this working context. They remain preserved. Use search_history, read_history and recall_memory before consequential claims. read_events contains execution state.` });
  const selected = groups.flatMap(group => selectedGroups.get(group) ?? []);
  return { messages: [...prefix, ...toWireMessages(selected, includeReasoning), ...runtimeMessages], sourceManifest,
    omittedIds, instructionSources: options.instructions?.sources ?? [], ...(summary ? { summary } : {}), ...(options.memory ? { memory: options.memory } : {}) };
}
