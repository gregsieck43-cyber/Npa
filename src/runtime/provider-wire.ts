import type { ProviderConfig } from '../contracts.js';

import type { WireSettings } from '../provider-types.js';
export type { WireSettings } from '../provider-types.js';
type Json = Record<string, any>;
const safeKey = (s: string) => /^[a-zA-Z0-9_-]+$/.test(s) && !['constructor','prototype','__proto__'].includes(s);
export function wireSettings(input: unknown): WireSettings {
  const w = input as WireSettings;
  if (!w || typeof w !== 'object' || !['chat','messages','responses','custom'].includes(w.format)) throw new Error('Unknown API format.');
  if (w.format !== 'custom') return { format: w.format };
  if (!['chat','messages','responses'].includes(w.protocol ?? 'chat')) throw new Error('Unknown underlying protocol.');
  if (!w.path || !/^\/?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(w.path) || w.path.split('/').some(p => p === '.' || p === '..')) throw new Error('Enter a relative endpoint path.');
  if (w.authHeader && !/^(?:authorization|api-key|x-[a-z0-9-]+)$/i.test(w.authHeader)) throw new Error('Invalid authentication header.');
  for (const [group, fields] of Object.entries(w)) {
    if (['format','protocol','path','authHeader'].includes(group)) continue;
    if (!['requestFields','responseFields','streamFields','toolFields'].includes(group) || !fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Invalid protocol mapping.');
    for (const [key, value] of Object.entries(fields)) {
      if (!safeKey(key) || typeof value !== 'string' || value.length > 180 || !value.split('.').every(safeKey)) throw new Error('Invalid field mapping.');
      if (group === 'toolFields' && !['id','name','arguments','index'].includes(key)) throw new Error('Unknown tool field.');
      if (group !== 'requestFields' && group !== 'toolFields' && !['content','tool_calls','finish_reason','usage','done','reasoning_content'].includes(key)) throw new Error('Unknown response field.');
    }
  }
  return w;
}

export function endpoint(config: ProviderConfig, models = false) {
  const base = new URL(config.baseUrl.replace(/\/?$/, '/'));
  const w = config.wire, format = w?.format === 'custom' ? w.protocol : w?.format;
  const standard = models ? 'models' : format === 'messages' ? 'messages' : format === 'responses' ? 'responses' : 'chat/completions';
  const suffix = !models && w?.format === 'custom' ? w.path!.replace(/^\//, '') : (base.pathname === '/' ? 'v1/' : '') + standard;
  return new URL(suffix, base);
}
export function authHeaders(w?: WireSettings, token?: string): Record<string,string> {
  const messages = (w?.format === 'custom' ? w.protocol : w?.format) === 'messages';
  const key = w?.authHeader ?? (messages ? 'x-api-key' : 'Authorization');
  return { ...(messages ? { 'anthropic-version': '2023-06-01' } : {}), ...(token ? { [key]: key.toLowerCase() === 'authorization' ? 'Bearer ' + token : token } : {}) };
}
function mappedValue(data: Json, field: string) {
  return field.split('.').reduce((obj, key) => obj && Object.hasOwn(obj, key) ? obj[key] : undefined, data as any);
}
function mapRequest(data: Json, fields?: Record<string,string>) {
  if (!fields) return data;
  const output = { ...data };
  for (const key of Object.keys(fields)) delete output[key];
  for (const [key, target] of Object.entries(fields)) {
    if (data[key] === undefined) continue;
    const parts = target.split('.'), last = parts.pop()!;
    let node = output;
    for (const part of parts) {
      if (Object.hasOwn(node, part) && (typeof node[part] !== 'object' || !node[part] || Array.isArray(node[part]))) throw new Error('Conflicting request mapping.');
      node = node[part] ??= {};
    }
    node[last] = data[key];
  }
  return output;
}
export function wireBody(body: Json, w?: WireSettings): Json {
  const format = w?.format === 'custom' ? w.protocol : w?.format;
  const { model, stream, messages, tools, max_tokens, max_completion_tokens, reasoning_effort } = body;
  let result = body;
  if (format === 'messages') {
    const system = messages.filter((m: Json) => ['system','developer'].includes(m.role)).map((m: Json) => m.content).join('\n');
    const conversation = messages.filter((m: Json) => !['system','developer'].includes(m.role)).map((m: Json) => {
      if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] };
      if (!m.tool_calls) return { role: m.role, content: m.content };
      return { role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.tool_calls.map((c: Json) => ({ type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) }))] };
    });
    result = { model, stream, ...(body.thinking ? { thinking: body.thinking } : {}), ...(body.temperature !== undefined ? { temperature: body.temperature } : {}), ...(body.top_p !== undefined ? { top_p: body.top_p } : {}), messages: conversation, max_tokens: max_tokens ?? max_completion_tokens, ...(system ? { system } : {}), ...(tools ? { tools: tools.map((t: Json) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) } : {}) };
  } else if (format === 'responses') {
    const input = messages.flatMap((m: Json) => {
      if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.tool_call_id, output: m.content }];
      const items = m.content ? [{ role: m.role, content: m.content }] : [];
      return [...items, ...(m.tool_calls ?? []).map((c: Json) => ({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments }))];
    });
    result = { model, stream, store: false, input, max_output_tokens: max_tokens ?? max_completion_tokens, ...(body.reasoning || reasoning_effort ? { reasoning: body.reasoning ?? { effort: reasoning_effort } } : {}), ...(tools ? { tools: tools.map((t: Json) => ({ type:'function', ...t.function })) } : {}) };
  }
  return mapRequest(result, w?.requestFields);
}
function usage(value?: Json) {
  return value && { ...(value.input_tokens !== undefined ? { prompt_tokens: value.input_tokens } : {}), ...(value.output_tokens !== undefined ? { completion_tokens: value.output_tokens } : {}), ...(value.total_tokens !== undefined ? { total_tokens: value.total_tokens } : {}) };
}
const call = (id: string, name: string, args: string, index?: number) => ({ id, type: 'function', function: { name, arguments: args }, index });
export function normalizeWire(data: Json, w?: WireSettings, stream = false): Json {
  const fields = stream ? w?.streamFields : w?.responseFields;
  if (fields && Object.keys(fields).length) {
    const mapped = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, mappedValue(data, field)]));
    if (w?.toolFields && mapped.tool_calls) {
      const fields = w.toolFields;
      if (!Array.isArray(mapped.tool_calls)) throw new Error('Expected a list of custom tool calls.');
      mapped.tool_calls = mapped.tool_calls.map((item: Json, index: number) => {
        const field = (key: string) => fields[key] ? mappedValue(item, fields[key]) : undefined;
        const args = field('arguments');
        return call(field('id'), field('name'), typeof args === 'object' && args !== null ? JSON.stringify(args) : args, field('index') ?? index);
      });
    }
    return { done: mapped.done === true, usage: mapped.usage, choices: [{ finish_reason: mapped.finish_reason, [stream ? 'delta' : 'message']: { content: mapped.content, reasoning_content: mapped.reasoning_content, tool_calls: mapped.tool_calls } }] };
  }
  const format = w?.format === 'custom' ? w.protocol : w?.format;
  if (!format || format === 'chat') return data;
  const delta: Json = {};
  let finish: string | undefined, done = false, counts: Json | undefined;
  if (format === 'messages') {
    counts = usage(data.usage ?? data.message?.usage);
    if (!stream) {
      if (!Array.isArray(data.content)) throw new Error('Invalid Messages response.');
      delta.content = data.content.filter((b: Json) => b.type === 'text').map((b: Json) => b.text).join('');
      delta.tool_calls = data.content.filter((b: Json) => b.type === 'tool_use').map((b: Json) => call(b.id,b.name,JSON.stringify(b.input)));
    } else if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') delta.tool_calls = [call(data.content_block.id,data.content_block.name,'',data.index)];
    else if (data.type === 'content_block_delta') {
      delta.content = data.delta?.text;
      delta.reasoning_content = data.delta?.thinking;
      if (data.delta?.partial_json !== undefined) delta.tool_calls = [call('','',data.delta.partial_json,data.index)];
    }
    finish = data.stop_reason ?? data.delta?.stop_reason;
    if (finish === 'max_tokens') finish = 'length';
    done = data.type === 'message_stop';
  } else {
    if (['response.failed','error'].includes(data.type) || data.status === 'failed') throw new Error('Responses request failed.');
    const terminal = !stream || ['response.completed','response.incomplete'].includes(data.type);
    if (terminal) {
      const r = data.response ?? data;
      if (!['incomplete','completed'].includes(r.status)) throw new Error('Incomplete Responses reply.');
      finish = r.status === 'incomplete' ? 'length' : 'stop';
      counts = usage(r.usage); done = true;
      if (!stream) {
        delta.content = r.output.flatMap((i: Json) => i.content ?? []).map((b: Json) => b.text ?? b.refusal ?? '').join('');
        delta.tool_calls = r.output.filter((i: Json) => i.type === 'function_call').map((i: Json) => call(i.call_id,i.name,i.arguments));
      }
    } else if (data.type === 'response.output_text.delta' || data.type === 'response.refusal.delta') delta.content = data.delta;
    else if (data.type === 'response.output_item.added' && data.item?.type === 'function_call') delta.tool_calls = [call(data.item.call_id,data.item.name,'',data.output_index)];
    else if (data.type === 'response.function_call_arguments.delta') delta.tool_calls = [call('','',data.delta,data.output_index)];
  }
  return { done, usage: counts, choices: [{ finish_reason: finish, [stream ? 'delta' : 'message']: delta }] };
}
