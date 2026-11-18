import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { Kernel, KernelError } from '../src/kernel/index.js';
import { decide, decideForMode, reviewEscalates } from '../src/kernel/permissions.js';
import type {
  AppMode, Command, Intent, PermissionMode, PolicyCapability, PolicyOutcome, RiskLevel, Task, ToolCall, ToolReviewRecord,
} from '../src/contracts.js';

const fixtureRoot = path.resolve('.tmp/module-02-permissions/A/temp');
const MODES: PermissionMode[] = ['read-only', 'ask', 'auto-review', 'full-access'];
const RISKS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
const NON_READ: PolicyCapability[] = ['write', 'exec', 'network', 'mcp'];
const expectCode = (expected: string) => (error: unknown) => error instanceof KernelError && error.code === expected;

/** Decision table identical to src/frontend/api/policy.ts decide(). Critical exec/plugin/MCP asks in ask/full-access. */
function table(mode: PermissionMode, capability: PolicyCapability, risk: RiskLevel): PolicyOutcome {
  if (capability === 'read') return 'allow';
  if (risk === 'critical' && (mode === 'ask' || mode === 'full-access')) return 'ask';
  if (mode === 'read-only') return 'deny';
  if (mode === 'ask') return 'ask';
  if (mode === 'auto-review') return risk === 'low' ? 'allow' : 'review';
  return 'allow';
}

class Fixture {
  kernel: Kernel;
  private closed = false;
  constructor(readonly directory: string) { this.kernel = new Kernel(directory); }
  close(): void { if (this.closed) return; this.kernel.close(); this.closed = true; }
  reopen(): Kernel { this.close(); this.kernel = new Kernel(this.directory); this.closed = false; return this.kernel; }
}

function fixture(t: TestContext): Fixture {
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(path.join(fixtureRoot, 'kernel-permissions-'));
  const created = new Fixture(directory);
  t.after(() => {
    try { created.close(); }
    finally {
      assert.ok(directory.startsWith(fixtureRoot + path.sep), 'fixtures stay inside the module temp root');
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return created;
}

function create(f: Fixture, parameters: Record<string, unknown> = {}, origin: Command['origin'] = 'operator'): Task {
  const ack = f.kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', origin, parameters: { title: 'Permission fixture', ...parameters } });
  return f.kernel.getTask(ack.taskId!)!;
}

function delegate(f: Fixture, parentId: string, parameters: Record<string, unknown> = {}, origin: Command['origin'] = 'operator'): Task {
  const ack = f.kernel.command({ commandId: crypto.randomUUID(), type: 'delegate', origin, taskId: parentId, parameters: { objective: 'Scoped child', ...parameters } });
  return f.kernel.getTask(f.kernel.delegations(parentId).at(-1)!.childTaskId)! ?? f.kernel.getTask(ack.taskId!)!;
}

function start(f: Fixture, taskId: string): string {
  const run = f.kernel.createRun(taskId);
  f.kernel.transition(taskId, 'running');
  return run.id;
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: crypto.randomUUID(), name, arguments: args };
}

function write(target: string, content = 'fixture content', id = crypto.randomUUID()): ToolCall {
  return { id, name: 'write_file', arguments: { path: target, content } };
}

function reviewRecord(verdict: ToolReviewRecord['verdict'], reason: string, overrides: Partial<ToolReviewRecord> = {}): ToolReviewRecord {
  return {
    verdict, reviewer: 'tool-reviewer:fixture', reviewerModelId: 'fixture-reviewer', risk: 'high', reason,
    checks: [{ label: 'bounded_scope', ok: verdict === 'pass' }], durationMs: 12, ...overrides,
  };
}

/** Read intent_reviews directly: whether a verdict row is executable authority is not exposed by the public API. */
function reviewRowCount(f: Fixture, intentId: string): number {
  const db = new DatabaseSync(path.join(f.directory, 'kernel.sqlite'));
  try { return Number(db.prepare('SELECT COUNT(*) AS count FROM intent_reviews WHERE intent_id=?').get(intentId)?.count ?? 0); }
  finally { db.close(); }
}

test('the exported policy table is exactly the frontend four-mode decision table', () => {
  const expected: Record<PermissionMode, Record<RiskLevel, PolicyOutcome>> = {
    'read-only': { low: 'deny', medium: 'deny', high: 'deny', critical: 'deny' },
    ask: { low: 'ask', medium: 'ask', high: 'ask', critical: 'ask' },
    'auto-review': { low: 'allow', medium: 'review', high: 'review', critical: 'review' },
    'full-access': { low: 'allow', medium: 'allow', high: 'allow', critical: 'ask' },
  };
  for (const mode of MODES) {
    for (const risk of RISKS) {
      assert.equal(decide(mode, 'read', risk), 'allow', 'reads are always readable: ' + mode + '/' + risk);
      for (const capability of NON_READ) {
        assert.equal(decide(mode, capability, risk), expected[mode][risk], mode + '/' + capability + '/' + risk);
      }
    }
  }
  for (const mode of MODES) {
    for (const risk of RISKS) {
      assert.equal(decideForMode('chat', mode, 'read', risk), 'allow');
      assert.equal(decideForMode('chat', mode, 'network', risk), 'allow');
      for (const capability of ['write', 'exec', 'mcp'] as PolicyCapability[]) {
        assert.equal(decideForMode('chat', mode, capability, risk), capability === 'mcp' && risk === 'low' ? 'allow' : 'deny', 'Chat only permits the low-risk MCP adapter');
      }
      for (const capability of ['read', 'write', 'exec', 'network', 'mcp'] as PolicyCapability[]) {
        assert.equal(decideForMode('work', mode, capability, risk), decide(mode, capability, risk));
      }
    }
  }
  assert.equal(reviewEscalates('low', 'medium'), false);
  assert.equal(reviewEscalates('medium', 'medium'), true);
  assert.equal(reviewEscalates('high', 'high'), true);
  assert.equal(reviewEscalates('critical', 'high'), true);
  assert.equal(reviewEscalates('high', 'critical'), false);
});

test('the kernel enforces the table per mode and snapshots the decision on every intent', t => {
  const f = fixture(t);
  const specimens: { name: string; args: Record<string, unknown>; capability: PolicyCapability; risk: RiskLevel }[] = [
    { name: 'read_file', args: { path: 'notes.txt' }, capability: 'read', risk: 'low' },
    { name: 'write_file', args: { path: 'notes.txt', content: 'x' }, capability: 'write', risk: 'high' },
    { name: 'run_command', args: { executable: 'node', args: ['--version'] }, capability: 'exec', risk: 'high' },
    { name: 'run_shell', args: { command: 'echo fixture' }, capability: 'exec', risk: 'critical' },
    { name: 'web_search', args: { query: 'fixture' }, capability: 'network', risk: 'low' },
    { name: 'mcp_call', args: { serverId: 'fixture', toolName: 'echo', arguments: {} }, capability: 'mcp', risk: 'high' },
  ];
  for (const mode of MODES) {
    const task = create(f, { permissionMode: mode });
    assert.equal(task.permissionMode, mode);
    assert.equal(task.appMode, 'work');
    assert.equal(f.kernel.permissionMode(task.id), mode);
    const runId = start(f, task.id);
    for (const specimen of specimens) {
      const outcome = table(mode, specimen.capability, specimen.risk);
      if (outcome === 'deny') {
        assert.throws(() => f.kernel.prepareIntent(task.id, runId, call(specimen.name, specimen.args)), expectCode('PERMISSION_DENIED'), mode + ':' + specimen.name);
        continue;
      }
      const intent = f.kernel.prepareIntent(task.id, runId, call(specimen.name, specimen.args));
      const authorization = intent.authorization;
      assert.ok(authorization, 'every prepared intent snapshots its authorization');
      assert.equal(authorization.tool, specimen.name);
      assert.equal(authorization.mode, mode);
      assert.equal(authorization.appMode, 'work');
      assert.equal(authorization.capability, specimen.capability);
      assert.equal(authorization.risk, specimen.risk);
      assert.equal(authorization.decision, outcome);
      assert.equal(authorization.workspace, task.workspace);
      assert.equal(typeof authorization.reason, 'string');
      assert.ok(authorization.reason.length > 0);
      const event = f.kernel.events(task.id).find(item => item.type === 'intent.prepared' && item.payload.intentId === intent.id)!;
      assert.equal(event.payload.decision, outcome);
      assert.equal(event.payload.risk, specimen.risk);
      assert.equal(event.payload.mode, mode);
      assert.equal(event.payload.appMode, 'work');
    }
  }
});

test('read-only denies write, exec, network and MCP with nothing approvable, while reads still pass', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'read-only' });
  const runId = start(f, task.id);
  const denied: ToolCall[] = [
    write('notes.txt'),
    call('run_command', { executable: 'node', args: ['--version'] }),
    call('run_shell', { command: 'echo denied' }),
    call('fixture_increment', { amount: 1 }),
    call('web_search', { query: 'denied' }),
    call('mcp_call', { serverId: 'srv', toolName: 'tool', arguments: {} }),
  ];
  for (const deniedCall of denied) {
    assert.throws(() => f.kernel.prepareIntent(task.id, runId, deniedCall), expectCode('PERMISSION_DENIED'));
  }
  assert.equal(f.kernel.intents(task.id).length, 0, 'a deny decision must leave no approvable intent row');
  assert.equal(f.kernel.events(task.id).filter(event => event.type === 'intent.prepared').length, 0);
  const read = f.kernel.prepareIntent(task.id, runId, call('read_file', { path: 'notes.txt' }));
  assert.equal(read.authorization!.decision, 'allow');
});

test('ask mode needs an individual operator approval for every effect', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'ask' });
  const runId = start(f, task.id);
  const intent = f.kernel.prepareIntent(task.id, runId, write('approved.txt'));
  assert.equal(intent.authorization!.decision, 'ask');
  for (const source of ['policy', 'review', 'session'] as const) {
    assert.throws(() => f.kernel.approve(intent.id, { source }), expectCode('OPERATOR_APPROVAL_REQUIRED'), source);
  }
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'prepared');
  const approved = f.kernel.approve(intent.id);
  assert.equal(approved.state, 'approved');
  assert.equal(f.kernel.approve(intent.id).state, 'approved', 're-approving stays idempotent');
  f.kernel.dispatch(intent.id);
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'sent');
  const next = f.kernel.prepareIntent(task.id, runId, write('approved.txt', 'again'));
  assert.equal(next.authorization!.decision, 'ask', 'a once approval never becomes a standing permission');
  assert.equal(next.authorization!.grantId, undefined);
});

test('full-access allows ordinary work but a critical effect still needs the human', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'full-access' });
  const runId = start(f, task.id);
  const writeIntent = f.kernel.prepareIntent(task.id, runId, write('free.txt'));
  assert.equal(writeIntent.authorization!.decision, 'allow');
  f.kernel.approve(writeIntent.id, { source: 'policy' });
  f.kernel.dispatch(writeIntent.id);
  const critical = f.kernel.prepareIntent(task.id, runId, call('run_shell', { command: 'echo critical' }));
  assert.equal(critical.authorization!.risk, 'critical');
  assert.equal(critical.authorization!.decision, 'ask');
  assert.throws(() => f.kernel.approve(critical.id, { source: 'review' }), expectCode('OPERATOR_APPROVAL_REQUIRED'));
  assert.throws(() => f.kernel.approve(critical.id, { source: 'operator', scope: 'session' }), expectCode('SESSION_GRANT_FORBIDDEN'));
  f.kernel.approve(critical.id);
  f.kernel.dispatch(critical.id);
  assert.equal(f.kernel.getIntent(critical.id)!.state, 'sent');
});

test('auto review allows low risk, reviews higher risk, and records pass, escalate or block as real events', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'auto-review' });
  const runId = start(f, task.id);
  const low = f.kernel.prepareIntent(task.id, runId, call('fixture_increment', { amount: 1 }));
  assert.equal(low.authorization!.decision, 'allow');
  f.kernel.approve(low.id, { source: 'policy' });
  f.kernel.dispatch(low.id);

  const reviewed = f.kernel.prepareIntent(task.id, runId, write('reviewed.txt'));
  assert.equal(reviewed.authorization!.decision, 'review');
  assert.throws(() => f.kernel.approve(reviewed.id, { source: 'policy' }), expectCode('REVIEW_REQUIRED'));
  assert.throws(() => f.kernel.approve(reviewed.id, { source: 'review' }), expectCode('REVIEW_REQUIRED'));
  assert.throws(() => f.kernel.approve(reviewed.id), expectCode('REVIEW_REQUIRED'));
  const invalid: unknown[] = [
    reviewRecord('maybe' as ToolReviewRecord['verdict'], 'invalid verdict'),
    reviewRecord('pass', 'wrong risk', { risk: 'low' }),
    reviewRecord('pass', 'malformed checks', { checks: 'nope' as unknown as ToolReviewRecord['checks'] }),
    reviewRecord('pass', 'negative duration', { durationMs: -1 }),
    reviewRecord('pass', 'blank reviewer', { reviewer: '  ' }),
  ];
  for (const record of invalid) assert.throws(() => f.kernel.recordToolReview(reviewed.id, record as ToolReviewRecord), expectCode('INVALID_REVIEW'));
  assert.equal(f.kernel.getIntent(reviewed.id)!.authorization!.decision, 'review');
  assert.throws(() => f.kernel.recordToolReview(low.id, reviewRecord('pass', 'not under review')), expectCode('INVALID_INTENT_STATE'));

  const escalated = f.kernel.recordToolReview(reviewed.id, reviewRecord('escalate', 'needs a human decision'));
  assert.equal(escalated.authorization!.decision, 'ask');
  assert.equal(escalated.authorization!.review!.verdict, 'escalate');
  assert.ok(f.kernel.events(task.id).some(event => event.type === 'intent.review_escalated' && event.payload.intentId === reviewed.id));
  assert.throws(() => f.kernel.approve(reviewed.id, { source: 'policy' }), expectCode('OPERATOR_APPROVAL_REQUIRED'));
  f.kernel.approve(reviewed.id);
  f.kernel.dispatch(reviewed.id);

  const passing = f.kernel.prepareIntent(task.id, runId, write('passed.txt'));
  const passed = f.kernel.recordToolReview(passing.id, reviewRecord('pass', 'bounded to the workspace'));
  assert.equal(passed.authorization!.decision, 'review', 'a pass keeps the review decision; the review source approves it');
  assert.ok(f.kernel.events(task.id).some(event => event.type === 'intent.reviewed' && event.payload.verdict === 'pass' && event.payload.reviewer === 'tool-reviewer:fixture'));
  f.kernel.approve(passing.id, { source: 'review' });
  f.kernel.dispatch(passing.id);

  const blocking = f.kernel.prepareIntent(task.id, runId, write('blocked.txt'));
  const blocked = f.kernel.recordToolReview(blocking.id, reviewRecord('block', 'destructive request'));
  assert.equal(blocked.state, 'denied');
  assert.ok(f.kernel.events(task.id).some(event => event.type === 'intent.review_blocked' && event.payload.intentId === blocking.id));
  assert.ok(f.kernel.events(task.id).some(event => event.type === 'intent.denied' && event.payload.intentId === blocking.id));
});

test('direct approve and dispatch cannot bypass a narrowed policy', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'read-only' });
  const runId = start(f, task.id);
  assert.throws(() => f.kernel.prepareIntent(task.id, runId, write('guarded.txt')), expectCode('PERMISSION_DENIED'));
  f.kernel.setPermission(task.id, { permissionMode: 'auto-review' });
  const reviewedRun = start(f, task.id);
  const intent = f.kernel.prepareIntent(task.id, reviewedRun, write('guarded.txt'));
  assert.equal(intent.authorization!.decision, 'review');
  f.kernel.recordToolReview(intent.id, reviewRecord('pass', 'bounded'));
  f.kernel.approve(intent.id, { source: 'review' });
  f.kernel.setPermission(task.id, { permissionMode: 'read-only', reason: 'operator narrowed the policy again' });
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'denied');
  assert.throws(() => f.kernel.dispatch(intent.id), expectCode('STALE_GENERATION'));
  const deniedRun = start(f, task.id);
  assert.throws(() => f.kernel.prepareIntent(task.id, deniedRun, write('guarded.txt')), expectCode('PERMISSION_DENIED'));
});

test('a session grant authorizes only the identical tool, capability and resources', t => {
  const f = fixture(t);
  const task = create(f);
  const runId = start(f, task.id);
  const first = f.kernel.prepareIntent(task.id, runId, write('granted.txt', 'one'));
  assert.equal(first.authorization!.decision, 'ask');
  f.kernel.approve(first.id, { source: 'operator', scope: 'session' });
  const state = f.kernel.permissionState(task.id);
  assert.equal(state.mode, 'ask');
  assert.equal(state.appMode, 'work');
  assert.equal(state.policyEpoch, f.kernel.getTask(task.id)!.policyEpoch);
  assert.equal(state.grants.length, 1);
  assert.equal(state.grants[0]!.tool, 'write_file');
  assert.equal(state.grants[0]!.policyEpoch, state.policyEpoch);
  assert.deepEqual(state.grants[0]!.resources, [path.resolve(task.workspace, 'granted.txt')]);

  const again = f.kernel.prepareIntent(task.id, runId, write('granted.txt', 'one'));
  assert.notEqual(again.id, first.id);
  assert.equal(again.authorization!.decision, 'allow');
  assert.equal(again.authorization!.grantId, state.grants[0]!.id);
  f.kernel.approve(again.id, { source: 'policy' });
  f.kernel.dispatch(again.id);

  const other = f.kernel.prepareIntent(task.id, runId, write('different.txt', 'one'));
  assert.equal(other.authorization!.decision, 'ask', 'a different file still asks');
  assert.equal(other.authorization!.grantId, undefined);
  assert.notEqual(other.digest, first.digest);
  const shell = f.kernel.prepareIntent(task.id, runId, call('run_shell', { command: 'echo same workspace' }));
  assert.equal(shell.authorization!.decision, 'ask', 'a different tool is not covered by the grant');
});

test('once approvals never create grants and session grants are forbidden for critical or protected tools', t => {
  const f = fixture(t);
  const task = create(f);
  const runId = start(f, task.id);
  const once = f.kernel.prepareIntent(task.id, runId, write('once.txt'));
  f.kernel.approve(once.id, { source: 'operator', scope: 'once' });
  assert.equal(f.kernel.permissionState(task.id).grants.length, 0);
  assert.equal(f.kernel.prepareIntent(task.id, runId, write('once.txt')).authorization!.decision, 'ask');
  const critical = f.kernel.prepareIntent(task.id, runId, call('run_shell', { command: 'echo critical' }));
  assert.throws(() => f.kernel.approve(critical.id, { source: 'operator', scope: 'session' }), expectCode('SESSION_GRANT_FORBIDDEN'));
  assert.equal(f.kernel.getIntent(critical.id)!.state, 'prepared');
  const plugin = f.kernel.prepareIntent(task.id, runId, call('plugin_transform', { pluginId: 'fixture', operationId: 'echo', input: 'x' }));
  assert.equal(plugin.authorization!.risk, 'high');
  assert.throws(() => f.kernel.approve(plugin.id, { source: 'operator', scope: 'session' }), expectCode('SESSION_GRANT_FORBIDDEN'));
  const mcp = f.kernel.prepareIntent(task.id, runId, call('mcp_call', { serverId: 'srv', toolName: 'tool', arguments: {} }));
  assert.throws(() => f.kernel.approve(mcp.id, { source: 'operator', scope: 'session' }), expectCode('SESSION_GRANT_FORBIDDEN'));
  assert.throws(() => f.kernel.approve(once.id, { source: 'policy', scope: 'session' }), expectCode('OPERATOR_APPROVAL_REQUIRED'));
  assert.equal(f.kernel.permissionState(task.id).grants.length, 0);
});

test('session grants die with a mode change, a goal revision, a ceiling change or a revoke', t => {
  const f = fixture(t);
  const grantOn = (task: Task, content: string): void => {
    const runId = start(f, task.id);
    const intent = f.kernel.prepareIntent(task.id, runId, write('epoch.txt', content));
    f.kernel.approve(intent.id, { source: 'operator', scope: 'session' });
    assert.equal(f.kernel.permissionState(task.id).grants.length, 1);
  };
  const modeTask = create(f);
  grantOn(modeTask, 'mode');
  f.kernel.setPermission(modeTask.id, { permissionMode: 'ask', reason: 'policy refresh' });
  assert.equal(f.kernel.permissionState(modeTask.id).grants.length, 0);
  assert.equal(f.kernel.prepareIntent(modeTask.id, start(f, modeTask.id), write('epoch.txt', 'mode')).authorization!.decision, 'ask');

  const revisionTask = create(f);
  grantOn(revisionTask, 'revision');
  f.kernel.command({ commandId: crypto.randomUUID(), type: 'revise_goal', origin: 'operator', taskId: revisionTask.id, parameters: { goal: { objective: 'Revised permission objective' }, reason: 'operator revised the goal' } });
  assert.equal(f.kernel.permissionState(revisionTask.id).grants.length, 0);

  const revokeTask = create(f);
  grantOn(revokeTask, 'revoke');
  f.kernel.revoke(revokeTask.id);
  assert.equal(f.kernel.permissionState(revokeTask.id).grants.length, 0);

  const ceilingTask = create(f);
  grantOn(ceilingTask, 'ceiling');
  f.kernel.setCapabilityCeiling(ceilingTask.id, ['workspace.read', 'workspace.write']);
  assert.equal(f.kernel.permissionState(ceilingTask.id).grants.length, 0);
});

test('a parent permission change fences descendants, bumps their epochs and revokes their grants', t => {
  const f = fixture(t);
  const parent = create(f, { permissionMode: 'full-access' });
  const child = delegate(f, parent.id, { objective: 'Child under full access', paths: ['child'] });
  assert.equal(f.kernel.permissionMode(child.id), 'full-access', 'a child inherits the parent mode until narrowed');
  const childRun = start(f, child.id);
  const intent = f.kernel.prepareIntent(child.id, childRun, write('child.txt'));
  assert.equal(intent.authorization!.decision, 'allow');
  f.kernel.approve(intent.id, { source: 'operator', scope: 'session' });
  assert.equal(f.kernel.permissionState(child.id).grants.length, 1);
  const before = f.kernel.getTask(child.id)!;
  f.kernel.setPermission(parent.id, { permissionMode: 'ask', reason: 'operator narrowed the parent' });
  const after = f.kernel.getTask(child.id)!;
  assert.ok(after.policyEpoch > before.policyEpoch);
  assert.ok(after.generation > before.generation);
  assert.equal(f.kernel.permissionMode(child.id), 'ask');
  assert.equal(f.kernel.permissionState(child.id).grants.length, 0);
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'denied');
  assert.throws(() => f.kernel.dispatch(intent.id), expectCode('STALE_GENERATION'));
});

test('restart keeps durable modes but never revives grants or approvals', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'ask' });
  const runId = start(f, task.id);
  const granted = f.kernel.prepareIntent(task.id, runId, write('persist.txt', 'one'));
  f.kernel.approve(granted.id, { source: 'operator', scope: 'session' });
  assert.equal(f.kernel.permissionState(task.id).grants.length, 1);
  const applied = f.kernel.prepareIntent(task.id, runId, call('fixture_increment', { amount: 1 }));
  f.kernel.approve(applied.id);
  f.kernel.dispatch(applied.id);
  f.kernel.receipt(applied.id, { fixtureValue: 1 });
  const approvedOnly = f.kernel.prepareIntent(task.id, runId, write('pending.txt'));
  f.kernel.approve(approvedOnly.id);
  const dispatched = f.kernel.prepareIntent(task.id, runId, call('fixture_increment', { amount: 2 }));
  f.kernel.approve(dispatched.id);
  f.kernel.dispatch(dispatched.id);

  f.reopen();
  assert.equal(f.kernel.permissionMode(task.id), 'ask', 'the durable task body restores its mode');
  assert.equal(f.kernel.permissionState(task.id).grants.length, 0, 'session grants die with the process');
  const recovery = f.kernel.recover();
  assert.ok(recovery.unknownIntents.includes(dispatched.id));
  assert.equal(f.kernel.getIntent(applied.id)!.state, 'applied', 'an applied effect is never replayed');
  assert.equal(f.kernel.getIntent(approvedOnly.id)!.state, 'denied', 'a pre-restart approval is never reused');
  assert.equal(f.kernel.getIntent(dispatched.id)!.state, 'unknown');
  assert.equal(f.kernel.getTask(task.id)!.status, 'reconciling');
  assert.throws(() => f.kernel.dispatch(approvedOnly.id), expectCode('STALE_GENERATION'));
  f.kernel.reconcile(dispatched.id, { fixtureValue: 2 });
  const nextRun = start(f, task.id);
  const repeat = f.kernel.prepareIntent(task.id, nextRun, write('persist.txt', 'one'));
  assert.equal(repeat.authorization!.decision, 'ask', 'an old grant never authorizes a new process');
  assert.equal(repeat.authorization!.grantId, undefined);
});

test('restart strips recorded reviews so the old artifact cannot be approved', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'auto-review' });
  const runId = start(f, task.id);
  const reviewed = f.kernel.prepareIntent(task.id, runId, write('reviewed-persist.txt'));
  f.kernel.recordToolReview(reviewed.id, reviewRecord('pass', 'bounded to the workspace'));
  f.reopen();
  const after = f.kernel.getIntent(reviewed.id)!;
  assert.equal(after.authorization!.review, undefined, 'a review verdict is process authority, not durable state');
  assert.throws(() => f.kernel.approve(reviewed.id, { source: 'review' }), expectCode('REVIEW_REQUIRED'));
});

test('restart strips an executable review and its binding row, never reviving approval', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'auto-review' });
  const runId = start(f, task.id);
  const reviewed = f.kernel.prepareIntent(task.id, runId, write('executable-review.txt'));
  const recorded = f.kernel.recordToolReview(reviewed.id, reviewRecord('pass', 'bounded to the workspace', { requestId: 'executable-review-request' }));
  assert.equal(recorded.authorization!.review!.requestId, 'executable-review-request');
  f.reopen();
  const after = f.kernel.getIntent(reviewed.id)!;
  assert.equal(after.state, 'prepared');
  assert.equal(after.authorization!.review, undefined, 'a prepared review is process authority, not durable evidence');
  assert.equal(reviewRowCount(f, reviewed.id), 0, 'the executable review row dies with the process too');
  assert.throws(() => f.kernel.approve(reviewed.id, { source: 'review' }), expectCode('REVIEW_REQUIRED'));
  assert.throws(() => f.kernel.approve(reviewed.id), expectCode('REVIEW_REQUIRED'));
});

test('restart keeps a completed review as durable evidence while re-execution stays impossible', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'auto-review' });
  const runId = start(f, task.id);
  const applied = f.kernel.prepareIntent(task.id, runId, write('completed-review.txt'));
  const recorded = f.kernel.recordToolReview(applied.id, reviewRecord('pass', 'completed historical decision', { requestId: 'historical-review-request' }));
  f.kernel.approve(applied.id, { source: 'review' });
  f.kernel.dispatch(applied.id);
  f.kernel.receipt(applied.id, { fixtureValue: 1 });
  f.reopen();
  const historical = f.kernel.getIntent(applied.id)!;
  assert.equal(historical.state, 'applied');
  assert.deepEqual(historical.authorization!.review, recorded.authorization!.review, 'a completed decision keeps every review detail');
  assert.equal(historical.authorization!.review!.requestId, 'historical-review-request');
  assert.equal(historical.authorization!.review!.reviewerModelId, 'fixture-reviewer');
  assert.deepEqual(historical.authorization!.review!.checks, [{ label: 'bounded_scope', ok: true }]);
  assert.equal(reviewRowCount(f, applied.id), 1, 'a terminal review row survives the startup cleanup');
  assert.throws(() => f.kernel.approve(applied.id, { source: 'review' }), expectCode('INVALID_INTENT_STATE'));
  assert.throws(() => f.kernel.dispatch(applied.id), expectCode('INVALID_INTENT_STATE'));
  assert.equal(f.kernel.getIntent(applied.id)!.state, 'applied', 'an applied effect is never re-executed');
});

test('restart keeps a blocking verdict as deny evidence and still refuses the effect', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'auto-review' });
  const runId = start(f, task.id);
  const blocked = f.kernel.prepareIntent(task.id, runId, write('blocked-review.txt'));
  assert.equal(f.kernel.recordToolReview(blocked.id, reviewRecord('block', 'destructive request', { requestId: 'historical-block-request' })).state, 'denied');
  f.reopen();
  const historical = f.kernel.getIntent(blocked.id)!;
  assert.equal(historical.state, 'denied');
  assert.equal(historical.authorization!.review!.verdict, 'block');
  assert.equal(historical.authorization!.review!.reason, 'destructive request');
  assert.equal(historical.authorization!.review!.requestId, 'historical-block-request');
  assert.equal(reviewRowCount(f, blocked.id), 1, 'a terminal block keeps its review row');
  assert.throws(() => f.kernel.approve(blocked.id), expectCode('POLICY_DENY'));
  assert.throws(() => f.kernel.dispatch(blocked.id), expectCode('INVALID_INTENT_STATE'));
});

test('one startup cleanup strips the prepared review and keeps the applied review in the same database', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'auto-review' });
  const runId = start(f, task.id);
  const completed = f.kernel.prepareIntent(task.id, runId, write('mixed-completed.txt'));
  f.kernel.recordToolReview(completed.id, reviewRecord('pass', 'completed effect', { requestId: 'mixed-completed-request' }));
  f.kernel.approve(completed.id, { source: 'review' });
  f.kernel.dispatch(completed.id);
  f.kernel.receipt(completed.id, { fixtureValue: 1 });
  const pending = f.kernel.prepareIntent(task.id, runId, write('mixed-pending.txt'));
  f.kernel.recordToolReview(pending.id, reviewRecord('pass', 'pending effect', { requestId: 'mixed-pending-request' }));
  f.reopen();
  const kept = f.kernel.getIntent(completed.id)!;
  const stripped = f.kernel.getIntent(pending.id)!;
  assert.equal(kept.state, 'applied');
  assert.equal(kept.authorization!.review!.requestId, 'mixed-completed-request', 'the terminal record keeps its review');
  assert.equal(stripped.state, 'prepared');
  assert.equal(stripped.authorization!.review, undefined, 'the executable record loses its review');
  assert.equal(reviewRowCount(f, completed.id), 1);
  assert.equal(reviewRowCount(f, pending.id), 0);
  assert.throws(() => f.kernel.dispatch(kept.id), expectCode('INVALID_INTENT_STATE'));
  assert.throws(() => f.kernel.approve(stripped.id, { source: 'review' }), expectCode('REVIEW_REQUIRED'));
});

test('children may only inherit or narrow and model-origin commands cannot widen anything', t => {
  const f = fixture(t);
  const fullParent = create(f, { permissionMode: 'full-access' });
  const inherited = delegate(f, fullParent.id, { objective: 'Inheriting child', paths: ['inherit'] });
  assert.equal(inherited.permissionMode, 'full-access');
  const narrowed = delegate(f, fullParent.id, { objective: 'Narrowed child', paths: ['narrow'], permissionMode: 'ask' });
  assert.equal(f.kernel.permissionMode(narrowed.id), 'ask');
  const strictParent = create(f, { permissionMode: 'ask' });
  assert.throws(() => f.kernel.command({
    commandId: crypto.randomUUID(), type: 'delegate', taskId: strictParent.id,
    parameters: { objective: 'Escalating child', paths: ['escalate'], permissionMode: 'full-access' },
  }), expectCode('PERMISSION_ESCALATION'));
  assert.equal(f.kernel.delegations(strictParent.id).length, 0, 'a rejected escalation creates no child');
  const modelChild = delegate(f, strictParent.id, { objective: 'Model child', paths: ['model'], permissionMode: 'full-access', appMode: 'code' }, 'model');
  assert.equal(f.kernel.permissionMode(modelChild.id), 'ask', 'model-origin permission fields are ignored');
  assert.equal(f.kernel.appMode(modelChild.id), 'work');
  const taskCount = f.kernel.listTasks().length;
  assert.throws(() => create(f, { permissionMode: 'full-access', appMode: 'chat' }, 'model'), expectCode('OPERATOR_REQUIRED'));
  assert.equal(f.kernel.listTasks().length, taskCount, 'a model root request creates no task at all');
  assert.throws(() => f.kernel.command({ commandId: crypto.randomUUID(), type: 'delegate', origin: 'model', parameters: { objective: 'Parentless model delegation' } }), expectCode('TASK_REQUIRED'));
  assert.equal(f.kernel.listTasks().length, taskCount);
  assert.throws(() => f.kernel.command({ commandId: crypto.randomUUID(), type: 'set_permission', origin: 'model', taskId: strictParent.id, parameters: { permissionMode: 'full-access' } }), expectCode('OPERATOR_REQUIRED'));
  assert.equal(f.kernel.permissionMode(strictParent.id), 'ask');
  const ceilingParent = create(f, { permissionMode: 'ask' });
  const ceilingChild = delegate(f, ceilingParent.id, { objective: 'Ceiling child', paths: ['ceiling'] });
  f.kernel.setCapabilityCeiling(ceilingParent.id, ['workspace.read']);
  assert.deepEqual(f.kernel.getCapabilityCeiling(ceilingChild.id), ['workspace.read']);
});

test('a model may only delegate under its parent and inherits the parent budget, workspace and ceiling', t => {
  const f = fixture(t);
  const parent = create(f, { permissionMode: 'auto-review', goal: { objective: 'Budget parent', maxModelCalls: 7, maxToolCalls: 9 } });
  f.kernel.setCapabilityCeiling(parent.id, ['workspace.read', 'workspace.write']);
  const before = { task: f.kernel.getTask(parent.id)!, budget: f.kernel.getBudgets(parent.id) };
  const ack = f.kernel.command({
    commandId: crypto.randomUUID(), type: 'create_task', origin: 'model', taskId: parent.id,
    parameters: {
      objective: 'Model child', permissionMode: 'full-access', appMode: 'chat',
      workspace: path.dirname(parent.workspace), maxModelCalls: 500, maxToolCalls: 500,
    },
  });
  const child = f.kernel.getTask(ack.taskId!)!;
  assert.equal(child.parentId, parent.id, 'a model task is a delegate of the task it runs');
  assert.equal(f.kernel.getBudgets(child.id).maxModelCalls, 7, 'the model cannot raise the inherited model budget');
  assert.equal(f.kernel.getBudgets(child.id).maxToolCalls, 9, 'the model cannot raise the inherited tool budget');
  assert.deepEqual(f.kernel.getBudgets(parent.id), before.budget, 'delegating never resets the parent budget');
  assert.equal(f.kernel.getTask(parent.id)!.workspace, before.task.workspace, 'delegating never moves the parent workspace');
  assert.equal(f.kernel.getTask(parent.id)!.permissionMode, before.task.permissionMode);
  assert.ok(!path.relative(parent.workspace, child.workspace).startsWith('..'), 'a model child stays inside the parent workspace');
  assert.equal(f.kernel.permissionMode(child.id), 'auto-review', 'model permission fields are ignored');
  assert.equal(f.kernel.appMode(child.id), 'work');
  assert.deepEqual(f.kernel.getCapabilityCeiling(child.id), ['workspace.read', 'workspace.write']);
  assert.equal(f.kernel.delegations(parent.id).at(-1)!.childTaskId, child.id);
});

test('a narrowed ceiling cannot be escaped by borrowing a sibling fixture capability', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'full-access' });
  f.kernel.setCapabilityCeiling(task.id, ['workspace.read', 'fixture.write']);
  const runId = start(f, task.id);
  assert.throws(() => f.kernel.prepareIntent(task.id, runId, write('borrow.txt'), { capability: 'fixture.write' }), expectCode('PERMISSION_DENIED'));
  assert.throws(() => f.kernel.prepareIntent(task.id, runId, write('borrow.txt')), expectCode('CAPABILITY_DENIED'));
  assert.equal(f.kernel.intents(task.id).length, 0, 'neither rejection leaves an approvable intent');
  const fixtureEffect = f.kernel.prepareIntent(task.id, runId, call('fixture_increment', { amount: 1 }));
  assert.equal(fixtureEffect.authorization!.capability, 'write');
  assert.equal(fixtureEffect.authorization!.decision, 'allow');
});

test('a passing review is bound to its digest and generation and never survives a rebind', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'auto-review' });
  const runId = start(f, task.id);
  const intent = f.kernel.prepareIntent(task.id, runId, write('reviewed-rebind.txt'));
  f.kernel.recordToolReview(intent.id, reviewRecord('pass', 'bounded to the workspace'));
  f.kernel.approve(intent.id, { source: 'review' });
  const recovery = f.kernel.recover();
  assert.ok(recovery.requeued.includes(task.id));
  const rebound = f.kernel.rebindIntent(intent.id, start(f, task.id));
  assert.equal(rebound.state, 'prepared');
  assert.equal(rebound.authorization!.review, undefined, 'the old verdict never travels to the new digest');
  assert.throws(() => f.kernel.approve(intent.id, { source: 'review' }), expectCode('REVIEW_REQUIRED'));
});

test('revocation between approval and dispatch invalidates the standing grant', t => {
  const f = fixture(t);
  const task = create(f);
  const runId = start(f, task.id);
  const first = f.kernel.prepareIntent(task.id, runId, write('grant-race.txt', 'one'));
  f.kernel.approve(first.id, { source: 'operator', scope: 'session' });
  const second = f.kernel.prepareIntent(task.id, runId, write('grant-race.txt', 'one'));
  assert.ok(second.authorization!.grantId, 'a matching grant allows the repeated effect');
  f.kernel.approve(second.id, { source: 'policy' });
  f.kernel.revokeSessionGrants(task.id);
  assert.throws(() => f.kernel.dispatch(second.id), expectCode('APPROVAL_STALE'));
});

test('deny forever blocks approval and a post-dispatch revoke forces an unknown effect', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'full-access' });
  const runId = start(f, task.id);
  const denied = f.kernel.prepareIntent(task.id, runId, write('denied-once.txt'));
  f.kernel.deny(denied.id);
  assert.equal(f.kernel.getIntent(denied.id)!.state, 'denied');
  assert.throws(() => f.kernel.approve(denied.id), expectCode('INVALID_INTENT_STATE'));
  const sent = f.kernel.prepareIntent(task.id, runId, write('revoked-after-dispatch.txt'));
  f.kernel.approve(sent.id, { source: 'policy' });
  f.kernel.dispatch(sent.id);
  assert.equal(f.kernel.getIntent(sent.id)!.state, 'sent');
  f.kernel.revoke(task.id);
  assert.equal(f.kernel.getIntent(sent.id)!.state, 'unknown');
  assert.equal(f.kernel.getTask(task.id)!.status, 'reconciling');
  assert.throws(() => f.kernel.dispatch(sent.id), expectCode('STALE_GENERATION'));
});

test('Chat app mode keeps only reads and network retrieval, including for delegated children', t => {
  const f = fixture(t);
  const task = create(f, { appMode: 'chat', permissionMode: 'full-access' });
  assert.equal(task.appMode, 'chat');
  assert.equal(task.permissionMode, 'read-only', 'Chat forces read-only');
  assert.equal(f.kernel.appMode(task.id), 'chat');
  assert.equal(f.kernel.permissionMode(task.id), 'read-only');
  const runId = start(f, task.id);
  const read = f.kernel.prepareIntent(task.id, runId, call('read_file', { path: 'notes.txt' }));
  assert.equal(read.authorization!.decision, 'allow');
  const search = f.kernel.prepareIntent(task.id, runId, call('web_search', { query: 'chat' }));
  assert.equal(search.authorization!.decision, 'allow');
  for (const deniedCall of [write('chat.txt'), call('run_command', { executable: 'node', args: ['--version'] }), call('run_shell', { command: 'echo chat' }), call('mcp_call', { serverId: 'srv', toolName: 'tool', arguments: {} })]) {
    assert.throws(() => f.kernel.prepareIntent(task.id, runId, deniedCall), expectCode('PERMISSION_DENIED'));
  }
  const child = delegate(f, task.id, { objective: 'Chat child', paths: ['chat-child'] });
  assert.equal(f.kernel.appMode(child.id), 'chat');
  assert.equal(f.kernel.permissionMode(child.id), 'read-only');
  const childRun = start(f, child.id);
  assert.throws(() => f.kernel.prepareIntent(child.id, childRun, write('child-chat.txt')), expectCode('PERMISSION_DENIED'));
});

test('protected paths and workspace escapes stay rejected in every permission mode', t => {
  const f = fixture(t);
  const protectedPaths = ['.env', 'api.txt', '.git/config', 'credentials.json', 'secrets/keys.txt', '.tmp/state.json', 'node_modules/module.js', 'id_rsa', 'sub/.aws/credentials'];
  for (const mode of MODES) {
    const task = create(f, { permissionMode: mode });
    const runId = start(f, task.id);
    for (const target of protectedPaths) {
      const relative = target.replaceAll('/', path.sep);
      assert.throws(() => f.kernel.prepareIntent(task.id, runId, write(relative)), expectCode('PERMISSION_DENIED'), mode + ':' + target);
    }
    assert.throws(() => f.kernel.prepareIntent(task.id, runId, call('read_file', { path: '.env' })), expectCode('PERMISSION_DENIED'), mode + ':read .env');
    assert.throws(() => f.kernel.prepareIntent(task.id, runId, write('..' + path.sep + 'escaped.txt')), expectCode('OUTSIDE_WORKSPACE'), mode + ':escape');
    assert.equal(f.kernel.intents(task.id).length, 0);
  }
  const full = create(f, { permissionMode: 'full-access' });
  const fullRun = start(f, full.id);
  assert.equal(f.kernel.prepareIntent(full.id, fullRun, write('output.txt')).authorization!.decision, 'allow', 'full access still writes ordinary workspace paths');
});

test('unknown tools and spoofed capabilities fail closed before an intent exists', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'full-access' });
  const runId = start(f, task.id);
  assert.throws(() => f.kernel.prepareIntent(task.id, runId, call('delete_everything', {})), expectCode('PERMISSION_DENIED'));
  for (const capability of ['workspace.read', 'process.exec', 'fs.write', 'read', 'workspace.write ']) {
    assert.throws(() => f.kernel.prepareIntent(task.id, runId, write('spoof.txt'), { capability }), expectCode('PERMISSION_DENIED'), capability);
  }
  assert.throws(() => f.kernel.prepareIntent(task.id, runId, call('run_shell', { command: 'echo spoof' }), { capability: 'workspace.write' }), expectCode('PERMISSION_DENIED'));
  assert.throws(() => f.kernel.prepareIntent(task.id, runId, call('fixture_increment', { amount: 1 }), { capability: 'process.exec' }), expectCode('PERMISSION_DENIED'));
  assert.equal(f.kernel.intents(task.id).length, 0);
  const valid = f.kernel.prepareIntent(task.id, runId, call('fixture_increment', { amount: 1 }), { capability: 'fixture.write' });
  assert.equal(valid.authorization!.decision, 'allow');
});

test('set_permission is operator-only, validates input and reports permission.changed per task', t => {
  const f = fixture(t);
  const parent = create(f, { permissionMode: 'auto-review' });
  const child = delegate(f, parent.id, { objective: 'Child of policy change', paths: ['policy-child'] });
  const childRun = start(f, child.id);
  const intent = f.kernel.prepareIntent(child.id, childRun, write('policy.txt'));
  assert.equal(intent.authorization!.decision, 'review');
  const childBefore = f.kernel.getTask(child.id)!;
  const ack = f.kernel.command({
    commandId: crypto.randomUUID(), type: 'set_permission', origin: 'operator', taskId: parent.id,
    parameters: { permissionMode: 'ask', ceiling: ['workspace.read', 'workspace.write'], reason: 'operator narrowed permissions' },
  });
  assert.equal(ack.taskId, parent.id);
  assert.equal(f.kernel.getTask(parent.id)!.permissionMode, 'ask');
  assert.ok(f.kernel.getTask(parent.id)!.policyEpoch > 1);
  assert.ok(f.kernel.getTask(child.id)!.policyEpoch > childBefore.policyEpoch);
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'denied');
  assert.deepEqual(f.kernel.getCapabilityCeiling(child.id), ['workspace.read', 'workspace.write']);
  const parentEvents = f.kernel.events(parent.id).filter(event => event.type === 'permission.changed');
  assert.equal(parentEvents.length, 1);
  assert.equal(parentEvents[0]!.payload.permissionMode, 'ask');
  assert.ok(f.kernel.events(child.id).some(event => event.type === 'permission.changed'));
  assert.throws(() => f.kernel.command({ commandId: crypto.randomUUID(), type: 'set_permission', taskId: parent.id, parameters: { permissionMode: 'root' } }), expectCode('INVALID_PERMISSION'));
  assert.throws(() => f.kernel.command({ commandId: crypto.randomUUID(), type: 'set_permission', taskId: parent.id, parameters: { appMode: 'terminal' } }), expectCode('INVALID_PERMISSION'));
  assert.throws(() => f.kernel.command({ commandId: crypto.randomUUID(), type: 'set_permission', origin: 'model', taskId: parent.id, parameters: { permissionMode: 'full-access' } }), expectCode('OPERATOR_REQUIRED'));
  assert.throws(() => f.kernel.setPermission(child.id, { permissionMode: 'full-access' }), expectCode('PERMISSION_ESCALATION'));
  assert.throws(() => f.kernel.setPermission(child.id, { ceiling: ['mcp.call'] }), expectCode('CAPABILITY_ESCALATION'));
  f.kernel.setPermission(parent.id, { appMode: 'chat' });
  assert.equal(f.kernel.getTask(parent.id)!.permissionMode, 'read-only', 'Chat forces read-only');
  assert.equal(f.kernel.appMode(child.id), 'chat');
  f.kernel.setPermission(parent.id, { appMode: 'work' });
  assert.equal(f.kernel.getTask(parent.id)!.permissionMode, 'read-only', 'leaving Chat does not silently widen the saved mode');
});

test('legacy tasks keep ask/work behaviour and pre-upgrade approved effects still dispatch', t => {
  const f = fixture(t);
  const task = create(f);
  const runId = start(f, task.id);
  const legacy = f.kernel.prepareIntent(task.id, runId, write('legacy.txt'));
  f.kernel.approve(legacy.id);
  assert.ok(legacy.authorization);
  f.close();
  const raw = new DatabaseSync(path.join(f.directory, 'kernel.sqlite'));
  try {
    raw.exec("UPDATE intents SET body=json_remove(body,'\$.authorization') WHERE id='" + legacy.id + "';" +
      "UPDATE tasks SET body=json_remove(body,'\$.permissionMode','\$.appMode') WHERE id='" + task.id + "';");
  } finally { raw.close(); }
  f.reopen();
  const stripped = f.kernel.getIntent(legacy.id)!;
  assert.equal(stripped.authorization, undefined);
  assert.equal(f.kernel.getTask(task.id)!.permissionMode, undefined);
  assert.equal(f.kernel.permissionMode(task.id), 'ask');
  assert.equal(f.kernel.appMode(task.id), 'work');
  f.kernel.dispatch(legacy.id);
  assert.equal(f.kernel.getIntent(legacy.id)!.state, 'sent', 'an approved pre-upgrade effect can still finish');
  const fresh = f.kernel.prepareIntent(task.id, runId, write('fresh.txt'));
  assert.equal(fresh.authorization!.decision, 'ask');
});
