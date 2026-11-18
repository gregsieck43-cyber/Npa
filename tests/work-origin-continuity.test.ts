import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';
import type { ScopedMemoryPort } from '../src/memory/tools.js';

/**
 * Work-origin continuity across real Harness/Kernel archives.
 *
 * A branched Work task owns one immutable origin file per ancestry hop. Three contracts are covered here:
 *  A) a long A -> B1 -> ... -> B9 chain must still recall A's oldest record from the deepest branch, with the
 *     exact canonical record SHA, after the source is hidden and after the backend restarts; the same holds for
 *     two branches of a promoted Chat task after the Chat session is removed;
 *  B) composite origin memory must page every layer honestly: nextOffset must walk the whole union instead of
 *     re-reading each layer from the same offset and dropping the older ones;
 *  C) a corrupted workOrigin:* link must fail truthfully (cycle/ancestry error) instead of silently returning a
 *     port that hides the layers it could not resolve.
 *
 * All fixtures stay under .tmp/history-lifecycle/continuity; only the loopback mock provider is used.
 */

type Backend = Awaited<ReturnType<typeof startBackend>>;
type Kernel = Backend['services']['kernel'];
type Memory = ReturnType<Kernel['memory']>;
type Reply = { status: number; json: any; text: string; headers: Headers };

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function checkoutRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'src', 'app', 'backend.ts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot locate the project root from ' + start);
    dir = parent;
  }
}

function projectRoot(): string {
  for (const start of [process.cwd(), path.dirname(fileURLToPath(import.meta.url))]) {
    try { return checkoutRoot(start); } catch { /* try the next anchor */ }
  }
  throw new Error('Cannot locate the checkout root for the continuity suite.');
}

const TREE = projectRoot();
const CONTINUITY = path.join(TREE, '.tmp', 'history-lifecycle', 'continuity');
mkdirSync(CONTINUITY, { recursive: true });

async function newFixture(t: TestContext, mockOptions: MockProviderOptions = {}) {
  const owned = mkdtempSync(path.join(CONTINUITY, 'child-b-'));
  const workspace = path.join(owned, 'workspace');
  const dataDir = path.join(owned, 'data');
  mkdirSync(workspace, { recursive: true });
  const relative = path.relative(TREE, dataDir);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'dataDir must stay inside the project root');
  const wire: any[] = [];
  const settings = { dataDir, projectRoot: TREE, mockOptions: { ...mockOptions, trace: (body: any) => wire.push(body) } };

  let backend: Backend | undefined;
  let closed = false;
  t.after(async () => {
    try { if (!closed) { closed = true; await backend?.close(); } }
    finally { rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
  backend = await startBackend(settings);

  const request = async (method: string, route: string, options: { body?: unknown } = {}): Promise<Reply> => {
    const active = backend;
    assert.ok(active, 'backend must be running');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + active.token };
    const response = await fetch('http://127.0.0.1:' + active.port + route, {
      method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: response.status, json, text, headers: response.headers };
  };
  const ok = async (method: string, route: string, body?: unknown): Promise<any> => {
    const reply = await request(method, route, body === undefined ? {} : { body });
    assert.equal(reply.status, 200, method + ' ' + route + ' -> ' + reply.status + ': ' + reply.text.slice(0, 400));
    assert.match(String(reply.headers.get('content-type') ?? ''), /application\/json/);
    return reply.json;
  };
  const until = async <T>(read: () => Promise<T | undefined> | T | undefined, label: string): Promise<T> => {
    const deadline = performance.now() + 45_000;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      assert.ok(performance.now() < deadline, 'Did not settle: ' + label);
      await sleep(25);
    }
  };
  const restart = async (): Promise<void> => {
    const active = backend;
    assert.ok(active, 'backend must be running before a restart');
    await active.close();
    backend = await startBackend(settings);
  };
  t.after(() => { closed = true; });

  return {
    get backend(): Backend { const active = backend; assert.ok(active, 'backend must be running'); return active; },
    get kernel(): Kernel { return this.backend.services.kernel; },
    get harness() { const harness = this.backend.services.harness; assert.ok(harness, 'harness must be running'); return harness; },
    wire, workspace, dataDir, settings, request, ok, until, restart,
  };
}
type Fixture = Awaited<ReturnType<typeof newFixture>>;

const addMarkedMessages = (kernel: Kernel, taskId: string, label: string, count: number, marker?: string): string[] => {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const suffix = String(index).padStart(2, '0');
    const content = marker === undefined
      ? 'origin continuity ' + label + ' record ' + suffix
      : marker + ' origin ' + label + ' record ' + suffix;
    ids.push(kernel.addMessage(taskId, 'user', content).id);
  }
  return ids;
};

/** A real Kernel Work task: operator create_task with initialStatus=paused, so no model request is dispatched. */
const createPausedWorkTask = (f: Fixture, title: string, objective: string): string => {
  const ack = f.backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    title, workspace: f.workspace, appMode: 'work', permissionMode: 'read-only', initialStatus: 'paused', goal: { objective },
  } });
  assert.equal(ack.status, 'accepted');
  assert.ok(ack.taskId, 'create_task must return a task id');
  return ack.taskId!;
};

const ledger = (kernel: Kernel, taskId: string) => ({
  task: kernel.getTask(taskId),
  events: kernel.events(taskId),
  messages: kernel.getMessages(taskId, 'main'),
  pendingCalls: kernel.pendingCalls(taskId),
  intents: kernel.intents(taskId),
  runs: kernel.getRuns(taskId),
});

interface Canonical { sha: string; text: string }

/** Canonical origin record captured from the owning Kernel archive before any branch copies it. */
const canonicalOf = (memory: Memory, messageId: string): Canonical => {
  const record = memory.read({ id: messageId, field: 'record' });
  const content = memory.read({ id: messageId });
  assert.equal(typeof record.sha256, 'string');
  assert.equal(record.sha256.length, 64);
  assert.equal(typeof content.text, 'string');
  return { sha: record.sha256, text: content.text };
};

const recallRoute = (sessionId: string, sourceId: string): string =>
  '/v1/product/inspector/recall?sessionId=' + encodeURIComponent(sessionId) + '&sourceId=' + encodeURIComponent(sourceId);

const recall = (f: Fixture, sessionId: string, sourceId: string): Promise<Reply> => f.request('GET', recallRoute(sessionId, sourceId));

const assertRecall = async (f: Fixture, sessionId: string, sourceId: string, expected: Canonical): Promise<void> => {
  const reply = await recall(f, sessionId, sourceId);
  assert.equal(reply.status, 200, 'GET recall ' + sessionId + ' <- ' + sourceId + ' -> ' + reply.status + ': ' + reply.text.slice(0, 400));
  assert.equal(reply.json.sourceId, sourceId);
  assert.equal(reply.json.offset, 0);
  assert.equal(reply.json.sha, expected.sha, 'recall must return the canonical origin record SHA for ' + sourceId);
  assert.equal(reply.json.text, expected.text, 'recall must return the original field content for ' + sourceId);
};

const branchOk = async (f: Fixture, sessionId: string, messageId: string): Promise<any> => {
  const reply = await f.request('POST', '/v1/product/sessions/' + sessionId + '/branch', { body: { messageId } });
  assert.equal(reply.status, 200, 'branch ' + sessionId + ' at ' + messageId + ' -> ' + reply.status + ': ' + reply.text.slice(0, 500));
  assert.match(String(reply.headers.get('content-type') ?? ''), /application\/json/);
  return reply.json;
};

const waitTask = (f: Fixture, taskId: string, statuses: readonly string[]) => f.until(async () => {
  const task = await f.ok('GET', '/v1/product/tasks/' + taskId);
  return task && statuses.includes(String(task.status)) ? task : undefined;
}, 'task ' + taskId + ' reaches ' + statuses.join('/'));

const pauseTask = async (f: Fixture, taskId: string): Promise<void> => {
  const deadline = performance.now() + 30_000;
  for (;;) {
    const reply = await f.request('POST', '/v1/product/tasks/' + taskId + '/control', { body: { action: 'pause' } });
    if (reply.status === 200) break;
    assert.ok(performance.now() < deadline, 'pause was never accepted for ' + taskId + ': ' + reply.status + ' ' + reply.text.slice(0, 300));
    assert.equal(reply.status, 409, 'unexpected pause failure for ' + taskId + ': ' + reply.status + ' ' + reply.text.slice(0, 300));
    await sleep(25);
  }
  await waitTask(f, taskId, ['paused']);
};

const removeSession = async (f: Fixture, sessionId: string): Promise<void> => {
  const removed = await f.ok('POST', '/v1/product/sessions/' + sessionId + '/remove');
  assert.deepEqual(removed, { removed: true });
};

/** assert one freshly created paused branch adds no execution state and leaves its source ledger untouched. */
const assertCleanBranch = (f: Fixture, branchId: string, sourceId: string, sourceBefore: ReturnType<typeof ledger>, wireBefore: number): void => {
  assert.equal(f.wire.length, wireBefore, 'branch creation must not dispatch a model request');
  const branch = f.kernel.getTask(branchId);
  assert.ok(branch, 'the branch task must exist');
  assert.equal(branch!.status, 'paused');
  assert.equal(branch!.modelCalls, 0);
  assert.equal(f.kernel.getMessages(branchId, 'main').length, 1, 'a paused branch owns only its goal row');
  assert.deepEqual(f.kernel.pendingCalls(branchId), []);
  assert.deepEqual(f.kernel.intents(branchId), []);
  assert.deepEqual(f.kernel.getRuns(branchId), []);
  assert.deepEqual(ledger(f.kernel, sourceId), sourceBefore, 'branch creation must not change the source task ledger');
};

test('nine Work branches keep the oldest origin record recallable through removal and restart', { timeout: 180_000 }, async t => {
  const f = await newFixture(t);
  const kernel = f.kernel;

  const sourceId = createPausedWorkTask(f, 'Origin ancestry root', 'Trace the origin ancestry');
  const sourceMarkers = addMarkedMessages(kernel, sourceId, 'A', 4);
  const firstMarker = sourceMarkers[0]!;
  const firstCanonical = canonicalOf(kernel.memory(sourceId), firstMarker);
  assert.match(firstCanonical.text, / A record 00$/);

  const chain: string[] = [];
  let current = sourceId;
  let selected = sourceMarkers[sourceMarkers.length - 1]!;
  for (let depth = 1; depth <= 9; depth++) {
    const sourceBefore = ledger(kernel, current);
    const wireBefore = f.wire.length;
    const created = await branchOk(f, current, selected);
    assert.equal(created.status, 'paused');
    assert.equal(created.parentSessionId, current);
    const branchId = String(created.id);
    assert.notEqual(branchId, current);
    assertCleanBranch(f, branchId, current, sourceBefore, wireBefore);
    chain.push(branchId);
    const markers = addMarkedMessages(kernel, branchId, 'B' + depth, depth < 9 ? 2 : 1);
    current = branchId;
    selected = markers[markers.length - 1]!;
  }
  assert.equal(chain.length, 9);
  const deepest = current;
  assert.equal(kernel.getTask(deepest)!.status, 'paused');

  // The origin port itself must resolve A's oldest record through all nine copies.
  const origin = f.harness.originMemory(deepest);
  assert.ok(origin, 'the deepest branch must expose its origin memory');
  assert.equal(origin!.read({ id: firstMarker, field: 'record' }).sha256, firstCanonical.sha);
  await assertRecall(f, deepest, firstMarker, firstCanonical);

  // The source Work task is hidden/removed: the immutable copies keep their authority.
  await removeSession(f, sourceId);
  assert.ok(kernel.getTask(sourceId), 'removed Work source stays an audit record in the Kernel');
  await assertRecall(f, deepest, firstMarker, firstCanonical);

  // A backend restart re-opens the same data directory and must not lose or re-dispatch the ancestry.
  const wireAtRestart = f.wire.length;
  await f.restart();
  await sleep(350);
  assert.equal(f.wire.length, wireAtRestart, 'restart must not dispatch a paused branch');
  assert.equal(f.kernel.getTask(deepest)!.status, 'paused');
  const restartedOrigin = f.harness.originMemory(deepest);
  assert.ok(restartedOrigin, 'the restarted branch must expose its origin memory');
  assert.equal(restartedOrigin!.read({ id: firstMarker, field: 'record' }).sha256, firstCanonical.sha);
  await assertRecall(f, deepest, firstMarker, firstCanonical);
});

test('two branches of a promoted Chat keep the original chat record after the Chat session is removed', { timeout: 180_000 }, async t => {
  const f = await newFixture(t);
  const kernel = f.kernel;

  const chat = await f.ok('POST', '/v1/harness/sessions', { title: 'Promotion origin chat', workspace: f.workspace });
  const chatId = String(chat.id);
  const sent = await f.ok('POST', '/v1/product/chat/send', {
    sessionId: chatId, mode: 'chat', text: 'Discuss the promotion origin continuity', attachments: [], permission: 'read-only', modelId: 'default',
  });
  await f.until(async () => {
    const detail = await f.ok('GET', '/v1/product/sessions/' + chatId);
    return detail.status === 'idle' ? detail : undefined;
  }, 'the chat settles');
  const chatMessageId = String(sent.messageId);
  const chatCanonical = canonicalOf(f.harness.store.memory(chatId), chatMessageId);

  const promoted = await f.ok('POST', '/v1/product/sessions/' + chatId + '/promote', {
    objective: 'Implement the promoted origin goal', acceptance: [],
  });
  const promotedId = String(promoted.id);
  assert.equal(promoted.mode, 'cowork');
  assert.equal(promoted.parentSessionId, chatId);
  await pauseTask(f, promotedId);
  const promotedSnapshot = ledger(kernel, promotedId);
  const originRow = kernel.getMessages(promotedId, 'main')[0]!;
  assert.equal(originRow.role, 'user');
  const originRowCanonical = canonicalOf(kernel.memory(promotedId), originRow.id);

  const wireBeforeFirst = f.wire.length;
  const branch1 = await branchOk(f, promotedId, originRow.id);
  const branch1Id = String(branch1.id);
  assert.equal(branch1.status, 'paused');
  assert.equal(branch1.parentSessionId, promotedId);
  assert.equal(f.wire.length, wireBeforeFirst, 'branching a promoted task must not dispatch a model request');
  assert.deepEqual(kernel.getRuns(branch1Id), []);
  assert.equal(kernel.getTask(branch1Id)!.modelCalls, 0);
  const branch1Row = kernel.getMessages(branch1Id, 'main')[0]!;
  assert.equal(branch1Row.role, 'user');
  assert.equal(branch1Row.content, originRow.content);

  const wireBeforeSecond = f.wire.length;
  const branch2 = await branchOk(f, branch1Id, branch1Row.id);
  const branch2Id = String(branch2.id);
  assert.equal(branch2.status, 'paused');
  assert.equal(branch2.parentSessionId, branch1Id);
  assert.equal(f.wire.length, wireBeforeSecond, 'branching a branch must not dispatch a model request');
  assert.deepEqual(kernel.getRuns(branch2Id), []);
  assert.equal(kernel.getTask(branch2Id)!.modelCalls, 0);
  assert.equal(kernel.getTask(branch2Id)!.appMode, 'work');
  assert.deepEqual(kernel.getMessages(branch2Id, 'main').map(message => message.role), ['user']);

  // The deeper branch resolves both its parent Work row and the still older canonical Chat record.
  await assertRecall(f, branch2Id, originRow.id, originRowCanonical);
  await assertRecall(f, branch2Id, chatMessageId, chatCanonical);
  const chatOrigin = f.harness.originMemory(branch2Id);
  assert.ok(chatOrigin, 'a branch of a promoted task must expose the promoted Chat layer');
  assert.equal(chatOrigin!.read({ id: chatMessageId, field: 'record' }).sha256, chatCanonical.sha);

  await removeSession(f, chatId);
  await assertRecall(f, branch2Id, chatMessageId, chatCanonical);
  await assertRecall(f, branch2Id, originRow.id, originRowCanonical);

  // Branching never edits the promoted source task or its ledger.
  assert.deepEqual(ledger(kernel, promotedId), promotedSnapshot);
});

test('composite origin memory pages all three immutable layers without losing older records', { timeout: 180_000 }, async t => {
  const f = await newFixture(t);
  const kernel = f.kernel;
  const marker = 'PAGEHIT' + process.pid + Date.now().toString(36).toUpperCase();

  const aId = createPausedWorkTask(f, 'Origin paging root', 'Origin paging root');
  const aMarkers = addMarkedMessages(kernel, aId, 'A', 12, marker);
  const b = await branchOk(f, aId, aMarkers[aMarkers.length - 1]!);
  const bId = String(b.id);
  const bMarkers = addMarkedMessages(kernel, bId, 'B', 12, marker);
  const c = await branchOk(f, bId, bMarkers[bMarkers.length - 1]!);
  const cId = String(c.id);
  const cMarkers = addMarkedMessages(kernel, cId, 'C', 12, marker);
  const d = await branchOk(f, cId, cMarkers[cMarkers.length - 1]!);
  const dId = String(d.id);

  const memory = f.harness.originMemory(dId);
  assert.ok(memory, 'four Work tasks chained through origins must expose composite memory');
  const expected = [...aMarkers, ...bMarkers, ...cMarkers];
  assert.equal(expected.length, 36);
  const canonical = new Map<string, string>();
  for (const [taskId, ids] of [[aId, aMarkers], [bId, bMarkers], [cId, cMarkers]] as [string, string[]][]) {
    for (const id of ids) canonical.set(id, kernel.memory(taskId).read({ id, field: 'record' }).sha256);
  }

  type SearchPage = ReturnType<ScopedMemoryPort['search']>;
  const walk = (limit: number) => {
    const pages: SearchPage[] = [];
    const ids: string[] = [];
    let offset = 0;
    for (;;) {
      assert.ok(pages.length < 20, 'composite paging must terminate');
      const page = memory!.search({ query: marker, limit, offset });
      pages.push(page);
      assert.ok(Array.isArray(page.results));
      assert.ok(page.results.length <= 20, 'a returned page may never exceed the 20-result archive cap');
      assert.ok(page.results.length <= limit, 'a page may not exceed the requested limit');
      for (const hit of page.results) ids.push(hit.id);
      if (page.nextOffset === null) break;
      assert.equal(typeof page.nextOffset, 'number', 'an intermediate composite nextOffset must be a number');
      assert.ok(Number.isInteger(page.nextOffset) && page.nextOffset > offset, 'nextOffset must advance, got ' + page.nextOffset + ' after ' + offset);
      offset = page.nextOffset;
    }
    return { pages, ids };
  };

  const pageLimit = 8;
  const eight = walk(pageLimit);
  assert.equal(eight.ids.length, expected.length, 'composite paging must return every matching source exactly once');
  assert.equal(new Set(eight.ids).size, eight.ids.length, 'no duplicate source id may appear across pages');
  assert.deepEqual([...new Set(eight.ids)].sort(), [...expected].sort(), 'every expected source id must be returned');
  assert.equal(eight.pages.length, Math.ceil(expected.length / pageLimit));
  for (const page of eight.pages.slice(0, -1)) assert.equal(typeof page.nextOffset, 'number');
  assert.equal(eight.pages[eight.pages.length - 1]!.nextOffset, null, 'nextOffset must stay null only after exhaustion');
  assert.equal(eight.pages[eight.pages.length - 1]!.results.length, expected.length % pageLimit);

  for (const id of eight.ids) assert.equal(memory!.read({ id, field: 'record' }).sha256, canonical.get(id), 'read SHA must equal the canonical source record SHA for ' + id);

  const twenty = walk(20);
  assert.equal(twenty.ids.length, expected.length, 'paging with limit 20 must also cover every matching source');
  assert.equal(new Set(twenty.ids).size, twenty.ids.length);
  assert.deepEqual([...new Set(twenty.ids)].sort(), [...expected].sort());
  assert.equal(twenty.pages.length, Math.ceil(expected.length / 20));
  assert.equal(twenty.pages[twenty.pages.length - 1]!.nextOffset, null);
  for (const id of twenty.ids) assert.equal(memory!.read({ id, field: 'record' }).sha256, canonical.get(id));
});

test('a cyclic workOrigin link must fail truthfully instead of hiding layers', { timeout: 120_000 }, async t => {
  const f = await newFixture(t);
  const kernel = f.kernel;

  const aId = createPausedWorkTask(f, 'Origin cycle root', 'Origin cycle root');
  const aMarker = addMarkedMessages(kernel, aId, 'A', 1)[0]!;
  const aCanonical = canonicalOf(kernel.memory(aId), aMarker);
  const branch = await branchOk(f, aId, aMarker);
  const branchId = String(branch.id);

  const baseline = f.harness.originMemory(branchId);
  assert.ok(baseline, 'a healthy branch must expose its copied source prefix');
  assert.equal(baseline!.read({ id: aMarker, field: 'record' }).sha256, aCanonical.sha);

  const link = f.harness.workOriginLink(branchId);
  assert.ok(link, 'the branch must persist a workOrigin link');
  f.harness.store.setSetting('workOrigin:' + branchId, { ...link!, sourceTaskId: branchId });

  let returned: unknown;
  let thrown: Error | undefined;
  try { returned = f.harness.originMemory(branchId); }
  catch (error) { thrown = error instanceof Error ? error : new Error(String(error)); }
  assert.ok(thrown, 'a cyclic workOrigin link must make originMemory fail; it returned ' + (returned === undefined ? 'undefined' : 'a port'));
  assert.match(thrown!.message, /origin|ancestry|cycle/i, 'the cycle error must state the ancestry problem, got: ' + thrown!.message);
});
