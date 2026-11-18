import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { assertProjectFixtureRoot } from './project-boundary.js';

type Backend = Awaited<ReturnType<typeof startBackend>>;
type Snapshot = ReturnType<Backend['services']['snapshot']>;

test('default mock resumes a paused write with fresh approval while the superseded intent stays denied', { timeout: 35_000 }, async t => {
  const tempRoot = path.resolve('.tmp');
  assertProjectFixtureRoot(tempRoot);
  mkdirSync(tempRoot, { recursive: true });
  const owned = mkdtempSync(path.join(tempRoot, 'mock-pause-case-'));
  const backend = await startBackend({ dataDir: path.join(owned, 'data'), projectRoot: path.resolve('.') });
  t.after(async () => {
    try { await backend.close(); }
    finally {
      assert.equal(path.dirname(owned), tempRoot);
      rmSync(owned, { recursive: true, force: true });
    }
  });
  const request = async (method: string, route: string, input?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${backend.port}${route}`, {
      method, headers: { Authorization: `Bearer ${backend.token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, value: await response.json() as any };
  };
  const command = async (input: unknown) => {
    const response = await request('POST', '/v1/commands', input);
    assert.equal(response.status, 200, JSON.stringify(response.value));
    return response.value;
  };
  let taskId = '';
  const snapshot = async (): Promise<Snapshot> => {
    const response = await request('GET', `/v1/snapshot?taskId=${encodeURIComponent(taskId)}`);
    assert.equal(response.status, 200);
    return response.value;
  };
  const diagnose = (stage: string, value: Snapshot) => t.diagnostic(JSON.stringify({
    stage, status: value.selectedTask?.status, generation: value.selectedTask?.generation, error: value.selectedTask?.error,
    intents: value.intents.map(intent => ({ id: intent.id, state: intent.state, generation: intent.generation, runId: intent.runId, error: intent.error })),
    toolMessages: value.messages.filter(message => message.role === 'tool').map(message => message.content),
    eventTypes: value.events.slice(-16).map(event => event.type),
    verifications: value.verifications.map(verification => verification.record),
  }));
  const waitFor = async (stage: string, predicate: (value: Snapshot) => boolean) => {
    const deadline = Date.now() + 15_000;
    let value: Snapshot;
    do {
      value = await snapshot();
      if (predicate(value)) return value;
      if (['failed', 'completed', 'cancelled'].includes(value.selectedTask!.status)) {
        diagnose(stage, value);
        assert.fail(`${stage}: unexpected ${value.selectedTask!.status}; ${value.selectedTask!.error ?? ''}`);
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    } while (Date.now() < deadline);
    diagnose(stage, value!);
    assert.fail(`${stage}: expected state was not reached; observed ${value!.selectedTask!.status}`);
  };

  const created = await command({ commandId: randomUUID(), type: 'create_task', parameters: { goal: {
    objective: 'Write pause-output.txt with the default mock output.', acceptance: ['file:pause-output.txt', 'contains:pause-output.txt:NPN-Gamma mock output'],
    constraints: ['Require an exact current approval before writing'], maxModelCalls: 8, mode: 'autonomous',
  } } });
  taskId = created.taskId;
  const waiting = await waitFor('initial approval', value => value.selectedTask?.status === 'waiting_approval');
  const oldIntent = waiting.intents.find(intent => intent.name === 'write_file' && intent.state === 'prepared')!;
  assert.ok(oldIntent);
  const artifact = path.join(waiting.selectedTask!.workspace, 'pause-output.txt');
  assert.equal(existsSync(artifact), false);
  const originalInputs = waiting.messages.filter(message => message.role === 'user');

  await command({ commandId: randomUUID(), type: 'pause', taskId });
  const paused = await snapshot();
  assert.equal(paused.selectedTask!.status, 'paused');
  assert.equal(paused.intents.find(intent => intent.id === oldIntent.id)!.state, 'denied');
  assert.ok(paused.selectedTask!.generation > oldIntent.generation);
  assert.equal(existsSync(artifact), false, 'Pausing an unapproved tool must have no file effect');
  diagnose('paused old proposal fenced', paused);

  await command({ commandId: randomUUID(), type: 'resume', taskId });
  const resumed = await waitFor('fresh approval after resume', value => value.selectedTask?.status === 'waiting_approval'
    && value.intents.some(intent => intent.name === 'write_file' && intent.state === 'prepared' && intent.id !== oldIntent.id));
  const fresh = resumed.intents.find(intent => intent.name === 'write_file' && intent.state === 'prepared')!;
  assert.notEqual(fresh.id, oldIntent.id);
  assert.notEqual(fresh.runId, oldIntent.runId);
  assert.ok(fresh.generation > oldIntent.generation);
  assert.equal(fresh.generation, resumed.selectedTask!.generation);
  assert.equal(resumed.intents.find(intent => intent.id === oldIntent.id)!.state, 'denied');
  assert.equal(existsSync(artifact), false, 'Resume must ask for fresh approval before executing the new proposal');
  assert.deepEqual(resumed.messages.filter(message => message.role === 'user'), originalInputs, 'Pause/resume must not manufacture continuation messages');

  const oldGrant = await request('POST', '/v1/commands', { commandId: randomUUID(), type: 'grant', taskId, parameters: { intentId: oldIntent.id } });
  assert.notEqual(oldGrant.status, 200, 'The old denied approval must never authorize the fresh run');
  const afterOldGrant = await snapshot();
  assert.equal(afterOldGrant.intents.find(intent => intent.id === fresh.id)!.state, 'prepared');
  assert.equal(existsSync(artifact), false);
  await command({ commandId: randomUUID(), type: 'grant', taskId, parameters: { intentId: fresh.id } });
  const completed = await waitFor('verified completion after fresh grant', value => value.selectedTask?.status === 'completed');
  assert.equal(completed.intents.find(intent => intent.id === oldIntent.id)!.state, 'denied');
  assert.equal(completed.intents.find(intent => intent.id === fresh.id)!.state, 'applied');
  assert.match(readFileSync(artifact, 'utf8'), /NPN-Gamma mock output/);
  assert.ok(completed.verifications.some(verification => verification.record.passed === true), 'The actual artifact and receipt require independent acceptance');
  diagnose('fresh current-run effect verified', completed);
});
