import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { workspaceRootId } from '../src/app/workspace-roots.js';
import type { MockCompletion } from '../src/fixtures/mock-provider.js';

/**
 * F1-01/F1-02/F1-03: a project selected after a default Chat already exists must become the real
 * read scope of the Chat tool task, the session must follow a later project switch (also across
 * restart), and a switch must never disturb a pending request, tool call, task or receipt.
 *
 * Everything runs through the real startBackend/Services/Product HTTP stack with a loopback mock
 * model; the only injected component is the network transport of the real ExternalTools instance
 * for the web_search case. Nothing here reads the model files of the worktree.
 */
const PROJECT_ROOT = process.cwd();
const ROOT = path.resolve('.tmp', 'chat-project-binding');
const TERMINAL = new Set(['completed', 'failed', 'denied']);

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const until = async <T>(read: () => Promise<T | undefined> | T | undefined, label: string, timeoutMs = 40000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail('Timed out waiting for ' + label);
    await sleep(25);
  }
};
const lastUser = (body: any): string => [...(Array.isArray(body?.messages) ? body.messages : [])]
  .reverse().find((message: any) => message?.role === 'user')?.content ?? '';
/** The receipt the model is answering now: the history may already contain older tool receipts. */
const toolResult = (body: any): any => {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.at(-1)?.role === 'tool' ? messages.at(-1) : undefined;
};
const toolBatch = (calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) => (body: any, index: number): MockCompletion => {
  if (toolResult(body)) return { content: 'Tool receipt received; no further action.' };
  // Model tool-call ids are unique per response; keep them unique across rounds and sessions.
  return { content: '', toolCalls: calls.map(call => ({ ...call, id: call.id + '-' + index })) };
};
const caseVariant = (value: string): string => value === value.toUpperCase() ? value.toLowerCase() : value.toUpperCase();
const samePath = (left: string, right: string): boolean => path.relative(left, right) === '';
const projectPath = (env: Env): string => realpathSync(env.workspaceA);

const setup = async (responder: (body: any, index: number) => MockCompletion | Promise<MockCompletion>) => {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(ROOT, 'case-'));
  const workspaceA = path.join(dir, 'alpha');
  const workspaceB = path.join(dir, 'beta');
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  writeFileSync(path.join(workspaceA, 'alpha-marker.txt'), 'alpha project file\n');
  writeFileSync(path.join(workspaceB, 'beta-marker.txt'), 'beta project file\n');
  const dataDir = path.join(dir, 'data');
  const wire: any[] = [];
  const settings = { dataDir, projectRoot: PROJECT_ROOT, mockOptions: { responder, trace: (body: any) => { wire.push(body); } } };
  let backend = await startBackend(settings);
  const requestRaw = async (method: string, route: string, input?: unknown) => {
    const response = await fetch('http://127.0.0.1:' + backend.port + route, { method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) }).catch(error => {
        const cause = error instanceof Error ? error.cause : undefined;
        const detail = cause instanceof Error ? `${cause.message} (${(cause as NodeJS.ErrnoException).code ?? cause.name})` : String(cause);
        throw new Error(`${method} ${route} failed: ${detail}`, { cause: error });
      });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const request = (method: string, route: string, input?: unknown) => requestRaw(method, '/v1/product' + route, input);
  const restart = async () => { await backend.close(); backend = await startBackend(settings); };
  const close = async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); };
  const env = {
    dir, workspaceA, workspaceB, dataDir, settings, request, requestRaw, restart, close, wire,
    services: () => backend.services,
    store: () => backend.services.harness!.store,
    harness: () => backend.services.harness!,
    kernel: () => backend.services.kernel,
    toolsReady: () => backend.services.harness!.tools.ready,
  };
  return env;
};
type Env = Awaited<ReturnType<typeof setup>>;

const sendChat = (env: Env, text: string, extra: Record<string, unknown> = {}) =>
  env.request('POST', '/chat/send', { mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default', ...extra });
const register = async (env: Env, directory: string): Promise<string> => {
  const response = await env.request('POST', '/workspace/projects', { path: directory });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.id as string;
};
const detail = (env: Env, sessionId: string) => env.request('GET', '/sessions/' + encodeURIComponent(sessionId));
/** Settle one Chat round: idle, exact model-request count, and the expected cumulative tool records. */
const waitSettled = async (env: Env, sessionId: string, rounds: number, expected: Record<string, number> = {}): Promise<void> => {
  await until(async () => {
    const current = await detail(env, sessionId);
    if (current.status !== 200 || current.body.status !== 'idle') return undefined;
    if (env.wire.length !== rounds) return undefined;
    const records = env.store().toolCalls({ sessionId, limit: 200 });
    for (const [name, count] of Object.entries(expected)) {
      if (records.filter(record => record.name === name && TERMINAL.has(record.status)).length < count) return undefined;
    }
    return true;
  }, 'the Chat round to settle');
};
const listRecords = (env: Env, sessionId: string) => env.store().toolCalls({ sessionId, limit: 200 }).filter(record => record.name === 'list_files');
const latestList = (env: Env, sessionId: string) => {
  const records = listRecords(env, sessionId);
  assert.ok(records.length, 'expected a list_files record');
  return records[0]!;
};
const assertProjectTask = (env: Env, taskId: string, workspace: string) => {
  const task = env.kernel().getTask(taskId);
  assert.ok(task, 'the Chat tool task must exist: ' + taskId);
  assert.ok(samePath(task!.workspace, realpathSync(workspace)), 'the Chat tool task must run in the selected project, got ' + task!.workspace);
  assert.ok(existsSync(task!.workspace));
  assert.deepEqual(env.kernel().getTaskPermission(task!.id), { ...env.kernel().getTaskPermission(task!.id), app: 'chat', mode: 'read-only' });
  return task!;
};
const assertImplicitTask = (env: Env, taskId: string) => {
  const task = env.kernel().getTask(taskId);
  assert.ok(task, 'the Chat tool task must exist: ' + taskId);
  assert.ok(samePath(task!.workspace, path.join(env.dataDir, 'workspaces', taskId)), 'default Chat tools must use the Kernel per-task workspace');
  assert.ok(!samePath(task!.workspace, PROJECT_ROOT));
  assert.ok(existsSync(task!.workspace));
  return task!;
};

test('a project selected after a default Chat exists becomes the real read scope of its tools', { timeout: 120000 }, async t => {
  const env = await setup((body, index) => {
    const user = lastUser(body);
    if (toolResult(body)) return { content: 'Read the selected project; no further action.' };
    if (user.includes('List the selected project')) return toolBatch([
      { id: 'later-list', name: 'list_files', arguments: { path: '.' } },
      { id: 'later-write', name: 'write_file', arguments: { path: 'must-not-exist.txt', content: 'nope' } },
      { id: 'later-shell', name: 'run_shell', arguments: { command: 'echo nope' } },
      { id: 'later-mcp', name: 'mcp_call', arguments: { serverId: 'none', toolName: 'echo', arguments: {} } },
    ])(body, index);
    return { content: 'Default answer.' };
  });
  t.after(() => env.close());

  const first = await sendChat(env, 'Start a default conversation.');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const sessionId = first.body.sessionId as string;
  await waitSettled(env, sessionId, 1);
  assert.ok(samePath(env.store().getSession(sessionId).workspace!, PROJECT_ROOT), 'a default Chat still starts on the installation root scope');
  assert.equal(env.kernel().listTasks().length, 0, 'a plain turn must not allocate a tool task');

  const projectId = await register(env, env.workspaceA);
  const sent = await sendChat(env, 'List the selected project.', { sessionId, projectId });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await waitSettled(env, sessionId, 3, { list_files: 1 });

  // The Harness session, not only the Product index, follows the project selected later.
  const session = env.store().getSession(sessionId);
  assert.ok(session.workspace && samePath(session.workspace, realpathSync(env.workspaceA)),
    'the selected project must become the Harness session workspace, got ' + session.workspace);
  const view = await detail(env, sessionId);
  assert.equal(view.body.projectId, projectId, 'the Product index keeps the project association');

  // The tool read the real project, and that receipt is what the model received next.
  const listed = latestList(env, sessionId);
  assert.equal(listed.failureStage, undefined);
  assert.match(String(listed.result), /alpha-marker\.txt/, 'list_files must read the selected project, got ' + String(listed.result));
  assert.ok(listed.taskId, 'the completed read must be bound to a Kernel task');
  const task = assertProjectTask(env, listed.taskId!, env.workspaceA);
  assert.ok(env.services().runner.managedExternally.has(task.id), 'the Chat tool task stays outside the autonomous Runner');
  const continuation = env.wire.at(-1)!;
  const receipt = (Array.isArray(continuation.messages) ? continuation.messages : [])
    .find((message: any) => message?.role === 'tool' && message.tool_call_id === listed.toolCallId);
  assert.equal(receipt?.content, String(listed.result), 'the real receipt feeds the next model request');
  assert.equal(env.services().runner.managedExternally.size >= 1, true);

  // Chat stays read-only: write/exec/MCP are denied before any intent or effect exists.
  for (const name of ['write_file', 'run_shell', 'mcp_call']) {
    const denied = env.store().toolCalls({ sessionId, limit: 50 }).find(record => record.name === name)!;
    assert.equal(denied.status, 'failed', name + ' must be denied: ' + String(denied.error));
    assert.equal(denied.failureStage, 'permission');
    assert.equal(denied.intentId, undefined, name + ' must not reach a Kernel intent');
    assert.equal(denied.taskId, undefined, name + ' must not create a task');
  }
  assert.equal(existsSync(path.join(env.workspaceA, 'must-not-exist.txt')), false);
  assert.equal(existsSync(path.join(PROJECT_ROOT, 'must-not-exist.txt')), false);
  assert.equal(env.kernel().listTasks().length, 1, 'only the read-only Chat tool task may exist');

  // Selecting the same project again is idempotent: no second task, no rebinding.
  const again = await sendChat(env, 'List the selected project again.', { sessionId, projectId });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  await waitSettled(env, sessionId, 5, { list_files: 2 });
  assert.equal(env.kernel().listTasks().length, 1);
  assert.equal(latestList(env, sessionId).taskId, task.id, 'the same scope must reuse the existing Chat tool task');
  assert.match(String(latestList(env, sessionId).result), /alpha-marker\.txt/);
});

test('a Chat session that already used tools follows a later project switch, including across restart', { timeout: 180000 }, async t => {
  const env = await setup((body, index) => {
    const user = lastUser(body);
    if (toolResult(body)) return { content: 'Receipt received; no further action.' };
    if (/alpha|beta|switch|list/i.test(user)) return toolBatch([{ id: 'switch-list', name: 'list_files', arguments: { path: '.' } }])(body, index);
    return { content: 'Plain answer.' };
  });
  t.after(() => env.close());
  const projectA = await register(env, env.workspaceA);
  const projectB = await register(env, env.workspaceB);

  const start = await sendChat(env, 'List project alpha.', { projectId: projectA });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const sessionId = start.body.sessionId as string;
  await waitSettled(env, sessionId, 2, { list_files: 1 });
  const alphaRecord = latestList(env, sessionId);
  assert.match(String(alphaRecord.result), /alpha-marker\.txt/);
  const taskA = assertProjectTask(env, alphaRecord.taskId!, env.workspaceA);
  assert.ok(samePath(env.store().getSession(sessionId).workspace!, realpathSync(env.workspaceA)));

  // The used session is switched to project beta through the product send route.
  const switched = await sendChat(env, 'Switch to project beta and list it.', { sessionId, projectId: projectB });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  await waitSettled(env, sessionId, 4, { list_files: 2 });
  const betaRecord = latestList(env, sessionId);
  assert.match(String(betaRecord.result), /beta-marker\.txt/, 'the switched Chat must read project beta, got ' + String(betaRecord.result));
  const taskB = assertProjectTask(env, betaRecord.taskId!, env.workspaceB);
  assert.notEqual(taskB.id, taskA.id, 'a new scope must not reuse the previous project task');
  assert.ok(samePath(env.store().getSession(sessionId).workspace!, realpathSync(env.workspaceB)));
  assert.equal((await detail(env, sessionId)).body.projectId, projectB);

  // The old task keeps its own workspace/receipt as audit, and remains outside the Runner.
  assert.equal(env.kernel().getTask(taskA.id)!.id, taskA.id);
  assert.ok(samePath(env.kernel().getTask(taskA.id)!.workspace, realpathSync(env.workspaceA)));
  assert.equal(env.store().getTool(alphaRecord.id)!.status, 'completed');
  assert.match(String(env.store().getTool(alphaRecord.id)!.result), /alpha-marker\.txt/);
  assert.equal(env.kernel().intents(taskA.id).filter(intent => intent.state === 'applied').length, 1, 'the old receipt is not replayed or rebound');
  assert.ok(env.services().runner.managedExternally.has(taskA.id) && env.services().runner.managedExternally.has(taskB.id));

  // Restart: the binding survives, both Chat tasks stay out of the autonomous Runner, no replay/model call.
  const wireBeforeRestart = env.wire.length;
  await env.restart();
  await env.toolsReady();
  assert.equal(env.wire.length, wireBeforeRestart, 'restart must not invent a model request');
  assert.equal(env.kernel().intents(taskA.id).filter(intent => intent.state === 'applied').length, 1);
  assert.ok(env.services().runner.managedExternally.has(taskA.id), 'the replaced project task must stay externally managed after restart');
  assert.ok(env.services().runner.managedExternally.has(taskB.id), 'the current project task must stay externally managed after restart');
  assert.equal(env.kernel().getTask(taskA.id)!.status, 'waiting_input', 'the replaced task must not be runnable after restart');
  assert.equal(env.kernel().getTask(taskB.id)!.status, 'waiting_input');
  await sleep(150); // give the Runner a tick to (wrongly) pick a task up

  const followUp = await sendChat(env, 'List the current project again.', { sessionId });
  assert.equal(followUp.status, 200, JSON.stringify(followUp.body));
  await waitSettled(env, sessionId, wireBeforeRestart + 2, { list_files: 3 });
  const afterRestart = latestList(env, sessionId);
  assert.match(String(afterRestart.result), /beta-marker\.txt/, 'after restart the session must still read beta, got ' + String(afterRestart.result));
  assert.equal(afterRestart.taskId, taskB.id, 'a follow-up after restart must reuse the current scope task');
  assert.equal(env.kernel().listTasks().length, 2, 'no extra task may be allocated by the follow-up');

  // Switching back is a new governed scope, never a silent fallback to the old task.
  const back = await sendChat(env, 'Switch back to project alpha and list it.', { sessionId, projectId: projectA });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  await waitSettled(env, sessionId, wireBeforeRestart + 4, { list_files: 4 });
  const backRecord = latestList(env, sessionId);
  assert.match(String(backRecord.result), /alpha-marker\.txt/);
  assert.notEqual(backRecord.taskId, taskA.id, 'the old task is history, not reused authority');
  assertProjectTask(env, backRecord.taskId!, env.workspaceA);
  assert.equal(env.kernel().getTask(taskA.id)!.status, 'waiting_input', 'the replaced task keeps its settled state');
});

test('an unknown project id is rejected before the Chat session or a model request changes', { timeout: 120000 }, async t => {
  const env = await setup(body => toolResult(body) ? { content: 'done' } : { content: 'Plain answer.' });
  t.after(() => env.close());
  const first = await sendChat(env, 'Create the default conversation.');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const sessionId = first.body.sessionId as string;
  await waitSettled(env, sessionId, 1);
  const workspace = env.store().getSession(sessionId).workspace;

  const rejected = await sendChat(env, 'Select a missing project.', { sessionId, projectId: 'project-does-not-exist' });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.equal(rejected.body.code, 'validation');
  assert.match(String(rejected.body.error), /project/i);
  assert.equal(env.wire.length, 1, 'a rejected project must not cause a model request');
  assert.equal(env.store().getSession(sessionId).workspace, workspace, 'a rejected project must not change the Harness session scope');
  assert.equal((await detail(env, sessionId)).body.projectId, undefined, 'a rejected project must not enter the Product index');
  assert.equal(env.kernel().listTasks().length, 0);

  const retry = await sendChat(env, 'Continue without a project.', { sessionId });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  await waitSettled(env, sessionId, 2);
});

test('a project target that violates the workspace boundary is rejected before any Chat state changes', { timeout: 120000 }, async t => {
  const env = await setup(body => toolResult(body) ? { content: 'done' } : { content: 'Plain answer.' });
  t.after(() => env.close());
  const first = await sendChat(env, 'Create the default conversation.');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const sessionId = first.body.sessionId as string;
  await waitSettled(env, sessionId, 1);
  const workspace = env.store().getSession(sessionId).workspace;

  // A tampered registry entry is the only way a dangerous target could arrive by id; the Services
  // boundary, not the registry file, must stay authoritative.
  const dangerous = env.dataDir;
  const now = new Date().toISOString();
  writeFileSync(path.join(env.dataDir, 'projects.json'), JSON.stringify([
    { id: workspaceRootId(dangerous), path: dangerous, name: 'tampered-data', addedAt: now, lastOpenedAt: now },
  ]));
  const projectId = workspaceRootId(dangerous);
  const rejected = await sendChat(env, 'Select the tampered project.', { sessionId, projectId });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.equal(rejected.body.code, 'validation');
  assert.match(String(rejected.body.error), /workspace|project/i);
  assert.equal(env.wire.length, 1, 'a rejected workspace must not cause a model request');
  assert.equal(env.store().getSession(sessionId).workspace, workspace);
  assert.equal((await detail(env, sessionId)).body.projectId, undefined);
  assert.equal(env.kernel().listTasks().length, 0);

  // A new Chat must not be created around an unsafe project either.
  const created = await sendChat(env, 'Create a new Chat on the tampered project.', { projectId });
  assert.equal(created.status, 400, JSON.stringify(created.body));
  assert.equal(created.body.code, 'validation');
  assert.equal(env.wire.length, 1);
  assert.equal(env.harness().store.listSessions().length, 1, 'the rejected project must not create a session');
});

test('a pending model request refuses the project switch and leaves the original session scope intact', { timeout: 120000 }, async t => {
  let release!: (value: MockCompletion) => void;
  const slow = new Promise<MockCompletion>(resolve => { release = resolve; });
  const env = await setup(body => {
    if (toolResult(body)) return { content: 'done' };
    if (lastUser(body).includes('Slow question')) return slow;
    return { content: 'Fast answer.' };
  });
  t.after(async () => { release({ content: 'Late answer.' }); await env.close(); });
  const projectA = await register(env, env.workspaceA);

  const first = await sendChat(env, 'Create the default conversation.');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const sessionId = first.body.sessionId as string;
  await waitSettled(env, sessionId, 1);
  const slowSend = await sendChat(env, 'Slow question.', { sessionId });
  assert.equal(slowSend.status, 200, JSON.stringify(slowSend.body));
  await until(() => env.wire.length === 2 ? true : undefined, 'the pending model request');

  const rejected = await sendChat(env, 'Switch to alpha.', { sessionId, projectId: projectA });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.code, 'busy');
  assert.equal(env.wire.length, 2, 'the rejected switch must not add a model request');
  assert.ok(samePath(env.store().getSession(sessionId).workspace!, PROJECT_ROOT), 'the pending switch must not change the stored scope');
  assert.equal((await detail(env, sessionId)).body.projectId, undefined);
  assert.equal(env.kernel().listTasks().length, 0);

  release({ content: 'Slow answer finished.' });
  await waitSettled(env, sessionId, 2);
  const switched = await sendChat(env, 'Now switch to alpha.', { sessionId, projectId: projectA });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  await waitSettled(env, sessionId, 3);
  assert.ok(samePath(env.store().getSession(sessionId).workspace!, realpathSync(env.workspaceA)));
});

test('a pending tool call refuses the project switch and keeps its task and receipt provenance', { timeout: 180000 }, async t => {
  let releaseFetch!: (value: Response) => void;
  const gated = new Promise<Response>(resolve => { releaseFetch = resolve; });
  const webOptions = {
    searchProvider: 'wikipedia' as const,
    resolveDns: async () => [{ address: '93.184.216.34', family: 4 as const }],
    fetch: async () => gated,
  };
  const env = await setup((body, index) => {
    const user = lastUser(body);
    if (toolResult(body)) return { content: 'Search receipt received.' };
    if (user.includes('Search while alpha')) return toolBatch([{ id: 'pending-web', name: 'web_search', arguments: { query: 'pending switch probe' } }])(body, index);
    if (user.includes('List beta')) return toolBatch([{ id: 'beta-list', name: 'list_files', arguments: { path: '.' } }])(body, index);
    return { content: 'Plain answer.' };
  });
  t.after(async () => { releaseFetch(Response.json({})); await env.close(); });
  const projectA = await register(env, env.workspaceA);
  const projectB = await register(env, env.workspaceB);
  const configured = await env.requestRaw('POST', '/v1/config', { searchProvider: 'wikipedia' });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  (env.services().external as unknown as { options: { webOptions?: typeof webOptions } }).options.webOptions = webOptions;

  const start = await sendChat(env, 'Create the alpha conversation.', { projectId: projectA });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const sessionId = start.body.sessionId as string;
  await waitSettled(env, sessionId, 1);

  const searched = await sendChat(env, 'Search while alpha is selected.', { sessionId });
  assert.equal(searched.status, 200, JSON.stringify(searched.body));
  const pending = await until(() => {
    const record = env.store().toolCalls({ sessionId, limit: 50 }).find(item => item.name === 'web_search');
    return record && record.status === 'running' ? record : undefined;
  }, 'the web_search tool call to start');
  assert.ok(pending.taskId, 'a dispatched Chat tool is bound to its task before it settles');
  const alphaTask = assertProjectTask(env, pending.taskId!, env.workspaceA);
  const sessionWorkspace = env.store().getSession(sessionId).workspace;
  const wireBefore = env.wire.length;

  const rejected = await sendChat(env, 'Switch to beta while the tool is pending.', { sessionId, projectId: projectB });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.code, 'busy');
  assert.equal(env.wire.length, wireBefore, 'the rejected switch must not start a model request');
  assert.equal(env.store().getSession(sessionId).workspace, sessionWorkspace, 'the pending tool scope must not change');
  assert.equal((await detail(env, sessionId)).body.projectId, projectA);
  const afterReject = env.store().getTool(pending.id);
  assert.equal(afterReject.status, 'running', 'the pending tool must keep running under its original task');
  assert.equal(afterReject.taskId, alphaTask.id);
  assert.equal(afterReject.intentId, pending.intentId, 'the dispatched receipt identity must not change');
  assert.equal(env.kernel().getTask(alphaTask.id)!.workspace, alphaTask.workspace);

  releaseFetch(Response.json({ query: { search: [{ title: 'Controlled pending receipt', snippet: 'resolved after refusal' }] } }));
  await waitSettled(env, sessionId, wireBefore + 1, { web_search: 1 });
  const settled = env.store().getTool(pending.id);
  assert.equal(settled.status, 'completed', String(settled.error));
  assert.equal(settled.intentId, pending.intentId);
  assert.match(String(settled.result), /Controlled pending receipt/);

  const switched = await sendChat(env, 'Now switch to beta.', { sessionId, projectId: projectB });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  await waitSettled(env, sessionId, wireBefore + 2);
  const listed = await sendChat(env, 'List beta now.', { sessionId });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  await waitSettled(env, sessionId, wireBefore + 4, { list_files: 1 });
  const betaRecord = latestList(env, sessionId);
  assert.match(String(betaRecord.result), /beta-marker\.txt/, 'after the pending tool settles the switch must read beta');
  assertProjectTask(env, betaRecord.taskId!, env.workspaceB);
  assert.notEqual(betaRecord.taskId, alphaTask.id);
});

test('a case-only variant of the installation root is the same implicit default scope', { timeout: 120000, skip: process.platform === 'win32' ? false : 'Windows path identity' }, async t => {
  const env = await setup(toolBatch([{ id: 'case-list', name: 'list_files', arguments: { path: '.' } }]));
  t.after(() => env.close());
  const rootVariant = caseVariant(PROJECT_ROOT);
  assert.notEqual(rootVariant, PROJECT_ROOT);
  const session = env.store().createSession({ title: 'Case variant root', workspace: rootVariant,
    capabilities: { web: true, tools: true, mcp: false, skills: false, projectInstructions: false } });
  const sent = await env.requestRaw('POST', '/v1/harness/chat', { sessionId: session.id, content: 'List the default scope.' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const record = await until(() => {
    const found = env.store().toolCalls({ sessionId: session.id, limit: 20 }).find(item => item.name === 'list_files');
    return found && TERMINAL.has(found.status) ? found : undefined;
  }, 'the case-variant root tool to settle');
  assert.equal(record.status, 'completed', 'a case-only variant of the installation root must stay the implicit scope: ' + String(record.error));
  assert.equal(record.failureStage, undefined);
  assert.equal(record.result, '[]');
  assert.ok(record.taskId);
  assertImplicitTask(env, record.taskId!);
  assert.equal(env.kernel().listTasks().length, 1);

  // The explicit dangerous boundary is not lowered by that equality fix.
  const dangerousVariant = caseVariant(env.dataDir);
  assert.notEqual(dangerousVariant, env.dataDir);
  const dangerousSession = env.store().createSession({ title: 'Case variant data root', workspace: dangerousVariant,
    capabilities: { web: true, tools: true, mcp: false, skills: false, projectInstructions: false } });
  const dangerousSend = await env.requestRaw('POST', '/v1/harness/chat', { sessionId: dangerousSession.id, content: 'List the data directory.' });
  assert.equal(dangerousSend.status, 200, JSON.stringify(dangerousSend.body));
  const rejected = await until(() => {
    const found = env.store().toolCalls({ sessionId: dangerousSession.id, limit: 20 }).find(item => item.name === 'list_files');
    return found && TERMINAL.has(found.status) ? found : undefined;
  }, 'the case-variant data root tool to settle');
  assert.equal(rejected.status, 'failed', 'the data directory stays a rejected scope in any casing');
  assert.match(String(rejected.error), /audit, approval and task data|mutable task workspace/);
  assert.equal(rejected.taskId, undefined, 'a rejected explicit scope must not create a task');
  assert.equal(env.kernel().listTasks().length, 1);
});
