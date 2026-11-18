import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { Kernel, KernelError } from '../src/kernel/index.js';
import { validatePermissionRules } from '../src/kernel/permission-rules.js';
import type { PermissionRule } from '../src/kernel/permission-rules.js';
import type { Command, PermissionMode, Task, ToolCall } from '../src/contracts.js';

/**
 * Settings.rules are operator configuration that turns into authority. The tests here exercise the
 * kernel only: a rule must be validated once at the settings boundary, must be stable across a
 * restart, and must be re-read whenever an effect moves from proposal to executable authority.
 */

const fixtureRoot = path.resolve('.tmp/settings-product/a/tests');

class Fixture {
  kernel: Kernel;
  private closed = false;
  constructor(readonly directory: string) { this.kernel = new Kernel(directory); }
  close(): void { if (this.closed) return; this.kernel.close(); this.closed = true; }
  reopen(): Kernel { this.close(); this.kernel = new Kernel(this.directory); this.closed = false; return this.kernel; }
}

function fixture(t: TestContext): Fixture {
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(path.join(fixtureRoot, 'permission-rules-'));
  const created = new Fixture(directory);
  t.after(() => {
    try { created.close(); }
    finally {
      assert.ok(directory.startsWith(fixtureRoot + path.sep), 'fixtures stay inside the settings temp root');
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return created;
}

function rule(id: string, pattern: string, capability: PermissionRule['capability'], decision: PermissionRule['decision']): PermissionRule {
  return { id, pattern, capability, decision };
}

function create(f: Fixture, parameters: Record<string, unknown> = {}, origin: Command['origin'] = 'operator'): Task {
  const ack = f.kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', origin, parameters: { title: 'Rule fixture', ...parameters } });
  return f.kernel.getTask(ack.taskId!)!;
}

function start(f: Fixture, taskId: string): string {
  const run = f.kernel.createRun(taskId);
  f.kernel.transition(taskId, 'running');
  return run.id;
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: crypto.randomUUID(), name, arguments: args };
}

function code(expected: string) {
  return (error: unknown): boolean => error instanceof KernelError && error.code === expected;
}

/** A deny must carry the matched rule id in its audit-visible reason. */
function denial(run: () => unknown, ruleId?: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof KernelError, 'expected a KernelError');
    assert.equal(error.code, 'PERMISSION_DENIED');
    if (ruleId) assert.ok(error.message.includes(ruleId), 'reason names the matched rule ' + ruleId + ': ' + error.message);
    return true;
  });
}

function rulesChanged(f: Fixture, taskId: string) {
  return f.kernel.events(taskId).filter(event => event.type === 'permission.rules_changed');
}

/** Write a rule row behind the kernel's back, simulating a concurrent writer or a version mismatch. */
function insertStoredRule(directory: string, stored: PermissionRule, ordinal = 0): void {
  const db = new DatabaseSync(path.join(directory, 'kernel.sqlite'));
  try {
    db.prepare('INSERT OR REPLACE INTO permission_rules(id,pattern,capability,decision,ordinal) VALUES(?,?,?,?,?)')
      .run(stored.id, stored.pattern, stored.capability, stored.decision, ordinal);
  } finally { db.close(); }
}

test('rule validation bounds shape, identifiers, capabilities and decisions', () => {
  assert.deepEqual(validatePermissionRules([]), []);
  const hundred = Array.from({ length: 100 }, (_, index) => rule('r-' + index, 'notes/' + index + '.txt', 'read', 'allow'));
  assert.equal(validatePermissionRules(hundred).length, 100, 'exactly the limit is accepted');
  const wildcard = rule('r-wild', 'a*b?c[0-9]^$+(){}|\\', 'exec', 'deny');
  assert.deepEqual(validatePermissionRules([wildcard]), [wildcard], 'glob and regex punctuation stays literal data');

  const valid = rule('r-valid', 'docs/*.md', 'read', 'deny');
  const rejected: { label: string; value: unknown }[] = [
    { label: 'input is not an array', value: { rules: [] } },
    { label: 'more than 100 rules', value: Array.from({ length: 101 }, (_, index) => rule('r-' + index, '*', 'read', 'allow')) },
    { label: 'null entry', value: [null] },
    { label: 'array entry', value: [[]] },
    { label: 'unknown field', value: [{ ...valid, scope: 'session' }] },
    { label: 'empty id', value: [{ ...valid, id: '' }] },
    { label: 'id over 100 characters', value: [{ ...valid, id: 'x'.repeat(101) }] },
    { label: 'control character in id', value: [{ ...valid, id: 'r-\u0000x' }] },
    { label: 'duplicate id', value: [valid, { ...valid, pattern: 'other/*' }] },
    { label: 'empty pattern', value: [{ ...valid, pattern: '' }] },
    { label: 'blank pattern', value: [{ ...valid, pattern: '   ' }] },
    { label: 'pattern over 200 characters', value: [{ ...valid, pattern: 'x'.repeat(201) }] },
    { label: 'NUL in pattern', value: [{ ...valid, pattern: 'notes/\u0000.md' }] },
    { label: 'control character in pattern', value: [{ ...valid, pattern: 'notes/\u0007.md' }] },
    { label: 'unknown capability', value: [{ ...valid, capability: 'shell' }] },
    { label: 'non-string capability', value: [{ ...valid, capability: 42 }] },
    { label: 'unknown decision', value: [{ ...valid, decision: 'block' }] },
    { label: 'non-string decision', value: [{ ...valid, decision: true }] },
  ];
  for (const specimen of rejected) {
    assert.throws(() => validatePermissionRules(specimen.value), code('INVALID_PERMISSION_RULE'), specimen.label);
  }
});

test('invalid input never replaces the stored rule set', t => {
  const f = fixture(t);
  const accepted = f.kernel.setPermissionRules([rule('r-keep', 'docs/*', 'read', 'ask')]);
  assert.deepEqual(f.kernel.permissionRules(), accepted);
  assert.throws(() => f.kernel.validatePermissionRules('not rules'), code('INVALID_PERMISSION_RULE'));
  assert.throws(() => f.kernel.setPermissionRules([rule('r-bad', 'notes/\u0000.md', 'read', 'ask')]), code('INVALID_PERMISSION_RULE'));
  assert.deepEqual(f.kernel.permissionRules(), accepted, 'a rejected set never reaches the database');
  assert.equal(f.kernel.setPermissionRules([]).length, 0);
  assert.deepEqual(f.kernel.permissionRules(), [], 'an explicit empty set clears every rule');
});

test('rule patterns are case-insensitive globs and never regular expressions', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'full-access' });
  f.kernel.setPermissionRules([
    rule('r-question', 'notes?.md', 'read', 'deny'),
    rule('r-star', 'DOCS/*.MD', 'read', 'deny'),
    rule('r-literal', 'a[0-9].md', 'read', 'deny'),
  ]);
  const runId = start(f, task.id);
  denial(() => f.kernel.prepareIntent(task.id, runId, call('read_file', { path: 'notes1.md' })), 'r-question');
  assert.equal(f.kernel.prepareIntent(task.id, runId, call('read_file', { path: 'notes.md' })).authorization!.decision, 'allow', '? consumes exactly one character');
  denial(() => f.kernel.prepareIntent(task.id, runId, call('read_file', { path: 'docs\\deep\\Guide.md' })), 'r-star');
  assert.equal(f.kernel.prepareIntent(task.id, runId, call('read_file', { path: 'a1.md' })).authorization!.decision, 'allow', 'a[0-9] is a literal name, not a character class');
  denial(() => f.kernel.prepareIntent(task.id, runId, call('read_file', { path: 'a[0-9].md' })), 'r-literal');
});

test('a deny rule wins in every mode and outranks ask and allow matches', t => {
  const f = fixture(t);
  f.kernel.setPermissionRules([
    rule('r-allow', '*', 'write', 'allow'),
    rule('r-ask', 'blocked/*', 'write', 'ask'),
    rule('r-deny', 'blocked/*', 'write', 'deny'),
    rule('r-read-deny', 'private/*', 'read', 'deny'),
  ]);
  const full = create(f, { permissionMode: 'full-access' });
  const fullRun = start(f, full.id);
  denial(() => f.kernel.prepareIntent(full.id, fullRun, call('write_file', { path: 'blocked/one.txt', content: 'x' })), 'r-deny');

  const readOnly = create(f, { permissionMode: 'read-only' });
  const readRun = start(f, readOnly.id);
  denial(() => f.kernel.prepareIntent(readOnly.id, readRun, call('read_file', { path: 'private/note.txt' })), 'r-read-deny');
  denial(() => f.kernel.prepareIntent(readOnly.id, readRun, call('write_file', { path: 'plain.txt', content: 'x' })), undefined);
  assert.equal(f.kernel.intents(readOnly.id).length, 0, 'denied proposals leave no approvable intent');

  const chat = create(f, { appMode: 'chat', permissionMode: 'full-access' });
  const chatRun = start(f, chat.id);
  denial(() => f.kernel.prepareIntent(chat.id, chatRun, call('read_file', { path: 'private/chat.txt' })), 'r-read-deny');
  denial(() => f.kernel.prepareIntent(chat.id, chatRun, call('write_file', { path: 'plain.txt', content: 'x' })), undefined);
});

test('an ask rule is never satisfied by an existing session grant', t => {
  const f = fixture(t);
  f.kernel.setPermissionRules([rule('r-ask', 'granted/*', 'write', 'ask')]);
  const task = create(f, { permissionMode: 'ask' });
  const runId = start(f, task.id);
  const first = f.kernel.prepareIntent(task.id, runId, call('write_file', { path: 'granted/one.txt', content: 'x' }));
  assert.equal(first.authorization!.decision, 'ask');
  assert.equal(first.authorization!.grantId, undefined);
  assert.ok(first.authorization!.reason.includes('r-ask'), 'the ask reason is auditable');
  f.kernel.approve(first.id, { source: 'operator', scope: 'session' });
  assert.equal(f.kernel.permissionState(task.id).grants.length, 1, 'the operator did grant the exact effect for the session');

  const repeated = f.kernel.prepareIntent(task.id, runId, call('write_file', { path: 'granted/one.txt', content: 'x' }));
  assert.equal(repeated.authorization!.decision, 'ask', 'the grant must not answer a rule ask');
  assert.equal(repeated.authorization!.grantId, undefined);
  assert.throws(() => f.kernel.approve(repeated.id, { source: 'policy' }), code('OPERATOR_APPROVAL_REQUIRED'));
});

test('an allow rule lifts a base ask but never a deny mode, a critical effect or a protected tool', t => {
  const f = fixture(t);
  f.kernel.setPermissionRules([rule('r-allow', 'allowed.txt', 'write', 'allow')]);
  const askTask = create(f, { permissionMode: 'ask' });
  const askRun = start(f, askTask.id);
  const lifted = f.kernel.prepareIntent(askTask.id, askRun, call('write_file', { path: 'allowed.txt', content: 'x' }));
  assert.equal(lifted.authorization!.decision, 'allow');
  assert.ok(lifted.authorization!.reason.includes('r-allow'));
  f.kernel.approve(lifted.id, { source: 'policy' });
  assert.equal(f.kernel.dispatch(lifted.id).state, 'sent');

  const readOnly = create(f, { permissionMode: 'read-only' });
  const readRun = start(f, readOnly.id);
  denial(() => f.kernel.prepareIntent(readOnly.id, readRun, call('write_file', { path: 'allowed.txt', content: 'x' })));
  const chat = create(f, { appMode: 'chat', permissionMode: 'full-access' });
  const chatRun = start(f, chat.id);
  denial(() => f.kernel.prepareIntent(chat.id, chatRun, call('write_file', { path: 'allowed.txt', content: 'x' })));

  const full = create(f, { permissionMode: 'full-access' });
  f.kernel.setPermissionRules([rule('r-exec-allow', '*', 'exec', 'allow'), rule('r-mcp-allow', '*', 'mcp', 'allow')]);
  const fullRun = start(f, full.id);
  const critical = f.kernel.prepareIntent(full.id, fullRun, call('run_shell', { command: 'echo fixture' }));
  assert.equal(critical.authorization!.decision, 'ask', 'critical risk always needs a human');
  assert.throws(() => f.kernel.approve(critical.id, { source: 'policy' }), code('OPERATOR_APPROVAL_REQUIRED'));
  f.kernel.approve(critical.id, { source: 'operator' });
  assert.equal(f.kernel.dispatch(critical.id).state, 'sent');

  const protectedTask = create(f, { permissionMode: 'ask' });
  const protectedRun = start(f, protectedTask.id);
  const protectedIntent = f.kernel.prepareIntent(protectedTask.id, protectedRun, call('mcp_call', { serverId: 'srv', toolName: 'echo', arguments: {} }));
  assert.equal(protectedIntent.authorization!.decision, 'ask', 'a protected tool cannot be short-circuited by a rule');
  assert.throws(() => f.kernel.approve(protectedIntent.id, { source: 'policy' }), code('OPERATOR_APPROVAL_REQUIRED'));
  const transform = f.kernel.prepareIntent(protectedTask.id, protectedRun, call('plugin_transform', { pluginId: 'fixture', arguments: {} }));
  assert.equal(transform.authorization!.decision, 'ask', 'a protected plugin tool stays guarded');
  assert.throws(() => f.kernel.approve(transform.id, { source: 'policy' }), code('OPERATOR_APPROVAL_REQUIRED'));
});

test('approve rewrites the authorization to the current rules without touching the artifact digest', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'ask' });
  const runId = start(f, task.id);
  const pending = f.kernel.prepareIntent(task.id, runId, call('write_file', { path: 'fresh/a.txt', content: 'x' }));
  assert.equal(pending.authorization!.decision, 'ask');
  insertStoredRule(f.directory, rule('r-late-allow', 'fresh/*', 'write', 'allow'), 1);
  const approved = f.kernel.approve(pending.id, { source: 'operator' });
  assert.equal(approved.digest, pending.digest, 'rules never change the approved artifact');
  assert.equal(approved.authorization!.decision, 'allow', 'approval records the verdict the current rules supply');
  assert.ok(approved.authorization!.reason.includes('r-late-allow'), 'the approval reason names the rule');
  assert.equal(f.kernel.dispatch(approved.id).state, 'sent');
});

test('exec rules match the normalized command line, not just paths', t => {
  const f = fixture(t);
  f.kernel.setPermissionRules([
    rule('r-push', 'git push*', 'exec', 'deny'),
    rule('r-secret', 'type *secrets/*', 'exec', 'deny'),
    rule('r-test', 'node --test *A.TEST.TS', 'exec', 'deny'),
  ]);
  const task = create(f, { permissionMode: 'full-access' });
  const runId = start(f, task.id);
  denial(() => f.kernel.prepareIntent(task.id, runId, call('run_shell', { command: 'git push origin main' })), 'r-push');
  denial(() => f.kernel.prepareIntent(task.id, runId, call('run_shell', { command: 'GIT PUSH origin main' })), 'r-push');
  assert.equal(f.kernel.prepareIntent(task.id, runId, call('run_shell', { command: 'git status' })).authorization!.decision, 'ask', 'the critical command still asks, the deny rule does not match');
  denial(() => f.kernel.prepareIntent(task.id, runId, call('run_shell', { command: 'type C:\\secrets\\token.txt' })), 'r-secret');
  denial(() => f.kernel.prepareIntent(task.id, runId, call('run_command', { executable: 'node', argv: ['--test', 'tests/A.test.ts'] })), 'r-test');
  denial(() => f.kernel.prepareIntent(task.id, runId, call('run_command', { executable: 'node', argv: ['--test', path.join(task.workspace, 'tests', 'A.test.ts')] })), 'r-test');
});

test('path targets are workspace-relative, POSIX-normalized and capability-exact', t => {
  const f = fixture(t);
  f.kernel.setPermissionRules([
    rule('r-write', 'files/*', 'write', 'deny'),
    rule('r-key', 'private/*.key', 'read', 'deny'),
  ]);
  const task = create(f, { permissionMode: 'full-access' });
  const runId = start(f, task.id);
  assert.equal(f.kernel.prepareIntent(task.id, runId, call('read_file', { path: 'files/readme.txt' })).authorization!.decision, 'allow', 'a write rule never matches a read capability');
  denial(() => f.kernel.prepareIntent(task.id, runId, call('write_file', { path: 'files/readme.txt', content: 'x' })), 'r-write');
  denial(() => f.kernel.prepareIntent(task.id, runId, call('read_file', { path: './PRIVATE\\Store\\Id.Key' })), 'r-key');
  denial(() => f.kernel.prepareIntent(task.id, runId, call('read_file', { path: path.join(task.workspace, 'private', 'Store', 'id.key') })), 'r-key');
});

test('tightening rules between approval and dispatch fences the effect and blocks dispatch', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'ask' });
  const runId = start(f, task.id);
  const pending = f.kernel.prepareIntent(task.id, runId, call('write_file', { path: 'frozen/pending.txt', content: 'x' }));
  assert.equal(pending.authorization!.decision, 'ask');
  f.kernel.approve(pending.id, { source: 'operator' });
  const untouched = create(f, { permissionMode: 'full-access' });
  const before = f.kernel.getTask(task.id)!;
  const untouchedBefore = f.kernel.getTask(untouched.id)!;

  f.kernel.setPermissionRules([rule('r-freeze', 'frozen/*', 'write', 'deny')]);

  const after = f.kernel.getTask(task.id)!;
  assert.ok(after.policyEpoch > before.policyEpoch, 'policy epoch moves');
  assert.ok(after.generation > before.generation, 'generation moves so the old run is fenced');
  assert.equal(after.status, 'queued');
  assert.equal(f.kernel.getIntent(pending.id)!.state, 'denied', 'the old approval is not executable authority');
  const changed = rulesChanged(f, task.id);
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.payload.affected, 1);
  assert.throws(() => f.kernel.dispatch(pending.id), code('POLICY_DENY'), 'the second line of defence re-reads the rule');
  assert.throws(() => f.kernel.approve(pending.id), (error: unknown) => error instanceof KernelError && ['STALE_GENERATION', 'INVALID_INTENT_STATE'].includes(error.code), 'a fenced approval can never be revived');

  const untouchedAfter = f.kernel.getTask(untouched.id)!;
  assert.equal(untouchedAfter.generation, untouchedBefore.generation, 'a task with no pending effect is not interrupted');
  assert.equal(untouchedAfter.policyEpoch, untouchedBefore.policyEpoch);
  assert.equal(rulesChanged(f, untouched.id).length, 0);

  const epoch = f.kernel.getTask(task.id)!.policyEpoch;
  f.kernel.setPermissionRules([rule('r-freeze', 'frozen/*', 'write', 'deny')]);
  assert.equal(f.kernel.getTask(task.id)!.policyEpoch, epoch, 'an identical set is a no-op');
  assert.equal(rulesChanged(f, task.id).length, 1, 'a no-op records no second rules event');

  const nextRun = start(f, task.id);
  denial(() => f.kernel.prepareIntent(task.id, nextRun, call('write_file', { path: 'frozen/next.txt', content: 'x' })), 'r-freeze');
});

test('a rule that now asks makes an old allow approval stale at dispatch', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'full-access' });
  const runId = start(f, task.id);
  const allowed = f.kernel.prepareIntent(task.id, runId, call('write_file', { path: 'stale.txt', content: 'x' }));
  assert.equal(allowed.authorization!.decision, 'allow');
  f.kernel.approve(allowed.id, { source: 'policy' });
  assert.equal(f.kernel.getIntent(allowed.id)!.state, 'approved');

  f.kernel.setPermissionRules([rule('r-stale', 'stale.txt', 'write', 'ask')]);
  assert.equal(f.kernel.getTask(task.id)!.status, 'queued');
  assert.throws(() => f.kernel.dispatch(allowed.id), code('APPROVAL_STALE'), 'an old allow approval never crosses a newly asking rule');
  assert.equal(f.kernel.getIntent(allowed.id)!.state, 'denied', 'the effect stays denied');
});

test('rules persist across restart and old grants remain dead', t => {
  const f = fixture(t);
  const stored = f.kernel.setPermissionRules([rule('r-keep', 'kept/*', 'write', 'deny'), rule('r-audit', 'logs/*', 'read', 'ask')]);
  const task = create(f, { permissionMode: 'ask' });
  const runId = start(f, task.id);
  const granted = f.kernel.prepareIntent(task.id, runId, call('write_file', { path: 'granted.txt', content: 'one' }));
  f.kernel.approve(granted.id, { source: 'operator', scope: 'session' });
  assert.equal(f.kernel.permissionState(task.id).grants.length, 1);

  f.reopen();
  assert.deepEqual(f.kernel.permissionRules(), stored, 'the rule set is durable operator configuration');
  assert.equal(f.kernel.permissionState(task.id).grants.length, 0, 'opening the database revokes process authority');
  f.kernel.recover();
  const nextRun = start(f, task.id);
  denial(() => f.kernel.prepareIntent(task.id, nextRun, call('write_file', { path: 'kept/notes.txt', content: 'x' })), 'r-keep');
  const repeated = f.kernel.prepareIntent(task.id, nextRun, call('write_file', { path: 'granted.txt', content: 'one' }));
  assert.equal(repeated.authorization!.decision, 'ask', 'an old grant never authorizes a new process');
});

test('corrupted persisted rules fail closed with an explicit error', t => {
  const f = fixture(t);
  f.kernel.setPermissionRules([rule('r-one', 'docs/*', 'read', 'deny')]);
  const task = create(f, { permissionMode: 'ask' });
  f.close();
  const db = new DatabaseSync(path.join(f.directory, 'kernel.sqlite'));
  try { db.prepare("UPDATE permission_rules SET decision='block' WHERE id='r-one'").run(); } finally { db.close(); }
  const reopened = f.reopen();
  assert.throws(() => reopened.permissionRules(), code('INVALID_PERMISSION_RULE'), 'stored authority is never trusted blindly');
  reopened.recover();
  const runId = start(f, task.id);
  assert.throws(() => reopened.prepareIntent(task.id, runId, call('read_file', { path: 'docs/note.txt' })), code('INVALID_PERMISSION_RULE'));
});

test('approve and dispatch re-read rules that arrived outside the settings path', t => {
  const f = fixture(t);
  const task = create(f, { permissionMode: 'full-access' });
  const runId = start(f, task.id);
  const deniedLater = f.kernel.prepareIntent(task.id, runId, call('write_file', { path: 'defense.txt', content: 'x' }));
  assert.equal(deniedLater.authorization!.decision, 'allow');
  insertStoredRule(f.directory, rule('r-out-of-band', 'defense.txt', 'write', 'deny'));
  assert.throws(() => f.kernel.approve(deniedLater.id, { source: 'policy' }), code('POLICY_DENY'));

  const second = create(f, { permissionMode: 'full-access' });
  const secondRun = start(f, second.id);
  const stale = f.kernel.prepareIntent(second.id, secondRun, call('write_file', { path: 'late-ask.txt', content: 'x' }));
  assert.equal(stale.authorization!.decision, 'allow');
  f.kernel.approve(stale.id, { source: 'policy' });
  insertStoredRule(f.directory, rule('r-late-ask', 'late-ask.txt', 'write', 'ask'), 1);
  const events = f.kernel.events(second.id).length;
  assert.equal(f.kernel.decideIntent(stale.id).outcome, 'ask', 'decideIntent reports the current rule outcome');
  assert.equal(f.kernel.events(second.id).length, events, 'decideIntent stays a read');
  assert.equal(f.kernel.getIntent(stale.id)!.authorization!.decision, 'allow', 'decideIntent never mutates the stored snapshot');
  assert.throws(() => f.kernel.dispatch(stale.id), code('APPROVAL_STALE'));
});

test('rules can never widen an existing hard boundary', t => {
  const f = fixture(t);
  f.kernel.setPermissionRules([rule('r-env', '.env', 'read', 'allow'), rule('r-exec', '*', 'exec', 'allow')]);
  const task = create(f, { permissionMode: 'read-only' });
  const runId = start(f, task.id);
  denial(() => f.kernel.prepareIntent(task.id, runId, call('read_file', { path: '.env' })), undefined);
  denial(() => f.kernel.prepareIntent(task.id, runId, call('run_command', { executable: 'node', argv: ['--version'] })), undefined);

  const narrowed = create(f, { permissionMode: 'ask' });
  f.kernel.setCapabilityCeiling(narrowed.id, ['workspace.read']);
  const narrowedRun = start(f, narrowed.id);
  assert.throws(() => f.kernel.prepareIntent(narrowed.id, narrowedRun, call('run_command', { executable: 'node', argv: ['--version'] })), code('CAPABILITY_DENIED'), 'a rule never restores a narrowed ceiling');
});
