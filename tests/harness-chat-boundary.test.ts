import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ChatService, type ChatDependencies } from '../src/harness/chat.js';
import { ChatTools } from '../src/harness/chat-tools.js';
import { HarnessStore } from '../src/harness/store.js';
import { Configuration } from '../src/app/configuration.js';
import { ExternalTools } from '../src/app/external-tools.js';
import { Runner } from '../src/app/runner.js';
import { Kernel, digest } from '../src/kernel/index.js';
import { ModelClient, validateRequestBody } from '../src/runtime/model.js';
import { startMockProvider, type MockCompletion } from '../src/fixtures/mock-provider.js';
import type { Services } from '../src/app/services.js';
import type { CandidateManager } from '../src/adaptation/index.js';
import type { Command, ToolCall, ToolDefinition } from '../src/contracts.js';
import type { PreparedTool, ToolExecutionOptions, ToolOutcome } from '../src/tools/gateway.js';
import { digestValue } from '../src/tools/policy.js';
import { INTEGRATION_TOOL_DEFINITIONS, type IntegrationTools } from '../src/integrations/tools.js';
import { MEMORY_TOOL_NAMES } from '../src/memory/tools.js';
import { customParts } from '../src/harness/prompts.js';
import type { ChatSession, RequestBody } from '../src/harness/types.js';

/**
 * The Chat read-only boundary in one place: the schemas an actual request may carry, the refusal
 * of every side-effect proposal The model proposes, the settlement of records an older version left
 * behind, and receipt-based recovery that never repeats an effect.
 */

type Capabilities = Partial<ChatSession['capabilities']>;
type IntegrationBoundary = Pick<IntegrationTools, 'definitions' | 'prepare' | 'execute' | 'queryOutcome'>;
const chatCapabilities = (overrides: Capabilities = {}): ChatSession['capabilities'] =>
  ({ web: false, tools: false, mcp: false, skills: false, projectInstructions: false, ...overrides });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: args });
const hasToolResult = (body: any) => (body.messages ?? []).some((message: any) => message.role === 'tool');
const toolMessages = (store: HarnessStore, sessionId: string) => store.allMessages(sessionId).filter(message => message.role === 'tool');
const now = () => new Date().toISOString();
const until = async (condition: () => boolean) => {
  const deadline = performance.now() + 10000;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(condition(), 'Expected Chat state before deadline');
};

// ---------------------------------------------------------------------------
// Wire fixture: real ChatService -> loopback mock provider -> real ChatTools.
// Shows what the model actually receives and what a real proposal becomes.
// ---------------------------------------------------------------------------
type Responder = (body: any) => MockCompletion | Promise<MockCompletion>;

async function wireFixture(t: import('node:test').TestContext, responder: Responder, integrationDefinitions: () => ToolDefinition[] = () => []) {
  const tempRoot = path.resolve(process.env.TEMP ?? '.tmp'), owned = mkdtempSync(path.join(tempRoot, 'chat-boundary-')), workspace = path.join(owned, 'workspace'), dataDir = path.join(owned, 'data');
  mkdirSync(workspace); mkdirSync(dataDir);
  const wire: RequestBody[] = [];
  const provider = await startMockProvider({ responder, trace: body => wire.push(body) });
  let store = new HarnessStore(dataDir), kernel = new Kernel(dataDir), webRequests = 0;
  const configuration = new Configuration(provider.url);
  const candidates = { snapshotFor: () => ({}), applySnapshot: async (_: unknown, value: string) => value } as unknown as CandidateManager;
  let runner = new Runner(kernel, configuration, candidates, dataDir);
  const external = new ExternalTools({ dataDir, projectRoot: path.resolve('.'), webOptions: { searchProvider: 'wikipedia', resolveDns: async () => [{ address: '93.184.216.34', family: 4 }], fetch: async () => {
    webRequests++; return Response.json({ query: { search: [{ title: 'Checked result', snippet: 'Owned public transport fixture' }] } });
  } } });
  // The integration service exists but has nothing to offer a Chat request: definitions are read-only schemas,
  // and no Chat call may ever prepare, execute or reconcile integration work through this fixture.
  const integrations = { tools: { definitions: integrationDefinitions,
    prepare: async (_workspace: string, pending: { name: string }) => {
      if (pending.name === 'rea_analyze_local') throw new Error('Chat must not prepare integration work.');
      return undefined;
    },
    execute: async () => { throw new Error('Chat must not execute integration work.'); },
    queryOutcome: async () => { throw new Error('Chat must not reconcile integration work.'); } } };
  const services = { dataDir, projectRoot: path.resolve('.'), configuration, external, integrations,
    get kernel() { return kernel; }, get runner() { return runner; }, command(command: Command) {
      const result = kernel.command(command); if (result.taskId) mkdirSync(kernel.getTask(result.taskId)!.workspace, { recursive: true }); return result;
    } } as unknown as Services;
  let bridge: ChatTools;
  const dependencies: ChatDependencies = {
    get store() { return store; }, configuration, services,
    profileConfig: () => configuration.provider,
    getPromptParts: session => customParts(store, session),
    prepareModel: (context, body, sources) => {
      validateRequestBody(body, configuration.provider);
      return store.createRequest({ ...context, profileId: context.profileId ?? 'default', status: 'draft', endpoint: `${provider.url}/chat/completions`,
        body, bodyHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'), sources, recordContent: true, draft: '' });
    },
    sendPrepared: async (requestId, body, signal, onDelta) => {
      store.updateRequest(requestId, { status: 'running' });
      try {
        let draft = '';
        const result = await new ModelClient(configuration.provider).completeRaw(body!, signal, delta => {
          draft += delta.content ?? ''; store.updateRequest(requestId, { draft }); onDelta?.(delta);
        });
        store.updateRequest(requestId, { status: 'completed', response: result, usage: result.usage });
        // The production observer records each proposal before the response hook runs; ChatTools reads those rows.
        const exposed = store.getRequest(requestId).body?.tools ?? [];
        for (const pending of result.toolCalls) {
          const definition = exposed.find((tool: any) => tool.function.name === pending.name)?.function;
          const stamp = new Date().toISOString();
          store.saveTool({ id: `${requestId}:${pending.id}`, requestId, sessionId: store.getRequest(requestId).sessionId, toolCallId: pending.id, name: pending.name, arguments: pending.arguments,
            source: 'model', schema: definition?.parameters, description: definition?.description, permission: 'unassessed', status: 'proposed', retries: 0, createdAt: stamp, updatedAt: stamp });
        }
        return result;
      } catch (error) {
        store.updateRequest(requestId, { status: signal.aborted ? 'cancelled' : 'failed', error: { code: 'fixture', message: String(error) } }); throw error;
      }
    },
    onResponse: async (session, requestId, result) => { await bridge.accept(session, requestId, result); },
  };
  const chat = new ChatService(dependencies);
  bridge = new ChatTools(services, store, chat); await bridge.ready;
  t.after(async () => {
    await chat.stop(); await bridge.stop(); await runner.stop(); await external.close(); provider.close(); store.close(); kernel.close();
    assert.equal(path.dirname(owned), tempRoot); rmSync(owned, { recursive: true, force: true });
  });
  return { owned, workspace, dataDir, wire, provider, get store() { return store; }, get kernel() { return kernel; }, get chat() { return chat; }, get bridge() { return bridge; }, get webRequests() { return webRequests; },
    session(input: Partial<ChatSession> = {}) { return store.createSession({ title: 'Boundary chat', workspace, ...input }); },
    async send(session: ChatSession, content: string, requestTemplate?: RequestBody) {
      if (requestTemplate) store.updateSession(session.id, { requestTemplate });
      const request = await chat.send({ sessionId: session.id, content });
      await until(() => !chat.sessionView(session.id).activeRequestId && chat.pendingToolCalls(session.id).length === 0
        && store.toolCalls({ requestId: request.requestId, limit: 500 }).every(record => ['completed', 'failed', 'denied', 'unknown'].includes(record.status)));
      return request;
    },
    tools(requestId: string) { return store.toolCalls({ requestId, limit: 500 }); },
    body(requestId: string) { return store.getRequest(requestId).body!; },
  };
}

// ---------------------------------------------------------------------------
// Execution fixture: real store, kernel, runner gateway, external transport and
// a stub ChatService continuation. Proposals and legacy records are injected
// exactly as one conversation turn or a crashed older process would leave them.
// ---------------------------------------------------------------------------
async function toolsFixture(t: import('node:test').TestContext, integration?: IntegrationBoundary) {
  const tempRoot = path.resolve(process.env.TEMP ?? '.tmp'), owned = mkdtempSync(path.join(tempRoot, 'chat-boundary-tools-')), workspace = path.join(owned, 'workspace'), dataDir = path.join(owned, 'data');
  mkdirSync(workspace); mkdirSync(dataDir);
  let store = new HarnessStore(dataDir), kernel = new Kernel(dataDir);
  const configuration = new Configuration('http://127.0.0.1:1/provider/v1');
  const candidates = { snapshotFor: () => ({}), applySnapshot: async (_: unknown, value: string) => value } as unknown as CandidateManager;
  let runner = new Runner(kernel, configuration, candidates, dataDir), webRequests = 0;
  const external = new ExternalTools({ dataDir, projectRoot: path.resolve('.'), webOptions: { searchProvider: 'wikipedia', resolveDns: async () => [{ address: '93.184.216.34', family: 4 }], fetch: async () => {
    webRequests++; return Response.json({ query: { search: [{ title: 'Checked result', snippet: 'Owned public transport fixture' }] } });
  } } });
  // An explicit execution counter: recovery must settle from receipts, never call execute again.
  const executions = { external: 0 };
  const executeExternal = external.execute.bind(external);
  external.execute = async (prepared: PreparedTool, options: ToolExecutionOptions) => { executions.external++; return executeExternal(prepared, options); };
  const commands: Command[] = [];
  const services = { dataDir, projectRoot: path.resolve('.'), configuration, external, integrations: integration ? { tools: integration } : undefined,
    get kernel() { return kernel; }, get runner() { return runner; },
    command(command: Command) {
      commands.push(command);
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
  return { owned, workspace, dataDir, external, executions, continuations, commands, until, get webRequests() { return webRequests; },
    get kernel() { return kernel; }, get store() { return store; }, get bridge() { return bridge; }, get runner() { return runner; },
    session(capabilities: Capabilities = {}) { return store.createSession({ workspace, capabilities: chatCapabilities(capabilities) }); },
    async propose(session: ChatSession, calls: ToolCall[], exposed = calls.map(pending => pending.name), kind: 'chat' | 'studio' = 'chat') {
      const request = store.createRequest({ sessionId: session.id, kind, profileId: 'default', status: 'completed', endpoint: 'fixture', bodyHash: 'fixture', sources: [], recordContent: false, exposedToolNames: exposed, draft: '' });
      store.addMessage(session.id, { role: 'assistant', content: '', toolCalls: calls, requestId: request.id });
      for (const pending of calls) store.saveTool({ id: `${request.id}:${pending.id}`, requestId: request.id, sessionId: session.id, toolCallId: pending.id, name: pending.name, arguments: pending.arguments, source: pending.name.startsWith('web') ? 'web' : 'builtin', permission: 'unassessed', status: 'proposed', retries: 0, createdAt: now(), updatedAt: now() });
      await bridge.accept(session, request.id, { content: '', toolCalls: calls, finishReason: 'tool_calls' });
      return calls.map(pending => `${request.id}:${pending.id}`);
    },
    async restart() {
      await bridge.stop(); await runner.stop(); store.close(); kernel.close();
      store = new HarnessStore(dataDir); kernel = new Kernel(dataDir); kernel.recover();
      runner = new Runner(kernel, configuration, candidates, dataDir); bridge = new ChatTools(services, store, chat); await bridge.ready;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof toolsFixture>>;

/** The task an older ChatTools created: no explicit permission request, so the historical work/ask default. */
function legacyTask(f: Fixture, session: ChatSession) {
  const ack = f.kernel.command({ commandId: `legacy-task-${randomUUID()}`, type: 'create_task', parameters: {
    title: 'Legacy Chat task', workspace: session.workspace,
    goal: { objective: 'Legacy Chat task', constraints: [], acceptance: [], maxModelCalls: 1, maxToolCalls: 10, mode: 'collaborative' } } });
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
  const { taskId, runId } = legacyTask(f, session);
  const request = manualRequest(f, session, ['write_file']);
  const args = { path: filename, content: 'never written' };
  const intent = f.kernel.prepareIntent(taskId, runId, { id: callId, name: 'write_file', arguments: args }, { effectKey: `legacy-${callId}`, capability: 'workspace.write', paths: [path.join(session.workspace!, filename)] });
  const digest = digestValue({ name: 'write_file', arguments: args });
  f.store.saveTool({ id: `${request.id}:${callId}`, requestId: request.id, sessionId: session.id, toolCallId: callId, name: 'write_file', arguments: args, source: 'builtin', permission: 'approval_required', status: 'awaiting_approval', taskId, runId, intentId: intent.id, digest, retries: 0, createdAt: now(), updatedAt: now() });
  return { request, taskId, runId, intent, recordId: `${request.id}:${callId}`, digest };
}

/** Dispatch an external web effect at Kernel level, as a crashed or bypassed request would leave it. */
async function dispatchedWeb(f: Fixture, session: ChatSession, callId: string, query: string, execute: boolean, recordReceipt = true) {
  const { taskId, runId } = legacyTask(f, session);
  const request = manualRequest(f, session, ['web_search']);
  const prepared = (await f.external.prepare({ name: 'web_search', arguments: { query } }))!;
  const intent = f.kernel.prepareIntent(taskId, runId, { id: callId, name: 'web_search', arguments: prepared.arguments }, { effectKey: `dispatched-${callId}`, capability: 'network.read', paths: [], resources: prepared.resources });
  f.kernel.approve(intent.id, { source: 'operator' }); f.kernel.dispatch(intent.id);
  if (execute) {
    const outcome = await f.external.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
    assert.equal(outcome.status, 'applied'); assert.ok(outcome.receipt);
    if (recordReceipt) f.kernel.receipt(intent.id, outcome.receipt!);
  }
  const recordId = `${request.id}:${callId}`;
  f.store.saveTool({ id: recordId, requestId: request.id, sessionId: session.id, toolCallId: callId, name: 'web_search', arguments: prepared.arguments, source: 'web', permission: 'read_only', status: 'running', taskId, runId, intentId: intent.id, digest: prepared.digest, retries: 0, createdAt: now(), updatedAt: now() });
  return { request, intent, recordId };
}

/** A legacy dispatched integration effect, with the executor's receipt when the effect applied. */
function dispatchedIntegration(f: Fixture, session: ChatSession, callId: string, receipt?: Record<string, unknown>) {
  const { taskId, runId } = legacyTask(f, session);
  const request = manualRequest(f, session, ['rea_analyze_local']);
  const args = { workspace: session.workspace!, manifest: [{ path: 'sample.js', sha256: digestValue('fixture'), bytes: 7 }], installation: 'fixture-pinned', version: '6.4.0' };
  const preparedDigest = digestValue({ name: 'rea_analyze_local', arguments: args });
  const intent = f.kernel.prepareIntent(taskId, runId, { id: callId, name: 'rea_analyze_local', arguments: args }, { effectKey: `legacy-integration-${callId}`, capability: 'process.exec', paths: [] });
  f.kernel.approve(intent.id, { source: 'operator' }); f.kernel.dispatch(intent.id);
  if (receipt) f.kernel.receipt(intent.id, receipt);
  const recordId = `${request.id}:${callId}`;
  f.store.saveTool({ id: recordId, requestId: request.id, sessionId: session.id, toolCallId: callId, name: 'rea_analyze_local', arguments: args, source: 'integration', permission: 'approved', status: 'running', taskId, runId, intentId: intent.id, digest: preparedDigest, retries: 0, createdAt: now(), updatedAt: now() });
  return { intent, recordId, taskId, runId };
}

// ---------------------------------------------------------------------------
// 1. Request surface: schemas actually compiled and actually sent.
// ---------------------------------------------------------------------------
test('Chat exposes enabled memory, skill guidance, workspace read, web and readonly MCP schemas', { timeout: 30000 }, async t => {
  const f = await wireFixture(t, () => ({ content: 'unused' }));
  const names = async (capabilities: Capabilities = {}) =>
    ((await f.chat.preview(f.session({ capabilities: chatCapabilities(capabilities) }).id)).body.tools ?? []).map((tool: any) => tool.function.name).sort();
  const everything = await names({ web: true, tools: true, mcp: true, skills: true, projectInstructions: true });
  assert.deepEqual(everything, [...MEMORY_TOOL_NAMES, 'list_skills', 'read_skill', 'read_file', 'list_files', 'search_text', 'git_query', 'web_search', 'web_fetch', 'web_crawl', 'list_mcp_tools', 'mcp_read'].sort());
  for (const forbidden of ['write_file', 'run_command', 'run_shell', 'mcp_call', 'rea_analyze_local', 'plugin_transform', 'delegate', 'read_events'])
    assert.equal(everything.includes(forbidden), false, `Chat must never expose ${forbidden}`);
  assert.deepEqual(await names(), [...MEMORY_TOOL_NAMES].sort());
  assert.deepEqual(await names({ tools: true }), [...MEMORY_TOOL_NAMES, 'read_file', 'list_files', 'search_text', 'git_query'].sort());
  assert.deepEqual(await names({ skills: true }), [...MEMORY_TOOL_NAMES, 'list_skills', 'read_skill'].sort());
  assert.deepEqual(await names({ web: true }), [...MEMORY_TOOL_NAMES, 'web_search', 'web_fetch', 'web_crawl'].sort());
  assert.deepEqual(await names({ mcp: true }), [...MEMORY_TOOL_NAMES, 'list_mcp_tools', 'mcp_read'].sort(), 'MCP capability exposes only discovery and the checked readonly adapter');
  assert.equal(f.provider.requests(), 0, 'Preview compiles the authoritative body without contacting the provider');
});

test('actual Chat requests keep read/web schemas and drop template-injected side-effect tools', { timeout: 30000 }, async t => {
  const injected = [
    { type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'run_command', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'mcp_call', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'rea_analyze_local', parameters: { type: 'object' } } },
  ];
  let integrationEnabled = true;
  const f = await wireFixture(t, () => ({ content: 'Plain answer without tools.' }), () => integrationEnabled ? INTEGRATION_TOOL_DEFINITIONS : []);
  const session = f.session({ capabilities: chatCapabilities({ web: true, tools: true, mcp: true }) });
  const request = await f.send(session, 'Which tools exist?', { tools: injected, tool_choice: 'auto', temperature: 0.25 });
  const body = f.body(request.requestId), names: string[] = body.tools.map((definition: any) => definition.function.name);
  for (const forbidden of ['write_file', 'run_command', 'run_shell', 'mcp_call', 'rea_analyze_local']) assert.ok(!names.includes(forbidden), `actual Chat request must not expose ${forbidden}`);
  for (const expected of ['read_file', 'list_files', 'web_search', 'web_fetch', 'web_crawl', ...MEMORY_TOOL_NAMES]) assert.ok(names.includes(expected), `actual Chat request keeps ${expected}`);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.temperature, 0.25, 'unrelated template/parameter merge is preserved');

  const restricted = f.session({ capabilities: chatCapabilities() });
  const plain = await f.send(restricted, 'No workspace tools', { tools: injected });
  const restrictedNames: string[] = f.body(plain.requestId).tools.map((definition: any) => definition.function.name);
  assert.deepEqual([...restrictedNames].sort(), [...MEMORY_TOOL_NAMES].sort(), 'Only session-enabled read schemas survive the merge');
  assert.equal(restrictedNames.includes('write_file') || restrictedNames.includes('mcp_call'), false);

  integrationEnabled = false;
  const off = await f.send(f.session({ capabilities: chatCapabilities({ tools: true, mcp: true }) }), 'Check disabled integration');
  assert.equal(f.body(off.requestId).tools.some((definition: any) => definition.function.name === 'rea_analyze_local'), false);
});

// ---------------------------------------------------------------------------
// 2. Proposal refusal: registered side effects fail at the permission stage.
// ---------------------------------------------------------------------------
test('a model-forged write_file is a permission failure with no intent, file, approval or task', { timeout: 30000 }, async t => {
  const f = await wireFixture(t, body => hasToolResult(body) ? { content: 'Understood.' } : { content: '', toolCalls: [call('forged', 'write_file', { path: 'forged.txt', content: 'must not exist' })] });
  const session = f.session({ capabilities: chatCapabilities({ tools: true, web: true, mcp: true }) });
  const request = await f.send(session, 'Write a file');
  const [record] = f.tools(request.requestId);
  assert.equal(record!.name, 'write_file');
  assert.equal(record!.status, 'failed'); assert.equal(record!.failureStage, 'permission');
  assert.equal(record!.intentId, undefined, 'The refusal happens before any approvable intent exists');
  assert.equal(existsSync(path.join(f.workspace, 'forged.txt')), false);
  assert.equal(f.kernel.listTasks().length, 0, 'a forged side effect creates no kernel task');
  const followUp = f.wire.at(-1)!;
  const toolMessage = followUp.messages.find((message: any) => message.role === 'tool');
  assert.match(toolMessage.content, /executed.*false/);
  assert.equal(f.store.traces({ sessionId: session.id }).events.some(event => event.type === 'tool.awaiting_approval'), false);
});

test('a model-forged unregistered tool name is rejected as unknown_tool', { timeout: 30000 }, async t => {
  const f = await wireFixture(t, body => hasToolResult(body) ? { content: 'Understood.' } : { content: '', toolCalls: [call('secret', 'read_secret', { path: 'C:/keys.txt' })] });
  const session = f.session({ capabilities: chatCapabilities({ tools: true }) });
  const request = await f.send(session, 'Read a secret');
  const [record] = f.tools(request.requestId);
  assert.equal(record!.status, 'failed'); assert.equal(record!.failureStage, 'unknown_tool');
  assert.equal(record!.intentId, undefined);
  assert.equal(f.kernel.listTasks().length, 0);
});

test('forged write, exec, MCP, integration and plugin calls fail closed at the permission stage', { timeout: 30000 }, async t => {
  const f = await toolsFixture(t), session = f.session({ web: true, tools: true, mcp: true });
  const calls: ToolCall[] = [
    call('forged-write', 'write_file', { path: 'forged.txt', content: 'must never exist' }),
    call('forged-command', 'run_command', { script: 'build' }),
    call('forged-shell', 'run_shell', { command: 'echo nope' }),
    call('forged-mcp', 'mcp_call', { serverId: 'fixture', toolName: 'echo', arguments: {} }),
    call('forged-integration', 'rea_analyze_local', { paths: ['sample.js'] }),
    call('forged-plugin', 'plugin_transform', {}),
  ];
  const ids = await f.propose(session, calls, calls.map(pending => pending.name));
  await f.until(() => f.store.toolCalls({ requestId: f.store.getTool(ids[0]!).requestId }).every(record => record.status === 'failed'));
  for (const id of ids) {
    const record = f.store.getTool(id);
    assert.equal(record.status, 'failed', `${record.name} must not execute`);
    assert.equal(record.failureStage, 'permission', `${record.name} must fail at the permission stage`);
    assert.equal(record.intentId, undefined, `${record.name} must not prepare a kernel intent`);
    assert.match(String(record.error), /Chat/);
  }
  assert.equal(existsSync(path.join(f.workspace, 'forged.txt')), false);
  assert.equal(f.kernel.listTasks().length, 0, 'A refused call must not create a Chat tool task');
  assert.equal(f.commands.filter(command => command.type === 'create_task').length, 0);
  assert.equal(f.executions.external, 0);
  const messages = toolMessages(f.store, session.id);
  assert.deepEqual(messages.map(message => message.toolCallId), calls.map(pending => pending.id));
  for (const message of messages) assert.match(message.content, /"executed":false/);
  assert.equal(f.continuations.length, 1, 'A settled batch continues once, only terminal results are delivered');
  // Chat never enters the approval or review stage, so no dialog, grant or reviewer can appear.
  assert.equal(f.store.traces({ sessionId: session.id }).events.some(event => ['tool.awaiting_approval', 'tool.approved'].includes(event.type)), false);
  assert.equal(f.kernel.listTasks().some(task => f.kernel.events(task.id).some(event => /^intent.(reviewed|review_escalated|review_blocked)$/.test(event.type))), false);
});

test('unknown names stay unknown_tool while known but Chat-forbidden names are permission failures', { timeout: 30000 }, async t => {
  const f = await toolsFixture(t);
  const cases = [
    { session: f.session({ tools: true }), pending: call('unknown', 'invented_tool', {}), exposed: ['invented_tool'], expected: 'unknown_tool' },
    { session: f.session({ tools: true, web: true, mcp: true }), pending: call('write', 'write_file', { path: 'blocked.txt', content: 'no' }), exposed: ['write_file'], expected: 'permission' },
    { session: f.session(), pending: call('read-denied', 'read_file', { path: 'blocked.txt' }), exposed: ['read_file'], expected: 'permission' },
    { session: f.session({ tools: true }), pending: call('schema', 'read_file', { path: 42 as unknown as string }), exposed: ['read_file'], expected: 'validation' },
  ];
  for (const item of cases) {
    const [id] = await f.propose(item.session, [item.pending], [...item.exposed]);
    await f.until(() => f.store.getTool(id!).status === 'failed');
    assert.equal(f.store.getTool(id!).failureStage, item.expected, `${item.pending.name} expected ${item.expected}`);
  }
  assert.equal(existsSync(path.join(f.workspace, 'blocked.txt')), false);
});

test('an enabled integration is never prepared, executed or reconciled from Chat', { timeout: 30000 }, async t => {
  let prepares = 0, executions = 0, queries = 0;
  const integration: IntegrationBoundary = {
    definitions: () => INTEGRATION_TOOL_DEFINITIONS,
    async prepare() { prepares++; throw new Error('Chat must not prepare integration work.'); },
    async execute() { executions++; throw new Error('Chat must not execute integration work.'); },
    async queryOutcome() { queries++; throw new Error('Chat must not reconcile integration work.'); },
  };
  const f = await toolsFixture(t, integration), session = f.session({ tools: true });
  writeFileSync(path.join(f.workspace, 'sample.js'), 'let x=1');
  const [id] = await f.propose(session, [call('rea', 'rea_analyze_local', { paths: ['sample.js'] })], ['rea_analyze_local']);
  await f.until(() => f.store.getTool(id!).status === 'failed');
  assert.equal(f.store.getTool(id!).failureStage, 'permission');
  assert.equal(prepares, 0); assert.equal(executions, 0); assert.equal(queries, 0);
  assert.equal(f.kernel.listTasks().length, 0);
});

// ---------------------------------------------------------------------------
// 3. Reads, memory and web retrieval still work inside the boundary.
// ---------------------------------------------------------------------------
test('read_file and list_files run only when the session enables workspace tools', { timeout: 30000 }, async t => {
  const f = await toolsFixture(t); writeFileSync(path.join(f.workspace, 'input.txt'), 'real read evidence');
  const denied = f.session();
  const [readDenied] = await f.propose(denied, [call('read-denied', 'read_file', { path: 'input.txt' })]);
  await f.until(() => f.store.getTool(readDenied!).status === 'failed');
  const deniedRecord = f.store.getTool(readDenied!);
  assert.equal(deniedRecord.failureStage, 'permission');
  assert.equal(deniedRecord.intentId, undefined, 'A denial before the intent stage cannot become an approvable intent');
  assert.equal(f.commands.filter(command => command.type === 'create_task').length, 0);
  assert.equal(f.continuations.length, 1);
  assert.match(toolMessages(f.store, denied.id)[0]!.content, /"executed":false/);
  const enabled = f.session({ tools: true });
  const [read, listing] = await f.propose(enabled, [
    call('read', 'read_file', { path: 'input.txt' }),
    call('list', 'list_files', {}),
  ]);
  await f.until(() => f.store.getTool(read!).status === 'completed' && f.store.getTool(listing!).status === 'completed');
  assert.match(String(f.store.getTool(read!).result), /real read evidence/);
  assert.match(String(f.store.getTool(listing!).result), /input.txt/);
  assert.equal(f.kernel.getBudgets(f.store.getTool(read!).taskId!).toolCalls, 2);
});

test('memory recall works without workspace tools while web retrieval follows the web capability', { timeout: 30000 }, async t => {
  const f = await toolsFixture(t);
  const memory = f.session();
  f.store.addMessage(memory.id, { role: 'user', content: 'Durable decision: keep the archive on F drive.' });
  const [search] = await f.propose(memory, [call('search', 'search_history', { query: 'archive' })]);
  await f.until(() => f.store.getTool(search!).status === 'completed');
  assert.match(String(f.store.getTool(search!).result), /keep the .{0,4}archive.{0,4} on F drive/);
  const noWeb = f.session({ tools: true });
  const [denied] = await f.propose(noWeb, [call('web-denied', 'web_search', { query: 'should not run' })], ['web_search']);
  await f.until(() => f.store.getTool(denied!).status === 'failed');
  assert.equal(f.store.getTool(denied!).failureStage, 'permission');
  assert.equal(f.webRequests, 0, 'A refused web call never reaches the network transport');
  assert.equal(f.executions.external, 0);
  const web = f.session({ web: true });
  const [allowed] = await f.propose(web, [call('web', 'web_search', { query: 'checked fixture' })]);
  await f.until(() => f.store.getTool(allowed!).status === 'completed');
  assert.equal(f.webRequests, 1);
  assert.equal(f.executions.external, 1);
  assert.match(String(f.store.getTool(allowed!).result), /Owned public transport fixture/);
  assert.equal(f.store.traces({ sessionId: web.id }).events.some(event => event.type === 'tool.awaiting_approval'), false, 'Chat retrieval must not open an approval dialog');
  assert.equal(f.kernel.getIntent(f.store.getTool(allowed!).intentId!)!.state, 'applied');
  assert.equal(f.continuations.length, 3, 'memory, denied web and allowed web each deliver one tool result continuation');
});

test('a read executes while a same-batch write denial leaves no file, intent or effect', { timeout: 30000 }, async t => {
  const f = await toolsFixture(t), session = f.session({ tools: true, web: true, mcp: true });
  writeFileSync(path.join(f.workspace, 'input.txt'), 'retained read evidence');
  const [read, write] = await f.propose(session, [
    call('read', 'read_file', { path: 'input.txt' }),
    call('write', 'write_file', { path: 'denied.txt', content: 'must not appear' }),
  ]);
  await f.until(() => f.store.getTool(read!).status === 'completed' && f.store.getTool(write!).status === 'failed');
  assert.equal(f.store.getTool(write!).failureStage, 'permission');
  assert.equal(f.store.getTool(write!).intentId, undefined);
  assert.equal(existsSync(path.join(f.workspace, 'denied.txt')), false);
  const taskId = f.store.getTool(read!).taskId!;
  assert.ok(taskId);
  assert.equal(f.kernel.intents(taskId).some(intent => intent.name === 'write_file'), false);
  assert.equal(f.kernel.getTask(taskId)!.status, 'waiting_input');
  const denied = toolMessages(f.store, session.id).find(message => message.toolCallId === 'write')!;
  assert.match(denied.content, /"executed":false/);
  assert.match(String(f.store.getTool(write!).error), /Chat/);
  assert.equal(f.continuations.length, 1);
});

test('Chat tool tasks are created with the read-only Chat permission parameters', { timeout: 30000 }, async t => {
  const f = await toolsFixture(t), session = f.session({ tools: true });
  writeFileSync(path.join(f.workspace, 'input.txt'), 'parameter evidence');
  const [read] = await f.propose(session, [call('read', 'read_file', { path: 'input.txt' })]);
  await f.until(() => f.store.getTool(read!).status === 'completed');
  const created = f.commands.filter(command => command.type === 'create_task');
  assert.equal(created.length, 1);
  assert.deepEqual((created[0]!.parameters as Record<string, unknown>).permission, { app: 'chat', mode: 'read-only' });
  const permission = f.kernel.getTaskPermission(f.store.getTool(read!).taskId!);
  assert.equal(permission.app, 'chat', 'The kernel must enforce the Chat app boundary if ChatTools is bypassed');
  assert.equal(permission.mode, 'read-only', 'The kernel must enforce the read-only mode if ChatTools is bypassed');
});

test('workspace reads and web retrieval complete inside a real Chat turn with tool results on the wire', { timeout: 30000 }, async t => {
  const f = await wireFixture(t, body => hasToolResult(body) ? { content: 'Both reads are done.' } : { content: '', toolCalls: [
    call('read', 'read_file', { path: 'notes.txt' }),
    call('search', 'web_search', { query: 'checked fixture' }),
  ] });
  writeFileSync(path.join(f.workspace, 'notes.txt'), 'owned workspace evidence');
  const session = f.session({ capabilities: chatCapabilities({ web: true, tools: true }) });
  const request = await f.send(session, 'Read the notes and search');
  const records = f.tools(request.requestId);
  const byName = new Map(records.map(record => [record.name, record]));
  assert.deepEqual([...byName.keys()].sort(), ['read_file', 'web_search']);
  assert.ok(records.every(record => record.status === 'completed'),
    JSON.stringify(records.map(record => [record.name, record.status, record.failureStage, record.error])));
  assert.match(String(byName.get('read_file')!.result), /owned workspace evidence/);
  assert.match(String(byName.get('web_search')!.result), /Checked result/);
  assert.equal(f.webRequests, 1);
  const task = f.kernel.listTasks()[0]!;
  const permission = f.kernel.getTaskPermission(task.id);
  assert.equal(permission.app, 'chat'); assert.equal(permission.mode, 'read-only');
  const intents = f.kernel.intents(task.id);
  assert.ok(intents.length === 2 && intents.every(intent => intent.state === 'applied'));
  assert.deepEqual(intents.map(intent => intent.name).sort(), ['read_file', 'web_search'], 'Chat tasks dispatch no write, exec or MCP intent');
  assert.equal(f.kernel.getBudgets(task.id).toolCalls, 2);
  const followUp = f.wire.at(-1)!;
  assert.equal(followUp.messages.filter((message: any) => message.role === 'tool').length, 2);
  assert.ok(INTEGRATION_TOOL_DEFINITIONS.every(definition => !String(followUp.tools).includes(definition.function.name)));
  assert.equal(readFileSync(path.join(f.workspace, 'notes.txt'), 'utf8'), 'owned workspace evidence');
});

// ---------------------------------------------------------------------------
// 4. Legacy records: pending writes are settled denied and never replayed.
// ---------------------------------------------------------------------------
test('a legacy awaiting-approval write is settled denied by any approval attempt and never executed', { timeout: 30000 }, async t => {
  const f = await toolsFixture(t), session = f.session({ tools: true });
  const legacy = legacyWrite(f, session);
  await assert.rejects(f.bridge.approve(legacy.recordId, { digest: 'wrong', approved: true }), /exact prepared/);
  assert.equal(f.store.getTool(legacy.recordId)!.status, 'awaiting_approval');
  assert.equal(f.kernel.getIntent(legacy.intent.id)!.state, 'prepared');
  await assert.rejects(f.bridge.approve(legacy.recordId, { digest: legacy.digest, approved: true }), /cannot execute side effects/);
  const settledRecord = f.store.getTool(legacy.recordId)!;
  assert.equal(settledRecord.status, 'denied');
  assert.equal(settledRecord.failureStage, 'permission');
  assert.equal(f.kernel.getIntent(legacy.intent.id)!.state, 'denied');
  assert.equal(existsSync(path.join(f.workspace, 'legacy.txt')), false);
  assert.match(toolMessages(f.store, session.id).at(-1)!.content, /"executed":false/);
  const second = legacyWrite(f, session, 'legacy-deny', 'denied.txt');
  const denied = await f.bridge.approve(second.recordId, { digest: second.digest, approved: false });
  assert.equal(denied.status, 'denied');
  assert.equal(f.kernel.getIntent(second.intent.id)!.state, 'denied');
  assert.equal(existsSync(path.join(f.workspace, 'denied.txt')), false);
  assert.equal(f.executions.external, 0);
});

test('restart never replays a legacy awaiting-approval write: the effect is revoked, not executed', { timeout: 30000 }, async t => {
  const f = await toolsFixture(t), session = f.session({ tools: true });
  const legacy = legacyWrite(f, session, 'crash', 'crash.txt');
  await f.restart();
  const intent = f.kernel.getIntent(legacy.intent.id)!;
  assert.equal(intent.state, 'denied');
  assert.match(String(intent.error), /invalidated during recovery/);
  const record = f.store.getTool(legacy.recordId)!;
  assert.notEqual(record.status, 'awaiting_approval');
  assert.equal(record.status, 'failed'); assert.equal(record.failureStage, 'permission');
  assert.equal(existsSync(path.join(f.workspace, 'crash.txt')), false);
  assert.match(toolMessages(f.store, session.id).at(-1)!.content, /"executed":false/);
  assert.equal(f.executions.external, 0);
});

// ---------------------------------------------------------------------------
// 5. Dispatched effects: reconcile the original receipt, never execute again.
// ---------------------------------------------------------------------------
test('recovery settles dispatched effects only from their original receipt and never repeats them', { timeout: 40000 }, async t => {
  const f = await toolsFixture(t), session = f.session({ web: true });
  const applied = await dispatchedWeb(f, session, 'web-applied', 'checked fixture', true);
  const executes = f.executions.external, requests = f.webRequests, continuations = f.continuations.length;
  await f.restart();
  assert.equal(f.store.getTool(applied.recordId)!.status, 'completed');
  assert.match(String(f.store.getTool(applied.recordId)!.result), /Checked result/);
  assert.equal(f.kernel.getIntent(applied.intent.id)!.state, 'applied');
  assert.equal(f.executions.external, executes, 'A recorded receipt is settled without executing the effect again');
  assert.equal(f.webRequests, requests, 'The independent observer answers from its stored receipt');
  assert.equal(f.continuations.length, continuations + 1);

  const unknown = await dispatchedWeb(f, session, 'web-unknown', 'never sent to the network', false);
  const beforeRequests = f.webRequests, beforeContinuations = f.continuations.length, beforeExecutes = f.executions.external;
  await f.restart();
  const record = f.store.getTool(unknown.recordId)!;
  assert.equal(record.status, 'unknown'); assert.equal(record.failureStage, 'reconciliation');
  assert.equal(f.webRequests, beforeRequests);
  assert.equal(f.executions.external, beforeExecutes, 'An unobserved effect is never replayed');
  assert.equal(f.continuations.length, beforeContinuations, 'An unknown effect blocks the conversation continuation');
  assert.equal(f.kernel.getIntent(unknown.intent.id)!.state, 'unknown');
  await f.restart();
  assert.equal(f.store.getTool(unknown.recordId)!.status, 'unknown');
  assert.equal(f.executions.external, beforeExecutes);
  assert.equal(f.continuations.length, beforeContinuations);

  // A crash after the effect applied but before the Kernel receipt leaves the intent "sent": recovery must
  // settle it from the observer's stored effect, without a second execution or a fabricated result.
  const sent = await dispatchedWeb(f, session, 'web-sent', 'checked fixture', true, false);
  const sentExecutes = f.executions.external, sentRequests = f.webRequests, sentContinuations = f.continuations.length;
  await f.restart();
  assert.equal(f.store.getTool(sent.recordId)!.status, 'completed');
  assert.match(String(f.store.getTool(sent.recordId)!.result), /Checked result/);
  assert.equal(f.kernel.getIntent(sent.intent.id)!.state, 'applied');
  assert.equal(f.executions.external, sentExecutes, 'Reconciliation reads the stored effect; it never executes again');
  assert.equal(f.webRequests, sentRequests);
  assert.equal(f.continuations.length, sentContinuations + 1);
});

test('a dispatched integration effect is reconciled from its receipt after the integration is disabled', { timeout: 40000 }, async t => {
  let enabled = true, prepares = 0, executions = 0, queries = 0;
  const effects = new Map<string, { digest: string; outcome: ToolOutcome }>();
  const integration: IntegrationBoundary = {
    definitions: () => enabled ? INTEGRATION_TOOL_DEFINITIONS : [],
    async prepare(workspace, pending) {
      if (pending.name !== 'rea_analyze_local') return undefined;
      assert.ok(enabled, 'A disabled integration cannot prepare a new call'); prepares++;
      const args = { workspace, manifest: [{ path: 'sample.js', sha256: digestValue('fixture'), bytes: 7 }], installation: 'fixture-pinned', version: '6.4.0' };
      return { name: pending.name, arguments: args, digest: digestValue({ name: pending.name, arguments: args }), capability: 'process.exec', mutating: true, resources: [path.join(workspace, 'sample.js'), path.resolve('src/integrations/tools.ts')] };
    },
    async execute(prepared, options) {
      executions++; assert.equal(options.approvedDigest, prepared.digest);
      const outcome: ToolOutcome = { status: 'applied', output: 'persisted integration analysis', receipt: { effectKey: options.effectKey, digest: prepared.digest } };
      effects.set(options.effectKey, { digest: prepared.digest, outcome }); return outcome;
    },
    async queryOutcome(key, digest) { queries++; const effect = effects.get(key); if (effect) assert.equal(effect.digest, digest); return effect?.outcome ?? { status: 'unknown', output: '' }; },
  };
  const f = await toolsFixture(t, integration), session = f.session({ tools: true });
  writeFileSync(path.join(f.workspace, 'sample.js'), 'let x=1');
  const { taskId, runId } = legacyTask(f, session);
  const request = manualRequest(f, session, ['rea_analyze_local']);
  const prepared = (await integration.prepare(f.workspace, { name: 'rea_analyze_local', arguments: { paths: ['sample.js'] } }))!;
  const intent = f.kernel.prepareIntent(taskId, runId, { id: 'rea-applied', name: 'rea_analyze_local', arguments: prepared.arguments }, { effectKey: 'legacy-integration-applied', capability: 'process.exec', paths: [] });
  f.kernel.approve(intent.id, { source: 'operator' }); f.kernel.dispatch(intent.id);
  const outcome = await integration.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
  assert.equal(outcome.status, 'applied'); assert.ok(outcome.receipt);
  f.kernel.receipt(intent.id, outcome.receipt!);
  const recordId = `${request.id}:rea-applied`;
  f.store.saveTool({ id: recordId, requestId: request.id, sessionId: session.id, toolCallId: 'rea-applied', name: 'rea_analyze_local', arguments: prepared.arguments, source: 'integration', permission: 'approved', status: 'running', taskId, runId, intentId: intent.id, digest: prepared.digest, retries: 0, createdAt: now(), updatedAt: now() });
  const preparationCount = prepares;
  enabled = false; writeFileSync(path.join(f.workspace, 'sample.js'), 'changed after the accepted effect');
  await f.restart();
  assert.equal(f.store.getTool(recordId)!.status, 'completed');
  assert.equal(f.store.getTool(recordId)!.result, 'persisted integration analysis');
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'applied');
  assert.ok(queries >= 1, 'Recovery reads the applied receipt from the now-disabled integration store');
  assert.equal(prepares, preparationCount, 'Reconciliation never re-prepares a disabled integration');
  assert.equal(executions, 1, 'A dispatched integration effect is never executed twice');
  assert.equal(f.continuations.length, 1);

  // A crash between dispatch and the Kernel receipt leaves the intent "sent". Recovery must find the effect in the
  // original integration store (now disabled) instead of replaying or inventing it.
  enabled = true;
  const secondTask = legacyTask(f, session), secondRequest = manualRequest(f, session, ['rea_analyze_local']);
  const secondPrepared = (await integration.prepare(f.workspace, { name: 'rea_analyze_local', arguments: { paths: ['sample.js'] } }))!;
  const secondIntent = f.kernel.prepareIntent(secondTask.taskId, secondTask.runId, { id: 'rea-sent', name: 'rea_analyze_local', arguments: secondPrepared.arguments }, { effectKey: 'legacy-integration-sent', capability: 'process.exec', paths: [] });
  f.kernel.approve(secondIntent.id, { source: 'operator' }); f.kernel.dispatch(secondIntent.id);
  const secondOutcome = await integration.execute(secondPrepared, { effectKey: secondIntent.effectKey, approvedDigest: secondPrepared.digest });
  assert.equal(secondOutcome.status, 'applied');
  const secondRecordId = `${secondRequest.id}:rea-sent`;
  f.store.saveTool({ id: secondRecordId, requestId: secondRequest.id, sessionId: session.id, toolCallId: 'rea-sent', name: 'rea_analyze_local', arguments: secondPrepared.arguments, source: 'integration', permission: 'approved', status: 'running', taskId: secondTask.taskId, runId: secondTask.runId, intentId: secondIntent.id, digest: secondPrepared.digest, retries: 0, createdAt: now(), updatedAt: now() });
  enabled = false;
  const queriesBefore = queries, executionsBefore = executions, continuationsBefore = f.continuations.length;
  await f.restart();
  assert.equal(f.store.getTool(secondRecordId)!.status, 'completed');
  assert.equal(f.store.getTool(secondRecordId)!.result, 'persisted integration analysis');
  assert.equal(f.kernel.getIntent(secondIntent.id)!.state, 'applied', 'The original store receipt settles the unknown dispatch');
  assert.equal(queries, queriesBefore + 1, 'The dispatched effect is reconciled from its original receipt');
  assert.equal(executions, executionsBefore, 'The dispatched effect is never executed again');
  assert.equal(f.continuations.length, continuationsBefore + 1);
  const [disabled] = await f.propose(session, [call('disabled-rea', 'rea_analyze_local', { paths: ['sample.js'] })], ['rea_analyze_local']);
  await f.until(() => f.store.getTool(disabled!).status === 'failed');
  assert.equal(f.store.getTool(disabled!).failureStage, 'permission');
  assert.equal(executions, executionsBefore);
  assert.equal(prepares, preparationCount + 1, 'A disabled integration can never prepare a new Chat call');
});

test('an applied effect settles from the Kernel receipt when the integration store is gone, while a dispatched one stays unknown', { timeout: 40000 }, async t => {
  const f = await toolsFixture(t), session = f.session({ tools: true });
  const applied = dispatchedIntegration(f, session, 'rea-applied', { effectKey: 'missing-store', appliedAt: now(), output: 'fixture receipt' });
  await f.restart();
  const settled = f.store.getTool(applied.recordId)!;
  assert.equal(settled.status, 'completed');
  assert.match(String(settled.result), /fixture receipt/);
  assert.equal(f.kernel.getIntent(applied.intent.id)!.state, 'applied');
  assert.equal(f.executions.external, 0, 'Recovery reads the Kernel receipt instead of executing the effect');

  const pending = dispatchedIntegration(f, session, 'rea-pending');
  await f.restart();
  const record = f.store.getTool(pending.recordId)!;
  assert.equal(record.status, 'unknown'); assert.equal(record.failureStage, 'reconciliation');
  assert.equal(f.kernel.getIntent(pending.intent.id)!.state, 'unknown');
  assert.equal(f.executions.external, 0);
});
