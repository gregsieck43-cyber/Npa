import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';

for (const finishTool of [false, true]) test(`a user message arriving during Work inference reaches a new normal request before completion review (finish tool=${finishTool})`, { timeout: 20000 }, async t => {
  const root = mkdtempSync(path.resolve('.tmp', 'work-pending-input-'));
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  const normalInputs: string[] = [], order: string[] = [];
  const backend = await startBackend({ dataDir: path.join(root, 'data'), projectRoot: process.cwd(), mockOptions: { responder: async body => {
    if (body.messages[0]?.content.includes('REVIEWER ROLE')) {
      order.push('review'); return { content: JSON.stringify({ verdict: 'unknown', reason: 'Fixture ends after checking request delivery.' }) };
    }
    normalInputs.push(JSON.stringify(body.messages)); order.push('work');
    if (normalInputs.length === 1) { started(); await gate; }
    return { content: 'The original request is complete.', ...(finishTool && normalInputs.length === 1 ? { toolCalls: [{ id: 'old-finish', name: 'finish', arguments: { result: 'The original request is complete.' } }] } : {}) };
  } } });
  t.after(async () => { release(); await backend.close(); assert.equal(path.dirname(root), path.resolve('.tmp')); rmSync(root, { recursive: true, force: true }); });
  const taskId = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    objective: 'Prepare the original report', maxModelCalls: 8,
  } }).taskId!;
  await requested;
  const steering = 'Correction: include the revised verification evidence before finishing.';
  backend.services.command({ commandId: randomUUID(), taskId, type: 'send_message', parameters: { content: steering } });
  release();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && normalInputs.length < 2 && !['waiting_input', 'failed', 'completed'].includes(backend.services.task(taskId).status))
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(normalInputs.length, 2, 'the old response must not finish or wait for review before sampling new user input');
  assert.ok(!normalInputs[0]!.includes(steering)); assert.ok(normalInputs[1]!.includes(steering));
  assert.deepEqual(order.slice(0, 2), ['work', 'work']);
});

test('Work context pins the latest operator instruction beyond the rolling history and keeps chronological tool exchanges', async t => {
  const root = mkdtempSync(path.resolve('.tmp', 'work-pending-input-'));
  const backend = await startBackend({ dataDir: path.join(root, 'data'), projectRoot: process.cwd() });
  await backend.services.runner.stop();
  t.after(async () => { await backend.close(); assert.equal(path.dirname(root), path.resolve('.tmp')); rmSync(root, { recursive: true, force: true }); });
  const kernel = backend.services.kernel;
  const taskId = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { objective: 'Check the project' } }).taskId!;
  const steering = kernel.addMessage(taskId, 'user', 'OPERATOR_CONSTRAINT_KEEP: do not publish until I review.');
  for (let i = 0; i < 170; i++) kernel.addMessage(taskId, 'assistant', 'Observed history ' + i + 'x'.repeat(512));
  const call = kernel.addMessage(taskId, 'assistant', 'Latest read', 'main', { toolCalls: [{ id: 'read-final', name: 'read_file', arguments: { path: 'notes.txt' } }] });
  kernel.addMessage(taskId, 'tool', 'latest tool output', 'main', { toolCallId: 'read-final' });
  const built = await backend.services.runner.assembleWork(taskId, { ...backend.services.configuration.provider, maxRequestBytes: 131072 });
  assert.ok(built.context.sourceManifest.some(source => source.id === steering.id && source.included));
  assert.ok(built.context.sourceManifest.some(source => source.id === call.id && source.included));
  const wire = built.context.messages;
  const userIndex = wire.findIndex(message => message.content?.includes('OPERATOR_CONSTRAINT_KEEP'));
  const toolIndex = wire.findIndex(message => message.tool_calls?.some(tool => tool.id === 'read-final'));
  assert.ok(userIndex >= 0 && userIndex < toolIndex);
  assert.equal(wire[toolIndex + 1]?.tool_call_id, 'read-final');
  assert.ok(JSON.stringify(wire).length <= 32000);
  const longUser = kernel.addMessage(taskId, 'user', '修订约束'.repeat(20000));
  kernel.addMessage(taskId, 'assistant', 'Read a larger result', 'main', { toolCalls: [{ id: 'read-large', name: 'read_file', arguments: { path: 'notes.txt' } }] });
  const longTool = kernel.addMessage(taskId, 'tool', 'result '.repeat(20000), 'main', { toolCallId: 'read-large' });
  const large = await backend.services.runner.assembleWork(taskId, { ...backend.services.configuration.provider, maxRequestBytes: 131072 });
  for (const sourceId of [longUser.id, longTool.id]) assert.ok(large.context.sourceManifest.some(source => source.id === sourceId && source.included && source.truncated));
  assert.ok(JSON.stringify(large.context.messages).length <= 32000);
  assert.equal(kernel.getMessage(longUser.id)!.content, longUser.content);
  assert.equal(kernel.getMessage(longTool.id)!.content, longTool.content);
});

for (const legacy of [false, true]) test(`restarted pending finish cannot consume a newer user instruction (legacy=${legacy})`, async t => {
  const root = mkdtempSync(path.resolve('.tmp', 'work-pending-input-')), dataDir = path.join(root, 'data');
  let backend = await startBackend({ dataDir, projectRoot: process.cwd() });
  await backend.services.runner.stop();
  t.after(async () => { await backend.close(); assert.equal(path.dirname(root), path.resolve('.tmp')); rmSync(root, { recursive: true, force: true }); });
  const kernel = backend.services.kernel;
  const taskId = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { objective: 'Original task', maxModelCalls: 8 } }).taskId!;
  kernel.addMessage(taskId, 'assistant', 'Old finish proposal', 'main', {
    toolCalls: [{ id: 'persisted-finish', name: 'finish', arguments: { result: 'STALE_PROPOSAL' } }],
    ...(legacy ? {} : { sampledUserCursor: kernel.latestUserCursor(taskId) }),
  });
  backend.services.command({ commandId: randomUUID(), taskId, type: 'send_message', parameters: { content: 'NEW_REQUIREMENT_AFTER_PROPOSAL' } });
  await backend.close();
  const inputs: string[] = [], reviewed: string[] = [];
  backend = await startBackend({ dataDir, projectRoot: process.cwd(), mockOptions: { responder: body => {
    if (body.messages[0]?.content.includes('REVIEWER ROLE')) {
      reviewed.push(JSON.stringify(body.messages)); return { content: '{"verdict":"unknown"}' };
    }
    inputs.push(JSON.stringify(body.messages)); return { content: 'Fresh response' };
  } } });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !['waiting_input', 'failed', 'completed'].includes(backend.services.task(taskId).status)) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(inputs.length, 1); assert.ok(inputs[0]!.includes('NEW_REQUIREMENT_AFTER_PROPOSAL'));
  assert.ok(reviewed.every(wire => !wire.includes('STALE_PROPOSAL')));
  assert.equal(backend.services.kernel.pendingCalls(taskId).length, 0);
  assert.equal(backend.services.kernel.intents(taskId).length, 0, 'the stale local proposal did not create any effect');
  assert.ok(backend.services.kernel.events(taskId).some(event => event.type === 'verification.stale' && event.payload.phase === 'input'));
});
