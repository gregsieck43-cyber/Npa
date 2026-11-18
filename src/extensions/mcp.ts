import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import type { Command, GoalContract } from '../contracts.js';
import { BackendClient, type BackendAccess, type HistoryOptions } from './client.js';
import { taskFromSnapshot } from './cli.js';
import packageMetadata from '../../package.json' with { type: 'json' };

export const MCP_PROTOCOL_VERSION = '2025-11-25';
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const taskIdSchema = { type: 'string', minLength: 1, description: 'Durable task ID returned by npn_submit.' };
const mutationFields = { commandId: { type: 'string', minLength: 1, description: 'Reuse this ID to safely repeat the same command.' }, expectedRevision: { type: 'integer', minimum: 0 } };
const stringsSchema = { type: 'array', items: { type: 'string' } };
export const MCP_TOOLS = [
  { name: 'npn_submit', description: 'Submit a durable goal to the shared NPN backend. Tool permissions still require desktop approval.', inputSchema: objectSchema({ objective: { type: 'string', minLength: 1 }, title: { type: 'string' }, constraints: stringsSchema, acceptance: stringsSchema, mode: { type: 'string', enum: ['collaborative', 'autonomous'] }, maxModelCalls: { type: 'integer', minimum: 1, maximum: 1000000 }, workspace: { type: 'string' }, commandId: mutationFields.commandId }, ['objective']), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'npn_query', description: 'Read a bounded current task/history window and health. Use npn_history cursors for original messages or audit events beyond this window.', inputSchema: objectSchema({ taskId: taskIdSchema }), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'npn_cancel', description: 'Send a cancellation control event for a task.', inputSchema: objectSchema({ taskId: taskIdSchema, ...mutationFields }, ['taskId']), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'npn_retry', description: 'Retry a failed or paused task through the backend state machine; no duplicate chat message is added.', inputSchema: objectSchema({ taskId: taskIdSchema, ...mutationFields }, ['taskId']), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'npn_resume', description: 'Resume an eligible paused task through the backend state machine.', inputSchema: objectSchema({ taskId: taskIdSchema, ...mutationFields }, ['taskId']), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'npn_result', description: 'Read task status, result and tool-effect receipts; an unfinished task does not imply success.', inputSchema: objectSchema({ taskId: taskIdSchema }, ['taskId']), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'npn_history', description: 'Read one bounded page of original messages or events (default events; 100 rows, at most 1 MiB). This is not the complete history. Reuse page.nextCursor as cursor and page.throughSeq as throughSeq until nextCursor is null. Message and event cursors are separate. Oversized original records produce an explicit error; no source is silently truncated.', inputSchema: objectSchema({ taskId: taskIdSchema, kind: { type: 'string', enum: ['messages', 'events'] }, afterSeq: { type: 'integer', minimum: 0, description: 'Exclusive source sequence; cannot be combined with cursor.' }, cursor: { type: 'integer', minimum: 0, description: 'Exclusive sequence returned by page.nextCursor; cannot be combined with afterSeq.' }, limit: { type: 'integer', minimum: 1, maximum: 1000 }, throughSeq: { type: 'integer', minimum: 0, description: 'Fixed watermark from the first page.' } }, ['taskId']), annotations: { readOnlyHint: true, openWorldHint: false } },
] as const;

export interface McpOptions { dataDir: string; client?: BackendAccess; input?: Readable; output?: Writable; diagnostics?: Writable; }
class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError(-32602, `${name} must be an object.`);
  return value as Record<string, unknown>;
}
function toolArguments(name: string, value: unknown): Record<string, unknown> {
  const tool = MCP_TOOLS.find(item => item.name === name);
  if (!tool) throw new RpcError(-32602, `Unknown tool ${name}.`);
  const args = object(value ?? {}, 'arguments');
  const schema = tool.inputSchema;
  for (const required of schema.required) if (args[required] === undefined) throw new RpcError(-32602, `${required} is required.`);
  for (const [key, val] of Object.entries(args)) {
    const field = (schema.properties as Record<string, Record<string, unknown>>)[key];
    if (!field) throw new RpcError(-32602, `Unknown argument ${key}.`);
    if (field.type === 'string' && (typeof val !== 'string' || (field.minLength === 1 && !val.trim()) || val.length > 100000)) throw new RpcError(-32602, `${key} must be a valid string.`);
    if (field.type === 'integer' && (!Number.isSafeInteger(val) || (val as number) < (field.minimum as number) || (field.maximum !== undefined && (val as number) > (field.maximum as number)))) throw new RpcError(-32602, `${key} must be an integer in the supported range.`);
    if (field.type === 'array' && (!Array.isArray(val) || val.length > 100 || val.some(item => typeof item !== 'string' || item.length > 100000))) throw new RpcError(-32602, `${key} must be an array of strings.`);
    if (field.enum && !(field.enum as unknown[]).includes(val)) throw new RpcError(-32602, `${key} is unsupported.`);
  }
  return args;
}
async function callTool(client: BackendAccess, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (name === 'npn_submit') {
    const objective = (args.objective as string).trim();
    const goal: GoalContract = { objective, constraints: (args.constraints as string[] | undefined) ?? [], acceptance: (args.acceptance as string[] | undefined) ?? [], mode: (args.mode as GoalContract['mode'] | undefined) ?? 'collaborative', maxModelCalls: (args.maxModelCalls as number | undefined) ?? 20 };
    return client.command({ type: 'submit', commandId: (args.commandId as string | undefined) ?? randomUUID(), parameters: { title: args.title ?? objective.slice(0, 80), goal, ...(args.workspace ? { workspace: args.workspace } : {}) } }, signal);
  }
  const taskId = args.taskId as string | undefined;
  if (['npn_cancel', 'npn_retry', 'npn_resume'].includes(name)) {
    const command: Command = { commandId: (args.commandId as string | undefined) ?? randomUUID(), type: name.slice(4), taskId, ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision as number }) };
    return client.command(command, signal);
  }
  if (name === 'npn_history') {
    const options: HistoryOptions = { ...(args.afterSeq === undefined ? {} : { afterSeq: args.afterSeq as number }), ...(args.cursor === undefined ? {} : { cursor: args.cursor as number }), ...(args.limit === undefined ? {} : { limit: args.limit as number }), ...(args.throughSeq === undefined ? {} : { throughSeq: args.throughSeq as number }) };
    const kind = args.kind ?? 'events';
    if (kind === 'messages' && !client.messages) throw new Error('This backend client does not support paged message history.');
    return { taskId, kind, ...await (kind === 'messages' ? client.messages!(taskId!, options, signal) : client.events(taskId!, options, signal)), historyWindow: true };
  }
  const snapshot = await client.snapshot(taskId, signal);
  if (name === 'npn_query') {
    if (taskId) taskFromSnapshot(snapshot, taskId);
    return snapshot;
  }
  const task = taskFromSnapshot(snapshot, taskId!);
  if (name === 'npn_result') return { taskId, status: task.status, result: task.result ?? null, error: task.error ?? null, waitingReason: task.waitingReason ?? null, intents: snapshot.intents, historyWindow: true };
  throw new RpcError(-32602, `Unknown tool ${name}.`);
}

/** MCP stdio transport: UTF-8 JSON-RPC messages separated by newlines, no stdout logs. */
export async function runMcp(options: McpOptions): Promise<void> {
  const client = options.client ?? new BackendClient({ dataDir: options.dataDir, maxResponseBytes: 16 * 1024 * 1024 });
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostics = options.diagnostics ?? process.stderr;
  const pending = new Map<string | number, AbortController>();
  const active = new Set<Promise<void>>();
  const transport = new AbortController();
  const abortPending = () => { for (const controller of pending.values()) controller.abort(); };
  const close = () => { transport.abort(); abortPending(); input.destroy(); };
  output.on('close', close); output.on('error', close);
  const drain = async () => { if (output.writableNeedDrain) await once(output, 'drain', { signal: transport.signal }); };
  let initialized = false;
  let ready = false;
  const write = (value: unknown) => { if (!transport.signal.aborted) output.write(`${JSON.stringify(value)}\n`); };
  const handle = async (line: string): Promise<void> => {
    let id: string | number | null = null;
    let hasId = true;
    let controller: AbortController | undefined;
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { throw new RpcError(-32700, 'Invalid JSON.'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RpcError(-32600, 'Expected one JSON-RPC message.');
      const message = parsed as Record<string, unknown>;
      hasId = Object.hasOwn(message, 'id');
      if (hasId && typeof message.id !== 'string' && typeof message.id !== 'number') throw new RpcError(-32600, 'Request ID must be a string or number.');
      if (hasId) id = message.id as string | number;
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw new RpcError(-32600, 'Invalid JSON-RPC request.');
      if (!hasId) {
        if (message.method === 'notifications/initialized' && initialized) ready = true;
        else if (message.method === 'notifications/cancelled') {
          const params = object(message.params, 'params');
          if (typeof params.requestId === 'string' || typeof params.requestId === 'number') pending.get(params.requestId)?.abort();
        }
        return;
      }
      if (pending.has(id!)) throw new RpcError(-32600, 'Request ID is already in flight.');
      if (pending.size >= 8) throw new RpcError(-32000, 'At most 8 MCP requests may be in flight. Wait for a reply before sending more.');
      controller = new AbortController();
      pending.set(id!, controller);
      let result: unknown;
      if (message.method === 'initialize') {
        if (initialized) throw new RpcError(-32600, 'Already initialized.');
        const params = object(message.params, 'params');
        if (typeof params.protocolVersion !== 'string') throw new RpcError(-32602, 'protocolVersion is required.');
        object(params.capabilities, 'capabilities');
        const info = object(params.clientInfo, 'clientInfo');
        if (typeof info.name !== 'string' || typeof info.version !== 'string') throw new RpcError(-32602, 'clientInfo name and version are required.');
        initialized = true;
        result = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'npn-gamma', version: packageMetadata.version }, instructions: 'Tasks share the desktop backend. Autonomous mode does not grant tool approval. Reuse commandId when repeating mutations; query task state after an uncertain response.' };
      } else if (message.method === 'ping') result = {};
      else {
        if (!ready) throw new RpcError(-32002, 'Complete initialize and notifications/initialized first.');
        if (message.method === 'tools/list') result = { tools: MCP_TOOLS };
        else if (message.method === 'tools/call') {
          const params = object(message.params, 'params');
          if (typeof params.name !== 'string') throw new RpcError(-32602, 'Tool name is required.');
          const args = toolArguments(params.name, params.arguments);
          try {
            const value = await callTool(client, params.name, args, controller.signal);
            result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
          } catch (error) {
            result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
          }
        } else throw new RpcError(-32601, `Method ${message.method} is not supported.`);
      }
      if (!controller.signal.aborted) write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (hasId && !controller?.signal.aborted) write({ jsonrpc: '2.0', id, error: { code: error instanceof RpcError ? error.code : -32603, message: error instanceof Error ? error.message : 'Internal error.' } });
    } finally { if (controller) pending.delete(id!); }
  };
  const dispatch = (line: string) => {
    if (!line.trim()) return;
    const promise = handle(line);
    active.add(promise);
    void promise.finally(() => active.delete(promise));
  };
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  try {
    for await (const chunk of input) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 1_048_576) { diagnostics.write('MCP message exceeds 1 MiB; closing transport.\n'); abortPending(); return; }
        dispatch(line);
        // Yield completed handlers even within one large stdin chunk, and never accumulate
        // replies in memory while the external client has stopped consuming stdout.
        await drain();
      }
      if (Buffer.byteLength(buffer) > 1_048_576) { diagnostics.write('MCP message exceeds 1 MiB; closing transport.\n'); abortPending(); return; }
    }
    buffer += decoder.end();
    if (buffer.trim()) { diagnostics.write('MCP input ended without a newline delimiter.\n'); write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Missing newline delimiter.' } }); }
    await Promise.all(active);
    await drain();
  } catch (error) { if (!transport.signal.aborted) throw error; }
  finally {
    abortPending(); await Promise.all(active);
    output.off('close', close); output.off('error', close);
  }
}
