import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, linkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatTools } from '../src/harness/chat-tools.js';
import type { ChatService } from '../src/harness/chat.js';
import { HarnessStore } from '../src/harness/store.js';
import { Configuration } from '../src/app/configuration.js';
import { ExternalTools } from '../src/app/external-tools.js';
import { Runner } from '../src/app/runner.js';
import type { Services } from '../src/app/services.js';
import type { CandidateManager } from '../src/adaptation/index.js';
import { Kernel } from '../src/kernel/index.js';
import type { Command, ToolCall } from '../src/contracts.js';
import type { ChatSession } from '../src/harness/types.js';
import { INTEGRATION_TOOL_DEFINITIONS, type IntegrationTools } from '../src/integrations/tools.js';
import { digestValue } from '../src/tools/policy.js';

type IntegrationBoundary = Pick<IntegrationTools, 'definitions' | 'prepare' | 'execute' | 'queryOutcome'>;
async function fixture(t: import('node:test').TestContext, integration?: IntegrationBoundary) {
  const tempRoot = path.resolve(process.env.TEMP ?? '.tmp'), owned = mkdtempSync(path.join(tempRoot, 'chat-tools-')), workspace = path.join(owned, 'workspace'), dataDir = path.join(owned, 'data');
  mkdirSync(workspace); mkdirSync(dataDir);
  let store = new HarnessStore(dataDir), kernel = new Kernel(dataDir);
  const configuration = new Configuration('http://127.0.0.1:1/provider/v1');
  const candidates = { snapshotFor: () => ({}), applySnapshot: async (_: unknown, value: string) => value } as unknown as CandidateManager;
  let runner = new Runner(kernel, configuration, candidates, dataDir), webRequests = 0;
  const external = new ExternalTools({ dataDir, projectRoot: path.resolve('.'), webOptions: { searchProvider: 'wikipedia', resolveDns: async () => [{ address: '93.184.216.34', family: 4 }], fetch: async () => {
    webRequests++; return Response.json({ query: { search: [{ title: 'Checked result', snippet: 'Owned public transport fixture' }] } });
  } } });
  const services = { dataDir, projectRoot: path.resolve('.'), configuration, external, integrations: integration ? { tools: integration } : undefined, get kernel() { return kernel; }, get runner() { return runner; }, command(command: Command) {
    const result = kernel.command(command); if (result.taskId) mkdirSync(kernel.getTask(result.taskId)!.workspace, { recursive: true }); return result;
  } } as unknown as Services;
  const continuations: string[] = [];
  const chat = { async continue(sessionId: string, parentId?: string) {
    continuations.push(sessionId);
    const request = store.createRequest({ sessionId, parentId, kind: 'chat', profileId: 'default', status: 'completed', endpoint: 'fixture', bodyHash: 'fixture', sources: [], recordContent: true, draft: '' });
    return { requestId: request.id, status: 'running' };
  } } as unknown as ChatService;
  let bridge = new ChatTools(services, store, chat); await bridge.ready;
  t.after(async () => {
    await bridge.stop(); await runner.stop(); await external.close(); store.close(); kernel.close();
    assert.equal(path.dirname(owned), tempRoot); rmSync(owned, { recursive: true, force: true });
  });
  const until = async (condition: () => boolean) => {
    const deadline = performance.now() + 10000;
    while (!condition() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15));
    assert.ok(condition(), 'Expected tool state before deadline');
  };
  return { owned, workspace, dataDir, get kernel() { return kernel; }, get store() { return store; }, get bridge() { return bridge; }, get runner() { return runner; }, external, continuations, get webRequests() { return webRequests; }, until,
    session(capabilities: Partial<ChatSession['capabilities']> = {}) { return store.createSession({ workspace, capabilities: { web: true, tools: true, mcp: true, skills: false, projectInstructions: false, ...capabilities } }); },
    async propose(session: ChatSession, calls: ToolCall[], exposed = calls.map(call => call.name), kind: 'chat' | 'studio' = 'chat') {
      const request = store.createRequest({ sessionId: session.id, kind, profileId: 'default', status: 'completed', endpoint: 'fixture', bodyHash: 'fixture', sources: [], recordContent: false, exposedToolNames: exposed, draft: '' });
      store.addMessage(session.id, { role: 'assistant', content: '', toolCalls: calls, requestId: request.id });
      for (const call of calls) store.saveTool({ id: `${request.id}:${call.id}`, requestId: request.id, sessionId: session.id, toolCallId: call.id, name: call.name, arguments: call.arguments, source: call.name.startsWith('web') ? 'web' : 'builtin', permission: 'unassessed', status: 'proposed', retries: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await bridge.accept(session, request.id, { content: '', toolCalls: calls, finishReason: 'tool_calls' });
      return calls.map(call => `${request.id}:${call.id}`);
    },
    async restart() { await bridge.stop(); await runner.stop(); store.close(); kernel.close(); store = new HarnessStore(dataDir); kernel = new Kernel(dataDir); kernel.recover(); runner = new Runner(kernel, configuration, candidates, dataDir); bridge = new ChatTools(services, store, chat); await bridge.ready; },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const now = () => new Date().toISOString();

/** Build the kernel task and run a legacy Chat record would have pointed at; older ChatTools created tasks without a permission request. */
function manualTask(f: Fixture, session: ChatSession, permission: Record<string, unknown> | null = { app: 'chat', mode: 'read-only' }) {
  const ack = f.kernel.command({ commandId: `manual-task-${randomUUID()}`, type: 'create_task', parameters: {
    title: 'Manual Chat task', workspace: session.workspace, ...(permission ? { permission } : {}),
    goal: { objective: 'Manual Chat task', constraints: [], acceptance: [], maxModelCalls: 1, maxToolCalls: 10, mode: 'collaborative' } } });
  const taskId = ack.taskId!, task = f.kernel.getTask(taskId)!;
  mkdirSync(task.workspace, { recursive: true });
  const runId = f.kernel.createRun(taskId).id; f.kernel.transition(taskId, 'running');
  return { taskId, runId };
}

function manualRequest(f: Fixture, session: ChatSession, exposed: string[]) {
  return f.store.createRequest({ sessionId: session.id, kind: 'chat', profileId: 'default', status: 'completed', endpoint: 'fixture', bodyHash: 'fixture', sources: [], recordContent: false, exposedToolNames: exposed, draft: '' });
}

/** A record an older ChatTools left awaiting approval, bound to a real prepared write intent. */
function legacyWrite(f: Fixture, session: ChatSession, callId = 'legacy-write', filename = 'legacy.txt') {
  const { taskId, runId } = manualTask(f, session, null);
  const request = manualRequest(f, session, ['write_file']);
  const args = { path: filename, content: 'never written' };
  const intent = f.kernel.prepareIntent(taskId, runId, { id: callId, name: 'write_file', arguments: args }, { effectKey: `legacy-${callId}`, capability: 'workspace.write', paths: [path.join(session.workspace!, filename)] });
  const digest = digestValue({ name: 'write_file', arguments: args });
  f.store.saveTool({ id: `${request.id}:${callId}`, requestId: request.id, sessionId: session.id, toolCallId: callId, name: 'write_file', arguments: args, source: 'builtin', permission: 'approval_required', status: 'awaiting_approval', taskId, runId, intentId: intent.id, digest, retries: 0, createdAt: now(), updatedAt: now() });
  return { request, taskId, runId, intent, recordId: `${request.id}:${callId}`, digest };
}

/** Dispatch an external web effect at kernel level, as a crashed/ChatTools-bypassing request would have left it. */
async function dispatchedWeb(f: Fixture, session: ChatSession, callId: string, query: string, execute: boolean) {
  const { taskId, runId } = manualTask(f, session);
  const request = manualRequest(f, session, ['web_search']);
  const prepared = (await f.external.prepare({ name: 'web_search', arguments: { query } }))!;
  const intent = f.kernel.prepareIntent(taskId, runId, { id: callId, name: 'web_search', arguments: prepared.arguments }, { effectKey: `dispatched-${callId}`, capability: 'network.read', paths: [], resources: prepared.resources });
  f.kernel.approve(intent.id, { source: 'policy' }); f.kernel.dispatch(intent.id);
  if (execute) assert.equal((await f.external.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest })).status, 'applied');
  const recordId = `${request.id}:${callId}`;
  f.store.saveTool({ id: recordId, requestId: request.id, sessionId: session.id, toolCallId: callId, name: 'web_search', arguments: prepared.arguments, source: 'web', permission: 'read_only', status: 'running', taskId, runId, intentId: intent.id, digest: prepared.digest, retries: 0, createdAt: now(), updatedAt: now() });
  return { request, intent, recordId };
}

test('Chat memory tools retrieve archived evidence without workspace permission and recover an unsent note once', { timeout: 25000 }, async t => {
  const f = await fixture(t), session = f.session({ tools: false, web: false, mcp: false });
  const original = f.store.addMessage(session.id, { role: 'user', content: 'padding '.repeat(1800) + 'Rare decision: storage stays on F drive.' });
  const [search] = await f.propose(session, [{ id: 'search', name: 'search_history', arguments: { query: 'Rare decision' } }]);
  await f.until(() => !!f.store.getTool(search!).receivedByRequestId);
  assert.match(String(f.store.getTool(search!).result), /Rare decision/);
  assert.equal(f.kernel.listTasks().length, 0, 'Session recall needs no workspace tool task or authority');
  const [read] = await f.propose(session, [{ id: 'read', name: 'read_history', arguments: { id: original.id, offset: 14000, length: 1000 } }]);
  await f.until(() => !!f.store.getTool(read!).receivedByRequestId);
  assert.match(String(f.store.getTool(read!).result), /storage stays on F/);
  const call = { id: 'note', name: 'remember', arguments: { key: 'storage', kind: 'constraint', text: 'Keep storage on F', sourceIds: [original.id], expectedRevision: 0 } };
  await f.bridge.stop();
  const [note] = await f.propose(session, [call]); // Stored model decision; dispatch has not happened.
  await f.restart();
  await f.until(() => !!f.store.getTool(note!).receivedByRequestId);
  assert.equal(f.store.memory(session.id).notes().notes[0]?.revision, 1);
  await f.restart();
  assert.equal(f.store.memory(session.id).notes({ revisions: true }).notes.length, 1);
  const foreign = f.store.createSession();
  const [rejected] = await f.propose(foreign, [{ id: 'cross', name: 'read_history', arguments: { id: original.id } }]);
  await f.until(() => !!f.store.getTool(rejected!).receivedByRequestId);
  assert.equal(f.store.getTool(rejected!).status, 'failed');
  assert.match(f.store.getTool(rejected!).error!, /scope/);
});

test('Chat refuses side-effect proposals without an approval dialog or an effect', { timeout: 25000 }, async t => {
  const f = await fixture(t), session = f.session();
  const [id] = await f.propose(session, [{ id: 'write', name: 'write_file', arguments: { path: 'result.txt', content: 'never written' } }]);
  await f.until(() => f.store.getTool(id!).status === 'failed');
  const record = f.store.getTool(id!);
  assert.equal(record.failureStage, 'permission'); assert.notEqual(record.status, 'awaiting_approval');
  assert.match(record.error!, /enabled/);
  assert.equal(record.intentId, undefined, 'Chat fails before any kernel intent exists');
  assert.equal(existsSync(path.join(f.workspace, 'result.txt')), false);
  assert.equal(f.kernel.listTasks().length, 0);
  const toolMessage = f.store.allMessages(session.id).find(message => message.role === 'tool' && message.toolCallId === 'write')!;
  assert.match(toolMessage.content, /executed.*false/);
  assert.equal(f.continuations.length, 1);
  await assert.rejects(f.bridge.approve(id!, { digest: 'anything', approved: true }), /not awaiting/);
});

test('Chat approve settles a legacy side-effect approval denied without executing it', { timeout: 25000 }, async t => {
  const f = await fixture(t), session = f.session(), legacy = legacyWrite(f, session);
  await assert.rejects(f.bridge.approve(legacy.recordId, { digest: 'wrong', approved: true }), /exact prepared/);
  assert.equal(f.store.getTool(legacy.recordId)!.status, 'awaiting_approval');
  await assert.rejects(f.bridge.approve(legacy.recordId, { digest: legacy.digest, approved: true }), /cannot execute side effects/);
  const settled = f.store.getTool(legacy.recordId)!;
  assert.equal(settled.status, 'denied'); assert.equal(settled.failureStage, 'permission');
  assert.equal(f.kernel.getIntent(legacy.intent.id)!.state, 'denied');
  assert.equal(existsSync(path.join(f.workspace, 'legacy.txt')), false);
  assert.match(f.store.allMessages(session.id).at(-1)!.content, /executed.*false/);
  const second = legacyWrite(f, session, 'legacy-deny', 'denied.txt');
  const denied = await f.bridge.approve(second.recordId, { digest: second.digest, approved: false });
  assert.equal(denied.status, 'denied'); assert.equal(f.kernel.getIntent(second.intent.id)!.state, 'denied');
  assert.equal(existsSync(path.join(f.workspace, 'denied.txt')), false);
});

test('restart revokes an unsent legacy Chat effect and never executes it', { timeout: 25000 }, async t => {
  const f = await fixture(t), session = f.session(), legacy = legacyWrite(f, session, 'crash');
  await f.restart();
  const restored = f.kernel.getIntent(legacy.intent.id)!;
  assert.equal(restored.state, 'denied');
  assert.match(restored.error!, /invalidated during recovery/);
  assert.equal(f.store.getTool(legacy.recordId)!.status, 'failed');
  assert.equal(f.store.getTool(legacy.recordId)!.failureStage, 'permission');
  assert.equal(existsSync(path.join(f.workspace, 'legacy.txt')), false);
});

test('same-batch calls execute in order; a read needs no dialog and a denied write has no effect', { timeout: 25000 }, async t => {
  const f = await fixture(t), session = f.session(); writeFileSync(path.join(f.workspace, 'input.txt'), 'real read evidence');
  const [readId, writeId] = await f.propose(session, [
    { id: 'read', name: 'read_file', arguments: { path: 'input.txt' } },
    { id: 'write', name: 'write_file', arguments: { path: 'denied.txt', content: 'must not appear' } },
  ]);
  await f.until(() => f.store.getTool(writeId!).status === 'failed');
  const read = f.store.getTool(readId!);
  assert.equal(read.status, 'completed'); assert.match(String(read.result), /real read evidence/);
  assert.equal(existsSync(path.join(f.workspace, 'denied.txt')), false);
  const toolMessages = f.store.allMessages(session.id).filter(message => message.role === 'tool');
  assert.deepEqual(toolMessages.map(message => message.toolCallId), ['read', 'write']); assert.match(toolMessages[1]!.content, /executed.*false/);
  assert.equal(f.continuations.length, 1); assert.equal(f.kernel.getTask(read.taskId!)!.status, 'waiting_input');
});

test('session capabilities and actual exposure both gate tools, and Studio responses cannot execute effects', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  for (const [session, exposed] of [[f.session({ tools: false }), ['write_file']], [f.session(), []]] as const) {
    const [id] = await f.propose(session, [{ id: randomUUID(), name: 'write_file', arguments: { path: 'forbidden.txt', content: 'no' } }], [...exposed]);
    await f.until(() => f.store.getTool(id!).status === 'failed'); assert.equal(f.store.getTool(id!).failureStage, 'permission');
    assert.equal(existsSync(path.join(f.workspace, 'forbidden.txt')), false);
  }
  await assert.rejects(f.propose(f.session(), [{ id: 'studio-write', name: 'write_file', arguments: { path: 'studio.txt', content: 'no' } }], ['write_file'], 'studio'), /matching Chat request/);
  assert.equal(existsSync(path.join(f.workspace, 'studio.txt')), false); assert.equal(f.kernel.listTasks().length, 0);
});

test('tool inspector distinguishes unknown names, denied capabilities and Chat side-effect refusals', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  for (const [session, call, expected] of [
    [f.session(), { id: 'unknown', name: 'invented_tool', arguments: {} }, 'unknown_tool'],
    [f.session({ tools: false }), { id: 'not-allowed', name: 'read_file', arguments: { path: 'file.txt' } }, 'permission'],
    [f.session(), { id: 'side-effect', name: 'write_file', arguments: { path: 'file.txt', content: 42 } }, 'permission'],
  ] as const) {
    const [id] = await f.propose(session, [call]); await f.until(() => f.store.getTool(id!).status === 'failed');
    assert.equal(f.store.getTool(id!).failureStage, expected);
  }
  assert.equal(f.kernel.listTasks().length, 0); assert.equal(existsSync(path.join(f.workspace, 'file.txt')), false);
});

test('restart reconciles a dispatched Chat receipt without repeating the effect; unknown never replays', { timeout: 35000 }, async t => {
  const f = await fixture(t), session = f.session();
  const applied = await dispatchedWeb(f, session, 'web-applied', 'checked fixture', true);
  const requests = f.webRequests, continuations = f.continuations.length;
  await f.restart();
  assert.equal(f.store.getTool(applied.recordId)!.status, 'completed');
  assert.match(String(f.store.getTool(applied.recordId)!.result), /Checked result/);
  assert.equal(f.kernel.getIntent(applied.intent.id)!.state, 'applied');
  assert.equal(f.webRequests, requests, 'A completed receipt is settled from the store, not re-fetched');
  assert.equal(f.continuations.length, continuations + 1);

  const unknown = await dispatchedWeb(f, session, 'web-unknown', 'never sent to the network', false);
  const before = f.webRequests, count = f.continuations.length;
  await f.restart();
  const record = f.store.getTool(unknown.recordId)!;
  assert.equal(record.status, 'unknown'); assert.equal(record.failureStage, 'reconciliation');
  assert.equal(f.webRequests, before); assert.equal(f.continuations.length, count);
  assert.equal(f.kernel.getIntent(unknown.intent.id)!.state, 'unknown');
});

test('optional integration tools are refused like every other Chat side effect', { timeout: 30000 }, async t => {
  let enabled = true, prepares = 0, executions = 0;
  const integration: IntegrationBoundary = {
    definitions: () => enabled ? INTEGRATION_TOOL_DEFINITIONS : [],
    async prepare(workspace, call) {
      if (call.name !== 'rea_analyze_local') return undefined;
      assert.ok(enabled, 'A disabled integration cannot prepare a new call'); prepares++;
      const args = { workspace, manifest: [{ path: 'sample.js', sha256: digestValue('fixture'), bytes: 7 }], installation: 'fixture-pinned', version: '6.4.0' };
      return { name: call.name, arguments: args, digest: digestValue({ name: call.name, arguments: args }), capability: 'process.exec', mutating: true,
        resources: [path.join(workspace, 'sample.js'), path.resolve('src/integrations/tools.ts')] };
    },
    async execute() { executions++; throw new Error('Chat must never dispatch an integration effect'); },
    async queryOutcome() { throw new Error('Chat must never replay an integration effect'); },
  };
  const f = await fixture(t, integration), session = f.session();
  writeFileSync(path.join(f.workspace, 'sample.js'), 'let x=1');
  const [id] = await f.propose(session, [{ id: 'rea', name: 'rea_analyze_local', arguments: { paths: ['sample.js'] } }]);
  await f.until(() => f.store.getTool(id!).status === 'failed');
  assert.equal(f.store.getTool(id!).failureStage, 'permission');
  assert.equal(prepares, 0); assert.equal(executions, 0);
  assert.equal(f.kernel.listTasks().length, 0);
  enabled = false;
});

test('restart discovers an undispatched legacy Chat proposal beyond the 500-call Inspector window', { timeout: 25000 }, async t => {
  const f = await fixture(t), session = f.session();
  await f.bridge.stop();
  const [id] = await f.propose(session, [{ id: 'old-write', name: 'write_file', arguments: { path: 'old.txt', content: 'must never be written' } }]);
  f.store.transaction(() => {
    for (let n = 0; n < 510; n++) {
      const request = f.store.createRequest({ sessionId: session.id, kind: 'studio', profileId: 'default', status: 'completed', endpoint: 'fixture', bodyHash: 'fixture', sources: [], recordContent: false, draft: '' });
      f.store.saveTool({ id: `${request.id}:studio`, requestId: request.id, sessionId: session.id, toolCallId: 'studio', name: 'write_file', arguments: {}, source: 'builtin', permission: 'model_only', status: 'not_executed', retries: 0, createdAt: 'now', updatedAt: 'now' });
    }
  });
  await f.restart();
  await f.until(() => f.store.getTool(id!).status === 'failed');
  assert.equal(f.store.getTool(id!).failureStage, 'permission');
  assert.equal(existsSync(path.join(f.workspace, 'old.txt')), false);
  assert.equal(f.kernel.listTasks().length, 0);
});

test('recovery never duplicates an archived read result outside the recent message window', { timeout: 25000 }, async t => {
  const f = await fixture(t), session = f.session(); writeFileSync(path.join(f.workspace, 'input.txt'), 'retained read evidence');
  const [readId, writeId] = await f.propose(session, [
    { id: 'read-old', name: 'read_file', arguments: { path: 'input.txt' } },
    { id: 'write-pending', name: 'write_file', arguments: { path: 'pending.txt', content: 'not allowed' } },
  ]);
  await f.until(() => f.store.getTool(writeId!).status === 'failed');
  f.store.transaction(() => { for (let n = 0; n < 510; n++) f.store.addMessage(session.id, { role: 'user', content: `Archive filler ${n}` }); });
  await f.restart();
  assert.equal(f.store.allMessages(session.id).filter(message => message.role === 'tool' && message.toolCallId === 'read-old').length, 1);
  assert.match(String(f.store.getTool(readId!).result), /retained read evidence/);
  assert.equal(f.kernel.getBudgets(f.store.getTool(readId!).taskId!).toolCalls, 1);
  assert.equal(f.store.getTool(writeId!).status, 'failed');
});

test('Chat web reads execute without a dialog while actual MCP calls are refused', { timeout: 35000 }, async t => {
  const f = await fixture(t), session = f.session();
  const [webId, mcpId] = await f.propose(session, [
    { id: 'web', name: 'web_search', arguments: { query: 'checked fixture' } },
    { id: 'mcp', name: 'mcp_call', arguments: { serverId: 'chat-fixture', toolName: 'echo', arguments: { text: 'must not run' } } },
  ]);
  await f.until(() => f.store.getTool(webId!).status === 'completed' && f.store.getTool(mcpId!).status === 'failed');
  assert.equal(f.webRequests, 1); assert.match(String(f.store.getTool(webId!).result), /Checked result/);
  assert.equal(f.store.getTool(mcpId!).failureStage, 'permission');
  assert.equal(f.store.getTool(mcpId!).intentId, undefined);
  assert.equal(f.continuations.length, 1);
  const taskId = f.store.getTool(webId!).taskId!;
  assert.deepEqual(f.kernel.getTaskPermission(taskId), { ...f.kernel.getTaskPermission(taskId), app: 'chat', mode: 'read-only' });
  assert.equal(f.kernel.intents(taskId).filter(intent => intent.state === 'applied').length, 1);
  assert.equal(f.kernel.getBudgets(taskId).toolCalls, 1);
});

test('Chat discovers and executes only enabled, exposed read-only MCP tools through the real kernel ledger', async t => {
  const f = await fixture(t), session = f.session();
  const runtime = path.join(f.owned, 'node.exe'), server = path.join(f.owned, 'mcp.mjs');
  linkSync(process.execPath, runtime);
  writeFileSync(server, `import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).on('line', line => {
      const r = JSON.parse(line); if (r.id === undefined) return;
      const result = r.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'chat-test', version: '1' } }
        : r.method === 'tools/list' ? { tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } }, { name: 'write', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'verified read: ' + r.params.arguments.query }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
    });`);
  const config = { id: 'chat-read', name: 'Chat read test', command: runtime, args: [server], cwd: f.owned };
  const pending = await f.external.connect(config);
  await f.external.connect({ ...config, approvedDigest: pending.digest });
  const calls: ToolCall[] = [
    { id: 'discover', name: 'list_mcp_tools', arguments: { serverId: config.id, toolName: 'lookup' } },
    { id: 'read', name: 'mcp_read', arguments: { serverId: config.id, toolName: 'lookup', arguments: { query: 'catalog schema' } } },
    { id: 'write', name: 'mcp_read', arguments: { serverId: config.id, toolName: 'write', arguments: {} } },
  ];
  const ids = await f.propose(session, calls);
  await f.until(() => f.continuations.length === 1);
  assert.equal(f.store.getTool(ids[0]!).status, 'completed');
  assert.match(String(f.store.getTool(ids[0]!).result), /inputSchema/);
  const read = f.store.getTool(ids[1]!);
  assert.equal(read.status, 'completed');
  assert.match(String(read.result), /verified read: catalog schema/);
  assert.equal(f.kernel.getIntent(read.intentId!)!.state, 'applied');
  assert.equal(f.kernel.getTaskPermission(read.taskId!).app, 'chat');
  assert.equal(f.store.getTool(ids[2]!).status, 'failed');
  assert.equal(f.store.getTool(ids[2]!).intentId, undefined);
  const hidden = await f.propose(session, [calls[1]!], []);
  await f.until(() => f.store.getTool(hidden[0]!).status === 'failed');
  assert.equal(f.store.getTool(hidden[0]!).failureStage, 'permission');
  const disabled = await f.propose(f.session({ mcp: false }), [calls[1]!]);
  await f.until(() => f.store.getTool(disabled[0]!).status === 'failed');
  assert.equal(f.store.getTool(disabled[0]!).intentId, undefined);
  for (const decision of ['deny', 'ask'] as const) {
    f.kernel.setPermissionRules([{ id: `mcp-${decision}`, capability: 'mcp', pattern: 'mcp://chat-read/lookup', decision }]);
    const blocked = await f.propose(session, [calls[1]!]);
    await f.until(() => f.store.getTool(blocked[0]!).status === 'failed');
    const record = f.store.getTool(blocked[0]!);
    assert.notEqual(record.status, 'awaiting_approval', 'Chat never creates an approval dialog');
    if (record.intentId) assert.equal(f.kernel.getIntent(record.intentId)!.state, 'denied');
  }
  f.kernel.setPermissionRules([{ id: 'mcp-all', capability: 'mcp', pattern: '*', decision: 'deny' }]);
  const allDenied = await f.propose(session, [calls[1]!]);
  await f.until(() => f.store.getTool(allDenied[0]!).status === 'failed');
  assert.equal(f.store.getTool(allDenied[0]!).intentId, undefined);
  f.kernel.setPermissionRules([]);
  const execute = f.external.execute.bind(f.external);
  f.external.execute = async (prepared, options) => { await f.external.disconnect(config.id); return execute(prepared, options); };
  const disconnected = await f.propose(session, [calls[1]!]);
  await f.until(() => ['failed', 'unknown'].includes(f.store.getTool(disconnected[0]!).status));
  const failure = f.store.getTool(disconnected[0]!);
  assert.equal(failure.status, 'failed', 'disconnect before dispatch is a known failure and must not strand Chat in unknown');
  assert.equal(f.kernel.getIntent(failure.intentId!)!.state, 'failed');
  await f.restart();
  assert.equal(f.store.getTool(read.id).status, 'completed');
  assert.equal(f.kernel.intents(read.taskId!).filter(intent => intent.state === 'applied').length, 1);
});
