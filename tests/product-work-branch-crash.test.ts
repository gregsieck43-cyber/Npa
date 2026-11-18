import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend } from '../src/app/backend.js';

/**
 * 真实进程退出下的 Work 分叉恢复边界。
 *
 * 每个用例都由独立子进程在真实 Product HTTP 分支路径中 process.exit(86)：
 * 1. Kernel paused 行已提交，origin 尚未开始；
 * 2. origin 已写入第一页但尚未提交，拷贝中途退出；
 * 3. origin 文件和 Harness link 已提交，但 Kernel 的 ready 标记尚未写入。
 * 父进程用同一 dataDir 重启，验证只有“已完整写入且可校验”的分支才能保持 paused/被恢复，
 * 其余分支被真实隔离/取消；恢复后的分支 resume 只运行一次模型请求，源任务与副作用均不变。
 */

type Backend = Awaited<ReturnType<typeof startBackend>>;
type Reply = { status: number; json: any; text: string; headers: Headers };

interface SourceSnapshot {
  task: any;
  messages: any[];
  events: any[];
  pendingCalls: any[];
  intents: any[];
  runs: any[];
  grants: any[];
}

interface CrashState {
  boundary: 'entry' | 'copy' | 'link';
  sourceId: string;
  branchId: string;
  messageId: string;
  objective: string;
  sourceSha: string;
  sourceText: string;
  source: SourceSnapshot;
}

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

const TREE = checkoutRoot(process.cwd());
const DATA_ROOT = path.join(TREE, '.tmp', 'history-lifecycle', 'crash-correction', 'tests');
const BACKEND_MODULE = fileURLToPath(new URL('../src/app/backend.js', import.meta.url));
mkdirSync(DATA_ROOT, { recursive: true });
let run = 0;

const CHILD_SOURCE = String.raw`
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const boundary = process.argv[2];
const owned = process.env.NPN_CRASH_FIXTURE;
const workspace = path.join(owned, 'workspace');
mkdirSync(workspace, { recursive: true });
const { startBackend } = await import(pathToFileURL(process.env.NPN_CRASH_BACKEND).href);
const backend = await startBackend({
  dataDir: path.join(owned, 'data'),
  projectRoot: process.env.NPN_CRASH_PROJECT_ROOT,
  mockOptions: { responder: () => ({ content: 'Synthetic child response; no effects.' }) },
});
const kernel = backend.services.kernel;
const state = { boundary, sourceId: '', branchId: '', messageId: '', objective: '', sourceSha: '', sourceText: '', source: undefined };
const statePath = path.join(owned, 'state.json');
const writeState = () => writeFileSync(statePath, JSON.stringify(state));

try {
  const ack = backend.services.command({
    commandId: randomUUID(),
    type: 'create_task',
    parameters: {
      title: 'Synthetic crash source task',
      workspace,
      initialStatus: 'paused',
      permissionMode: 'read-only',
      appMode: 'work',
      goal: {
        objective: 'Preserve the crash-boundary source constraint.',
        constraints: [], acceptance: [], mode: 'autonomous',
      },
    },
  });
  const sourceId = String(ack.taskId);
  for (let i = 0; i < 620; i++) kernel.addMessage(sourceId, 'user', 'Historical source row ' + i);
  const selected = kernel.addMessage(sourceId, 'user', 'CRASH_BRANCH_CHECKPOINT_LAST');
  const task = kernel.getTask(sourceId);
  state.sourceId = sourceId;
  state.messageId = selected.id;
  state.objective = task.goal.objective;
  state.sourceSha = kernel.memory(sourceId).read({ id: selected.id, field: 'record' }).sha256;
  state.sourceText = kernel.memory(sourceId).read({ id: selected.id }).text;
  state.source = {
    task,
    messages: kernel.getMessages(sourceId, 'main'),
    events: kernel.events(sourceId),
    pendingCalls: kernel.pendingCalls(sourceId),
    intents: kernel.intents(sourceId),
    runs: kernel.getRuns(sourceId),
    grants: kernel.sessionGrants(sourceId),
  };
  writeState();

  const harness = backend.services.harness;
  const originalCreate = harness.createWorkOrigin.bind(harness);
  const originalRows = kernel.messageRows.bind(kernel);
  let pages = 0;
  harness.createWorkOrigin = (branchId, sourceTaskId, sourceMessageId, snapshot, readPage) => {
    state.branchId = branchId;
    writeState();
    if (boundary === 'entry') process.exit(86);
    if (boundary === 'copy') {
      kernel.messageRows = (...args) => {
        const rows = originalRows(...args);
        pages += 1;
        if (pages === 2) process.exit(86);
        return rows;
      };
    }
    const link = originalCreate(branchId, sourceTaskId, sourceMessageId, snapshot, readPage);
    if (boundary === 'link') process.exit(86);
    return link;
  };

  const reply = await fetch('http://127.0.0.1:' + backend.port + '/v1/product/sessions/' + sourceId + '/branch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + backend.token },
    body: JSON.stringify({ messageId: selected.id }),
  });
  const text = await reply.text();
  writeState();
  console.error('crash child did not exit at the requested boundary; HTTP ' + reply.status + ': ' + text.slice(0, 300));
  process.exit(91);
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(90);
}
`;

function fixtureDir(): string {
  const owned = path.join(DATA_ROOT, 'run-' + process.pid + '-' + Date.now() + '-' + run++);
  mkdirSync(owned, { recursive: true });
  return owned;
}

async function runCrash(boundary: CrashState['boundary']): Promise<{ owned: string; state: CrashState; dataDir: string }> {
  const owned = fixtureDir();
  const childPath = path.join(owned, 'crash-child.mjs');
  writeFileSync(childPath, CHILD_SOURCE);
  const temp = path.join(owned, 'temp');
  const cache = path.join(owned, 'cache');
  mkdirSync(temp, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const child = spawnSync(process.execPath, [childPath, boundary], {
    cwd: TREE,
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      ...process.env,
      TEMP: temp,
      TMP: temp,
      NODE_COMPILE_CACHE: cache,
      NPN_CRASH_FIXTURE: owned,
      NPN_CRASH_BACKEND: BACKEND_MODULE,
      NPN_CRASH_PROJECT_ROOT: TREE,
    },
  });
  assert.equal(child.status, 86, 'child must exit 86 at ' + boundary + '\nstdout: ' + child.stdout + '\nstderr: ' + child.stderr);
  const state = JSON.parse(readFileSync(path.join(owned, 'state.json'), 'utf8')) as CrashState;
  assert.equal(state.boundary, boundary);
  assert.equal(typeof state.branchId, 'string');
  assert.ok(state.branchId.length > 0);
  return { owned, state, dataDir: path.join(owned, 'data') };
}

async function startRecovered(owned: string): Promise<{ backend: Backend; wire: any[] }> {
  const wire: any[] = [];
  const backend = await startBackend({
    dataDir: path.join(owned, 'data'),
    projectRoot: TREE,
    mockOptions: {
      responder: () => ({ content: 'Recovered branch answer' }),
      trace: (body: any) => wire.push(body),
    },
  });
  return { backend, wire };
}

async function replyOf(backend: Backend, method: string, route: string, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + backend.token };
  const response = await fetch('http://127.0.0.1:' + backend.port + route, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: response.status, json, text, headers: response.headers };
}

function snapshot(kernel: Backend['services']['kernel'], taskId: string): SourceSnapshot {
  return {
    task: kernel.getTask(taskId),
    messages: kernel.getMessages(taskId, 'main'),
    events: kernel.events(taskId),
    pendingCalls: kernel.pendingCalls(taskId),
    intents: kernel.intents(taskId),
    runs: kernel.getRuns(taskId),
    grants: kernel.sessionGrants(taskId),
  };
}

function assertSourceHistory(kernel: Backend['services']['kernel'], state: CrashState): void {
  assert.deepEqual(kernel.getMessages(state.sourceId, 'main'), state.source.messages, 'source history must not change');
  assert.deepEqual(kernel.getTask(state.sourceId), state.source.task, 'source task record must not change');
  assert.deepEqual(kernel.pendingCalls(state.sourceId), state.source.pendingCalls);
  assert.deepEqual(kernel.intents(state.sourceId), state.source.intents);
  assert.deepEqual(kernel.getRuns(state.sourceId), state.source.runs);
  assert.deepEqual(kernel.sessionGrants(state.sourceId), state.source.grants);
  assert.equal(kernel.memory(state.sourceId).read({ id: state.messageId, field: 'record' }).sha256, state.sourceSha,
    'the source canonical SHA must not change');
}

async function assertFenced(t: TestContext, boundary: 'entry' | 'copy'): Promise<void> {
  const { owned, state } = await runCrash(boundary);
  const { backend } = await startRecovered(owned);
  t.after(async () => { await backend.close(); rmSync(owned, { recursive: true, force: true }); });
  const kernel = backend.services.kernel;
  const harness = backend.services.harness!;
  const branch = kernel.getTask(state.branchId);
  assert.ok(branch, 'the branch task row must survive the crash');
  assert.equal(branch!.status, 'cancelled', boundary + ' must fence the incomplete branch');
  assert.equal(harness.originMemory(state.branchId), undefined, 'no origin may be advertised for a fenced branch');
  const preparation = kernel.workOrigin(state.branchId);
  assert.ok(preparation);
  assert.equal(preparation!.state, 'failed');
  assert.match(String(preparation!.reason ?? ''), /origin/i);
  assert.ok(kernel.events(state.branchId).some(event => event.type === 'task.origin_fenced'),
    'the recovery must write an explicit origin_fenced event');
  assert.equal(kernel.getMessages(state.branchId, 'main').length, 1, 'no source message may enter the branch');
  assert.deepEqual(kernel.pendingCalls(state.branchId), []);
  assert.deepEqual(kernel.intents(state.branchId), []);
  assert.deepEqual(kernel.getRuns(state.branchId), []);
  assert.deepEqual(kernel.sessionGrants(state.branchId), []);

  const indexed = backend.services.product!.store.getSession(state.branchId);
  assert.ok(indexed, 'the recovered/fenced task must still be visible to the product index');
  assert.equal((indexed as any).status, 'cancelled');

  const beforeResume = snapshot(kernel, state.sourceId);
  const resumed = await replyOf(backend, 'POST', '/v1/product/tasks/' + state.branchId + '/control', { action: 'resume' });
  assert.ok(resumed.status >= 400, 'resuming a fenced branch must fail, got ' + resumed.status + ': ' + resumed.text.slice(0, 300));
  await sleep(250);
  assert.equal(kernel.getTask(state.branchId)!.modelCalls, 0, 'an incomplete branch must never dispatch a model');
  assert.equal(kernel.getTask(state.branchId)!.status, 'cancelled');
  assert.deepEqual(snapshot(kernel, state.sourceId), beforeResume, 'the source must not change');
  assertSourceHistory(kernel, state);
}

test('crash after the Kernel paused row fences the branch before resume can dispatch', { timeout: 180_000 }, async t => {
  await assertFenced(t, 'entry');
});

test('crash during origin copy fences the branch and removes the partial origin', { timeout: 180_000 }, async t => {
  await assertFenced(t, 'copy');
});

test('crash after origin and link before ready is recovered and resume runs exactly one request', { timeout: 180_000 }, async t => {
  const { owned, state } = await runCrash('link');
  const { backend, wire } = await startRecovered(owned);
  t.after(async () => { await backend.close(); rmSync(owned, { recursive: true, force: true }); });
  const kernel = backend.services.kernel;
  const harness = backend.services.harness!;

  const branch = kernel.getTask(state.branchId);
  assert.ok(branch);
  assert.equal(branch!.status, 'paused', 'a verified origin must recover the branch paused');
  const preparation = kernel.workOrigin(state.branchId);
  assert.ok(preparation);
  assert.equal(preparation!.state, 'ready');
  assert.equal(preparation!.actualCount, preparation!.expectedCount);
  assert.equal(kernel.getMessages(state.branchId, 'main').length, 1);
  assert.deepEqual(kernel.pendingCalls(state.branchId), []);
  assert.deepEqual(kernel.intents(state.branchId), []);
  assert.deepEqual(kernel.getRuns(state.branchId), []);
  assert.deepEqual(kernel.sessionGrants(state.branchId), []);

  const origin = harness.originMemory(state.branchId);
  assert.ok(origin, 'the recovered branch must expose its immutable origin');
  const canonical = origin!.read({ id: state.messageId, field: 'record' });
  assert.equal(canonical.sha256, state.sourceSha, 'the origin must preserve the canonical source SHA');
  assert.equal(origin!.read({ id: state.messageId }).text, state.sourceText);

  const recall = await replyOf(backend, 'GET', '/v1/product/inspector/recall?sessionId=' + encodeURIComponent(state.branchId)
    + '&sourceId=' + encodeURIComponent(state.messageId));
  assert.equal(recall.status, 200, recall.text.slice(0, 300));
  assert.equal(recall.json.sha, state.sourceSha);

  const indexed = backend.services.product!.store.getSession(state.branchId);
  assert.ok(indexed);
  assert.equal((indexed as any).status, 'paused');
  assert.equal((indexed as any).parentSessionId, state.sourceId);

  const sourceAfterRestart = snapshot(kernel, state.sourceId);
  const resumed = await replyOf(backend, 'POST', '/v1/product/tasks/' + state.branchId + '/control', { action: 'resume' });
  assert.equal(resumed.status, 200, 'resume -> ' + resumed.status + ': ' + resumed.text.slice(0, 400));
  // 真实 Runner 在完成一次 Work 请求后还会做一次独立完成审查；mock 审查响应不是 JSON，
  // 因此合法终态是 waiting_input，而不是测试原先强制的 modelCalls===1。只允许一次 Work 请求。
  const workRequests = (): any[] => wire.filter(body => String(body?.messages?.[0]?.content ?? '').includes('MAIN ROLE'));
  const settled = await (async () => {
    const deadline = performance.now() + 20_000;
    let last: any;
    for (;;) {
      const current = kernel.getTask(state.branchId);
      last = { task: current, wire: wire.length, workRequests: workRequests().length, events: current ? kernel.events(state.branchId).slice(-8) : [] };
      if (current && workRequests().length === 1 && ['waiting_input', 'completed', 'failed'].includes(current.status)) return current;
      assert.ok(performance.now() < deadline, 'the recovered branch did not settle: ' + JSON.stringify(last).slice(0, 3000));
      await sleep(25);
    }
  })();
  assert.equal(settled.status, 'waiting_input', 'the mock reviewer does not return JSON, so the real Runner settles awaiting input');
  assert.equal(settled.modelCalls, 2, 'one Work request plus its one independent completion review');
  assert.equal(workRequests().length, 1, 'resuming the recovered branch must run exactly one Work model request');
  await sleep(250);
  assert.equal(workRequests().length, 1, 'no duplicate Work model request may follow the settled resume');
  const messages = kernel.getMessages(state.branchId, 'main');
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(messages[0]!.content, state.objective);
  assert.equal(messages[1]!.content, 'Recovered branch answer');
  const copied = messages.filter(message => state.source.messages.some(source => source.id === message.id));
  assert.deepEqual(copied, [], 'no source message may be copied into the live branch history');
  assert.deepEqual(snapshot(kernel, state.sourceId), sourceAfterRestart, 'resume must not alter the source');
  assertSourceHistory(kernel, state);
});
