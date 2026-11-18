import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ChatService, type ChatDependencies } from '../src/harness/chat.js';
import { HarnessStore } from '../src/harness/store.js';
import { Configuration } from '../src/app/configuration.js';
import { promptSettings } from '../src/harness/prompts.js';
import type { Services } from '../src/app/services.js';
import type { ChatMessage, ChatSession, RequestBody } from '../src/harness/types.js';
import type { ModelResult } from '../src/contracts.js';

/** Real HarnessStore SQLite and real ChatService; the model boundary is a stub, so no network. */
function fixture(t: import('node:test').TestContext) {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), dir = mkdtempSync(path.join(root, 'harness-branch-history-'));
  let store = new HarnessStore(dir);
  const configuration = new Configuration('http://127.0.0.1:9');
  const services = { projectRoot: dir } as unknown as Services;
  const bodies: { requestId: string; body: RequestBody }[] = [];
  const dependencies: ChatDependencies = {
    get store() { return store; }, configuration, services,
    profileConfig: () => configuration.provider,
    getPromptParts: () => [],
    prepareModel: (context, body, sources) => store.createRequest({ ...context, profileId: context.profileId ?? 'default', status: 'draft',
      endpoint: 'http://127.0.0.1:9/chat/completions', body, bodyHash: 'fixture', sources, recordContent: true, draft: '' }),
    sendPrepared: async (requestId, body) => {
      bodies.push({ requestId, body: body! });
      store.updateRequest(requestId, { status: 'running' });
      const result: ModelResult = { content: 'Stub assistant answer', toolCalls: [], finishReason: 'stop' };
      store.updateRequest(requestId, { status: 'completed', response: result });
      return result;
    },
    sanitize: value => value,
  };
  let chat = new ChatService(dependencies);
  const settle = async (sessionId: string) => {
    const deadline = performance.now() + 8000;
    while (chat.busy(sessionId) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(chat.busy(sessionId), false, 'Chat did not settle within the fixture deadline');
  };
  t.after(async () => {
    await chat.stop(); store.close();
    assert.equal(path.dirname(dir), root); rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, bodies, settle,
    get store() { return store; }, get chat() { return chat; },
    session(input: Partial<ChatSession> = {}) { return store.createSession({ title: 'Branch fixture', ...input }); },
    reopen() { store.close(); store = new HarnessStore(dir); chat = new ChatService(dependencies); },
  };
}

/** Insert an alternating user/assistant conversation in one transaction; ids stay in seq order. */
function seed(store: HarnessStore, sessionId: string, count: number, content = (index: number) => `Historical message ${index}`): ChatMessage[] {
  const messages: ChatMessage[] = [];
  store.transaction(() => {
    for (let index = 0; index < count; index++) messages.push(store.addMessage(sessionId, { role: index % 2 ? 'assistant' : 'user', content: content(index) }));
  });
  return messages;
}

/** Read a branch through the same bounded page helper (never allMessages) for exact row checks. */
function rows(store: HarnessStore, sessionId: string): ChatMessage[] {
  const result: ChatMessage[] = [];
  let after = 0;
  for (;;) {
    const page = store.messagePageAfter(sessionId, after, Number.MAX_SAFE_INTEGER, 500);
    result.push(...page.messages);
    if (page.messages.length < 500) return result;
    after = page.lastSeq;
  }
}

function instrumentBranchReads(store: HarnessStore) {
  const state = { maximumMaterialized: 0, allMessagesCalls: 0 };
  const allMessages = store.allMessages.bind(store), pageAfter = store.messagePageAfter.bind(store);
  store.allMessages = (sessionId: string) => { state.allMessagesCalls += 1; const result = allMessages(sessionId); state.maximumMaterialized = Math.max(state.maximumMaterialized, result.length); return result; };
  store.messagePageAfter = (sessionId: string, afterSeq: number, throughSeq: number, limit?: number) => {
    const page = pageAfter(sessionId, afterSeq, throughSeq, limit);
    state.maximumMaterialized = Math.max(state.maximumMaterialized, page.messages.length); return page;
  };
  return { state, restore() { store.allMessages = allMessages; store.messagePageAfter = pageAfter; } };
}

test('branching at the first of 20,013 messages stays page-bounded and leaves the original untouched', { timeout: 120000 }, async t => {
  const f = fixture(t), original = f.session({ title: 'Long history' }), messages = seed(f.store, original.id, 20_013), first = messages[0]!, last = messages.at(-1)!;
  const before = f.store.getSession(original.id);
  const probe = instrumentBranchReads(f.store);
  const branch = await f.chat.branch(original.id, { messageId: first.id });
  probe.restore();
  assert.equal(probe.state.allMessagesCalls, 0, 'branch must not materialize all history');
  assert.ok(probe.state.maximumMaterialized <= 500, 'branch materialized ' + probe.state.maximumMaterialized + ' rows');
  assert.equal(f.store.messageCount(branch.id), 1);
  const copied = f.store.messagePage(branch.id, 10).messages;
  assert.equal(copied.length, 1); assert.equal(copied[0]!.sourceMessageId, first.id); assert.equal(copied[0]!.content, 'Historical message 0');
  assert.equal(branch.title, 'Long history · 分支'); assert.equal(branch.parentSessionId, original.id); assert.equal(branch.branchMessageId, first.id);
  assert.equal(branch.workTaskId, undefined); assert.deepEqual(branch.capabilities, original.capabilities);
  assert.deepEqual(f.store.getSession(original.id), before); assert.equal(f.store.messageCount(original.id), 20_013);
  assert.equal(f.store.messageRef(original.id, first.id)!.message.content, 'Historical message 0');
  assert.equal(f.store.messageRef(original.id, last.id)!.message.content, 'Historical message 20012');
  const payload = f.store.traces({ sessionId: branch.id, type: 'chat.branched' }).events.at(-1)!.payload as Record<string, unknown>;
  assert.equal(payload.originalMessageId, first.id); assert.equal(payload.sourceMessageCount, 1);
  assert.equal(payload.sourceFirstMessageId, first.id); assert.equal(payload.sourceLastMessageId, first.id);
  assert.equal(payload.edited, false); assert.equal(payload.regenerated, false); assert.equal('sourceMessageIds' in payload, false);
});

test('page boundaries 200/500/501 copy exactly through the selected seq', { timeout: 60000 }, async t => {
  const f = fixture(t);
  for (const size of [200, 500, 501]) {
    const original = f.session({ title: 'Boundary ' + size }), messages = seed(f.store, original.id, size);
    const probe = instrumentBranchReads(f.store);
    const latest = await f.chat.branch(original.id, { messageId: messages.at(-1)!.id });
    probe.restore();
    assert.ok(probe.state.maximumMaterialized <= 500, size + ' branch materialized ' + probe.state.maximumMaterialized);
    assert.equal(f.store.messageCount(latest.id), size);
    const copied = rows(f.store, latest.id);
    assert.equal(copied.length, size);
    for (const [index, row] of copied.entries()) { assert.equal(row.sourceMessageId, messages[index]!.id); assert.equal(row.content, 'Historical message ' + index); }
    const earliest = await f.chat.branch(original.id, { messageId: messages[0]!.id });
    assert.equal(f.store.messageCount(earliest.id), 1);
    assert.equal(rows(f.store, earliest.id)[0]!.sourceMessageId, messages[0]!.id);
    assert.equal(f.store.messageCount(original.id), size);
  }
});

test('edit and regeneration fork through the bounded copy and branch-of-branch keeps lineage local', { timeout: 60000 }, async t => {
  const f = fixture(t), original = f.session({ title: 'Edit source' }), messages = seed(f.store, original.id, 501);
  const originalRows = f.store.allMessages(original.id);
  const edited = await f.chat.branch(original.id, { messageId: messages[500]!.id, content: 'Edited at the end' });
  await f.settle(edited.id);
  const editedRows = rows(f.store, edited.id);
  assert.equal(editedRows.length, 502);
  assert.equal(editedRows[500]!.content, 'Edited at the end'); assert.equal(editedRows[500]!.sourceMessageId, messages[500]!.id);
  assert.equal(editedRows[499]!.content, 'Historical message 499');
  assert.equal(f.bodies.at(-1)!.body.messages.at(-1).content, 'Edited at the end');
  assert.deepEqual(f.store.allMessages(original.id), originalRows);
  const branchSource = editedRows[100]!;
  const second = await f.chat.branch(edited.id, { messageId: branchSource.id, content: 'Second edit' });
  await f.settle(second.id);
  assert.equal(second.parentSessionId, edited.id); assert.equal(second.title, 'Edit source · 分支 · 分支');
  const secondRows = rows(f.store, second.id);
  assert.equal(secondRows.length, 102); assert.equal(secondRows[100]!.content, 'Second edit'); assert.equal(secondRows[100]!.sourceMessageId, branchSource.id);
  assert.equal(secondRows.at(-1)!.content, 'Stub assistant answer');
  assert.equal(f.store.messageCount(edited.id), 502); assert.equal(f.store.messageRef(edited.id, branchSource.id)!.message.content, branchSource.content);

  const regeneratedSource = f.session({ title: 'Regenerate source' }), regenerateMessages = seed(f.store, regeneratedSource.id, 501);
  const regenerated = await f.chat.branch(regeneratedSource.id, { messageId: regenerateMessages[499]!.id, regenerate: true });
  await f.settle(regenerated.id);
  const regeneratedRows = rows(f.store, regenerated.id);
  assert.equal(regeneratedRows.length, 500);
  assert.equal(regenerated.branchMessageId, regenerateMessages[499]!.id);
  assert.equal(regeneratedRows[498]!.sourceMessageId, regenerateMessages[498]!.id);
  assert.equal(regeneratedRows.at(-1)!.content, 'Stub assistant answer');
  assert.equal(f.store.messageCount(regeneratedSource.id), 501);
  await assert.rejects(f.chat.branch(regeneratedSource.id, { messageId: regenerateMessages[500]!.id, content: '   ' }), { message: 'Edit a user message with non-empty text of at most 100,000 characters.' });
  await assert.rejects(f.chat.branch(regeneratedSource.id, { messageId: regenerateMessages[499]!.id, content: 'assistant edit' }), { message: 'Edit a user message with non-empty text of at most 100,000 characters.' });
});

test('regeneration without a preceding user message and foreign selections keep the existing errors', { timeout: 30000 }, async t => {
  const f = fixture(t), source = f.session({ title: 'Assistant first' });
  const assistant = f.store.addMessage(source.id, { role: 'assistant', content: 'Only assistant turn' });
  await assert.rejects(f.chat.branch(source.id, { messageId: assistant.id, regenerate: true }), { message: 'There is no user message to regenerate from.' });
  const other = f.session({ title: 'Other session' }), foreign = f.store.addMessage(other.id, { role: 'user', content: 'Foreign user' });
  await assert.rejects(f.chat.branch(source.id, { messageId: foreign.id }), { message: 'The selected message is not in this conversation.' });
  await assert.rejects(f.chat.branch(source.id, { messageId: 'msg-missing' }), { message: 'The selected message is not in this conversation.' });
  assert.equal(f.store.listSessions().length, 2);
  assert.equal(f.store.messageCount(source.id), 1); assert.equal(f.store.messageCount(other.id), 1);
});

test('stored attachments, tool fields and recall flags are copied verbatim while originals stay unchanged', { timeout: 30000 }, async t => {
  const f = fixture(t), source = f.session({ title: 'Stored fields' });
  const attachment = { name: 'notes.txt', path: path.join(f.dir, 'notes.txt'), bytes: 12, sha256: 'a'.repeat(64), content: 'stored text' };
  const user = f.store.addMessage(source.id, { role: 'user', content: 'With attachment', attachments: [attachment] });
  const assistant = f.store.addMessage(source.id, { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'notes.txt' } }] });
  const tool = f.store.addMessage(source.id, { role: 'tool', content: 'Tool result text', toolCallId: 'call-1', archiveRecall: true });
  const before = f.store.allMessages(source.id);
  const branch = await f.chat.branch(source.id, { messageId: tool.id });
  const copied = rows(f.store, branch.id);
  assert.deepEqual(copied.map(row => row.sourceMessageId), [user.id, assistant.id, tool.id]);
  assert.deepEqual(copied[0]!.attachments, [attachment]); assert.deepEqual(copied[0]!.attachments, before[0]!.attachments);
  assert.deepEqual(copied[1]!.toolCalls, before[1]!.toolCalls); assert.equal(copied[2]!.toolCallId, 'call-1'); assert.equal(copied[2]!.archiveRecall, true);
  assert.deepEqual(f.store.allMessages(source.id), before);
});

test('a copy failure mid-transaction rolls the branch back fully and a retry then succeeds', { timeout: 30000 }, async t => {
  const f = fixture(t), source = f.session({ title: 'Rollback source' }), messages = seed(f.store, source.id, 8);
  promptSettings(f.store, { scope: 'session', scopeId: source.id, systemPrompt: 'ORIGINAL_SCOPED_PROMPT' }, true);
  const before = f.store.allMessages(source.id), beforeSession = f.store.getSession(source.id);
  const createSession = f.store.createSession.bind(f.store);
  let branchId: string | undefined;
  f.store.createSession = input => { const session = createSession(input); branchId = session.id; return session; };
  const addMessage = f.store.addMessage.bind(f.store);
  let copies = 0;
  f.store.addMessage = (sessionId, input, id) => { if (sessionId === branchId && ++copies === 3) throw new Error('injected copy failure'); return addMessage(sessionId, input, id); };
  await assert.rejects(f.chat.branch(source.id, { messageId: messages[4]!.id, content: 'Edited before failure' }), { message: 'injected copy failure' });
  assert.ok(branchId);
  assert.throws(() => f.store.getSession(branchId!), { message: 'Chat session not found.' });
  assert.equal(f.store.messageCount(branchId!), 0);
  assert.equal(f.store.getSetting('prompts:session:' + branchId!, null), null);
  assert.equal(f.store.traces({ sessionId: branchId!, type: 'chat.branched' }).events.length, 0);
  assert.deepEqual(f.store.getSession(source.id), beforeSession); assert.deepEqual(f.store.allMessages(source.id), before);
  f.store.addMessage = addMessage; copies = 0;
  const retried = await f.chat.branch(source.id, { messageId: messages[4]!.id, content: 'Edited on retry' });
  assert.equal(f.store.messageCount(retried.id), 6); assert.equal(rows(f.store, retried.id)[4]!.content, 'Edited on retry');
  assert.equal(rows(f.store, retried.id)[5]!.content, 'Stub assistant answer');
  assert.equal(promptSettings(f.store, { scope: 'session', scopeId: retried.id }).systemPrompt, 'ORIGINAL_SCOPED_PROMPT');
  assert.deepEqual(f.store.allMessages(source.id), before);
  assert.equal(f.store.traces({ type: 'chat.branched' }).events.length, 1);
});

test('a successful branch survives a store reopen with source ids and a bounded trace payload', { timeout: 60000 }, async t => {
  const f = fixture(t), source = f.session({ title: 'Persisted branch' }), messages = seed(f.store, source.id, 600);
  const traceBefore = f.store.traces({ type: 'chat.branched' }).events.length;
  const branch = await f.chat.branch(source.id, { messageId: messages[300]!.id });
  f.reopen();
  assert.equal(f.store.getSession(branch.id).parentSessionId, source.id);
  assert.equal(f.store.messageCount(branch.id), 301);
  const copied = rows(f.store, branch.id);
  assert.equal(copied[0]!.sourceMessageId, messages[0]!.id); assert.equal(copied[300]!.sourceMessageId, messages[300]!.id);
  assert.equal(copied[300]!.content, 'Historical message 300');
  assert.equal(f.store.messageCount(source.id), 600);
  const events = f.store.traces({ sessionId: branch.id, type: 'chat.branched' }).events;
  assert.equal(events.length, 1); assert.equal(f.store.traces({ type: 'chat.branched' }).events.length, traceBefore + 1);
  const payload = events[0]!.payload as Record<string, unknown>;
  assert.equal(payload.originalMessageId, messages[300]!.id); assert.equal(payload.sourceMessageCount, 301);
  assert.equal(payload.sourceFirstMessageId, messages[0]!.id); assert.equal(payload.sourceLastMessageId, messages[300]!.id);
  assert.equal(Array.isArray(payload.sourceMessageIds), false);
  assert.ok(JSON.stringify(payload).length < 500, 'trace payload must stay bounded, got ' + JSON.stringify(payload).length);
});
