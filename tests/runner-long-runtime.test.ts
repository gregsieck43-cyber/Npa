import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Kernel } from '../src/kernel/index.js';
import { Runner } from '../src/app/runner.js';
import { ModelDiagnosticError } from '../src/runtime/model.js';
import type { Configuration } from '../src/app/configuration.js';
import type { CandidateManager } from '../src/adaptation/index.js';
import type { WireMessage } from '../src/contracts.js';

test('separate rate limits after successful model calls do not exhaust a task lifetime retry count', { timeout: 15000 }, async t => {
  const tempRoot = path.resolve('.tmp');
  const owned = mkdtempSync(path.join(tempRoot, 'long-runtime-'));
  const kernel = new Kernel(owned);
  let clock = Date.now(), calls = 0;
  const originalNow = Date.now;
  Date.now = () => clock;
  const configuration = {
    globalPaths: [], skillRoots: [], redact: (value: string) => value, sanitize: (value: unknown) => value,
    client: () => ({ config: {}, complete: async () => {
      calls++;
      if (calls % 2) throw new ModelDiagnosticError('rate_limited', 'Controlled provider outage', true, 60_000);
      return { content: '', toolCalls: [{ id: `ask-${calls}`, name: 'ask_user', arguments: { question: 'Next checkpoint?', reason: 'blocker' } }], finishReason: 'tool_calls' };
    } }),
  } as unknown as Configuration;
  const candidates = { snapshotFor: () => ({}), applySnapshot: async (_: unknown, value: string) => value } as unknown as CandidateManager;
  const runner = new Runner(kernel, configuration, candidates, owned);
  t.after(async () => {
    await runner.stop(); Date.now = originalNow; kernel.close();
    assert.equal(path.dirname(owned), tempRoot); rmSync(owned, { recursive: true, force: true });
  });
  const taskId = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { objective: 'Produce checked milestones across repeated provider outages', maxModelCalls: 20 } }).taskId!;
  const until = async (condition: () => boolean) => {
    const deadline = performance.now() + 3000;
    while (!condition() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(condition(), `Expected runtime state, actual ${kernel.getTask(taskId)!.status}, calls ${calls}`);
  };
  runner.start();
  for (let cycle = 0; cycle < 3; cycle++) {
    await until(() => calls === cycle * 2 + 1 && kernel.getTask(taskId)!.status !== 'running');
    assert.equal(kernel.getTask(taskId)!.status, 'queued', 'A fresh outage after a successful response must still be recoverable');
    clock += 24 * 60 * 60 * 1000 * 7; // Accelerate seven days, not seven days of wall-clock evidence.
    await until(() => kernel.getTask(taskId)!.status === 'waiting_input');
    if (cycle < 2) kernel.command({ commandId: randomUUID(), type: 'send_message', taskId, parameters: { content: 'Proceed to the next recorded checkpoint.' } });
  }
  assert.equal(calls, 6);
  assert.equal(kernel.events(taskId).filter(event => event.type === 'model.retry_scheduled').length, 3);
  assert.equal(kernel.getMessages(taskId).filter(message => message.role === 'user').length, 3, 'Scheduling adds no synthetic continue messages');
});

test('Work model loop searches, pages and remembers an archived tool result beyond the rolling window', { timeout: 40000 }, async t => {
  const tempRoot = path.resolve(process.env.TEMP ?? '.tmp'), owned = mkdtempSync(path.join(tempRoot, 'recall-runtime-'));
  const kernel = new Kernel(owned), seen: WireMessage[][] = [];
  let summaryCalls = 0;
  // 3 ordered input samples (the third can search), 5 archive/recall continuations,
  // 5 raw-source phase summaries, plus one reserved possible completion-review slot.
  const taskId = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { objective: 'Recover the rare archived build requirement', maxModelCalls: 14 } }).taskId!;
  const source = kernel.addMessage(taskId, 'tool', 'old output '.repeat(1600) + 'LANTERN-725 build requires UTF-8 BOM.', 'main', { toolCallId: 'old-completed-call' });
  for (let index = 0; index < 170; index++) kernel.addMessage(taskId, index % 2 ? 'assistant' : 'user', `Later progress ${index}`);
  assert.ok(!kernel.tailMessages(taskId).some(message => message.id === source.id));
  const configuration = {
    globalPaths: [], skillRoots: [], redact: (value: string) => value, sanitize: (value: unknown) => value,
    client: () => ({ config: {}, complete: async (messages: WireMessage[]) => {
      if (messages[0]?.content?.startsWith('Summarize only these bounded original archive')) {
        summaryCalls++; return { content: 'Completed observations remain recoverable from their original archive.', toolCalls: [], finishReason: 'stop' };
      }
      seen.push(messages);
      const last = [...messages].reverse().find(message => message.role === 'tool');
      const result = last ? JSON.parse(last.content!) : undefined;
      const call = !last ? { id: 'search', name: 'search_history', arguments: { query: 'LANTERN-725' } }
        : last.tool_call_id === 'search' ? { id: 'read-0', name: 'read_history', arguments: { id: result.results[0].id, length: 6000 } }
        : last.tool_call_id?.startsWith('read-') && result.nextOffset !== null ? { id: `read-${result.nextOffset}`, name: 'read_history', arguments: { id: result.id, offset: result.nextOffset, length: 6000 } }
        : last.tool_call_id?.startsWith('read-') ? { id: 'remember', name: 'remember', arguments: { key: 'build-encoding', kind: 'constraint', text: result.text.match(/LANTERN-725.*$/)?.[0] ?? '', sourceIds: [source.id], expectedRevision: 0 } }
        : { id: 'ask', name: 'ask_user', arguments: { question: 'Recovered evidence is ready; choose the next test.', reason: 'blocker' } };
      return { content: '', toolCalls: [call], finishReason: 'tool_calls' };
    } }),
  } as unknown as Configuration;
  const candidates = { snapshotFor: () => ({}), applySnapshot: async (_: unknown, value: string) => value } as unknown as CandidateManager;
  const runner = new Runner(kernel, configuration, candidates, owned);
  t.after(async () => { await runner.stop(); kernel.close(); assert.equal(path.dirname(owned), tempRoot); rmSync(owned, { recursive: true, force: true }); });
  runner.start();
  const until = performance.now() + 30000;
  while (kernel.getTask(taskId)!.status !== 'waiting_input' && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(kernel.getTask(taskId)!.status, 'waiting_input', kernel.getTask(taskId)!.error);
  const inputSamples = kernel.events(taskId).filter(event => event.type === 'verification.stale' && event.payload.phase === 'input').length;
  assert.equal(inputSamples, 2); assert.equal(summaryCalls, 5);
  assert.equal(seen.length, 6 + inputSamples, 'Ordered ingestion samples precede the same six history/recall operations');
  assert.equal(kernel.getBudgets(taskId).modelCalls, 13);
  assert.equal(kernel.consumedUserInput(taskId).cursor, kernel.latestUserCursor(taskId));
  for (let index = 0; index < 170; index += 2) assert.ok(seen.some(messages => messages.some(message => message.role === 'user' && message.content === `Later progress ${index}`)), `Input ${index} was actually presented`);
  assert.match(kernel.memory(taskId).notes().notes.find(note => note.key === 'build-encoding')!.text, /LANTERN-725 build requires UTF-8 BOM/);
  const rawPages = kernel.tailMessages(taskId, 160).filter(message => message.role === 'tool' && message.toolCallId?.startsWith('read-')).map(message => JSON.parse(message.content));
  assert.deepEqual(rawPages.map(page => page.offset), [0, 6000, 12000]);
  assert.equal(rawPages.map(page => page.text).join(''), source.content, 'Three source pages reconstruct the full original output');
  assert.equal(kernel.getMessage(source.id)!.content.length, source.content.length);
  const lastWire = JSON.stringify(seen.at(-1));
  assert.match(lastWire, /Archive navigation/); assert.match(lastWire, /build-encoding/);
});

test('new invalid tool proposals return correctable errors without ending Work or granting effects', { timeout: 15000 }, async t => {
  const tempRoot = path.resolve('.tmp'), owned = mkdtempSync(path.join(tempRoot, 'tool-correction-')), kernel = new Kernel(owned);
  let calls = 0;
  const configuration = {
    globalPaths: [], skillRoots: [], redact: (value: string) => value, sanitize: (value: unknown) => value,
    client: () => ({ config: {}, complete: async (messages: WireMessage[]) => {
      calls++;
      if (calls > 1) {
        const result = JSON.parse(messages.findLast(message => message.role === 'tool')!.content!);
        assert.equal(result.executed, false); assert.match(result.recovery, /Permissions have not changed/);
      }
      const call = calls === 1 ? { id: 'typo', name: 'nonexistent_tool', arguments: {} }
        : calls === 2 ? { id: 'blocked', name: 'read_file', arguments: { path: 'API.txt' } }
        : { id: 'wait', name: 'ask_user', arguments: { question: 'Select the allowed input file.', reason: 'blocker' } };
      return { content: '', toolCalls: [call], finishReason: 'tool_calls' };
    } }),
  } as unknown as Configuration;
  const candidates = { snapshotFor: () => ({}), applySnapshot: async (_: unknown, value: string) => value } as unknown as CandidateManager;
  const runner = new Runner(kernel, configuration, candidates, owned);
  t.after(async () => { await runner.stop(); kernel.close(); assert.equal(path.dirname(owned), tempRoot); rmSync(owned, { recursive: true, force: true }); });
  const taskId = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { objective: 'Correct tool arguments and keep working', maxModelCalls: 5 } }).taskId!;
  runner.start(); const deadline = performance.now() + 10000;
  while (kernel.getTask(taskId)!.status !== 'waiting_input' && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(kernel.getTask(taskId)!.status, 'waiting_input', kernel.getTask(taskId)!.error);
  assert.equal(calls, 3); assert.equal(kernel.intents(taskId).length, 0);
  assert.equal(kernel.pendingCalls(taskId).length, 0);
});
