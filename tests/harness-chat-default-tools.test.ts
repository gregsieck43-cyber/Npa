import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import type { MockCompletion } from '../src/fixtures/mock-provider.js';

/**
 * Default Chat (no project selected) stores the installation root as its read-only scope. The
 * per-request tool task must not inherit that scope: the Kernel must assign data/workspaces/<taskId>.
 * A selected safe project stays the real workspace, and an explicitly stored dangerous scope is
 * still forwarded to the Services boundary, which rejects it. Everything here runs through the real
 * startBackend/Services/Product HTTP stack with a loopback mock model; only the network transport of
 * the real ExternalTools instance is injected for the web_search case.
 */
const PROJECT_ROOT = process.cwd();
const ROOT = path.resolve('.tmp', 'harness-chat-default-tools');

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const toolResult = (body: any): any => (Array.isArray(body?.messages) ? body.messages : []).find((message: any) => message?.role === 'tool');
const until = async <T>(read: () => T | undefined, label: string, timeoutMs = 40000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail('Timed out waiting for ' + label);
    await sleep(25);
  }
};

const setup = async (responder: (body: any, index: number) => MockCompletion) => {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(ROOT, 'case-'));
  const workspace = path.join(dir, 'project');
  mkdirSync(workspace, { recursive: true });
  const dataDir = path.join(dir, 'data');
  const wire: any[] = [];
  const settings = { dataDir, projectRoot: PROJECT_ROOT, mockOptions: { responder, trace: (body: any) => { wire.push(body); } } };
  let backend = await startBackend(settings);
  const requestRaw = async (method: string, route: string, input?: unknown) => {
    const response = await fetch('http://127.0.0.1:' + backend.port + route, { method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const request = (method: string, route: string, input?: unknown) => requestRaw(method, '/v1/product' + route, input);
  const restart = async () => { await backend.close(); backend = await startBackend(settings); };
  const close = async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); };
  return {
    dir, workspace, dataDir, settings, request, requestRaw, restart, close, wire,
    services: () => backend.services,
    store: () => backend.services.harness!.store,
    kernel: () => backend.services.kernel,
    toolsReady: () => backend.services.harness!.tools.ready,
  };
};
type Env = Awaited<ReturnType<typeof setup>>;

const sendChat = (env: Env, text: string, extra: Record<string, unknown> = {}) =>
  env.request('POST', '/chat/send', { mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default', ...extra });
const TERMINAL = new Set(['completed', 'failed', 'denied', 'unknown']);
const waitSettled = (env: Env, sessionId: string, rounds: number, names: string[]) => untilAsync(async () => {
  const result = await env.request('GET', '/sessions/' + encodeURIComponent(sessionId));
  if (result.status !== 200 || result.body.status !== 'idle') return undefined;
  if (env.wire.length !== rounds) return undefined;
  const records = env.store().toolCalls({ sessionId, limit: 50 });
  return names.every(name => records.some(record => record.name === name && TERMINAL.has(record.status))) ? true : undefined;
}, 'the Chat round to fully settle');
const untilAsync = async <T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 40000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail('Timed out waiting for ' + label);
    await sleep(25);
  }
};
const toolRecord = (env: Env, sessionId: string, name: string) => {
  const records = env.store().toolCalls({ sessionId, limit: 50 }).filter(record => record.name === name);
  assert.equal(records.length, 1, 'expected exactly one ' + name + ' record, got ' + records.length);
  return records[0]!;
};
const toolBatch = (calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) => (body: any): MockCompletion => {
  if (toolResult(body)) return { content: 'Tool receipt received; no further action.' };
  return { content: '', toolCalls: calls };
};
const assertTaskWorkspace = (env: Env, taskId: string) => {
  const task = env.kernel().getTask(taskId);
  assert.ok(task, 'the Chat tool task must exist: ' + taskId);
  assert.equal(path.resolve(task!.workspace), path.resolve(path.join(env.dataDir, 'workspaces', taskId)), 'default Chat tools must run in the Kernel per-task workspace');
  assert.notEqual(path.resolve(task!.workspace), path.resolve(PROJECT_ROOT), 'the installation root must never become a tool task workspace');
  assert.ok(existsSync(task!.workspace), 'the per-task workspace must exist');
  return task!;
};

test('default Chat list_files executes in a Kernel per-task workspace; its receipt feeds the next model request', { timeout: 120000 }, async t => {
  const env = await setup(toolBatch([
    { id: 'default-list', name: 'list_files', arguments: { path: '.' } },
    { id: 'default-write', name: 'write_file', arguments: { path: 'must-not-exist.txt', content: 'nope' } },
    { id: 'default-shell', name: 'run_shell', arguments: { command: 'echo nope' } },
    { id: 'default-mcp', name: 'mcp_call', arguments: { serverId: 'none', toolName: 'echo', arguments: {} } },
  ]));
  t.after(() => env.close());

  const sent = await sendChat(env, 'List this conversation workspace.');
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const sessionId = sent.body.sessionId as string;
  await waitSettled(env, sessionId, 2, ['list_files', 'write_file', 'run_shell', 'mcp_call']);

  const session = env.store().getSession(sessionId);
  assert.equal(path.resolve(session.workspace!), path.resolve(PROJECT_ROOT), 'a default Chat session still stores the installation root as its read-only scope');

  const listed = toolRecord(env, sessionId, 'list_files');
  assert.equal(listed.status, 'completed', 'list_files failed: ' + String(listed.error));
  assert.equal(listed.failureStage, undefined);
  assert.equal(listed.result, '[]', 'the per-task workspace starts empty');
  assert.ok(listed.taskId, 'the completed read is bound to a Kernel task');
  const task = assertTaskWorkspace(env, listed.taskId!);
  assert.deepEqual(env.kernel().getTaskPermission(task.id), { ...env.kernel().getTaskPermission(task.id), app: 'chat', mode: 'read-only' });

  // The real tool receipt, not an invention, is the tool message in the very next model request.
  assert.equal(env.wire.length, 2, 'exactly one continuation request; the auto Runner must not add a model task');
  const continuation = env.wire[1]!;
  const receipt = toolResult(continuation);
  assert.ok(receipt, 'the continuation request must carry the tool receipt');
  assert.equal(receipt.tool_call_id, 'default-list');
  assert.equal(receipt.content, '[]');
  assert.ok(Array.isArray(continuation.messages) && continuation.messages.some((message: any) => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.some((call: any) => call.id === 'default-list')));

  for (const name of ['write_file', 'run_shell', 'mcp_call']) {
    const denied = toolRecord(env, sessionId, name);
    assert.equal(denied.status, 'failed', name + ' must be denied: ' + String(denied.error));
    assert.equal(denied.failureStage, 'permission');
    assert.equal(denied.intentId, undefined, name + ' must not reach a Kernel intent');
  }
  assert.equal(existsSync(path.join(env.workspace, 'must-not-exist.txt')), false);
  assert.equal(existsSync(path.join(PROJECT_ROOT, 'must-not-exist.txt')), false);
  assert.equal(env.kernel().listTasks().length, 1, 'only the read-only tool task may exist');
  assert.ok(env.services().runner.managedExternally.has(task.id), 'the Chat tool task must stay outside the auto Runner');
  const budgets = env.kernel().getBudgets(task.id);
  assert.equal(budgets.modelCalls, 0, 'Chat tools must not consume automatic Runner model calls');
  assert.equal(budgets.maxModelCalls, 1);

  // Restart must not re-execute the settled read or invent another model round.
  const traceLength = env.wire.length, workspace = task.workspace;
  await env.restart();
  await env.toolsReady();
  assert.equal(env.store().getTool(listed.id)!.status, 'completed');
  assert.equal(env.wire.length, traceLength);
  assert.equal(path.resolve(env.kernel().getTask(task.id)!.workspace), path.resolve(workspace));
  assert.equal(env.kernel().listTasks().length, 1);

  const followUp = await sendChat(env, 'Continue after the read.', { sessionId });
  assert.equal(followUp.status, 200, JSON.stringify(followUp.body));
  await waitSettled(env, sessionId, 3, ['list_files', 'write_file', 'run_shell', 'mcp_call']);
  assert.equal(env.wire.length, traceLength + 1, 'a follow-up adds one model request and no automatic task');
  assert.equal(env.kernel().listTasks().length, 1);
  assert.equal(env.store().getTool(listed.id)!.result, '[]');
});

test('default Chat web_search runs on the injected transport once, and restart/follow-up never replay it', { timeout: 120000 }, async t => {
  let fetches = 0;
  const webOptions = {
    searchProvider: 'wikipedia' as const,
    resolveDns: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: async () => { fetches++; return Response.json({ query: { search: [{ title: 'Checked result', snippet: 'Controlled default-Chat transport' }] } }); },
  };
  const env = await setup(toolBatch([{ id: 'default-web', name: 'web_search', arguments: { query: 'default chat workspace probe' } }]));
  t.after(() => env.close());
  const configured = await env.requestRaw('POST', '/v1/config', { searchProvider: 'wikipedia' });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  (env.services().external as unknown as { options: { webOptions?: typeof webOptions } }).options.webOptions = webOptions;

  const sent = await sendChat(env, 'Search the public fixture.');
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const sessionId = sent.body.sessionId as string;
  await waitSettled(env, sessionId, 2, ['web_search']);

  const searched = toolRecord(env, sessionId, 'web_search');
  assert.equal(searched.status, 'completed', 'web_search failed: ' + String(searched.error));
  assert.equal(fetches, 1, 'the controlled transport must run exactly once');
  assert.match(String(searched.result), /Checked result/);
  assert.ok(searched.taskId);
  assertTaskWorkspace(env, searched.taskId!);
  assert.equal(env.wire.length, 2);
  assert.equal(toolResult(env.wire[1]!)?.content, String(searched.result));
  assert.equal(env.kernel().intents(searched.taskId!).filter(intent => intent.state === 'applied').length, 1);

  const traceLength = env.wire.length;
  await env.restart();
  (env.services().external as unknown as { options: { webOptions?: typeof webOptions } }).options.webOptions = webOptions;
  await env.toolsReady();
  assert.equal(env.store().getTool(searched.id)!.status, 'completed');
  assert.equal(fetches, 1, 'restart reconciles from the stored receipt; it must not re-run the network effect');
  assert.equal(env.wire.length, traceLength, 'recovery of an already delivered receipt must not add a model request');

  const followUp = await sendChat(env, 'Summarize the receipt.', { sessionId });
  assert.equal(followUp.status, 200, JSON.stringify(followUp.body));
  await waitSettled(env, sessionId, 3, ['web_search']);
  assert.equal(fetches, 1, 'a follow-up must not replay the applied web effect');
  assert.equal(env.kernel().intents(searched.taskId!).filter(intent => intent.state === 'applied').length, 1);
});

test('an explicitly selected safe project stays the real Chat tool workspace', { timeout: 120000 }, async t => {
  const env = await setup(toolBatch([{ id: 'project-list', name: 'list_files', arguments: { path: '.' } }]));
  t.after(() => env.close());
  writeFileSync(path.join(env.workspace, 'project-evidence.txt'), 'project scoped evidence');
  const project = await env.request('POST', '/workspace/projects', { path: env.workspace });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  const projectId = project.body.id as string;

  const sent = await sendChat(env, 'List the selected project.', { projectId });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const sessionId = sent.body.sessionId as string;
  await waitSettled(env, sessionId, 2, ['list_files']);
  const listed = toolRecord(env, sessionId, 'list_files');
  assert.equal(listed.status, 'completed', 'list_files failed: ' + String(listed.error));
  assert.match(String(listed.result), /project-evidence\.txt/);
  assert.ok(listed.taskId);
  const task = env.kernel().getTask(listed.taskId!)!;
  assert.equal(path.resolve(task.workspace).toLowerCase(), realpathSync(env.workspace).toLowerCase(), 'a selected safe project must keep its real file-read path');
  assert.deepEqual(env.kernel().getTaskPermission(task.id), { ...env.kernel().getTaskPermission(task.id), app: 'chat', mode: 'read-only' });
});

test('an explicitly stored dangerous Chat scope is still rejected by the Services boundary', { timeout: 120000 }, async t => {
  const env = await setup(toolBatch([{ id: 'danger-list', name: 'list_files', arguments: { path: '.' } }]));
  t.after(() => env.close());
  for (const [name, workspace, pattern] of [
    ['data directory', env.dataDir, /audit, approval and task data|mutable task workspace/],
    ['running product source', path.join(PROJECT_ROOT, 'src'), /running product|mutable task workspace/],
  ] as const) {
    const session = env.store().createSession({ title: 'Explicit ' + name, workspace,
      capabilities: { web: true, tools: true, mcp: false, skills: false, projectInstructions: false } });
    const sent = await env.requestRaw('POST', '/v1/harness/chat', { sessionId: session.id, content: 'Read this explicit scope.' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const record = await until(() => {
      const found = env.store().toolCalls({ sessionId: session.id, limit: 20 }).find(item => item.name === 'list_files');
      return found && ['completed', 'failed', 'denied'].includes(found.status) ? found : undefined;
    }, 'the ' + name + ' tool to settle');
    assert.equal(record.status, 'failed', name + ' must stay rejected: ' + String(record.error));
    assert.match(String(record.error), pattern);
    assert.equal(record.taskId, undefined, 'a rejected explicit workspace must not create a Kernel task');
  }
  assert.equal(env.kernel().listTasks().length, 0);
});