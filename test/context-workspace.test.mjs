import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createDatabase } from '../core/database.js';
import { createContextWorkspace, ContextWorkspaceStore } from '../core/context-workspace.js';
import { createPayloadStore } from '../core/payload-store.js';

async function fixture(t) {
  const root = join(process.cwd(), '.tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'workbench-context-'));
  const database = createDatabase(join(directory, 'state.sqlite'));
  const payloads = createPayloadStore(join(directory, 'payloads'), { key: Buffer.alloc(32, 3) });
  t.after(() => { database.close(); return rm(directory, { recursive: true, force: true }); });
  return { database, payloads };
}

test('context workspace creates independent pinned goal, acceptance, and constraint blocks', async (t) => {
  const { database, payloads } = await fixture(t);
  const workspace = createContextWorkspace({ database, payloadStore: payloads });
  assert.ok(workspace instanceof ContextWorkspaceStore);

  const created = workspace.createWorkspace({
    runId: 'run-1',
    goal: 'Ship the migration',
    acceptanceCriteria: ['Tests pass', 'No plaintext payloads'],
    constraints: ['Use Node 24']
  });
  assert.ok(created.id);
  assert.equal(created.runId, 'run-1');
  const pinned = workspace.listBlocks(created.id, { pinned: true });
  assert.equal(pinned.length, 4);
  assert.ok(pinned.every((block) => block.pinned));
  assert.ok(pinned.every((block) => block.metadata.permanentPinned === true));
  assert.deepEqual(new Set(pinned.map((block) => block.type)), new Set(['goal', 'acceptance', 'constraint']));
  assert.throws(() => workspace.unpin(created.id, pinned[0].id), (error) => error.code === 'context_permanent_pin');
  assert.throws(() => workspace.archive(created.id, pinned[0].id), (error) => error.code === 'context_permanent_pin');
});

test('block IDs are stable and lifecycle operations are auditable', async (t) => {
  const { database, payloads } = await fixture(t);
  const workspace = createContextWorkspace({ database, payloadStore: payloads });
  const context = workspace.createWorkspace({ workspaceId: 'ws-1', runId: 'run-1', goal: 'Goal' });
  const first = workspace.addBlock(context.id, {
    type: 'note', key: 'same-note', summary: 'A note', source: 'test', payload: { text: 'original' }
  });
  const second = workspace.addBlock(context.id, {
    type: 'note', key: 'same-note', summary: 'A note', source: 'test', payload: { text: 'original' }
  });
  assert.equal(first.id, second.id);
  assert.equal(workspace.pinBlock(context.id, first.id).pinned, true);
  assert.equal(workspace.unpinBlock(context.id, first.id).pinned, false);
  assert.equal(workspace.archiveBlock(context.id, first.id).archived, true);
  assert.equal(workspace.recoverBlock(context.id, first.id).archived, false);
  assert.deepEqual(workspace.restoreBlock(context.id, first.id).payload, { text: 'original' });
  const pinned = workspace.addBlock(context.id, {
    type: 'goal', key: 'pinned-goal', summary: 'Pinned goal', pinned: true, payload: 'Pinned goal'
  });
  assert.equal(workspace.archiveBlock(context.id, pinned.id).status, 'archived');
  assert.equal(workspace.getBlock(context.id, pinned.id).pinned, true);
  assert.equal(workspace.recoverBlock(context.id, pinned.id).status, 'pinned');
  assert.throws(() => workspace.deleteBlock(context.id, first.id), /confirm/i);
  assert.equal(workspace.deleteBlock(context.id, first.id, { confirm: true }), true);
  assert.equal(workspace.getBlock(context.id, first.id), null);
  assert.ok(database.get('SELECT count(*) AS count FROM audit').count >= 4);
});

test('pressure thresholds and lossless offload are enforced', async (t) => {
  const { database, payloads } = await fixture(t);
  const workspace = createContextWorkspace({ database, payloadStore: payloads });
  const context = workspace.createWorkspace({ workspaceId: 'ws-pressure', runId: 'run-pressure', tokenLimit: 100_000, goal: 'Pressure' });
  assert.equal(workspace.pressure(context.id, { usedTokens: 80_000 }).level, 'notice');
  assert.equal(workspace.pressure(context.id, { usedTokens: 92_000 }).level, 'manage');
  assert.equal(workspace.pressure(context.id, { usedTokens: 98_000 }).level, 'hard_preflight');
  assert.equal(workspace.pressure(context.id, { usedTokens: 1_000, resultTokens: 12_000 }).externalize, true);
  assert.equal(workspace.pressure(context.id, { usedTokens: 1_000, roundTokens: 50_000 }).externalize, true);

  const block = workspace.addBlock(context.id, {
    type: 'result', key: 'offload-me', summary: 'Result', payload: { text: 'preserve me' }, tokenEstimate: 12_001
  });
  assert.equal(block.offloaded, true);
  assert.deepEqual(workspace.restoreBlock(context.id, block.id).payload, { text: 'preserve me' });
  assert.deepEqual(workspace.dashboard(context.id).pinned.map((item) => item.type), ['goal']);
});

test('98% preflight blocks oversized model assembly and active recovery', async (t) => {
  const { database, payloads } = await fixture(t);
  const workspace = createContextWorkspace({ database, payloadStore: payloads });
  const context = workspace.createWorkspace({ runId: 'run-budget-gate', goal: 'budget', tokenLimit: 100, skipAutoBlocks: true });
  workspace.registerBlock(context.id, { type: 'goal', key: 'goal', summary: 'Pinned goal', payload: 'Pinned goal', tokenEstimate: 70, pinned: true });
  const archived = workspace.registerBlock(context.id, { type: 'result', key: 'large-result', summary: 'Large result', payload: 'x'.repeat(120), tokenEstimate: 30 });
  workspace.archive(context.id, archived.id);

  assert.throws(() => workspace.recover(context.id, archived.id), (error) => error.code === 'context_budget_exceeded');
  assert.equal(workspace.getBlock(context.id, archived.id).status, 'archived');
  assert.equal(workspace.restoreBlock(context.id, archived.id, { range: { start: 0, end: 8 } }).payload.length, 8);

  workspace.unpin(context.id, workspace.listBlocks(context.id)[0].id);
  workspace.registerBlock(context.id, { type: 'note', key: 'visible-fill', summary: 'fill', payload: 'fill', tokenEstimate: 29 });
  assert.throws(() => workspace.assemble(context.id, { loadPayloads: true }), (error) => error.code === 'context_hard_preflight');
});
