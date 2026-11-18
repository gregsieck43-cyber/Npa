import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AdaptationError, CandidateManager, TaskModuleError, taskModuleDigest, type Candidate, type PureTaskModule } from '../src/adaptation/index.js';

const tempRoot = resolve('.tmp');
mkdirSync(tempRoot, { recursive: true });
function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tempRoot, 'adaptation-module-test-'));
  t.after(() => {
    const owned = relative(tempRoot, resolve(root));
    assert.ok(owned.startsWith('adaptation-module-test-') && !isAbsolute(owned) && !owned.includes('..'));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function module(source: string, input: string, expected: string): PureTaskModule {
  return { kind: 'pure-task-module', source, fixtures: [{ input, expected }] };
}
function approve(manager: CandidateManager, candidate: Candidate): void {
  manager.approve(candidate.id, { artifactDigest: candidate.artifactDigest, taskId: candidate.taskId,
    expectedVersion: candidate.baseVersion, capabilityDiff: candidate.capabilityDiff, principal: 'operator:local' });
}
function expectCode(operation: () => unknown, code: string): void {
  assert.throws(operation, (error: unknown) => (error instanceof AdaptationError || error instanceof TaskModuleError) && error.code === code);
}
function runtimeClean(dataDir: string): void {
  assert.deepEqual(readdirSync(join(dataDir, 'adaptation', '.runtime')), []);
}

test('original pure source is copied, tested, approved, paused, pinned and rolled back', async t => {
  const dataDir = fixture(t);
  const manager = new CandidateManager(dataDir);
  const spec = { taskId: 'format-task', name: 'Normalize lines', promptSuffix: 'Keep original goal and audit rules.',
    transform: { kind: 'prefix' as const, value: 'Report:\n' },
    module: module('(text) => text.split("\\n").map(line => line.trim()).filter(Boolean).join("\\n")', '  alpha  \n\n beta  ', 'alpha\nbeta') };
  const candidate = manager.create(spec);
  const copiedSource = spec.module.source;
  spec.module.source = '(text) => "modified after create"';
  assert.equal(candidate.artifactVersion, 2);
  assert.deepEqual(candidate.capabilityDiff, ['+task.output.module', '+task.output.transform', '+task.prompt']);
  expectCode(() => manager.test(candidate.id), 'ASYNC_TEST_REQUIRED');
  expectCode(() => approve(manager, candidate), 'TEST_REQUIRED');
  expectCode(() => manager.activate(candidate.id, { taskStatus: 'paused' }), 'APPROVAL_REQUIRED');
  assert.equal(await manager.applySnapshot(manager.snapshotFor('format-task'), 'raw'), 'raw');
  const tested = await manager.testAsync(candidate.id);
  assert.equal(tested.testReport?.passed, true);
  assert.equal(tested.testReport?.validatorVersion, 2);
  assert.equal(tested.testReport?.moduleSourceDigest, taskModuleDigest(copiedSource));
  approve(manager, tested);
  expectCode(() => manager.activate(candidate.id), 'PAUSE_REQUIRED');
  expectCode(() => manager.activate(candidate.id, { taskStatus: 'running' }), 'PAUSE_REQUIRED');
  assert.equal(manager.activate(candidate.id, { taskStatus: 'paused' }).version, 1);
  const pinned = manager.snapshotFor('format-task');
  assert.equal(pinned.module?.source, copiedSource);
  assert.equal(pinned.promptSuffix, 'Keep original goal and audit rules.');
  assert.equal(await manager.applySnapshot(pinned, ' x \n\n y '), 'Report:\nx\ny');
  expectCode(() => manager.transformFor('format-task', 'input'), 'ASYNC_TRANSFORM_REQUIRED');
  expectCode(() => manager.test(candidate.id), 'IMMUTABLE_ACTIVATION');
  const restarted = new CandidateManager(dataDir);
  assert.equal(await restarted.applySnapshot(restarted.snapshotFor('format-task'), ' z '), 'Report:\nz');
  restarted.rollback('format-task', 1);
  assert.equal(await restarted.applySnapshot(restarted.snapshotFor('format-task'), ' z '), ' z ');
  assert.equal(await restarted.applySnapshot(pinned, ' z '), 'Report:\nz');
  runtimeClean(dataDir);
});

test('explicit output fixtures are behavior oracles and failure cannot be approved', async t => {
  const dataDir = fixture(t);
  const manager = new CandidateManager(dataDir);
  const candidate = manager.create({ taskId: 'task', name: 'Wrong formatter', module: module('(text) => text', ' alpha ', 'alpha') });
  const tested = await manager.testAsync(candidate.id);
  assert.equal(tested.status, 'failed');
  assert.equal(tested.testReport?.checks.find(check => check.name === 'task module explicit fixture outputs')?.passed, false);
  expectCode(() => approve(manager, tested), 'TEST_REQUIRED');
  assert.equal(manager.activeFor('task').version, 0);
  runtimeClean(dataDir);
});

test('each call has a fresh realm and source cannot retain cross-call state', async t => {
  const dataDir = fixture(t);
  const manager = new CandidateManager(dataDir);
  const candidate = manager.create({ taskId: 'task', name: 'Fresh realm', module: module('(text) => { globalThis.calls = (globalThis.calls ?? 0) + 1; return text + globalThis.calls; }', 'call:', 'call:1') });
  const tested = await manager.testAsync(candidate.id);
  assert.equal(tested.testReport?.passed, true);
  approve(manager, tested); manager.activate(candidate.id, { taskStatus: 'paused' });
  const pinned = manager.snapshotFor('task');
  assert.equal(await manager.applySnapshot(pinned, 'A:'), 'A:1');
  assert.equal(await manager.applySnapshot(pinned, 'B:'), 'B:1');
  runtimeClean(dataDir);
});

test('worker has no process, filesystem, network, host callbacks or real time interfaces', async t => {
  const dataDir = fixture(t);
  const manager = new CandidateManager(dataDir);
  const source = '(text) => [typeof process, typeof require, typeof Buffer, typeof fetch, typeof WebSocket, typeof Date, typeof console, typeof setTimeout].join(":")';
  const expected = Array(8).fill('undefined').join(':');
  const candidate = await manager.testAsync(manager.create({ taskId: 'task', name: 'Host boundary probe', module: module(source, '', expected) }).id);
  assert.equal(candidate.testReport?.passed, true);
  runtimeClean(dataDir);
});

test('module schema rejects dependency imports and protected capability requests', t => {
  const manager = new CandidateManager(fixture(t));
  expectCode(() => manager.create({ taskId: 'task', name: 'Imports', module: module('(text) => import("node:fs")', '', '') }), 'MODULE_IMPORT');
  expectCode(() => manager.create({ taskId: 'task', name: 'Invalid syntax', module: module('(text) => {', '', '') }), 'MODULE_SYNTAX');
  expectCode(() => manager.create({ taskId: 'task', name: 'No fixtures', module: { kind: 'pure-task-module', source: '(text)=>text', fixtures: [] } }), 'MODULE_FIXTURE');
  expectCode(() => manager.create({ taskId: 'task', name: 'Capability', module: module('(text)=>text', '', ''), capabilities: ['filesystem'] }), 'CAPABILITY_ESCALATION');
  expectCode(() => manager.create({ taskId: 'task', name: 'Protected field', module: { ...module('(text)=>text', '', ''), kernel: 'change' } as never }), 'MODULE_SCHEMA');
});

test('dynamic code, random behavior, invalid return and bounded-loop failures have fixed diagnostics', async t => {
  const dataDir = fixture(t);
  const manager = new CandidateManager(dataDir);
  const sources = ['(text) => Function("return 1")()', '(text) => Math.random().toString()',
    '(text) => ({ value: text })', '(text) => { while (true) {} }',
    '(text) => { throw new Error("candidate-diagnostic-fixture"); }'];
  for (const source of sources) {
    const candidate = await manager.testAsync(manager.create({ taskId: 'task', name: 'Bounded failure', module: module(source, '', '') }).id);
    assert.equal(candidate.status, 'failed');
    assert.ok(candidate.testReport?.checks.some(check => check.name === 'task module worker result: MODULE_EXECUTION' && !check.passed));
    assert.ok(!JSON.stringify(candidate).includes('candidate-diagnostic-fixture'));
  }
  runtimeClean(dataDir);
});

test('cancellation leaves the candidate draft and cleans the owned worker directory', async t => {
  const dataDir = fixture(t);
  const manager = new CandidateManager(dataDir);
  const candidate = manager.create({ taskId: 'task', name: 'Cancelled test', module: module('(text)=>text', 'a', 'a') });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(manager.testAsync(candidate.id, cancelled.signal), (error: unknown) => error instanceof TaskModuleError && error.code === 'MODULE_CANCELLED');
  assert.equal(manager.get(candidate.id).status, 'draft');
  const during = new AbortController();
  const pending = manager.testAsync(candidate.id, during.signal);
  during.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof TaskModuleError && error.code === 'MODULE_CANCELLED');
  assert.equal(manager.get(candidate.id).status, 'draft');
  runtimeClean(dataDir);
});

test('async tests cannot overwrite concurrent candidate state changes', async t => {
  const dataDir = fixture(t);
  const manager = new CandidateManager(dataDir);
  const candidate = manager.create({ taskId: 'task', name: 'Async fixture', module: module('(text)=>text', 'a', 'a') });
  const pending = manager.testAsync(candidate.id);
  manager.create({ taskId: 'other', name: 'Concurrent operator work' });
  await assert.rejects(pending, (error: unknown) => error instanceof AdaptationError && error.code === 'TEST_STALE');
  assert.equal(manager.get(candidate.id).status, 'draft');
  assert.equal(manager.list().length, 2);
  runtimeClean(dataDir);
});

test('approval binds source and fixtures; artifact and pinned source swaps fail before execution', async t => {
  const dataDir = fixture(t);
  const manager = new CandidateManager(dataDir);
  const first = await manager.testAsync(manager.create({ taskId: 'task', name: 'Upper case', module: module('(text)=>text.toUpperCase()', 'alpha', 'ALPHA') }).id);
  approve(manager, first); manager.activate(first.id, { taskStatus: 'paused' });
  const pinned = manager.snapshotFor('task');
  pinned.module!.source = '(text)=>text.toLowerCase()';
  await assert.rejects(manager.applySnapshot(pinned, 'ALPHA'), (error: unknown) => error instanceof AdaptationError && error.code === 'ARTIFACT_CORRUPT');
  manager.rollback('task');
  const next = await manager.testAsync(manager.create({ taskId: 'task', name: 'Next format', module: module('(text)=>text.trim()', ' alpha ', 'alpha') }).id);
  approve(manager, next);
  const artifactDir = join(dataDir, 'adaptation', 'artifacts');
  copyFileSync(join(artifactDir, `${first.artifactDigest}.json`), join(artifactDir, `${next.artifactDigest}.json`));
  expectCode(() => manager.activate(next.id, { taskStatus: 'paused' }), 'ARTIFACT_CORRUPT');
  assert.equal(manager.activeFor('task').version, 2);
  const stored = JSON.parse(readFileSync(join(artifactDir, `${first.artifactDigest}.json`), 'utf8'));
  assert.equal(stored.source.module.fixtures[0].expected, 'ALPHA');
  runtimeClean(dataDir);
});
