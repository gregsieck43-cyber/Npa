import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Kernel } from '../src/kernel/index.js';
import { Runner } from '../src/app/runner.js';
import { IntegrationService } from '../src/integrations/index.js';
import type { Configuration } from '../src/app/configuration.js';
import type { CandidateManager } from '../src/adaptation/index.js';
import type { ProviderConfig } from '../src/contracts.js';

function fixture(t: import('node:test').TestContext) {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), owned = mkdtempSync(path.join(root, 'context-state-'));
  let kernel = new Kernel(owned);
  let collaboration = new IntegrationService({ dataDir: owned, projectRoot: owned, kernel });
  const configuration = { globalPaths: [], skillRoots: [], redact: (value: string) => value, sanitize: (value: unknown) => value } as unknown as Configuration;
  const candidates = { snapshotFor: () => ({}) } as unknown as CandidateManager;
  const runner = () => { const value = new Runner(kernel, configuration, candidates, owned); value.collaboration = collaboration; return value; };
  t.after(() => { collaboration.close(); kernel.close(); assert.equal(path.dirname(owned), root); rmSync(owned, { recursive: true, force: true }); });
  return { owned, get kernel() { return kernel; }, get collaboration() { return collaboration; }, runner,
    restart() { collaboration.close(); kernel.close(); kernel = new Kernel(owned); kernel.recover(); collaboration = new IntegrationService({ dataDir: owned, projectRoot: owned, kernel }); } };
}
const config = { maxRequestBytes: 131072 } as ProviderConfig;
function snapshot(messages: { content?: string | null }[]) {
  const prefix = 'Current saved goal and progress (program snapshot): ';
  return JSON.parse(messages.findLast(message => message.content?.startsWith(prefix))!.content!.slice(prefix.length));
}

test('Work context remains bounded after many large child results without materializing full task history', async t => {
  const f = fixture(t), taskId = f.kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace: f.owned, objective: 'Continue the unfinished migration', maxModelCalls: 100 } }).taskId!;
  for (let index = 0; index < 36; index++) {
    f.kernel.command({ commandId: randomUUID(), taskId, type: 'delegate', parameters: { title: 'Milestone ' + index, objective: 'Inspect milestone ' + index, paths: ['part-' + index] } });
    const childId = f.kernel.delegations(taskId).at(-1)!.childTaskId;
    // This fixture uses explicit cancelled work with a large diagnostic, not invented verification.
    f.kernel.transition(childId, 'cancelled', { result: 'Historical diagnostic '.repeat(240) });
  }
  f.kernel.command({ commandId: randomUUID(), taskId, type: 'delegate', parameters: { title: 'Current milestone', objective: 'Finish the pending change', paths: ['current'] } });
  const activeId = f.kernel.delegations(taskId).at(-1)!.childTaskId;
  let allChildrenCalls = 0;
  const original = f.kernel.queryDelegations.bind(f.kernel);
  f.kernel.queryDelegations = (...args) => { allChildrenCalls++; return original(...args); };
  const traced = f.kernel as unknown as { rows: (sql: string, ...args: (string | number)[]) => Record<string, unknown>[] };
  const rows = traced.rows.bind(f.kernel), reads: { sql: string; args: (string | number)[]; values: Record<string, unknown>[] }[] = [];
  traced.rows = (sql, ...args) => { const values = rows(sql, ...args); if (sql.includes('FROM delegations d JOIN tasks')) reads.push({ sql, args, values }); return values; };
  const built = await f.runner().assembleWork(taskId, config);
  assert.ok(JSON.stringify(built.context.messages).length <= 32000);
  assert.equal(allChildrenCalls, 0, 'per-request projection must not allocate all child task bodies or verifications');
  const state = snapshot(built.context.messages);
  assert.equal(state.delegations.total, 37);
  assert.ok(state.delegations.items.length <= 8);
  assert.equal(state.delegations.omitted, state.delegations.total - state.delegations.items.length);
  assert.ok(state.delegations.items.some((child: { id: string }) => child.id === activeId), 'unfinished work takes precedence over old settled diagnostics');
  assert.match(state.delegations.hint, /list_delegations/);
  assert.equal(reads.length, 1); assert.equal(reads[0]!.values.length, 8);
  assert.ok(reads[0]!.values.every(row => !('body' in row) && String(row.result ?? '').length <= 400));
  const db = new DatabaseSync(f.kernel.dbPath);
  try { assert.match(JSON.stringify(db.prepare('EXPLAIN QUERY PLAN ' + reads[0]!.sql).all(...reads[0]!.args)), /delegations_parent/); }
  finally { db.close(); }
});

test('large predecessor outputs are bounded previews while exact results remain archived', async t => {
  const f = fixture(t), taskId = f.kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace: f.owned, objective: 'Coordinate dependent phases' } }).taskId!;
  const predecessors: string[] = [];
  for (let index = 0; index < 12; index++) {
    f.kernel.command({ commandId: randomUUID(), taskId, type: 'delegate', parameters: { title: 'Input ' + index, objective: 'Inspect input', paths: ['input-' + index] } });
    const childId = f.kernel.delegations(taskId).at(-1)!.childTaskId; predecessors.push(childId);
    f.kernel.transition(childId, 'cancelled', { result: 'Predecessor diagnostic '.repeat(400) });
  }
  f.kernel.command({ commandId: randomUUID(), taskId, type: 'delegate', parameters: { title: 'Consumer', objective: 'Check prerequisites before work', paths: ['consumer'], dependsOn: predecessors } });
  const consumerId = f.kernel.delegations(taskId).at(-1)!.childTaskId;
  const built = await f.runner().assembleWork(consumerId, config), state = snapshot(built.context.messages);
  assert.equal(state.predecessors.total, 12); assert.equal(state.predecessors.items.length, 8); assert.equal(state.predecessors.omitted, 4);
  assert.ok(state.predecessors.items.every((item: { resultPreview: string; resultTruncated: boolean }) => item.resultPreview.length <= 400 && item.resultTruncated));
  assert.ok(f.kernel.getTask(predecessors[0]!)!.result!.length > 400);
  assert.match(state.predecessors.hint, /do not prove readiness/);
  assert.ok(JSON.stringify(built.context.messages).length <= 32000);
});

test('restart and history compaction retain the current goal, plan identity and corrected source-backed decision', async t => {
  const f = fixture(t), taskId = f.kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace: f.owned, objective: 'Legacy migration', maxModelCalls: 100, mode: 'collaborative' } }).taskId!;
  const old = f.kernel.addMessage(taskId, 'user', 'Encoding decision: legacy ASCII only.');
  f.kernel.memory(taskId).remember({ key: 'encoding-decision', kind: 'decision', text: 'OBSOLETE_ASCII_DECISION', sourceIds: [old.id], expectedRevision: 0 }, 'old-decision');
  for (let index = 0; index < 450; index++) f.kernel.addMessage(taskId, index % 2 ? 'assistant' : 'user', 'Unrelated historical progress ' + index + ' ' + 'x'.repeat(180));
  const corrected = f.kernel.addMessage(taskId, 'user', 'Encoding decision corrected: use UTF-8 BOM for ledger AZ-981.');
  f.kernel.memory(taskId).remember({ key: 'encoding-decision', kind: 'decision', text: 'CURRENT_UTF8_BOM_DECISION', sourceIds: [corrected.id], expectedRevision: 1 }, 'corrected-decision');
  const plan = f.collaboration.createPlan(taskId, { id: 'migration-plan', title: 'Validate and migrate', nodes: [
    { id: 'validate', title: 'Validate source', objective: 'Validate source evidence', paths: ['source'], dependencies: [] },
    { id: 'migrate', title: 'Migrate ledger', objective: 'Migrate corrected ledger', paths: ['ledger'], dependencies: ['validate'] },
  ] });
  assert.equal(f.collaboration.planHeader(taskId)!.needsReview, false);
  f.kernel.command({ commandId: randomUUID(), taskId, type: 'revise_goal', parameters: { goal: { objective: 'CURRENT_GOAL preserve the ledger with UTF-8 BOM', mode: 'autonomous' }, reason: 'Operator corrects the migration encoding requirement' } });
  f.restart();
  const built = await f.runner().assembleWork(taskId, config), state = snapshot(built.context.messages);
  assert.equal(state.goalVersion, 2); assert.equal(state.mode, 'autonomous');
  assert.match(state.goal.objective, /CURRENT_GOAL/);
  assert.equal(state.plan.id, plan.id); assert.equal(state.plan.revision, plan.revision); assert.equal(state.plan.nodeCount, 2);
  assert.equal(state.plan.goalVersion, 1); assert.equal(state.plan.needsReview, true, 'a pre-revision plan must not silently authorize the revised goal');
  assert.ok(state.delegations.items.every((child: { needsReaccept: boolean }) => child.needsReaccept));
  const wire = JSON.stringify(built.context.messages);
  assert.match(wire, /CURRENT_UTF8_BOM_DECISION/); assert.doesNotMatch(wire, /OBSOLETE_ASCII_DECISION/);
  assert.ok(built.archivedCount > 0); assert.ok(wire.length <= 32000);
  assert.match(f.kernel.memory(taskId).read({ id: old.id }).text, /legacy ASCII/);
  assert.match(f.kernel.memory(taskId).read({ id: corrected.id }).text, /UTF-8 BOM/);
  assert.match(built.context.messages.at(-1)!.content!, /^Current saved goal/, 'current control state is a fresh tail snapshot, not old remembered text');
});

test('legacy plans without a goal version stay inspectable and require review after reopening', async t => {
  const f = fixture(t), taskId = f.kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace: f.owned, objective: 'Inspect legacy plan' } }).taskId!;
  f.collaboration.createPlan(taskId, { id: 'legacy', title: 'Legacy plan', nodes: [{ id: 'inspect', title: 'Inspect', objective: 'Read source evidence', paths: ['inspect'], dependencies: [] }] });
  const db = new DatabaseSync(path.join(f.owned, 'integrations.sqlite'));
  try { db.prepare("UPDATE records SET body=json_remove(body,'$.goalVersion') WHERE kind='plan' AND scope=? AND id='current'").run(taskId); }
  finally { db.close(); }
  f.restart();
  const state = snapshot((await f.runner().assembleWork(taskId, config)).context.messages);
  assert.equal(state.plan.id, 'legacy'); assert.equal(state.plan.nodeCount, 1);
  assert.equal(state.plan.goalVersion, undefined); assert.equal(state.plan.needsReview, true);
});

test('evidence near the start, middle and end remains exactly readable after restart; missing and foreign evidence stay missing', async t => {
  const f = fixture(t), taskId = f.kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace: f.owned, objective: 'Find original migration evidence' } }).taskId!;
  const sources: { id: string; marker: string; text: string }[] = [];
  for (let index = 0; index < 601; index++) {
    const marker = [0, 300, 600].includes(index) ? 'EXACT-EVIDENCE-' + index : '';
    const text = marker ? marker + '\n' + '原文证据\n'.repeat(1700) : 'Distractor progress ' + index;
    const message = f.kernel.addMessage(taskId, 'user', text);
    if (marker) sources.push({ id: message.id, marker, text });
  }
  const otherId = f.kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace: f.owned, objective: 'Other scope' } }).taskId!;
  const foreign = f.kernel.addMessage(otherId, 'user', 'FOREIGN-EVIDENCE');
  f.restart();
  for (const source of sources) {
    const hit = f.kernel.memory(taskId).search({ query: source.marker }).results[0]!;
    assert.equal(hit.id, source.id);
    let offset = 0, text = '';
    for (;;) { const page = f.kernel.memory(taskId).read({ id: hit.id, offset, length: 1000 }); text += page.text; if (page.nextOffset === null) break; offset = page.nextOffset; }
    assert.equal(createHash('sha256').update(text).digest('hex'), createHash('sha256').update(source.text).digest('hex'));
  }
  assert.deepEqual(f.kernel.memory(taskId).search({ query: 'NONEXISTENT-EVIDENCE' }).results, []);
  assert.deepEqual(f.kernel.memory(taskId).search({ query: 'FOREIGN-EVIDENCE' }).results, []);
  assert.throws(() => f.kernel.memory(taskId).read({ id: foreign.id }), /scope|not found/i);
});
