import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Kernel, digest } from '../src/kernel/index.js';
import { Runner } from '../src/app/runner.js';
import type { Configuration } from '../src/app/configuration.js';
import type { CandidateManager } from '../src/adaptation/index.js';
import type { ProviderConfig, Task, ToolCall } from '../src/contracts.js';
import type { ExternalTools } from '../src/app/external-tools.js';
import type { ToolGateway } from '../src/tools/gateway.js';
import { digestValue, ToolPolicyError } from '../src/tools/policy.js';
import { projectInputBatch } from '../src/runtime/context.js';
import { startBackend } from '../src/app/backend.js';
import { resourceBudget } from '../src/app/resource-budget.js';

function fixture(t: import('node:test').TestContext) {
  const base = path.resolve(process.env.TEMP ?? '.tmp');
  const root = mkdtempSync(path.join(base, 'input-011-'));
  const kernel = new Kernel(root);
  const configuration = { globalPaths: [], skillRoots: [], redact: (value: string) => value, sanitize: (value: unknown) => value } as unknown as Configuration;
  const runner = new Runner(kernel, configuration, { snapshotFor: () => ({}) } as unknown as CandidateManager, root);
  const taskId = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace: root, objective: 'Apply every operator correction' } }).taskId!;
  t.after(() => { kernel.close(); assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  return { root, kernel, runner, taskId };
}
const config = { maxRequestBytes: 131072 } as ProviderConfig;

const perform = (runner: Runner, task: Task, runId: string, call: ToolCall, messageId: string) =>
  (runner as unknown as { perform(task: Task, runId: string, call: ToolCall, messageId: string, gateway: ToolGateway, signal: AbortSignal): Promise<void> })
    .perform(task, runId, call, messageId, runner.gateway(task), new AbortController().signal);

test('a human save invalidates an undispatched approval and a newly reviewed proposal can proceed', async t => {
  const f = fixture(t), run = f.kernel.createRun(f.taskId); f.kernel.transition(f.taskId, 'running');
  const call = { id: 'before-save', name: 'write_file', arguments: { path: 'human.txt', content: 'agent output' } };
  const message = f.kernel.addMessage(f.taskId, 'assistant', '', 'main', { toolCalls: [call], sampledUserCursor: f.kernel.latestUserCursor(f.taskId) });
  const prepared = await f.runner.gateway(f.kernel.getTask(f.taskId)!).prepare(call);
  const intent = f.kernel.prepareIntent(f.taskId, run.id, { ...call, arguments: prepared.arguments }, { effectKey: digest({ taskId: f.taskId, messageId: message.id, toolCallId: call.id }) });
  f.kernel.approve(intent.id); f.kernel.transition(f.taskId, 'waiting_approval');
  writeFileSync(path.join(f.root, 'human.txt'), 'human saved version');
  await perform(f.runner, f.kernel.getTask(f.taskId)!, run.id, call, message.id);
  assert.equal(f.kernel.getTask(f.taskId)!.status, 'waiting_input'); assert.equal(f.kernel.getIntent(intent.id)!.state, 'denied');
  assert.equal(f.kernel.getBudgets(f.taskId).toolCalls, 0); assert.equal(readFileSync(path.join(f.root, 'human.txt'), 'utf8'), 'human saved version');
  assert.equal(JSON.parse(f.kernel.tailMessages(f.taskId).findLast(item => item.role === 'tool')!.content).executed, false);
  assert.equal(f.kernel.eventCount(f.taskId, 'effect.unknown'), 0);
  assert.throws(() => f.kernel.dispatch(intent.id));
  f.kernel.command({ commandId: randomUUID(), type: 'send_message', taskId: f.taskId, parameters: { content: 'I reviewed the saved version. Prepare a new replacement for explicit approval.' } });
  const nextRun = f.kernel.createRun(f.taskId); f.kernel.transition(f.taskId, 'running');
  // A real Runner samples the applicable instructions before creating this replacement proposal.
  const assembled = await f.runner.assembleWork(f.taskId, config);
  f.kernel.saveDecision(f.taskId, nextRun.id, { instructionSources: assembled.context.instructionSources });
  // A user saying "reviewed" is not a file read. Let the real Runner/worker produce its receipt.
  const readCall = { id: 'read-saved-version', name: 'read_file', arguments: { path: 'human.txt' } };
  const readMessage = f.kernel.addMessage(f.taskId, 'assistant', '', 'main', { toolCalls: [readCall], sampledUserCursor: f.kernel.latestUserCursor(f.taskId) });
  await perform(f.runner, f.kernel.getTask(f.taskId)!, nextRun.id, readCall, readMessage.id);
  const readIntent = f.kernel.intents(f.taskId).find(item => item.toolCallId === readCall.id);
  assert.ok(readIntent); assert.equal(readIntent.state, 'applied'); assert.ok(readIntent.receipt);
  assert.equal(readIntent.receipt.output, 'human saved version');
  const readVersion = f.kernel.getReadVersion(f.taskId, path.join(f.root, 'human.txt'));
  assert.ok(readVersion); assert.equal(readVersion.sourceIntentId, readIntent.id);
  assert.equal(readVersion.sha256, readIntent.receipt.sha256);
  assert.equal(f.kernel.getBudgets(f.taskId).toolCalls, 1, 'Only the actual worker read has executed.');
  const nextCall = { ...call, id: 'after-review' };
  const nextMessage = f.kernel.addMessage(f.taskId, 'assistant', '', 'main', { toolCalls: [nextCall], sampledUserCursor: f.kernel.latestUserCursor(f.taskId) });
  await perform(f.runner, f.kernel.getTask(f.taskId)!, nextRun.id, nextCall, nextMessage.id);
  const nextIntent = f.kernel.intents(f.taskId).find(item => item.toolCallId === nextCall.id)!;
  assert.ok(nextIntent, 'A freshly sampled proposal must reach approval after the source review.');
  assert.equal(nextIntent.state, 'prepared'); assert.notEqual(nextIntent.digest, intent.digest);
  assert.equal(nextIntent.arguments.expectedSha256, readIntent.receipt.sha256);
  assert.deepEqual(nextIntent.arguments.readVersion, readVersion);
  f.kernel.approve(nextIntent.id);
  await perform(f.runner, f.kernel.getTask(f.taskId)!, nextRun.id, nextCall, nextMessage.id);
  assert.equal(f.kernel.getBudgets(f.taskId).toolCalls, 2, 'One worker read plus one approved write; the stale write still executed zero times.');
  assert.equal(f.kernel.getIntent(nextIntent.id)!.state, 'applied');
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'denied');
  assert.equal(f.kernel.eventCount(f.taskId, 'intent.sent'), 2);
  assert.equal(f.kernel.eventCount(f.taskId, 'effect.receipted'), 2);
  assert.equal(f.kernel.eventCount(f.taskId, 'effect.unknown'), 0);
  assert.equal(readFileSync(path.join(f.root, 'human.txt'), 'utf8'), 'agent output');
});

for (const changed of ['digest', 'catalog'] as const) test(`MCP ${changed} changes before dispatch invalidate old approval without an unknown effect`, async t => {
  const f = fixture(t), run = f.kernel.createRun(f.taskId); f.kernel.transition(f.taskId, 'running');
  const call = { id: 'mcp-before-change', name: 'mcp_call', arguments: { serverId: 'fixture', toolName: 'write', arguments: {} } };
  const original = { ...call.arguments, toolDigest: 'original-schema', connectionId: 'connection-a' };
  const message = f.kernel.addMessage(f.taskId, 'assistant', '', 'main', { toolCalls: [call], sampledUserCursor: f.kernel.latestUserCursor(f.taskId) });
  const intent = f.kernel.prepareIntent(f.taskId, run.id, { ...call, arguments: original }, { effectKey: digest({ taskId: f.taskId, messageId: message.id, toolCallId: call.id }) });
  f.kernel.approve(intent.id); f.kernel.transition(f.taskId, 'waiting_approval');
  let executions = 0;
  const external = { prepare: () => {
    if (changed === 'catalog') throw new ToolPolicyError('MCP catalog changed; discover tools again before calling.');
    const args = { ...original, toolDigest: 'changed-schema', connectionId: 'connection-b' };
    return { name: 'mcp_call', arguments: args, capability: 'mcp.call', mutating: true, resources: ['mcp://fixture/write'], digest: digestValue({ name: 'mcp_call', arguments: args }) };
  }, execute: async () => { executions++; throw new Error('The stale MCP operation must never execute'); } } as unknown as ExternalTools;
  const runner = new Runner(f.kernel, f.runner.configuration, f.runner.candidates, f.root, external);
  await perform(runner, f.kernel.getTask(f.taskId)!, run.id, call, message.id);
  assert.equal(executions, 0); assert.equal(f.kernel.getTask(f.taskId)!.status, 'waiting_input');
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'denied'); assert.equal(f.kernel.getBudgets(f.taskId).toolCalls, 0);
  assert.equal(f.kernel.eventCount(f.taskId, 'effect.unknown'), 0);
});

test('an approval wait releases its execution owner and lease and resumes the same effect once', { timeout: 20000 }, async t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'approval-011-'));
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const backend = await startBackend({ dataDir: path.join(root, 'data'), projectRoot: process.cwd(), mockOptions: { responder: body => {
    if (body.messages[0]?.content.includes('REVIEWER ROLE')) return { content: '{"verdict":"pass"}' };
    if (body.messages.some((message: any) => message.role === 'tool')) return { content: 'The output is written.' };
    return { content: '', toolCalls: [{ id: 'write-once', name: 'write_file', arguments: { path: 'approved.txt', content: 'approved output' } }] };
  } } });
  t.after(async () => { await backend.close(); assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  const kernel = backend.services.kernel;
  const taskId = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, objective: 'Write approved.txt', acceptance: ['file:approved.txt'], maxModelCalls: 8 } }).taskId!;
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(ready(), JSON.stringify(kernel.getTask(taskId)));
  };
  await until(() => kernel.getTask(taskId)!.status === 'waiting_approval');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(resourceBudget.status().activeLeases, 0, 'operator think time must not retain an execution slot');
  assert.equal((backend.services.runner as unknown as { active: Map<string, unknown> }).active.size, 0, 'approval ownership remains durable, not a polling loop');
  const intent = kernel.intents(taskId)[0]!;
  backend.services.command({ commandId: randomUUID(), taskId, type: 'grant', parameters: { intentId: intent.id } });
  await until(() => ['completed', 'waiting_input', 'failed'].includes(kernel.getTask(taskId)!.status));
  assert.equal(kernel.getTask(taskId)!.status, 'completed');
  assert.equal(kernel.intents(taskId).length, 1); assert.equal(kernel.getIntent(intent.id)!.state, 'applied');
});

test('a correction after sampling invalidates an undispatched persisted effect proposal', async t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'stale-write-011-'));
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const wires: string[] = [];
  const backend = await startBackend({ dataDir: path.join(root, 'data'), projectRoot: process.cwd(), mockOptions: { responder: body => {
    wires.push(JSON.stringify(body));
    return { content: body.messages[0]?.content.includes('REVIEWER ROLE') ? '{"verdict":"unknown"}' : 'The corrected input has been read.' };
  } } });
  await backend.services.runner.stop();
  t.after(async () => { await backend.close(); assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  const kernel = backend.services.kernel;
  const taskId = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, objective: 'Prepare output', maxModelCalls: 8 } }).taskId!;
  kernel.addMessage(taskId, 'assistant', 'A saved effect proposal', 'main', { sampledUserCursor: kernel.latestUserCursor(taskId), toolCalls: [{ id: 'stale-write', name: 'fixture_increment', arguments: { amount: 1 } }] });
  backend.services.command({ commandId: randomUUID(), taskId, type: 'send_message', parameters: { content: 'CORRECTION_KEEP_READ_ONLY. Do not write anything.' } });
  backend.services.runner.start();
  const deadline = Date.now() + 10000;
  while (!wires.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(wires.length > 0, 'stale pending tools must yield to a fresh ordinary sample');
  assert.match(wires[0]!, /CORRECTION_KEEP_READ_ONLY/);
  assert.equal(kernel.intents(taskId).length, 0, 'the obsolete proposal must not create an approvable write');
  assert.ok(kernel.events(taskId).some(event => event.type === 'verification.stale' && event.payload.phase === 'tool'));
});

test('all pending operator inputs survive a tool history larger than the working window', async t => {
  const f = fixture(t);
  const inputs = ['FIRST_KEEP_DATABASE', 'SECOND_USE_UTF8', 'THIRD_NO_PUBLISH'].map(text => f.kernel.addMessage(f.taskId, 'user', text));
  for (let i = 0; i < 190; i++) f.kernel.addMessage(f.taskId, 'assistant', 'Historical observation ' + i + 'x'.repeat(350));
  const built = await f.runner.assembleWork(f.taskId, config);
  for (const input of inputs) assert.ok(built.context.sourceManifest.some(source => source.id === input.id && source.included), input.content + ' must not be skipped');
  assert.equal(built.sampledUserCursor, f.kernel.latestUserCursor(f.taskId));
  assert.ok(JSON.stringify(built.context.messages).length <= 32000);
});

test('a projected prefix cannot mark the unseen remainder of a large operator message consumed', async t => {
  const f = fixture(t);
  const message = f.kernel.addMessage(f.taskId, 'user', 'START\n' + 'long source instruction '.repeat(7000) + '\nTAIL_MUST_NOT_BE_SKIPPED');
  const before = f.kernel.latestUserCursor(f.taskId);
  const built = await f.runner.assembleWork(f.taskId, config);
  assert.ok(built.sampledUserCursor < before, 'previewing a prefix must not advance past its unseen suffix');
  let progress = (built as unknown as { sampledUserInput: { cursor: number; offset: number } }).sampledUserInput;
  if (!progress.offset) {
    f.kernel.addMessage(f.taskId, 'assistant', 'Read the initial input batch.', 'main', { sampledUserCursor: progress.cursor, sampledUserInput: progress });
    progress = (await f.runner.assembleWork(f.taskId, config)).sampledUserInput;
  }
  assert.ok(progress.cursor < before);
  assert.ok(progress.offset > 0 && progress.offset < message.content.length);
  assert.equal(f.kernel.getMessage(message.id)!.content, message.content);
});

test('fragment progress survives a fresh Kernel and presents every original character exactly once', async t => {
  const f = fixture(t), content = 'begin\n' + '原文😀 constraint '.repeat(2500) + '\nend';
  const message = f.kernel.addMessage(f.taskId, 'user', content), cursor = f.kernel.messageCursor(f.taskId, message.id);
  let consumed = '', rounds = 0;
  while (f.kernel.consumedUserInput(f.taskId).cursor < cursor) {
    const reopened = new Kernel(f.root);
    try {
      const runner = new Runner(reopened, f.runner.configuration, f.runner.candidates, f.root);
      const built = await runner.assembleWork(f.taskId, config);
      const range = built.context.sourceManifest.find(item => item.id === message.id)?.inputRange;
      if (range) {
        assert.equal(range.start, consumed.length);
        consumed += content.slice(range.start, range.end);
      }
      reopened.addMessage(f.taskId, 'assistant', 'Saved source-bound input batch.', 'main', { sampledUserCursor: built.sampledUserCursor, sampledUserInput: built.sampledUserInput });
      assert.ok(++rounds < 30);
    } finally { reopened.close(); }
  }
  assert.equal(consumed, content);
  assert.ok(rounds > 2);
});

test('input fragments never split an astral character or advance across an unpresented record', () => {
  const content = '😀'.repeat(2000), rows = [{ cursor: 10, message: { id: 'emoji', content } }, { cursor: 11, message: { id: 'later', content: 'later input' } }];
  let progress = { cursor: 0, offset: 0 }, text = '';
  while (progress.cursor < 10) {
    const batch = projectInputBatch(rows, progress, 601);
    const range = batch.ranges[0]!;
    assert.equal(range.start % 2, 0); assert.equal(range.end % 2, 0);
    text += content.slice(range.start, range.end); progress = batch.progress;
    if (range.end < content.length) assert.equal(progress.cursor, 0);
  }
  assert.equal(text, content);
});
