import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Kernel } from '../src/kernel/index.js';
import { Runner } from '../src/app/runner.js';
import { ToolGateway } from '../src/tools/gateway.js';
import { workingContextBudget } from '../src/runtime/context-budget.js';
import type { Configuration } from '../src/app/configuration.js';
import type { CandidateManager } from '../src/adaptation/index.js';
import type { WireMessage } from '../src/contracts.js';

const RARE = 'QX-2749-Z';
const RARE_TEXT = 'Day-1 rare requirement ' + RARE + ': keep the original source SHA and the UTF-8 BOM parity byte.';
const providerConfig = {
  baseUrl: 'http://127.0.0.1:9/mock', model: 'endurance-test-model', mode: 'mock',
  maxOutputTokens: 4096, maxRequestBytes: 131072, contextWindowTokens: 262144
};

function candidates(): CandidateManager {
  return { snapshotFor: () => ({}), applySnapshot: async (_snapshot: unknown, value: string) => value } as unknown as CandidateManager;
}

function configuration(complete: (messages: WireMessage[], tools: unknown[]) => Promise<unknown>): Configuration {
  return {
    globalPaths: [], skillRoots: [], redact: (value: string) => value, sanitize: (value: unknown) => value,
    client: () => ({ config: providerConfig, complete })
  } as unknown as Configuration;
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, name, arguments: args };
}

async function until(predicate: () => boolean, timeoutMs: number, label: string) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(predicate(), label);
}

function rejected(pattern: RegExp) {
  return (error: unknown) => pattern.test(String((error as { code?: string }).code ?? '')) || pattern.test(String((error as Error).message));
}

function owned(t: import('node:test').TestContext, prefix: string) {
  const tempRoot = path.resolve('.tmp');
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, prefix));
  let kernel = new Kernel(root);
  let runner: Runner | undefined;
  t.after(async () => {
    if (runner) await runner.stop();
    kernel.close();
    assert.equal(path.dirname(root), tempRoot);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    get kernel() { return kernel; },
    set kernel(next: Kernel) { kernel = next; },
    get runner() { return runner; },
    set runner(next: Runner | undefined) { runner = next; },
    restart() { kernel.close(); kernel = new Kernel(root); return kernel; }
  };
}

test('accelerated 20-stage Runner loop survives reopen, keeps recall and rebases every effect', { timeout: 120_000 }, async t => {
  const f = owned(t, 'endurance-agent-');
  const taskId = f.kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    objective: 'Sustain a twenty-stage accelerated endurance loop through real Kernel, Runner and SQLite',
    maxModelCalls: 200, maxToolCalls: 200, permissionMode: 'full-access'
  } }).taskId!;
  const workspace = f.kernel.getTask(taskId)!.workspace;
  mkdirSync(workspace, { recursive: true });
  for (let stage = 1; stage <= 20; stage++) writeFileSync(path.join(workspace, 'phase-' + stage + '.txt'), 'stage ' + stage + ' evidence\n');
  const requirement = f.kernel.addMessage(taskId, 'user', RARE_TEXT, 'main');
  const toolsSeen: unknown[][] = [];
  let turn = 0;
  const complete = async (messages: WireMessage[], tools: unknown[]) => {
    toolsSeen.push(tools);
    const toolsBudget = workingContextBudget(providerConfig as never, tools as never);
    assert.ok(toolsBudget >= 2048, 'working context budget must be usable');
    assert.ok(JSON.stringify(messages).length <= toolsBudget + 8192, 'prompt must stay inside the working context budget');
    const n = turn++;
    const stage = n < 4 ? 1 : 2 + Math.floor((n - 4) / 2);
    const slot = n < 4 ? n : (n - 4) % 2;
    if (n === 0) return { content: '', toolCalls: [call('search', 'search_history', { query: RARE, limit: 10 })], finishReason: 'tool_calls', requestId: 'turn-' + n };
    if (n === 1) {
      const lastTool = [...messages].reverse().find(message => message.role === 'tool');
      const result = lastTool ? JSON.parse(lastTool.content ?? '{}') : undefined;
      const id = result?.results?.[0]?.id as string | undefined;
      assert.ok(id, 'the rare requirement must be recallable through archive search');
      return { content: '', toolCalls: [call('read', 'read_history', { id, length: 4000 })], finishReason: 'tool_calls', requestId: 'turn-' + n };
    }
    if (n === 2) return { content: '', toolCalls: [call('phase-1', 'read_file', { path: 'phase-1.txt' })], finishReason: 'tool_calls', requestId: 'turn-' + n };
    if (n === 3) return { content: '', toolCalls: [call('ask-1', 'ask_user', { question: 'Stage 1 checkpoint saved; continue?', reason: 'blocker' })], finishReason: 'tool_calls', requestId: 'turn-' + n };
    if (slot === 0) return { content: '', toolCalls: [call('phase-' + stage, 'read_file', { path: 'phase-' + stage + '.txt' })], finishReason: 'tool_calls', requestId: 'turn-' + n };
    return { content: '', toolCalls: [call('ask-' + stage, 'ask_user', { question: 'Stage ' + stage + ' checkpoint saved; continue?', reason: 'blocker' })], finishReason: 'tool_calls', requestId: 'turn-' + n };
  };
  const config = configuration(complete);
  f.runner = new Runner(f.kernel, config, candidates(), f.root);
  f.runner.start();
  for (let stage = 1; stage <= 20; stage++) {
    const target = stage === 1 ? 4 : 4 + (stage - 1) * 2;
    await until(() => turn >= target && f.kernel.getTask(taskId)!.status === 'waiting_input', 15_000, 'stage ' + stage + ' did not settle (turn ' + turn + ', status ' + f.kernel.getTask(taskId)!.status + ')');
    assert.equal(turn, target);
    assert.equal(f.kernel.getTask(taskId)!.status, 'waiting_input', f.kernel.getTask(taskId)!.error);
    if (stage === 20) break;
    await f.runner.stop();
    f.kernel.close();
    f.kernel = new Kernel(f.root);
    assert.deepEqual(f.kernel.recover().unknownIntents, []);
    f.runner = new Runner(f.kernel, config, candidates(), f.root);
    f.runner.start();
    f.kernel.command({ commandId: randomUUID(), type: 'answer', taskId, parameters: { content: 'Proceed to stage ' + (stage + 1) + '.' } });
  }
  await f.runner.stop();
  const task = f.kernel.getTask(taskId)!;
  assert.equal(task.status, 'waiting_input', task.error);
  assert.ok(task.generation >= 19, 'each staged control transition advances the generation');
  assert.equal(turn, 42);
  const intents = f.kernel.intents(taskId);
  assert.equal(intents.length, 20);
  assert.equal(intents.filter(intent => intent.state === 'applied').length, 20);
  assert.ok(intents.every(intent => intent.receipt), 'every read_file effect needs a real receipt');
  assert.equal(f.kernel.getBudgets(taskId).modelCalls, 42);
  assert.equal(f.kernel.getBudgets(taskId).toolCalls, 20);
  assert.ok(f.kernel.getCheckpoints(taskId).length >= 20);
  assert.equal(toolsSeen.length, 42);
  const memory = f.kernel.memory(taskId);
  const read = memory.read({ id: requirement.id, field: 'record' });
  const expected = createHash('sha256').update(JSON.stringify(f.kernel.getMessage(requirement.id)!)).digest('hex');
  assert.equal(read.sha256, expected, 'recalled source hash must match the durable record');
  assert.ok(memory.search({ query: RARE, limit: 20 }).results.some(result => result.id === requirement.id));
});

test('dispatch and receipt crash windows reconcile external effects exactly once and revocation fences approved intents', { timeout: 120_000 }, async t => {
  const f = owned(t, 'endurance-crash-');
  mkdirSync(path.join(f.root, 'receipts'));
  const create = () => f.kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    objective: 'Recover approved effects without blind replay', maxModelCalls: 5, maxToolCalls: 5, permissionMode: 'full-access'
  } }).taskId!;
  const taskId = create();
  const workspace = f.kernel.getTask(taskId)!.workspace;
  mkdirSync(workspace, { recursive: true });
  const gateway = () => new ToolGateway({ workspace, receiptDirectory: path.join(f.root, 'receipts'), timeoutMs: 10_000 });

  const run = f.kernel.createRun(taskId);
  f.kernel.transition(taskId, 'running');
  const prepared = await gateway().prepare({ name: 'fixture_increment', arguments: { amount: 3 } });
  const intent = f.kernel.prepareIntent(taskId, run.id, { id: 'increment-once', name: prepared.name, arguments: prepared.arguments }, { effectKey: 'endurance-increment', capability: 'fixture.write' });
  f.kernel.approve(intent.id);
  f.kernel.dispatch(intent.id);
  const outcome = await gateway().execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
  assert.equal(outcome.status, 'applied');
  const firstValue = outcome.receipt!.fixtureValue;
  f.kernel = f.restart();
  assert.deepEqual(f.kernel.recover().unknownIntents, [intent.id]);
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'unknown');
  assert.equal(f.kernel.getTask(taskId)!.status, 'reconciling');
  assert.throws(() => f.kernel.dispatch(intent.id), rejected(/STALE_GENERATION|INVALID_INTENT_STATE|no longer owns/));
  const observed = await gateway().queryOutcome(intent.effectKey, prepared.digest);
  assert.equal(observed.status, 'applied');
  assert.equal(observed.receipt!.fixtureValue, firstValue);
  f.kernel.reconcile(intent.id, observed.receipt);
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'applied');
  assert.equal((await gateway().queryOutcome(intent.effectKey, prepared.digest)).receipt!.fixtureValue, firstValue);
  assert.throws(() => f.kernel.dispatch(intent.id), rejected(/INVALID_INTENT_STATE|STALE_GENERATION|no longer owns/));

  const revokeTask = create();
  const revokeRun = f.kernel.createRun(revokeTask);
  f.kernel.transition(revokeTask, 'running');
  const revokePrepared = await gateway().prepare({ name: 'fixture_increment', arguments: { amount: 7 } });
  const revokeIntent = f.kernel.prepareIntent(revokeTask, revokeRun.id, { id: 'revoked-once', name: revokePrepared.name, arguments: revokePrepared.arguments }, { effectKey: 'endurance-revoked', capability: 'fixture.write' });
  f.kernel.approve(revokeIntent.id);
  f.kernel.command({ commandId: randomUUID(), type: 'set_permission', taskId: revokeTask, parameters: { permissionMode: 'ask', reason: 'Narrow authority after approval in the endurance test' } });
  assert.equal(f.kernel.getIntent(revokeIntent.id)!.state, 'denied');
  assert.throws(() => f.kernel.dispatch(revokeIntent.id), rejected(/INVALID_INTENT_STATE|STALE_GENERATION|APPROVAL_STALE|not approved|revoked/i));
  assert.equal(f.kernel.events(revokeTask).filter(event => event.type === 'intent.sent').length, 0, 'revocation must not emit a dispatch');

  const controlTask = create();
  f.kernel.command({ commandId: randomUUID(), type: 'pause', taskId: controlTask });
  assert.equal(f.kernel.getTask(controlTask)!.status, 'paused');
  f.kernel.command({ commandId: randomUUID(), type: 'resume', taskId: controlTask });
  assert.equal(f.kernel.getTask(controlTask)!.status, 'queued');
  f.kernel.command({ commandId: randomUUID(), type: 'cancel', taskId: controlTask });
  assert.equal(f.kernel.getTask(controlTask)!.status, 'cancelled');
  assert.throws(() => f.kernel.createRun(controlTask), /cancelled|terminal|status/i);
});

test('delegated child model and tool charges appear once on parent and child budgets', { timeout: 60_000 }, async t => {
  const f = owned(t, 'endurance-budget-');
  const parent = f.kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    objective: 'Charge delegated model and tool work exactly once', maxModelCalls: 6, maxToolCalls: 6, permissionMode: 'full-access'
  } }).taskId!;
  f.kernel.command({ commandId: randomUUID(), type: 'delegate', taskId: parent, parameters: { title: 'Budget child', objective: 'Consume two model calls and one tool effect' } });
  const child = f.kernel.listTasks().find(task => task.parentId === parent)!;
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return calls === 1
      ? { content: '', toolCalls: [call('charge', 'fixture_increment', { amount: 4 })], finishReason: 'tool_calls', requestId: 'charge-1' }
      : { content: '', toolCalls: [call('wait', 'ask_user', { question: 'Budget fixture is complete; continue?', reason: 'blocker' })], finishReason: 'tool_calls', requestId: 'charge-2' };
  };
  f.runner = new Runner(f.kernel, configuration(complete), candidates(), f.root);
  f.runner.managedExternally.add(parent);
  f.runner.start();
  await until(() => f.kernel.getTask(child.id)!.status === 'waiting_input', 15_000, 'child did not settle: ' + f.kernel.getTask(child.id)!.status);
  await f.runner.stop();
  assert.equal(f.kernel.getBudgets(parent).modelCalls, 2);
  assert.equal(f.kernel.getBudgets(parent).toolCalls, 1);
  assert.equal(f.kernel.getBudgets(child.id).modelCalls, 2);
  assert.equal(f.kernel.getBudgets(child.id).toolCalls, 1);
  const charged = (taskId: string) => f.kernel.events(taskId).filter(event => event.type === 'budget.consumed' && event.payload.sourceTaskId === child.id);
  assert.equal(charged(child.id).length, 2);
  assert.equal(charged(parent).length, 2);
  const toolCharged = (taskId: string) => f.kernel.events(taskId).filter(event => event.type === 'budget.tool_consumed' && event.payload.sourceTaskId === child.id);
  assert.equal(toolCharged(child.id).length, 1);
  assert.equal(toolCharged(parent).length, 1);
  assert.notEqual(f.kernel.getTask(parent)!.status, 'running');
  assert.notEqual(f.kernel.getTask(parent)!.status, 'completed');
});
