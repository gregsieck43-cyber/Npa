import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import type { GatewayEvent } from '../src/frontend/api/types.js';
import { ProductStore } from '../src/product/store.js';

/**
 * Real-HTTP follow-up regressions for the product API corrections.
 *
 * Every test owns a real backend (real SQLite, real loopback HTTP with Bearer auth) and the mock
 * provider is the only model. These tests encode the expected end state, so against the current
 * candidate tree the image, cowork-attachment, replacement-cursor and protected-side-path cases
 * are red; the ordinary text controls pass. No production code is modified here.
 *
 * The four contracts covered:
 * 1. Chat mode never accepts an image it cannot send: an unsupported image is an explicit client
 *    rejection before a session exists or a model request is prepared; ordinary UTF-8 text still works.
 * 2. Cowork send rejects an attachment it cannot use instead of silently dropping it.
 * 3. A polling cursor beyond the store, from a replaced store, or below the retention window must
 *    request resynchronization and hand back a cursor this store can serve.
 * 4. SideAsk rejects protected selected paths (credential names, protected ancestors, runtime
 *    configuration) before preparing any model request, while ordinary text remains readable.
 */

const tempRoot = path.resolve(process.env.TEMP ?? '.tmp');
const DENIAL_CODES = ['denied', 'scope', 'validation'];
const UNSUPPORTED_CODES = ['unsupported', 'validation'];
const IDLE_STATUSES = ['idle', 'completed', 'failed', 'cancelled'];
/** The smallest valid 1x1 PNG: a real image file, never accepted by a text-only product Chat. */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGgAAAABJRU5ErkJggg==';

type Responder = (body: any) => { content: string };
interface SetupOptions { responder?: Responder; trace?: any[] }

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const until = async <T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 30000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state.');
    await pause(30);
  }
};

/**
 * One isolated backend per test: own temp directory, own data directory, own mock provider.
 * The current backend handle is replaced by restart()/replaceStore(), so request() always talks
 * to the process that is running now.
 */
const setup = async (options: SetupOptions = {}) => {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tempRoot, 'product-api-followup-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const settings = {
    dataDir: path.join(dir, 'data'),
    projectRoot: process.cwd(),
    mockOptions: {
      ...(options.responder ? { responder: options.responder } : {}),
      ...(options.trace ? { trace: (body: any) => { options.trace!.push(body); } } : {}),
    },
  };
  let backend = await startBackend(settings);
  const request = async (method: string, route: string, input?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch('http://127.0.0.1:' + backend.port + route, {
      method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const stop = async (): Promise<void> => { await backend.close(); };
  const start = async (): Promise<void> => { backend = await startBackend(settings); };
  const replaceStore = async (): Promise<void> => {
    await stop();
    for (const name of readdirSync(settings.dataDir)) {
      if (name.startsWith('product.sqlite')) rmSync(path.join(settings.dataDir, name), { force: true });
    }
    await start();
  };
  const close = async (): Promise<void> => { await backend.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, workspace, dataDir: settings.dataDir, settings, request, stop, start, replaceStore, close, current: () => backend };
};

type Setup = Awaited<ReturnType<typeof setup>>;

/** A cursor the client can actually poll: a non-negative safe integer, never the foreign value. */
const usableCursor = (value: unknown, label: string): number => {
  assert.equal(typeof value, 'number', label + ' must be a numeric event cursor');
  assert.ok(Number.isSafeInteger(value) && (value as number) >= 0, label + ' must be a usable non-negative integer cursor');
  return value as number;
};

const waitIdle = (env: Setup, sessionId: string) => until(async () => {
  const value = await env.request('GET', '/v1/product/sessions/' + encodeURIComponent(sessionId));
  return value.status === 200 && IDLE_STATUSES.includes(value.body.status) ? value : undefined;
});

const addProject = async (env: Setup, projectPath: string): Promise<string> => {
  const added = await env.request('POST', '/v1/product/workspace/projects', { path: projectPath });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  return added.body.id as string;
};

const sendChat = async (env: Setup, text: string, extra: Record<string, unknown> = {}) => {
  const sent = await env.request('POST', '/v1/product/chat/send', {
    mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default', ...extra,
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return sent.body as { sessionId: string; messageId: string };
};

const eventsOf = async (env: Setup, query: string) => {
  const value = await env.request('GET', '/v1/product/events' + query);
  assert.equal(value.status, 200, JSON.stringify(value.body));
  return value.body as { events: { id: number; event: GatewayEvent }[]; nextCursor: number; earliest: number; reset: boolean };
};

const taskCount = async (env: Setup): Promise<number> => {
  const snapshot = await env.request('GET', '/v1/snapshot');
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
  return (snapshot.body.tasks as unknown[]).length;
};

const retentionEvents = (from: number, count: number): { event: GatewayEvent }[] => Array.from({ length: count }, (_, index) => ({
  event: { type: 'notify', tone: 'info', title: 'retention fixture ' + (from + index) } as GatewayEvent,
}));

test('chat mode rejects an unsupported image before a session or a model request exists', { timeout: 120000 }, async t => {
  const trace: any[] = [];
  const env = await setup({ trace });
  t.after(() => env.close());
  const projectId = await addProject(env, env.workspace);
  // Inside the registered workspace on purpose: the rejection must come from the image modality,
  // not from a path that could not be resolved for text.
  const image = path.join(env.workspace, 'selected.png');
  writeFileSync(image, Buffer.from(PNG_1X1, 'base64'));

  const before = await env.request('GET', '/v1/product/sessions');
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual(before.body.items, []);

  const rejected = await env.request('POST', '/v1/product/chat/send', {
    mode: 'chat', text: 'Describe my selected image.', permission: 'ask', modelId: 'default', projectId,
    attachments: [{ id: 'img', name: 'shot.png', kind: 'image', path: image }],
  });
  assert.ok(rejected.status >= 400 && rejected.status < 500,
    'an unsupported image must be an explicit client rejection, got ' + rejected.status + ' ' + JSON.stringify(rejected.body));
  assert.ok(UNSUPPORTED_CODES.includes(rejected.body.code), JSON.stringify(rejected.body));

  const after = await env.request('GET', '/v1/product/sessions');
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.deepEqual(after.body.items, before.body.items, 'a rejected image must never create a product session');
  assert.equal((await env.request('GET', '/v1/product/sessions?limit=100')).body.items.length, 0, 'no session may exist for the rejected image send');

  await pause(150);
  assert.deepEqual(trace, [], 'a rejected image must never dispatch a model request');
});

test('ordinary selected text still reaches chat over real HTTP with its file content', { timeout: 120000 }, async t => {
  const trace: any[] = [];
  const env = await setup({ trace });
  t.after(() => env.close());
  const projectId = await addProject(env, env.workspace);
  const noteText = 'Ordinary selected text for the follow-up chat control.';
  const note = path.join(env.workspace, 'note.txt');
  writeFileSync(note, noteText, 'utf8');

  const sent = await env.request('POST', '/v1/product/chat/send', {
    mode: 'chat', text: 'Read my selected note.', permission: 'ask', modelId: 'default', projectId,
    attachments: [{ id: 'note', name: 'note.txt', kind: 'file', path: note }],
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.ok(sent.body.sessionId, 'the ordinary attachment send must create a session');
  assert.ok(sent.body.messageId, 'the ordinary attachment send must persist a user message');

  const listed = await env.request('GET', '/v1/product/sessions');
  assert.ok(listed.body.items.some((item: any) => item.id === sent.body.sessionId), 'the created session must be listed');

  const body = await until(() => trace.find(entry => JSON.stringify(entry.messages ?? []).includes(noteText)));
  assert.ok(body, 'the attached text must reach the mock model request');
  await waitIdle(env, sent.body.sessionId);
});

test('legacy Cowork tasks reject attachments, desktop office conversations accept source material', { timeout: 120000 }, async t => {
  const trace: any[] = [];
  const env = await setup({ trace });
  t.after(() => env.close());
  const projectId = await addProject(env, env.workspace);
  const note = path.join(env.workspace, 'note.txt');
  writeFileSync(note, 'Cowork attachment fixture text.', 'utf8');
  const image = path.join(env.dir, 'selected.png');
  writeFileSync(image, Buffer.from(PNG_1X1, 'base64'));

  const sessionsBefore = await env.request('GET', '/v1/product/sessions');
  assert.equal(sessionsBefore.status, 200, JSON.stringify(sessionsBefore.body));
  const tasksBefore = await taskCount(env);

  const attachments = [
    { id: 'note', name: 'note.txt', kind: 'file', path: note },
    { id: 'img', name: 'shot.png', kind: 'image', path: image },
  ];
  for (const attachment of attachments) {
    const rejected = await env.request('POST', '/v1/product/chat/send', {
      mode: 'cowork', text: 'Use this attachment in a Work task.', permission: 'ask', modelId: 'default', projectId,
      attachments: [attachment],
    });
    assert.ok(rejected.status >= 400 && rejected.status < 500,
      'a cowork attachment must be rejected explicitly, got ' + rejected.status + ' ' + JSON.stringify(rejected.body));
    assert.ok(UNSUPPORTED_CODES.includes(rejected.body.code), JSON.stringify(rejected.body));
  }

  const sessionsAfter = await env.request('GET', '/v1/product/sessions');
  assert.deepEqual(sessionsAfter.body.items, sessionsBefore.body.items, 'a rejected cowork attachment must never create a session');
  assert.equal(await taskCount(env), tasksBefore, 'a rejected cowork attachment must never create a task');

  await pause(150);
  assert.deepEqual(trace, [], 'a rejected cowork attachment must never dispatch a model request');
  const accepted = await env.request('POST', '/v1/product/chat/send', {
    mode: 'cowork', officeDraft: true, text: 'Summarize the note.', permission: 'ask', modelId: 'default', projectId, attachments: [attachments[0]],
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const detail = await env.request('GET', '/v1/product/sessions/' + accepted.body.sessionId);
  assert.equal(detail.body.mode, 'cowork');
  assert.ok(JSON.stringify(detail.body.messages).includes('Cowork attachment fixture text.'));
  assert.equal(await taskCount(env), tasksBefore, 'office drafting does not create a long-running task');
});

test('side ask rejects protected selected paths before preparing any model request', { timeout: 120000 }, async t => {
  const trace: any[] = [];
  const env = await setup({ trace });
  t.after(() => env.close());
  const fixtures = path.join(env.dir, 'side-fixtures');
  const protectedFiles: Record<string, string> = {
    'API.txt': 'Synthetic fixture. This file contains no credential.',
    '.git/config': 'Synthetic git config fixture; no repository is created and no credential is read.',
    '.aws/config': 'Synthetic AWS config fixture; no credential is read.',
    'configuration.json': '{"fixture":"synthetic runtime configuration","credential":"none"}',
  };
  for (const [relative, content] of Object.entries(protectedFiles)) {
    const file = path.join(fixtures, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }

  for (const relative of Object.keys(protectedFiles)) {
    const file = path.join(fixtures, relative);
    const side = await env.request('POST', '/v1/product/chat/side-ask', {
      question: 'Read the attached file.', modelId: 'default', history: [],
      attachments: [{ id: 'a1', name: path.basename(relative), kind: 'file', path: file }],
    });
    assert.ok(side.status >= 400 && side.status < 500,
      relative + ' must be an explicit client rejection, got ' + side.status + ' ' + JSON.stringify(side.body));
    assert.ok(DENIAL_CODES.includes(side.body.code), relative + ': ' + JSON.stringify(side.body));
    assert.equal(trace.length, 0, relative + ' must never prepare or send a model request');
  }
});

test('side ask still reads an ordinary selected text file over real HTTP', { timeout: 120000 }, async t => {
  const trace: any[] = [];
  const env = await setup({ trace });
  t.after(() => env.close());
  const fixture = path.join(env.dir, 'side-fixtures');
  mkdirSync(fixture, { recursive: true });
  const noteText = 'Ordinary selected text fixture for side chat.';
  const note = path.join(fixture, 'note.txt');
  writeFileSync(note, noteText, 'utf8');

  const side = await env.request('POST', '/v1/product/chat/side-ask', {
    question: 'Summarize the selected text.', modelId: 'default', history: [],
    attachments: [{ id: 'a1', name: 'note.txt', kind: 'file', path: note }],
  });
  assert.equal(side.status, 200, JSON.stringify(side.body));
  assert.ok(String(side.body.answer).length > 0);
  assert.equal(trace.length, 1, 'the ordinary attachment must produce exactly one prepared provider request');
  assert.match(JSON.stringify(trace[0].messages), /Ordinary selected text fixture for side chat./,
    'the attached text must reach the prepared request body');
  assert.deepEqual((await env.request('GET', '/v1/product/sessions')).body.items, [], 'side ask must not create a product session');
});

test('event cursors reset beyond the store and recover after a replaced store or a retention gap', { timeout: 180000 }, async t => {
  const env = await setup();
  t.after(() => env.close());

  // 1) A fresh backend has no events, so a foreign cursor above its latest id must request a reset.
  const beyond = await env.request('GET', '/v1/product/events?cursor=5000');
  assert.equal(beyond.status, 200, JSON.stringify(beyond.body));
  assert.equal(beyond.body.reset, true, 'a cursor from another or replaced store must request resynchronization');
  const firstCursor = usableCursor(beyond.body.nextCursor, 'reset nextCursor');
  assert.ok(firstCursor < 5000, 'the reset must hand back a cursor this store can serve, not the foreign one');
  const firstPoll = await env.request('GET', '/v1/product/events?cursor=' + firstCursor);
  assert.equal(firstPoll.status, 200, JSON.stringify(firstPoll.body));
  assert.equal(firstPoll.body.reset, false);
  const liveCursor = usableCursor(firstPoll.body.nextCursor, 'polled nextCursor');

  // 2) The bounded API shape stays intact.
  assert.equal((await env.request('GET', '/v1/product/events?cursor=0&limit=200')).status, 200);
  assert.equal((await env.request('GET', '/v1/product/events?cursor=0&limit=201')).status, 400);

  // 3) Polling the live cursor picks up newly appended events.
  const projectId = await addProject(env, env.workspace);
  const first = await sendChat(env, 'Cursor recovery conversation A', { projectId });
  await waitIdle(env, first.sessionId);
  const second = await sendChat(env, 'Cursor recovery conversation B', { projectId });
  await waitIdle(env, second.sessionId);

  const picked = await until(async () => {
    const value = await env.request('GET', '/v1/product/events?cursor=' + liveCursor + '&limit=200');
    return value.status === 200 && (value.body.events as any[]).some(entry =>
      entry.event.type === 'message.upsert' && entry.event.sessionId === first.sessionId) ? value : undefined;
  });
  assert.equal(picked.body.reset, false);
  const chatCursor = usableCursor(picked.body.nextCursor, 'chat nextCursor');
  assert.ok(chatCursor > liveCursor, 'the poll must advance past the cursor it was given');

  // 4) The session scope still filters the log.
  const scoped = await eventsOf(env, '?cursor=0&limit=200&sessionId=' + encodeURIComponent(first.sessionId));
  const unscoped = await eventsOf(env, '?cursor=0&limit=200');
  const sessionMessages = (page: { events: { id: number; event: GatewayEvent }[] }) => page.events
    .filter(entry => entry.event.type === 'message.upsert') as { id: number; event: GatewayEvent & { sessionId: string } }[];
  assert.ok(sessionMessages(unscoped).some(entry => entry.event.sessionId === first.sessionId), 'the unfiltered log must contain the first conversation');
  assert.ok(sessionMessages(unscoped).some(entry => entry.event.sessionId === second.sessionId), 'the unfiltered log must contain the second conversation');
  assert.ok(scoped.events.length > 0, 'the session scope must return that chat session events');
  assert.ok(sessionMessages(scoped).some(entry => entry.event.sessionId === first.sessionId), 'the session scope must return that chat session messages');
  assert.ok(!sessionMessages(scoped).some(entry => entry.event.sessionId === second.sessionId), 'the session scope must not leak other sessions');
  const unscopedIds = new Set(unscoped.events.map(entry => entry.id));
  assert.ok(scoped.events.every(entry => unscopedIds.has(entry.id)), 'the scope must page over the same event log');

  // 5) Replacing the event store under the same data directory resets a remembered cursor.
  const page = await eventsOf(env, '?cursor=0&limit=200');
  const remembered = usableCursor(page.nextCursor, 'remembered nextCursor');
  assert.ok(remembered > 0, 'the store must have appended events before it is replaced');
  await env.replaceStore();
  const replaced = await env.request('GET', '/v1/product/events?cursor=' + remembered);
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal(replaced.body.reset, true, 'a cursor from the replaced store must request resynchronization');
  const recovery = usableCursor(replaced.body.nextCursor, 'replacement nextCursor');
  assert.ok(recovery < remembered, 'the replacement store must return a cursor it can serve');
  const resumed = await env.request('GET', '/v1/product/events?cursor=' + recovery);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.reset, false, 'polling a recovered cursor must not reset again');

  // 6) A retention gap (the cursor fell below the retained window) also reports a reset.
  await env.stop();
  const store = new ProductStore(env.dataDir);
  let earliest = 0;
  try {
    for (let batch = 0; batch < 6; batch++) store.append(retentionEvents(batch * 1000, 1000));
    earliest = store.eventsAfter(0, 1).earliest;
  } finally { store.close(); }
  assert.ok(earliest > 1, 'the fixture must create a retention gap below the cursor');
  await env.start();
  const gap = await env.request('GET', '/v1/product/events?cursor=1&limit=200');
  assert.equal(gap.status, 200, JSON.stringify(gap.body));
  assert.equal(gap.body.reset, true, 'a cursor below the retained window must request resynchronization');
  const gapCursor = usableCursor(gap.body.nextCursor, 'retention nextCursor');
  assert.notEqual(gapCursor, 1, 'the retention reset must not hand the stale cursor straight back');
  const afterGap = await env.request('GET', '/v1/product/events?cursor=' + gapCursor + '&limit=200');
  assert.equal(afterGap.status, 200, JSON.stringify(afterGap.body));
  assert.equal(afterGap.body.reset, false);
});
