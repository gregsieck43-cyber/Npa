import { authHeaders, endpoint, normalizeWire, wireBody } from './provider-wire.js';
import type { ModelResult, ProviderConfig, ToolCall, ToolDefinition, WireMessage } from '../contracts.js';
import { resourceBudget } from '../app/resource-budget.js';

export const DEFAULT_PROVIDER: ProviderConfig = {
  baseUrl: 'https://api.commandcode.ai/provider/v1', model: 'deepseek/deepseek-v4.1-flash',
  mode: 'live', timeoutMs: 60_000, maxOutputTokens: 4096, maxRequestBytes: 131_072,
};
export type ModelErrorCode = 'unauthorized' | 'rate_limited' | 'provider_unavailable' | 'http_error' | 'timeout' | 'cancelled' | 'connection_failed' | 'invalid_response' | 'truncated_stream' | 'context_limit' | 'input_limit' | 'credential_required' | 'resource_pressure';
export class ModelDiagnosticError extends Error {
  constructor(public readonly code: ModelErrorCode, message: string, public readonly retryable = false,
    public readonly retryAfterMs?: number, public readonly status?: number) {
    super(message); this.name = 'ModelDiagnosticError';
  }
}
export interface ModelDelta {
  content?: string;
  /** Readable provider reasoning text, forwarded while streaming; never inferred from answer content. */
  reasoningContent?: string;
  /** Display-only provider fragments; complete tool arguments are validated in the final result. */
  toolCalls?: { index: number; id?: string; name?: string; arguments?: string }[];
}
export interface ModelObserver {
  prepare(body: Record<string, any>): { body: Record<string, any>; requestId: string };
  completed(result: ModelResult, durationMs: number): void;
  failed(error: unknown, durationMs: number): void;
  delta?(delta: ModelDelta): void;
  /** Called only after URL/credential/cancellation checks, immediately before the single fetch. */
  dispatching?(): void;
  responseObserved?(): void;
}

/** Validate the supported Chat Completions wire format once at the provider boundary. */
export function validateRequestBody(body: Record<string, any>, config: ProviderConfig): void {
  const invalid = (message: string): never => { throw new ModelDiagnosticError('invalid_response', message); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Request JSON must be an object.');
  if (typeof body.model !== 'string' || !body.model.trim()) invalid('Request model must be a non-empty string.');
  if (body.model !== config.model) invalid('Request model must match the selected provider profile. Select and authorize a matching profile before changing models.');
  if (!Array.isArray(body.messages) || !body.messages.length) invalid('Request messages must be a non-empty array.');
  for (const message of body.messages) {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) invalid('Unsupported message role.');
    if (message.role === 'developer' && !config.supportsDeveloper) invalid('This provider profile has not enabled developer messages.');
    if (message.content !== null && typeof message.content !== 'string' && !Array.isArray(message.content)) invalid('Message content must be text, a content-part array, or null.');
    // reasoning_content is official assistant text returned beside content; tools-enabled requests may echo it back.
    if (message.reasoning_content !== undefined && (message.role !== 'assistant' || typeof message.reasoning_content !== 'string')) invalid('reasoning_content is supported only as assistant text in a tool-call continuation.');
    if (message.role === 'tool' && typeof message.tool_call_id !== 'string') invalid('Tool messages require tool_call_id.');
    if (message.tool_calls !== undefined) callsFromWire(message.tool_calls);
  }
  for (const key of ['max_tokens', 'max_completion_tokens']) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1 || body[key] > 131072)) invalid(`${key} must be an integer from 1 to 131072.`);
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) invalid('Choose max_tokens or max_completion_tokens, not both.');
  const outputLimit = body.max_tokens ?? body.max_completion_tokens;
  if (outputLimit === undefined || outputLimit > config.maxOutputTokens) invalid(`Request requires an explicit output token limit no greater than the provider profile allowance (${config.maxOutputTokens}).`);
  for (const [key, minimum, maximum] of [['temperature', 0, 2], ['top_p', 0, 1], ['frequency_penalty', -2, 2], ['presence_penalty', -2, 2]] as const) {
    if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < minimum || body[key] > maximum)) invalid(`${key} must be between ${minimum} and ${maximum}.`);
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be boolean.');
  if (body.stream === false && body.stream_options !== undefined) invalid('stream_options requires stream=true.');
  if (body.n !== undefined && body.n !== 1) invalid('This workbench supports one completion per request (n=1). Fork the request for comparisons.');
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 128) invalid('tools must be an array with at most 128 definitions.');
    const names = new Set<string>();
    for (const tool of body.tools) {
      if (tool?.type !== 'function' || typeof tool.function?.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name)) invalid('Tools require a function with a valid name.');
      if (names.has(tool.function.name)) invalid(`Duplicate tool name: ${tool.function.name}`);
      names.add(tool.function.name);
      if (tool.function.parameters !== undefined && (typeof tool.function.parameters !== 'object' || tool.function.parameters === null || Array.isArray(tool.function.parameters))) invalid('Tool parameters must be a JSON Schema object.');
    }
  }
  if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(body.tool_choice)) {
    if (body.tool_choice?.type !== 'function' || typeof body.tool_choice.function?.name !== 'string' || !body.tools?.some((tool: any) => tool.function.name === body.tool_choice.function.name)) invalid('tool_choice must name an exposed function or use auto/none/required.');
  }
  for (const key of Object.keys(body)) if (/^(?:api[_-]?key|authorization|headers|base[_-]?url)$/i.test(key)) invalid('Credentials and transport settings belong in provider configuration, never the request body.');
  const requestBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (requestBytes > config.maxRequestBytes!) throw new ModelDiagnosticError('input_limit', `Model request is ${requestBytes} UTF-8 bytes; configured limit is ${config.maxRequestBytes}. Reduce the context or tool schema.`);
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(value) ? Math.max(0, value) : undefined;
}
function callsFromWire(value: unknown): ToolCall[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ModelDiagnosticError('invalid_response', 'Provider tool calls are not an array.');
  return value.map((item: any) => {
    if (!item || typeof item.id !== 'string' || typeof item.function?.name !== 'string' || typeof item.function.arguments !== 'string') {
      throw new ModelDiagnosticError('invalid_response', 'Provider returned a malformed tool call.');
    }
    let args: unknown;
    try { args = JSON.parse(item.function.arguments); } catch { throw new ModelDiagnosticError('invalid_response', 'Provider returned invalid tool arguments JSON.'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ModelDiagnosticError('invalid_response', 'Tool arguments must be an object.');
    return { id: item.id, name: item.function.name, arguments: args as Record<string, unknown> };
  });
}

const MAX_RESPONSE_BYTES = 4_000_000;

/** No automatic retries: callers decide whether the failed attempt may be repeated. */
export class ModelClient {
  readonly config: ProviderConfig;
  lastRequestId?: string;
  constructor(config: Partial<ProviderConfig> = {}, private readonly credential?: () => string | undefined, private readonly observer?: ModelObserver) {
    this.config = { ...DEFAULT_PROVIDER, ...config,
      maxOutputTokens: config.maxOutputTokens ?? DEFAULT_PROVIDER.maxOutputTokens,
      maxRequestBytes: config.maxRequestBytes ?? DEFAULT_PROVIDER.maxRequestBytes,
    };
    if (!Number.isInteger(this.config.maxOutputTokens) || this.config.maxOutputTokens < 64 || this.config.maxOutputTokens > 131072) {
      throw new ModelDiagnosticError('invalid_response', 'maxOutputTokens must be an integer from 64 to 131072.');
    }
    if (!Number.isInteger(this.config.maxRequestBytes) || this.config.maxRequestBytes! < 4096 || this.config.maxRequestBytes! > 262_144) {
      throw new ModelDiagnosticError('invalid_response', 'maxRequestBytes must be an integer from 4096 to 262144.');
    }
  }
  buildBody(messages: WireMessage[], tools: ToolDefinition[] = []): Record<string, any> {
    return { model: this.config.model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), stream: true, stream_options: { include_usage: true }, max_tokens: this.config.maxOutputTokens };
  }
  complete(messages: WireMessage[], tools: ToolDefinition[] = [], signal?: AbortSignal, onDelta?: (delta: ModelDelta) => void): Promise<ModelResult> {
    return this.completeRaw(this.buildBody(messages, tools), signal, onDelta);
  }
  async completeRaw(rawBody: Record<string, any>, signal?: AbortSignal, onDelta?: (delta: ModelDelta) => void): Promise<ModelResult> {
    const started = performance.now();
    const deadline = AbortSignal.timeout(this.config.timeoutMs);
    let admitted = false, observed = false;
    this.lastRequestId = undefined;
    try {
      return await resourceBudget.withLease(signal ? AbortSignal.any([signal, deadline]) : deadline, async () => {
      admitted = true;
      validateRequestBody(rawBody, this.config);
      observed = true;
      const prepared = this.observer?.prepare(structuredClone(rawBody));
      const body = prepared?.body ?? rawBody;
      this.lastRequestId = prepared?.requestId;
      validateRequestBody(body, this.config);
      const result = await this.send(body, signal, delta => { this.observer?.delta?.(delta); onDelta?.(delta); });
      if (this.lastRequestId) result.requestId = this.lastRequestId;
      this.observer?.completed(result, Math.round(performance.now() - started));
      return result;
      });
    } catch (error) {
      if (!admitted) {
        if (signal?.aborted) error = new ModelDiagnosticError('cancelled', 'Model request cancelled.');
        else if (deadline.aborted) error = new ModelDiagnosticError('resource_pressure', 'Resource admission timed out; no model request was sent.', true);
      }
      if (observed) this.observer?.failed(error, Math.round(performance.now() - started));
      throw error;
    }
  }
  private async send(rawBody: Record<string, any>, signal?: AbortSignal, onDelta?: (delta: ModelDelta) => void): Promise<ModelResult> {
    if (signal?.aborted) throw new ModelDiagnosticError('cancelled', 'Model request cancelled.');
    const body = JSON.stringify(wireBody(structuredClone(rawBody), this.config.wire));
    if (Buffer.byteLength(body) > this.config.maxRequestBytes!) throw new ModelDiagnosticError('input_limit', 'Encoded request exceeds the configured byte limit.');
    const base = new URL(this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
    if (base.username || base.password || (base.protocol !== 'https:' && !(this.config.mode === 'mock' && loopback && base.protocol === 'http:'))) {
      throw new ModelDiagnosticError('invalid_response', 'Provider URL must use HTTPS, or local HTTP in mock mode.');
    }
    const token = this.config.mode === 'live' ? this.credential?.() : undefined;
    if (this.config.mode === 'live' && !token) throw new ModelDiagnosticError('credential_required', 'Enter a credential for this session before using the live provider.');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    // Binding failures are local failures, not retryable provider failures. No fetch has occurred.
    try { this.observer?.dispatching?.(); }
    catch (error) { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); throw error; }
    try {
      const response = await fetch(endpoint(this.config), {
        method: 'POST', signal: controller.signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', ...authHeaders(this.config.wire, token) },
        body,
      });
      try { this.observer?.responseObserved?.(); }
      catch { await response.body?.cancel(); throw new ModelDiagnosticError('invalid_response', 'The provider responded but local dispatch observation could not be recorded. Do not replay this request automatically.'); }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new ModelDiagnosticError('unauthorized', 'Provider rejected the credential or account permissions.', false, undefined, response.status);
        if (response.status === 429) throw new ModelDiagnosticError('rate_limited', 'Provider rate limit reached. Retry after the indicated delay.', true, retryAfter(response.headers.get('retry-after')), 429);
        if (response.status >= 500) throw new ModelDiagnosticError('provider_unavailable', 'Provider is temporarily unavailable.', true, retryAfter(response.headers.get('retry-after')), response.status);
        throw new ModelDiagnosticError(response.status === 413 ? 'context_limit' : 'http_error', `Provider returned HTTP ${response.status}.`, false, undefined, response.status);
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        const text = await this.readJsonBody(response);
        let body: any;
        try { body = normalizeWire(JSON.parse(text), this.config.wire); } catch { throw new ModelDiagnosticError('invalid_response', 'Provider returned invalid JSON.'); }
        const choice = body.choices?.[0];
        if (!choice?.message || typeof choice.finish_reason !== 'string') throw new ModelDiagnosticError('invalid_response', 'Provider response has no completed choice.');
        if (choice.message.content != null && typeof choice.message.content !== 'string') throw new ModelDiagnosticError('invalid_response', 'Provider content must be text.');
        if (choice.message.reasoning_content != null && typeof choice.message.reasoning_content !== 'string') throw new ModelDiagnosticError('invalid_response', 'Provider reasoning_content must be text.');
        if (choice.finish_reason === 'length') throw new ModelDiagnosticError('context_limit', 'Model output reached its token limit; request a smaller step before continuing.');
        const reasoningContent = typeof choice.message.reasoning_content === 'string' && choice.message.reasoning_content ? choice.message.reasoning_content : undefined;
        const result: ModelResult = { content: choice.message.content ?? '', ...(reasoningContent ? { reasoningContent } : {}), toolCalls: callsFromWire(choice.message.tool_calls), usage: body.usage, finishReason: choice.finish_reason };
        onDelta?.({ content: result.content, ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}), ...(result.toolCalls.length ? { toolCalls: result.toolCalls.map((call, index) => ({ index, id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })) } : {}) });
        if (signal?.aborted) throw new ModelDiagnosticError('cancelled', 'Model request cancelled.');
        return result;
      }
      const result = await this.readStream(response, onDelta);
      if (signal?.aborted) throw new ModelDiagnosticError('cancelled', 'Model request cancelled.');
      return result;
    } catch (error) {
      if (timedOut) throw new ModelDiagnosticError('timeout', 'Model request timed out; no result was accepted.', true);
      if (signal?.aborted) throw new ModelDiagnosticError('cancelled', 'Model request cancelled.');
      if (error instanceof ModelDiagnosticError) throw error;
      throw new ModelDiagnosticError('connection_failed', 'Model connection failed. Check connectivity and provider configuration.', true);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  private async readJsonBody(response: Response): Promise<string> {
    if (!response.body) throw new ModelDiagnosticError('invalid_response', 'Provider response has no body.');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let received = 0, text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return text + decoder.decode();
        received += chunk.value.byteLength;
        if (received > MAX_RESPONSE_BYTES) throw new ModelDiagnosticError('invalid_response', 'Provider response exceeds the size limit.');
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  private async readStream(response: Response, onDelta?: (delta: ModelDelta) => void): Promise<ModelResult> {
    if (!response.body) throw new ModelDiagnosticError('truncated_stream', 'Provider stream has no body.', true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', content = '', reasoningContent = '', finishReason = '', done = false, received = 0;
    let usage: ModelResult['usage'];
    const calls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
    const parseEvent = (event: string) => {
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data.trim() === '[DONE]') { done = true; return; }
      let body: any;
      try { body = JSON.parse(data); } catch { throw new ModelDiagnosticError('invalid_response', 'Provider stream contains invalid JSON.'); }
      if (body.error) throw new ModelDiagnosticError('provider_unavailable', 'Provider reported an error during streaming.', true);
      body = normalizeWire(body, this.config.wire, true);
      if (body.done === true && this.config.wire && this.config.wire.format !== 'chat') done = true;
      if (body.usage) usage = { ...usage, ...body.usage };
      const choice = body.choices?.find((item: any) => item.index === 0) ?? body.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      const parsed: ModelDelta = {};
      if (delta.content != null && typeof delta.content !== 'string') throw new ModelDiagnosticError('invalid_response', 'Provider content fragment must be text.');
      if (typeof delta.content === 'string' && delta.content) { content += delta.content; parsed.content = delta.content; }
      if (delta.reasoning_content != null && typeof delta.reasoning_content !== 'string') throw new ModelDiagnosticError('invalid_response', 'Provider reasoning fragment must be text.');
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        parsed.reasoningContent = delta.reasoning_content;
      }
      if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) throw new ModelDiagnosticError('invalid_response', 'Invalid streamed tool calls.');
      for (const item of delta.tool_calls ?? []) {
        if (!Number.isInteger(item.index) || item.index < 0 || item.index > 64) throw new ModelDiagnosticError('invalid_response', 'Invalid streamed tool index.');
        if ((item.id !== undefined && typeof item.id !== 'string') ||
            (item.function?.name !== undefined && typeof item.function.name !== 'string') ||
            (item.function?.arguments !== undefined && typeof item.function.arguments !== 'string')) {
          throw new ModelDiagnosticError('invalid_response', 'Invalid streamed tool fragment.');
        }
        const call = calls.get(item.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
        if (item.id) call.id += item.id;
        if (item.function?.name) call.function.name += item.function.name;
        if (item.function?.arguments) call.function.arguments += item.function.arguments;
        calls.set(item.index, call);
        if (item.id || item.function?.name || item.function?.arguments) {
          (parsed.toolCalls ??= []).push({ index: item.index,
            ...(item.id ? { id: item.id } : {}),
            ...(item.function?.name ? { name: item.function.name } : {}),
            ...(item.function?.arguments ? { arguments: item.function.arguments } : {}),
          });
        }
      }
      if (parsed.content || parsed.reasoningContent || parsed.toolCalls?.length) onDelta?.(parsed);
    };
    try {
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.length;
        if (received > MAX_RESPONSE_BYTES) throw new ModelDiagnosticError('invalid_response', 'Provider stream exceeds the size limit.');
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) { parseEvent(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
      }
      if (!done || !finishReason) throw new ModelDiagnosticError('truncated_stream', 'Provider stream ended before completion; partial tool calls were discarded.', true);
      if (finishReason === 'length') throw new ModelDiagnosticError('context_limit', 'Model output reached its token limit; partial tool calls were discarded.');
      return { content, ...(reasoningContent ? { reasoningContent } : {}), toolCalls: callsFromWire([...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)), usage, finishReason };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
