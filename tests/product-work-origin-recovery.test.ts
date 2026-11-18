import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBackend } from '../src/app/backend.js';
import { Kernel } from '../src/kernel/index.js';

/**
 * 启动时 Work 分支来源恢复的查询规模回归。
 *
 * 旧缺陷：每次重启都把整个 task_origins 表读进 JS，再跳过已结算记录。201 条 settled 记录会让
 * 启动物化 201 行（Codex 独立探针红证）。这里的测试直接观测真实启动中 rows() 从 task_origins
 * 实际返回的行数：settled 历史必须返回 0 行；大量 pending 必须按有界 keyset 页恢复，不漏不重，
 * 且不产生模型调用。
 */

type Backend = Awaited<ReturnType<typeof startBackend>>;

interface OriginQueryStats {
  queries: number;
  rows: number;
  maxBatch: number;
  settledRows: number;
}

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
const DATA_ROOT = path.join(TREE, '.tmp', 'history-lifecycle', 'final-correction', 'tests', 'origin-recovery');
const SETTLED = 201;
const PENDING = 120;
const MAX_BATCH = 50;
mkdirSync(DATA_ROOT, { recursive: true });
let run = 0;

function fixtureDir(): { owned: string; dataDir: string; workspace: string } {
  const owned = path.join(DATA_ROOT, 'run-' + process.pid + '-' + Date.now() + '-' + run++);
  const workspace = path.join(owned, 'workspace');
  mkdirSync(workspace, { recursive: true });
  return { owned, dataDir: path.join(owned, 'data'), workspace };
}

/** 记录启动期间 Kernel rows() 对 task_origins 的实际返回行。rows() 只服务分页扫描，workOrigin 单行走 row()。 */
function instrumentOriginQueries(settled: Set<string>): { stats: OriginQueryStats; restore: () => void } {
  const prototype = Object.getPrototypeOf(Kernel.prototype) as {
    rows: (sql: string, ...args: (string | number | null)[]) => Record<string, unknown>[];
  };
  const original = prototype.rows;
  const stats: OriginQueryStats = { queries: 0, rows: 0, maxBatch: 0, settledRows: 0 };
  prototype.rows = function (this: unknown, sql: string, ...args: (string | number | null)[]) {
    const result = original.call(this, sql, ...args);
    if (/\bFROM\s+task_origins\b/i.test(sql)) {
      stats.queries += 1;
      stats.rows += result.length;
      stats.maxBatch = Math.max(stats.maxBatch, result.length);
      for (const row of result) if (settled.has(String(row.task_id))) stats.settledRows += 1;
    }
    return result;
  };
  return { stats, restore: () => { prototype.rows = original; } };
}

type Fixture = { backend: Backend; kernel: Backend['services']['kernel']; sourceId: string; messageId: string; snapshot: number };

function openBackend(dataDir: string): Promise<Backend> {
  return startBackend({ dataDir, projectRoot: TREE, mockOptions: { responder: () => ({ content: 'unused' }) } });
}

function createSource(kernel: Backend['services']['kernel'], workspace: string): { sourceId: string; selected: { id: string }; snapshot: number } {
  const sourceId = String(kernel.command({
    commandId: randomUUID(), type: 'create_task',
    parameters: { title: 'Origin recovery source', workspace, initialStatus: 'paused', permissionMode: 'read-only' },
  }).taskId);
  kernel.addMessage(sourceId, 'user', 'Historical source row');
  const selected = kernel.addMessage(sourceId, 'user', 'ORIGIN_RECOVERY_CHECKPOINT');
  return { sourceId, selected, snapshot: kernel.messageCursor(sourceId, selected.id) };
}

function branchParameters(sourceId: string, messageId: string, snapshot: number, title: string) {
  return { title, initialStatus: 'paused' as const, branchOrigin: { sourceTaskId: sourceId, sourceMessageId: messageId, snapshot } };
}

/** 201 条已结算（failed）的来源准备记录：真实旧缺陷会把它们全部读进启动恢复循环。 */
function createSettledPreparations(kernel: Backend['services']['kernel'], sourceId: string, messageId: string, snapshot: number): string[] {
  const ids: string[] = [];
  for (let index = 0; index < SETTLED; index++) {
    const taskId = String(kernel.command({
      commandId: randomUUID(), type: 'create_task',
      parameters: branchParameters(sourceId, messageId, snapshot, 'Settled origin ' + index),
    }).taskId);
    kernel.fenceIncompleteWorkOrigin(taskId, 'Synthetic completed failure for query-scaling verification');
    ids.push(taskId);
  }
  return ids;
}

/** pending 记录带有真实 origin 文件和 Harness link，只差 Kernel 的 ready 标记。 */
function createPendingPreparations(backend: Backend, sourceId: string, messageId: string, snapshot: number): string[] {
  const kernel = backend.services.kernel, harness = backend.services.harness!;
  const ids: string[] = [];
  for (let index = 0; index < PENDING; index++) {
    const taskId = String(kernel.command({
      commandId: randomUUID(), type: 'create_task',
      parameters: branchParameters(sourceId, messageId, snapshot, 'Pending origin ' + index),
    }).taskId);
    harness.createWorkOrigin(taskId, sourceId, messageId, snapshot,
      (after, limit) => kernel.messageRows(sourceId, after, limit, 'main', snapshot));
    ids.push(taskId);
  }
  return ids;
}

test('restart with only settled preparations materializes no origin rows', { timeout: 120_000 }, async t => {
  const { owned, dataDir, workspace } = fixtureDir();
  t.after(() => rmSync(owned, { recursive: true, force: true }));
  let initial: Backend | undefined, recovered: Backend | undefined;
  try {
    initial = await openBackend(dataDir);
    const source = createSource(initial.services.kernel, workspace);
    const settled = new Set(createSettledPreparations(initial.services.kernel, source.sourceId, source.selected.id, source.snapshot));
    await initial.close();
    initial = undefined;

    const { stats, restore } = instrumentOriginQueries(settled);
    try { recovered = await openBackend(dataDir); }
    finally { restore(); }
    const kernel = recovered.services.kernel;

    assert.equal(stats.rows, 0, 'settled branch history must stay in SQLite: startup row queries returned ' + stats.rows + ' rows');
    assert.equal(stats.settledRows, 0);
    assert.ok(stats.queries >= 1, 'startup must still run one bounded pending query');
    assert.equal(kernel.listTasks().reduce((sum, task) => sum + task.modelCalls, 0), 0, 'recovery must not call a model');
    for (const taskId of settled) assert.equal(kernel.workOrigin(taskId)!.state, 'failed');
  } finally {
    await recovered?.close();
    await initial?.close();
  }
});

test('restart recovers every pending preparation in bounded pages without reading settled history', { timeout: 180_000 }, async t => {
  const { owned, dataDir, workspace } = fixtureDir();
  t.after(() => rmSync(owned, { recursive: true, force: true }));
  let initial: Backend | undefined, recovered: Backend | undefined;
  try {
    initial = await openBackend(dataDir);
    const source = createSource(initial.services.kernel, workspace);
    const sourceSha = initial.services.kernel.memory(source.sourceId).read({ id: source.selected.id, field: 'record' }).sha256;
    const settled = new Set(createSettledPreparations(initial.services.kernel, source.sourceId, source.selected.id, source.snapshot));
    const pending = createPendingPreparations(initial, source.sourceId, source.selected.id, source.snapshot);
    await initial.close();
    initial = undefined;

    const { stats, restore } = instrumentOriginQueries(settled);
    try { recovered = await openBackend(dataDir); }
    finally { restore(); }
    const kernel = recovered.services.kernel, harness = recovered.services.harness!;

    assert.equal(stats.settledRows, 0, 'settled preparations must never be materialized during recovery');
    assert.equal(stats.rows, PENDING, 'startup must read exactly the pending preparations, got ' + stats.rows + ' rows');
    assert.ok(stats.maxBatch <= MAX_BATCH, 'each recovery query must stay a small batch, largest was ' + stats.maxBatch);
    assert.ok(stats.queries >= Math.ceil(PENDING / MAX_BATCH), 'pending rows must be read across bounded keyset pages');
    assert.equal(kernel.listTasks().reduce((sum, task) => sum + task.modelCalls, 0), 0, 'recovery must not call a model');

    const recoveredIds = new Set<string>();
    for (const taskId of pending) {
      const preparation = kernel.workOrigin(taskId)!;
      assert.equal(preparation.state, 'ready', 'pending origin was not recovered: ' + taskId);
      assert.equal(preparation.actualCount, preparation.expectedCount);
      assert.equal(kernel.getTask(taskId)!.status, 'paused');
      assert.equal(kernel.events(taskId).filter(event => event.type === 'task.origin_ready').length, 1, 'each origin becomes ready exactly once');
      const memory = harness.originMemory(taskId);
      assert.ok(memory, 'recovered branch must expose its immutable origin');
      assert.equal(memory.read({ id: source.selected.id, field: 'record' }).sha256, sourceSha, 'the recovered origin must preserve the source canonical SHA');
      recoveredIds.add(taskId);
    }
    assert.equal(recoveredIds.size, PENDING, 'no pending branch may be lost or duplicated');
    for (const taskId of settled) {
      assert.equal(kernel.workOrigin(taskId)!.state, 'failed');
      assert.equal(kernel.events(taskId).filter(event => event.type === 'task.origin_ready').length, 0);
    }
  } finally {
    await recovered?.close();
    await initial?.close();
  }
});
