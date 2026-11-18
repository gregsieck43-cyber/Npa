import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { ToolCall } from '../src/contracts.js';
import { Kernel, KernelError } from '../src/kernel/index.js';

/**
 * Model output is untrusted at the Kernel storage boundary. These checks use the real Kernel and
 * SQLite database: malformed or duplicate tool-call ids must fail as a typed KernelError without
 * persisting a message, pending call or event, while valid opaque ids keep the existing lifecycle.
 */

const isCode = (code: string) => (error: unknown): boolean => error instanceof KernelError && error.code === code;

function fixture(run: (kernel: Kernel, reopen: () => Kernel) => void): void {
  const root = path.resolve('.tmp');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'kernel-message-validation-'));
  let kernel = new Kernel(directory);
  const reopen = (): Kernel => { kernel.close(); kernel = new Kernel(directory); return kernel; };
  try { run(kernel, reopen); }
  finally {
    kernel.close();
    assert.ok(directory.startsWith(root + path.sep), 'Fixtures stay inside the checkout temp root');
    rmSync(directory, { recursive: true, force: true });
  }
}

function create(kernel: Kernel): string {
  const ack = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: 'Validate untrusted tool calls' } });
  return ack.taskId!;
}

function state(kernel: Kernel, taskId: string) {
  return {
    messages: kernel.messageCount(taskId),
    pending: kernel.pendingCalls(taskId),
    events: kernel.events(taskId).length,
  };
}

const call = (id: string, name = 'read_file', args: Record<string, unknown> = { path: 'notes.txt' }): ToolCall => ({ id, name, arguments: args });

test('a duplicate tool call id is rejected as a typed KernelError without persisting a partial row', () => fixture((kernel, reopen) => {
  const taskId = create(kernel);
  const before = state(kernel, taskId);
  const repeated = call('repeated-call');
  assert.throws(
    () => kernel.addMessage(taskId, 'assistant', '', 'main', { toolCalls: [repeated, repeated] }),
    isCode('INVALID_TOOL_CALL'),
    'A duplicate id must surface as INVALID_TOOL_CALL, not a raw SQLite constraint error',
  );
  assert.deepEqual(state(kernel, taskId), before, 'The rejected append must leave messages, pending calls and events untouched');

  // The same transaction boundary must still accept a later valid message: a failed append cannot
  // leave the connection inside a transaction or poison the pending-call projection.
  const accepted = kernel.addMessage(taskId, 'assistant', '', 'main', { toolCalls: [call('accepted-call')] });
  assert.equal(kernel.messageCount(taskId), before.messages + 1);
  assert.deepEqual(kernel.pendingCalls(taskId).map(pending => pending.call.id), ['accepted-call']);
  assert.deepEqual(kernel.events(taskId).at(-1)!.type, 'message.appended');
  assert.equal(kernel.events(taskId).length, before.events + 1);
  assert.equal(kernel.events(taskId).at(-1)!.payload.messageId, accepted.id);

  const after = state(kernel, taskId);
  const reopened = reopen();
  assert.deepEqual(state(reopened, taskId), after, 'A rejected append must stay absent after reopen, and the accepted message must remain whole');
}));

test('empty, whitespace or malformed tool call ids and shapes are rejected before any write', () => fixture(kernel => {
  const taskId = create(kernel);
  const before = state(kernel, taskId);
  const malformed: unknown[] = [
    call(''),
    call('   '),
    { id: 7, name: 'read_file', arguments: {} },
    { name: 'read_file', arguments: {} },
    null,
    call('missing-name', ''),
    { id: 'array-arguments', name: 'read_file', arguments: [] },
    { id: 'null-arguments', name: 'read_file', arguments: null },
  ];
  for (const [index, value] of malformed.entries()) {
    assert.throws(
      () => kernel.addMessage(taskId, 'assistant', '', 'main', { toolCalls: [value as ToolCall] }),
      isCode('INVALID_TOOL_CALL'),
      'Malformed tool call ' + index + ' must be rejected as INVALID_TOOL_CALL',
    );
    assert.deepEqual(state(kernel, taskId), before, 'Malformed tool call ' + index + ' must not persist anything');
  }
  assert.throws(
    () => kernel.addMessage(taskId, 'tool', 'result', 'main', { toolCallId: '' }),
    isCode('INVALID_TOOL_CALL'),
    'A tool result with an empty call id cannot be correlated',
  );
  assert.throws(
    () => kernel.addMessage(taskId, 'tool', 'result', 'main', { toolCallId: '   ' }),
    isCode('INVALID_TOOL_CALL'),
  );
  assert.deepEqual(state(kernel, taskId), before, 'A rejected tool result must not append a message or event');
  assert.equal(kernel.getMessages(taskId).length, before.messages);
}));

test('unique opaque ids keep the pending-call lifecycle and cross-message reuse unchanged', () => fixture(kernel => {
  const taskId = create(kernel);
  const first = call('call-a', 'read_file', { path: 'a.txt' });
  const second = call('call-b', 'read_file', { path: 'b.txt' });
  const proposal = kernel.addMessage(taskId, 'assistant', '', 'main', { toolCalls: [first, second] });
  assert.deepEqual(kernel.getMessages(taskId).at(-1)!.toolCalls, [first, second], 'Valid ids and arguments round-trip unchanged');
  assert.deepEqual(kernel.pendingCalls(taskId), [{ messageId: proposal.id, call: first }, { messageId: proposal.id, call: second }]);

  kernel.addMessage(taskId, 'tool', 'result for a', 'main', { toolCallId: first.id });
  assert.deepEqual(kernel.pendingCalls(taskId).map(pending => pending.call.id), [second.id], 'A tool result removes only its own pending call');
  kernel.addMessage(taskId, 'tool', 'result for b', 'main', { toolCallId: second.id });
  assert.deepEqual(kernel.pendingCalls(taskId), []);

  // Provider ids are opaque and may legitimately be reused in a newer assistant message: only
  // duplicates inside the same message are invalid.
  const reused = kernel.addMessage(taskId, 'assistant', '', 'main', { toolCalls: [call(second.id, 'read_file', { path: 'b2.txt' })] });
  const pending = kernel.pendingCalls(taskId);
  assert.deepEqual(pending.map(item => item.call.id), [second.id]);
  assert.equal(pending[0]!.messageId, reused.id, 'The reused id belongs to the newer assistant message');
  kernel.addMessage(taskId, 'tool', 'result for reused b', 'main', { toolCallId: second.id });
  assert.deepEqual(kernel.pendingCalls(taskId), []);

  // Empty call lists and absent ids are ordinary messages, not malformed tool calls.
  kernel.addMessage(taskId, 'assistant', 'No tools needed.', 'main', { toolCalls: [] });
  kernel.addMessage(taskId, 'assistant', 'Still no tools needed.');
  assert.equal(kernel.messageCount(taskId), 8);
}));
