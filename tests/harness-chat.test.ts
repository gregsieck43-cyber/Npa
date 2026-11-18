import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ChatService, type ChatDependencies } from '../src/harness/chat.js';
import { HarnessStore } from '../src/harness/store.js';
import { Configuration } from '../src/app/configuration.js';
import { Kernel } from '../src/kernel/index.js';
import { ModelClient, validateRequestBody } from '../src/runtime/model.js';
import { startMockProvider, type MockProviderOptions } from '../src/fixtures/mock-provider.js';
import type { Services } from '../src/app/services.js';
import type { Command, ToolDefinition } from '../src/contracts.js';
import { INTEGRATION_TOOL_DEFINITIONS } from '../src/integrations/tools.js';
import type { ChatSession, PromptPart, RequestBody } from '../src/harness/types.js';
import { customParts, promptSettings } from '../src/harness/prompts.js';
import { MEMORY_TOOL_NAMES } from '../src/memory/tools.js';

async function fixture(t: import('node:test').TestContext, providerOptions: MockProviderOptions = {}, integrationDefinitions: () => ToolDefinition[] = () => []) {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), owned = mkdtempSync(path.join(root, 'harness-chat-')), workspace = path.join(owned, 'workspace');
  mkdirSync(workspace);
  const wire: RequestBody[] = [];
  const provider = await startMockProvider({ ...providerOptions, trace: body => wire.push(body) });
  let store = new HarnessStore(owned);
  const configuration = new Configuration(provider.url), kernel = new Kernel(path.join(owned, 'kernel'));
  const services = { projectRoot: workspace, kernel, integrations: { tools: { definitions: integrationDefinitions } }, command: (command: Command) => kernel.command(command) } as unknown as Services;
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
        store.updateRequest(requestId, { status: 'completed', response: result, usage: result.usage }); return result;
      } catch (error) {
        store.updateRequest(requestId, { status: signal.aborted ? 'cancelled' : 'failed', error: { code: 'fixture', message: String(error) } }); throw error;
      }
    },
  };
  let chat = new ChatService(dependencies);
  t.after(async () => {
    await chat.stop(); await provider.close(); store.close(); kernel.close();
    assert.equal(path.dirname(owned), root); rmSync(owned, { recursive: true, force: true });
  });
  const settle = async (sessionId: string, timeoutMs = 8000) => {
    const deadline = performance.now() + timeoutMs;
    while (chat.sessionView(sessionId).activeRequestId && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(chat.sessionView(sessionId).activeRequestId, undefined, 'Chat did not settle within the fixture deadline');
  };
  return { get store() { return store; }, get chat() { return chat; }, kernel, configuration, owned, workspace, wire, provider, settle,
    onResponse(callback: NonNullable<ChatDependencies['onResponse']>) { dependencies.onResponse = callback; },
    async restart() { await chat.stop(); store.close(); store = new HarnessStore(owned); chat = new ChatService(dependencies); },
    session(input: Partial<ChatSession> = {}) { return store.createSession({ title: 'Fixture chat', workspace, ...input }); } };
}

test('localhost Chat Completions SSE preserves multiple sessions, actual parameters, drafts and messages across restart', { timeout: 20000 }, async t => {
  const f = await fixture(t, { delayMs: 100 });
  const one = f.session({ systemPrompt: 'Use short plain answers.', parameters: { temperature: 0.3, top_p: 0.8 } }), two = f.session({ title: 'Independent' });
  const first = await f.chat.send({ sessionId: one.id, content: 'First question' });
  assert.equal(first.status, 'running'); assert.equal(f.chat.sessionView(one.id).activeRequestId, first.requestId);
  await assert.rejects(f.chat.send({ sessionId: one.id, content: 'Concurrent same session' }), /active request/);
  await f.chat.send({ sessionId: two.id, content: 'Other question' });
  await f.settle(one.id); await f.settle(two.id);
  assert.equal(f.store.getRequest(first.requestId).status, 'completed');
  assert.match(f.store.getRequest(first.requestId).draft, /First question/);
  const second = await f.chat.send({ sessionId: one.id, content: 'Follow-up question' }); await f.settle(one.id);
  const body = f.store.getRequest(second.requestId).body!;
  assert.equal(body.temperature, 0.3); assert.equal(body.top_p, 0.8);
  assert.ok(body.messages.some((message: any) => message.role === 'assistant' && message.content.includes('First question')));
  assert.ok(!body.messages.some((message: any) => message.content.includes('Other question')));
  const original = f.store.allMessages(one.id), count = f.provider.requests();
  await f.restart(); assert.deepEqual(f.store.allMessages(one.id), original); assert.equal(f.provider.requests(), count);
});

test('Chat projects oversized history with source IDs and exposes recovery tools in the actual HTTP request', { timeout: 60000 }, async t => {
  const f = await fixture(t), session = f.session();
  const early = f.store.addMessage(session.id, { role: 'user', content: 'Original migration requires QX-2749 with BOM.' });
  f.store.transaction(() => {
    for (let n = 0; n < 240; n++) f.store.addMessage(session.id, { role: n % 2 ? 'assistant' : 'user', content: `Day log ${n} ` + 'details '.repeat(250) });
  });
  const before = f.store.allMessages(session.id);
  const sent = await f.chat.send({ sessionId: session.id, content: 'Find the original QX-2749 migration requirement.' }); await f.settle(session.id, 45000);
  const request = f.store.getRequest(sent.requestId), actual = f.wire[0]!;
  assert.deepEqual(actual.messages, request.body!.messages);
  assert.ok(JSON.stringify(actual.messages).length <= 32000);
  assert.ok(actual.tools.some((tool: any) => tool.function.name === 'read_history'));
  const navigation = request.sources.find(source => source.id === 'archive-navigation')!.content;
  assert.ok(navigation.includes(early.id));
  assert.match(navigation.replace(/[⟦⟧]/g, ''), /Original migration requires QX-2749/);
  assert.equal(f.store.memory(session.id).read({ id: early.id }).text, before[0]!.content);
  assert.deepEqual(f.store.allMessages(session.id).slice(0, before.length), before);
  assert.ok(request.sources.some(source => source.id === 'archive-navigation' && source.effective));
  assert.ok(request.sources.some(source => source.scope === 'session' && source.effective === false));
  assert.ok(f.wire.every(body => JSON.stringify(body.messages).length <= 32000));
  assert.equal(f.store.consumedUserInput(session.id).cursor, f.store.previousUserSeq(session.id, Number.MAX_SAFE_INTEGER),
    'every old pending input and the new question must be consumed before the final answer: ' + JSON.stringify(f.store.traces({ sessionId: session.id, type: 'chat.request_settled' }).events));
});

test('large Chat input is consumed in source-bound fragments before any proposed tool reaches the bridge', { timeout: 60000 }, async t => {
  const f = await fixture(t, { responder: () => ({ content: 'Read the current input.', toolCalls: [{ id: 'proposed-read', name: 'read_file', arguments: { path: 'note.txt' } }] }) });
  const session = f.session({ capabilities: { tools: true, web: false, mcp: false, skills: false, projectInstructions: false } });
  const accepted: string[] = [];
  f.onResponse(async (_session, requestId) => { accepted.push(requestId); });
  const content = 'FIRST_CONSTRAINT\n' + 'user instructions '.repeat(4500) + '\nLAST_CONSTRAINT';
  await f.chat.send({ sessionId: session.id, content }); await f.settle(session.id, 45000);
  assert.ok(f.wire.length > 2);
  assert.equal(accepted.length, 1, 'ingestion-only turns cannot dispatch model tool proposals');
  const messages = f.store.allMessages(session.id);
  assert.equal(messages[0]!.content, content, 'the original source is immutable');
  const progress = messages.filter(message => message.role === 'assistant').map(message => message.sampledUserInput!);
  assert.ok(progress.slice(0, -1).every(value => value.cursor === 0 && value.offset > 0));
  assert.ok(progress.slice(0, -2).every((value, index) => value.offset < progress[index + 1]!.offset));
  assert.equal(progress.at(-1)!.offset, 0);
  assert.equal(progress.at(-1)!.cursor, f.store.messageRef(session.id, messages[0]!.id)!.seq);
  assert.match(JSON.stringify(f.wire.at(-1)!.messages), /LAST_CONSTRAINT/);
});

test('editing and regeneration create preserved branches and never overwrite original history', { timeout: 20000 }, async t => {
  const f = await fixture(t), session = f.session();
  await f.chat.send({ sessionId: session.id, content: 'Original question' }); await f.settle(session.id);
  const original = f.store.allMessages(session.id);
  const edited = await f.chat.branch(session.id, { messageId: original[0]!.id, content: 'Edited question' }); await f.settle(edited.id);
  assert.equal(edited.parentSessionId, session.id); assert.equal(f.store.allMessages(edited.id)[0]!.content, 'Edited question');
  const regenerated = await f.chat.branch(session.id, { messageId: original[1]!.id, regenerate: true }); await f.settle(regenerated.id);
  assert.equal(f.store.allMessages(regenerated.id).length, 2);
  assert.equal(f.store.allMessages(regenerated.id)[0]!.content, 'Original question');
  assert.deepEqual(f.store.allMessages(session.id), original);
  await assert.rejects(f.chat.branch(session.id, { messageId: 'foreign-message', content: 'Invalid edit' }), /not in this conversation/);
});

test('text attachments are source-bound UTF-8 snapshots and credential/binary/oversize reads are rejected before dispatch', { timeout: 20000 }, async t => {
  const f = await fixture(t), session = f.session();
  const file = path.join(f.workspace, 'notes.txt'); writeFileSync(file, '中文 attachment evidence', 'utf8');
  const before = readFileSync(file);
  const request = await f.chat.send({ sessionId: session.id, content: 'Inspect the attached note', attachments: [file] }); await f.settle(session.id);
  const attachment = f.store.allMessages(session.id)[0]!.attachments![0]!;
  assert.equal(attachment.sha256, createHash('sha256').update(before).digest('hex'));
  assert.match(JSON.stringify(f.store.getRequest(request.requestId).body), /中文 attachment evidence/);
  assert.deepEqual(readFileSync(file), before);
  const count = f.provider.requests();
  for (const [name, contents] of [['API.txt', 'owned fake credential'], ['binary.txt', Buffer.from([0, 1, 2])], ['large.txt', 'x'.repeat(128_001)]] as const) {
    const filename = path.join(f.workspace, name); writeFileSync(filename, contents);
    await assert.rejects(f.chat.send({ sessionId: session.id, content: 'Try invalid attachment', attachments: [filename] }));
  }
  await assert.rejects(f.chat.send({ sessionId: session.id, content: 'Too many files', attachments: Array(6).fill(file) }), /at most five/);
  assert.equal(f.provider.requests(), count); assert.equal(f.store.allMessages(session.id).length, 2);
});

test('enabled tool schemas produce retained proposals and continue only after real tool results are supplied', { timeout: 20000 }, async t => {
  const f = await fixture(t, { responder: body => body.messages.some((message: any) => message.role === 'tool')
    ? { content: 'Observed the supplied tool result.' }
    : { content: '', toolCalls: [{ id: 'read-proposal', name: 'read_file', arguments: { path: 'notes.txt' } }] } });
  const session = f.session({ capabilities: { tools: true, web: true, mcp: true, skills: false, projectInstructions: false } });
  const request = await f.chat.send({ sessionId: session.id, content: 'Read notes.txt' }); await f.settle(session.id);
  const names = f.store.getRequest(request.requestId).body!.tools.map((tool: any) => tool.function.name);
  assert.deepEqual([...names].sort(), [...MEMORY_TOOL_NAMES, 'read_file', 'list_files', 'search_text', 'git_query', 'web_search', 'web_fetch', 'web_crawl', 'list_mcp_tools', 'mcp_read'].sort());
  for (const forbidden of ['write_file', 'run_command', 'run_shell', 'mcp_call', 'rea_analyze_local', 'plugin_transform', 'delegate', 'read_events'])
    assert.equal(names.includes(forbidden), false, `Chat must never expose ${forbidden}`);
  assert.equal(f.chat.pendingToolCalls(session.id).length, 1); assert.equal(f.kernel.listTasks().length, 0, 'Schema exposure has no side effect');
  await assert.rejects(f.chat.continue(session.id), /pending tool proposals/);
  f.store.addMessage(session.id, { role: 'tool', content: 'Fixture actual tool result supplied by the execution bridge', toolCallId: 'read-proposal' });
  const continued = await f.chat.continue(session.id); await f.settle(session.id);
  assert.equal(f.chat.pendingToolCalls(session.id).length, 0);
  assert.equal(f.store.allMessages(session.id).filter(message => message.role === 'user').length, 1);
  assert.equal(f.store.getRequest(continued.requestId).body!.messages.at(-1).tool_call_id, 'read-proposal');
});

test('Chat never exposes integration schemas even when an operator integration and legacy session tools are enabled', { timeout: 20000 }, async t => {
  let enabled = true;
  const f = await fixture(t, { responder: () => ({ content: 'Checked the exposed schemas.' }) }, () => enabled ? INTEGRATION_TOOL_DEFINITIONS : []);
  const session = f.session({ capabilities: { tools: true, web: false, mcp: true, skills: false, projectInstructions: false } });
  const exposed = (requestId: string) => f.store.getRequest(requestId).body!.tools.map((tool: any) => tool.function.name);
  const first = await f.chat.send({ sessionId: session.id, content: 'Inspect available tools' }); await f.settle(session.id);
  assert.deepEqual([...exposed(first.requestId)].sort(), [...MEMORY_TOOL_NAMES, 'read_file', 'list_files', 'search_text', 'git_query', 'list_mcp_tools', 'mcp_read'].sort(), 'An enabled integration must not add a Chat side effect');
  enabled = false;
  const second = await f.chat.send({ sessionId: session.id, content: 'Check disabled integration' }); await f.settle(session.id);
  assert.equal(exposed(second.requestId).includes('rea_analyze_local'), false);
  enabled = true;
  const limited = f.session();
  const third = await f.chat.send({ sessionId: limited.id, content: 'No workspace tools allowed' }); await f.settle(limited.id);
  assert.equal(exposed(third.requestId).includes('rea_analyze_local'), false);
});

test('cancelling an actual in-flight Chat request never appends a partial assistant answer', { timeout: 20000 }, async t => {
  const f = await fixture(t, { fault: 'timeout' }), session = f.session();
  const request = await f.chat.send({ sessionId: session.id, content: 'Wait for cancellation' });
  const deadline = performance.now() + 3000;
  while (!f.provider.requests() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.provider.requests(), 1); assert.equal(f.chat.cancel(request.requestId), true);
  await f.settle(session.id);
  assert.equal(f.store.getRequest(request.requestId).status, 'cancelled');
  assert.equal(f.store.allMessages(session.id).filter(message => message.role === 'assistant').length, 0);
  await f.restart(); assert.equal(f.provider.requests(), 1);
});

test('enabled project/global instructions and selected skills enter the actual wire and can be disabled', { timeout: 20000 }, async t => {
  const f = await fixture(t), skillRoot = path.join(f.workspace, 'skills'), skill = path.join(skillRoot, 'calculate');
  mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: calculate\ndescription: fixture arithmetic\n---\nCALCULATE_SKILL_FIXTURE');
  writeFileSync(path.join(f.workspace, 'AGENTS.md'), 'PROJECT_INSTRUCTION_FIXTURE');
  const global = path.join(f.workspace, 'global-agent.md'); writeFileSync(global, 'GLOBAL_INSTRUCTION_FIXTURE');
  f.configuration.globalPaths = [global]; f.configuration.skillRoots = [skillRoot];
  const session = f.session({ capabilities: { tools: false, web: false, mcp: false, skills: true, projectInstructions: true } });
  const request = await f.chat.send({ sessionId: session.id, content: 'Use $calculate' }); await f.settle(session.id);
  const body = JSON.stringify(f.store.getRequest(request.requestId).body);
  for (const expected of ['CALCULATE_SKILL_FIXTURE', 'PROJECT_INSTRUCTION_FIXTURE', 'GLOBAL_INSTRUCTION_FIXTURE']) assert.ok(body.includes(expected));
  const off = f.session(); const plain = await f.chat.send({ sessionId: off.id, content: 'Plain question' }); await f.settle(off.id);
  const plainBody = JSON.stringify(f.store.getRequest(plain.requestId).body);
  assert.ok(!plainBody.includes('INSTRUCTION_FIXTURE')); assert.ok(!plainBody.includes('SKILL_FIXTURE'));
});

test('Chat promotion makes one linked Work task with source context and preserves conversation history', { timeout: 20000 }, async t => {
  const f = await fixture(t), session = f.session();
  await f.chat.send({ sessionId: session.id, content: 'Implement the selected design' }); await f.settle(session.id);
  const original = f.store.allMessages(session.id);
  const promoted = f.chat.promote(session.id), replayed = f.chat.promote(session.id);
  assert.deepEqual(promoted, replayed); assert.equal(f.kernel.listTasks().length, 1);
  assert.equal(f.kernel.getTask(promoted.taskId)!.goal.objective, 'Implement the selected design');
  assert.ok(f.kernel.getMessages(promoted.taskId).some(message => message.content.includes(session.id)));
  assert.deepEqual(f.store.allMessages(session.id), original);
  assert.equal(f.store.getSession(session.id).workTaskId, promoted.taskId);
});

test('promoted Work can recall complete original Chat history at the promotion boundary after restart', { timeout: 20000 }, async t => {
  const f = await fixture(t), session = f.session();
  const early = f.store.addMessage(session.id, { role: 'user', content: 'Archived design exception: lunar-ledger is read-only.' });
  f.store.transaction(() => { for (let n = 0; n < 130; n++) f.store.addMessage(session.id, { role: 'user', content: `Later detail ${n}` }); });
  const { taskId } = f.chat.promote(session.id, { objective: 'Apply the original design' });
  const future = f.store.addMessage(session.id, { role: 'user', content: 'Future lunar-ledger message outside the promoted scope' });
  await f.restart();
  const memory = f.store.promotedMemory(taskId)!;
  assert.equal(memory.manifest().messages, 131);
  assert.deepEqual(memory.search({ query: 'lunar-ledger', snapshot: Number.MAX_SAFE_INTEGER }).results.map(item => item.id), [early.id]);
  assert.equal(memory.read({ id: early.id }).text, early.content);
  assert.throws(() => memory.read({ id: future.id }), /scope/);
  assert.throws(() => memory.remember({ key: 'forbidden', kind: 'fact', text: 'write from Work', expectedRevision: 0, sourceIds: [early.id] }, 'forbidden'), /read-only/);
  assert.equal(f.store.promotedMemory('unrelated-task'), undefined);
});

test('response hook can record a tool result and continue under a correlated child request without an extra user turn', { timeout: 20000 }, async t => {
  const f = await fixture(t, { responder: body => body.messages.some((message: any) => message.role === 'tool')
    ? { content: 'Tool continuation observed.' } : { content: '', toolCalls: [{ id: 'tool-hook', name: 'read_file', arguments: { path: 'fixture.txt' } }] } });
  f.onResponse(async (session, requestId, result) => {
    if (!result.toolCalls.length) return;
    f.store.addMessage(session.id, { role: 'tool', content: 'Observed fixture result', toolCallId: 'tool-hook', requestId });
    await f.chat.continue(session.id, requestId);
  });
  const session = f.session({ capabilities: { tools: true, web: false, mcp: false, skills: false, projectInstructions: false } });
  const first = await f.chat.send({ sessionId: session.id, content: 'Inspect fixture' });
  await f.settle(session.id);
  assert.equal(f.provider.requests(), 2);
  assert.equal(f.store.latestRequest(session.id)!.parentId, first.requestId);
  assert.equal(f.store.allMessages(session.id).filter(message => message.role === 'user').length, 1);
  assert.match(f.store.allMessages(session.id).at(-1)!.content, /Tool continuation observed/);
});

test('branching preserves scoped prompt settings and source versions while later edits stay branch-local', { timeout: 20000 }, async t => {
  const f = await fixture(t), session = f.session();
  promptSettings(f.store, { scope: 'session', scopeId: session.id, systemPrompt: 'ORIGINAL_SCOPED_PROMPT' }, true);
  await f.chat.send({ sessionId: session.id, content: 'Question' }); await f.settle(session.id);
  const branch = await f.chat.branch(session.id, { messageId: f.store.allMessages(session.id)[0]!.id, content: 'Edited question' }); await f.settle(branch.id);
  assert.match(JSON.stringify(f.store.latestRequest(branch.id)!.body), /ORIGINAL_SCOPED_PROMPT/);
  promptSettings(f.store, { scope: 'session', scopeId: branch.id, systemPrompt: 'BRANCH_ONLY_PROMPT' }, true);
  assert.equal(promptSettings(f.store, { scope: 'session', scopeId: session.id }).systemPrompt, 'ORIGINAL_SCOPED_PROMPT');
});

test('automatic tool continuations stop at eight model requests and an explicit new user turn can resume', { timeout: 30000 }, async t => {
  const f = await fixture(t, { responder: () => ({ content: '', toolCalls: [{ id: 'repeat', name: 'list_files', arguments: {} }] }) });
  f.onResponse(async (session, requestId) => {
    f.store.addMessage(session.id, { role: 'tool', content: 'Fixture result', toolCallId: 'repeat', requestId });
    await f.chat.continue(session.id, requestId);
  });
  const session = f.session({ capabilities: { tools: true, web: false, mcp: false, skills: false, projectInstructions: false } });
  await f.chat.send({ sessionId: session.id, content: 'Bounded tool loop' }); await f.settle(session.id);
  assert.equal(f.provider.requests(), 8);
  assert.match(JSON.stringify(f.store.traces({ sessionId: session.id }).events), /tool.*limit/i);
  f.onResponse(async () => {});
  await f.chat.send({ sessionId: session.id, content: 'Continue explicitly' }); await f.settle(session.id);
  assert.equal(f.provider.requests(), 9);
});
