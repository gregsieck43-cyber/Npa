import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import type { GatewayEvent } from '../src/frontend/api/types.js';
import { ProductChat } from '../src/product/chat.js';
import { ProductSessions } from '../src/product/sessions.js';
import { ProductError, type ProductRuntime } from '../src/product/shared.js';
import { ProductStore } from '../src/product/store.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');

const until = async <T>(read: () => T | undefined, timeoutMs = 20000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

const setup = async () => {
  const dir = mkdtempSync(path.join(root, 'sessions-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const trace: Record<string, any>[] = [];
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd(),
    mockOptions: { trace: (body: Record<string, any>) => { trace.push(body); } } });
  const store = new ProductStore(path.join(dir, 'data'));
  const events: GatewayEvent[] = [];
  const runtime: ProductRuntime = {
    services: backend.services, harness: backend.services.harness!, store,
    append: (event, sessionId) => { events.push(event); store.append([{ event, ...(sessionId ? { sessionId } : {}) }]); },
    resolveProject: projectId => projectId,
  };
  const sessions = new ProductSessions(runtime);
  const chat = new ProductChat(runtime, sessions);
  const close = async () => { store.close(); await backend.close(); rmSync(dir, { recursive: true, force: true }); };
  return { backend, store, sessions, chat, events, trace, dir, workspace, close };
};
type Env = Awaited<ReturnType<typeof setup>>;

const sendChat = (env: Env, text: string, projectId?: string) =>
  env.chat.send({ mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default', ...(projectId ? { projectId } : {}) });
const settle = (env: Env, sessionId: string) =>
  until(() => env.backend.services.harness!.chat.busy(sessionId) ? undefined : true);

const isProductError = (code: string, status?: number) => (error: unknown): boolean =>
  error instanceof ProductError && error.code === code && (status === undefined || error.status === status);

test('waiting for user input remains distinct from pending approval in detail, list and events', async t => {
  const env = await setup();
  t.after(() => env.close());
  const kernel = env.backend.services.kernel;
  const ack = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: 'Clarify requirements', workspace: env.workspace } });
  const id = ack.taskId!;
  kernel.createRun(id);
  kernel.transition(id, 'running');
  kernel.transition(id, 'waiting_input', { waitingReason: 'Choose an output format' });
  env.sessions.indexWorkTask(kernel.getTask(id)!);
  assert.equal((await env.sessions.get(id)).status, 'waiting_input');
  assert.equal((await env.sessions.list({})).items.find(item => item.id === id)?.status, 'waiting_input');
  assert.equal(kernel.pendingApprovals().filter(item => item.task.id === id).length, 0);
  const event = await until(() => env.backend.services.product!.store.eventsAfter(0, 200, id).events
    .map(item => item.event).find(item => item.type === 'session.upsert' && item.session.status === 'waiting_input'));
  assert.ok(event?.type === 'session.upsert');
  assert.equal(event.session.status, 'waiting_input');
});

test('chat send persists messages and list/get return real stored data', async t => {
  const env = await setup();
  t.after(() => env.close());
  const sent = await sendChat(env, 'Hello product sessions');
  assert.ok(sent.sessionId.length > 0);
  assert.ok(sent.messageId.length > 0);
  await settle(env, sent.sessionId);

  const detail = await env.sessions.get(sent.sessionId);
  assert.equal(detail.id, sent.sessionId);
  assert.equal(detail.mode, 'chat');
  assert.equal(detail.hasMoreBefore, false);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0]!.id, sent.messageId);
  assert.equal(detail.messages[0]!.role, 'user');
  assert.equal(detail.messages[0]!.status, 'done');
  assert.ok(detail.messages[0]!.parts.some(part => part.kind === 'text' && part.text === 'Hello product sessions'));
  assert.equal(detail.messages[1]!.role, 'assistant');
  assert.ok(detail.messages[1]!.parts.some(part => part.kind === 'text' && part.text.length > 0));

  const page = await env.sessions.list({ text: 'Hello product sessions' });
  assert.equal(page.items.length, 1);
  const summary = page.items[0]!;
  assert.equal(summary.id, sent.sessionId);
  assert.equal(summary.mode, 'chat');
  assert.equal(summary.status, 'idle');
  assert.equal(summary.permission, 'read-only');
  assert.equal(summary.modelId, 'default');
  assert.equal(summary.pinned, false);
  assert.ok(summary.preview === undefined || summary.preview.includes('Hello product sessions'));

  await assert.rejects(env.sessions.get('missing-session-id'), isProductError('not_found', 404));
  await assert.rejects(env.sessions.list({ limit: 0 }), isProductError('validation'));
  await assert.rejects(env.sessions.list({ mode: 'bogus' as never }), isProductError('validation'));
  await assert.rejects(env.sessions.list({ unexpected: true } as never), isProductError('validation'));
  await assert.rejects(env.sessions.get(sent.sessionId, '0'), isProductError('validation'));
  await assert.rejects(env.sessions.get(sent.sessionId, 'abc'), isProductError('validation'));
});

test('update persists title, pinned, model profile and reasoning effort', async t => {
  const env = await setup();
  t.after(() => env.close());
  const sent = await sendChat(env, 'Update target');
  await settle(env, sent.sessionId);
  const alt = env.backend.services.harness!.profiles.save({ id: 'provider-11111111-1111-1111-1111-111111111111', name: 'Alt provider', model: 'alt-model' });
  assert.equal(alt.id, 'provider-11111111-1111-1111-1111-111111111111');

  const updated = await env.sessions.update(sent.sessionId, { title: 'Renamed session', pinned: true, modelId: alt.id, reasoningEffort: 'high' });
  assert.equal(updated.title, 'Renamed session');
  assert.equal(updated.pinned, true);
  assert.equal(updated.modelId, alt.id);
  assert.equal(updated.reasoningEffort, 'high');
  const indexed = env.store.getSession(sent.sessionId)!;
  assert.equal(indexed.title, 'Renamed session');
  assert.equal(indexed.pinned, true);
  assert.equal(indexed.reasoningEffort, 'high');
  assert.equal(env.backend.services.harness!.store.getSession(sent.sessionId).profileId, alt.id);

  const listed = await env.sessions.list({ text: 'Renamed session' });
  assert.equal(listed.items[0]!.id, sent.sessionId);
  assert.equal(listed.items[0]!.pinned, true);

  const again = await env.chat.send({ sessionId: sent.sessionId, mode: 'chat', text: 'Second turn', attachments: [], permission: 'ask', modelId: alt.id });
  assert.equal(again.sessionId, sent.sessionId);
  await settle(env, sent.sessionId);
  const request = env.trace.at(-1)!;
  assert.equal(request.model, 'alt-model');

  const cleared = await env.sessions.update(sent.sessionId, { reasoningEffort: '' });
  assert.equal(cleared.reasoningEffort, undefined);
  assert.equal(env.store.getSession(sent.sessionId)!.reasoningEffort, undefined);

  await assert.rejects(env.sessions.update(sent.sessionId, { modelId: 'missing-profile' }), isProductError('validation'));
  await assert.rejects(env.sessions.update(sent.sessionId, { title: 'x'.repeat(201) }), isProductError('validation'));
  await assert.rejects(env.sessions.update(sent.sessionId, { permission: 'sometimes' as never }), isProductError('validation'));
  await assert.rejects(env.sessions.update('missing-session-id', { title: 'x' }), isProductError('not_found', 404));
});

test('work send creates a native kernel task and list status follows the kernel', async t => {
  const env = await setup();
  t.after(() => env.close());
  const kernel = env.backend.services.kernel;
  const sent = await env.chat.send({ mode: 'cowork', text: 'Build the result file', attachments: [], permission: 'ask', modelId: 'default', projectId: env.workspace });
  const task = kernel.getTask(sent.sessionId);
  assert.ok(task);
  assert.equal(task!.id, sent.sessionId);
  assert.equal(task!.goal.objective, 'Build the result file');
  assert.deepEqual(task!.goal.acceptance, []);
  assert.equal(task!.permissionMode, 'ask');
  const messages = kernel.getMessages(sent.sessionId);
  assert.ok(messages.some(message => message.id === sent.messageId && message.role === 'user' && message.content === 'Build the result file'));

  const listed = await env.sessions.list({ mode: 'cowork', text: 'Build the result file' });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0]!.id, sent.sessionId);
  assert.equal(listed.items[0]!.mode, 'cowork');
  assert.equal(listed.items[0]!.modelId, 'default');
  assert.ok(['idle', 'running'].includes(listed.items[0]!.status));
  assert.equal(env.store.getSession(sent.sessionId)!.workTaskId, sent.sessionId);

  const detail = await env.sessions.get(sent.sessionId);
  assert.equal(detail.mode, 'cowork');
  assert.ok(detail.messages.length >= 1);
  assert.ok(detail.messages.some(message => message.id === sent.messageId));

  await until(() => {
    const current = kernel.getTask(sent.sessionId);
    return current?.status === 'waiting_approval' ? current : undefined;
  }, 30000);
  const awaiting = await env.sessions.list({ mode: 'cowork', text: 'Build the result file' });
  assert.equal(awaiting.items[0]!.status, 'waiting_approval');
  const prepared = kernel.intents(sent.sessionId).find(intent => intent.state === 'prepared');
  assert.ok(prepared, 'The mock write proposal should be awaiting operator approval.');
  env.backend.services.command({ commandId: randomUUID(), taskId: sent.sessionId, type: 'grant', parameters: { intentId: prepared!.id } });
  const finished = await until(() => {
    const current = kernel.getTask(sent.sessionId);
    return current && ['completed', 'failed', 'cancelled', 'waiting_input'].includes(current.status) ? current : undefined;
  }, 30000);
  assert.equal(finished.status, 'completed', finished.waitingReason ?? finished.error);
  const after = await env.sessions.list({ mode: 'cowork', text: 'Build the result file' });
  assert.equal(after.items[0]!.status, 'completed');

  await env.sessions.update(sent.sessionId, { title: 'Widget task', pinned: true, permission: 'ask' });
  assert.equal(env.store.getSession(sent.sessionId)!.title, 'Widget task');
  assert.equal(kernel.getTask(sent.sessionId)!.permissionMode, 'ask');
  const renamed = await env.sessions.list({ text: 'Widget task' });
  assert.equal(renamed.items[0]!.id, sent.sessionId);

  await env.sessions.remove(sent.sessionId);
  assert.equal(env.store.getSession(sent.sessionId), undefined);
  assert.ok(kernel.getTask(sent.sessionId));
  assert.ok(env.store.isSessionDismissed(sent.sessionId));
  assert.ok(env.events.some(event => event.type === 'session.removed' && event.sessionId === sent.sessionId));
  const gone = await env.sessions.list({ text: 'Widget task' });
  assert.equal(gone.items.length, 0);
});

test('remove deletes a chat session but keeps other sessions intact', async t => {
  const env = await setup();
  t.after(() => env.close());
  const first = await sendChat(env, 'Delete me please');
  const second = await sendChat(env, 'Keep me around');
  await settle(env, first.sessionId);
  await settle(env, second.sessionId);
  assert.equal(env.backend.services.harness!.store.messageCount(first.sessionId), 2);
  await env.sessions.remove(first.sessionId);
  assert.throws(() => env.backend.services.harness!.store.getSession(first.sessionId));
  assert.equal(env.store.getSession(first.sessionId), undefined);
  await assert.rejects(env.sessions.get(first.sessionId), isProductError('not_found', 404));
  const deletedPage = await env.sessions.list({ text: 'Delete me please' });
  assert.equal(deletedPage.items.length, 0);
  const keptPage = await env.sessions.list({ text: 'Keep me around' });
  assert.equal(keptPage.items.length, 1);
  assert.equal(keptPage.items[0]!.id, second.sessionId);
  await assert.rejects(env.sessions.remove('missing-session-id'), isProductError('not_found', 404));
});

test('selectionFor reports model selection and unlinkProject detaches the project', async t => {
  const env = await setup();
  t.after(() => env.close());
  const sent = await sendChat(env, 'Project session', env.workspace);
  await settle(env, sent.sessionId);
  const selection = env.sessions.selectionFor(sent.sessionId);
  assert.ok(selection);
  assert.equal(selection!.profileId, 'default');
  assert.equal(selection!.mode, 'chat');
  assert.equal(selection!.permission, 'read-only');
  assert.equal(selection!.projectId, env.workspace);
  assert.equal(env.sessions.selectionFor('missing-session-id'), undefined);
  const changes = env.sessions.unlinkProject(env.workspace);
  assert.ok(changes >= 1);
  assert.equal(env.sessions.selectionFor(sent.sessionId)!.projectId, undefined);
  assert.equal(env.sessions.unlinkProject('missing-project'), 0);
});

test('context selection source hashes match the stored record hashes', async t => {
  const env = await setup();
  t.after(() => env.close());
  const harness = env.backend.services.harness!;
  const session = harness.store.createSession({ title: 'Hash probe', workspace: path.join(env.dir, 'workspace'),
    capabilities: { web: false, tools: false, mcp: false, skills: false, projectInstructions: false } });
  const message = harness.store.addMessage(session.id, { role: 'user', content: 'Keep this original source verifiable.' });
  const { sources } = await harness.chat.preview(session.id);
  const selection = JSON.parse(sources.find(source => source.id === 'context-selection')!.content) as {
    sources: { id: string; sha256: string; projectionSha256?: string }[];
  };
  const source = selection.sources.find(entry => entry.id === message.id);
  assert.ok(source);
  const archived = harness.store.memory(session.id).read({ id: message.id, field: 'record' });
  assert.equal(source!.sha256, archived.sha256);
  if (source!.projectionSha256) assert.notEqual(source!.projectionSha256, source!.sha256);
});

test('branch copies the origin and promote keeps the chat as a read-only source', async t => {
  const env = await setup();
  t.after(() => env.close());
  const attachmentPath = path.join(env.workspace, 'promote-note.txt');
  writeFileSync(attachmentPath, 'promote note text');
  const sent = await env.chat.send({ mode: 'chat', text: 'Discuss the promotion plan', attachments: [
    { id: 'f1', name: 'promote-note.txt', kind: 'file', bytes: 18, path: attachmentPath }], permission: 'ask', modelId: 'default', projectId: env.workspace });
  await settle(env, sent.sessionId);
  const original = await env.sessions.get(sent.sessionId);
  assert.equal(original.messages.length, 2);
  const assistantId = original.messages[1]!.id;

  const branch = await env.sessions.branch(sent.sessionId, sent.messageId);
  assert.notEqual(branch.id, sent.sessionId);
  assert.equal(branch.mode, 'chat');
  assert.equal(branch.parentSessionId, sent.sessionId);
  const branchMessages = env.backend.services.harness!.store.allMessages(branch.id);
  assert.equal(branchMessages.length, 1);
  assert.equal(branchMessages[0]!.sourceMessageId, sent.messageId);
  assert.notEqual(branchMessages[0]!.id, sent.messageId);
  assert.equal((await env.sessions.get(sent.sessionId)).messages.length, 2);
  const branchDetail = await env.sessions.get(branch.id);
  assert.ok(branchDetail.messages[0]!.parts.some(part => part.kind === 'text' && part.text === 'Discuss the promotion plan'));
  await assert.rejects(env.sessions.branch(sent.sessionId, 'missing-message'), isProductError('not_found'));
  await assert.rejects(env.sessions.branch('missing-session', sent.messageId), isProductError('not_found'));

  const promoted = await env.sessions.promote(sent.sessionId, { objective: 'Implement the promoted goal', acceptance: ['file:result.txt'] });
  assert.equal(promoted.mode, 'cowork');
  assert.equal(promoted.parentSessionId, sent.sessionId);
  const task = env.backend.services.kernel.getTask(promoted.id)!;
  assert.equal(task.id, promoted.id);
  assert.equal(task.goal.objective, 'Implement the promoted goal');
  assert.deepEqual(task.goal.acceptance, ['file:result.txt']);
  assert.equal(task.appMode, 'work');
  assert.equal(task.permissionMode, 'read-only');
  const settings = env.backend.services.harness!.store.getSetting<Record<string, any>>(`promotedChat:${task.id}`, {});
  assert.equal(settings.originalSessionId, sent.sessionId);
  assert.equal(settings.profileId, 'default');
  assert.deepEqual(settings.sourceMessageIds, [sent.messageId, assistantId]);
  assert.equal(Array.isArray(settings.attachments), true);
  assert.equal(settings.attachments.length, 1);
  assert.equal(settings.attachments[0].name, 'promote-note.txt');
  assert.equal(env.backend.services.harness!.store.getSession(sent.sessionId)!.workTaskId, promoted.id);
  assert.equal(env.store.getSession(sent.sessionId)!.workTaskId, promoted.id);
  const repromoted = await env.sessions.promote(sent.sessionId, { objective: 'Implement the promoted goal', acceptance: [] });
  assert.equal(repromoted.id, promoted.id);
  await assert.rejects(env.sessions.promote(promoted.id, { objective: 'Nested', acceptance: [] }), isProductError('unsupported', 501));
  // Work branching is now a real paused fork with an immutable origin, not the former 501 gap.
  const promotedMessages = env.backend.services.kernel.getMessages(promoted.id);
  const workBranch = await env.sessions.branch(promoted.id, promotedMessages[0]!.id);
  assert.notEqual(workBranch.id, promoted.id);
  assert.equal(workBranch.parentSessionId, promoted.id);
  assert.equal(workBranch.status, 'paused');
  assert.equal(workBranch.mode, 'cowork');
  assert.equal(workBranch.permission, 'read-only');
  const workBranchTask = env.backend.services.kernel.getTask(workBranch.id)!;
  assert.equal(workBranchTask.status, 'paused');
  assert.equal(workBranchTask.parentId, undefined);
  assert.equal(workBranchTask.goal.objective, 'Implement the promoted goal');
  await env.sessions.remove(promoted.id);
});
