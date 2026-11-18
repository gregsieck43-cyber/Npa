/**
 * Readable provider reasoning: wire projection contract (RED-first).
 *
 * The DeepSeek thinking-mode guide (verified 2026-10-26) requires every assistant message that a
 * tools-carrying request sends back to include its complete reasoning_content, including final
 * answers without tool calls. A request without tools may omit reasoning. This suite pins the real
 * Chat compile and Work assembly plus the shared bounded projection: reasoning is counted against
 * the working-context budget, is never truncated into a fake-complete field, and an exchange that
 * cannot fit fails explicitly instead of silently losing reasoning.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Services } from '../src/app/services.js';
import { Harness } from '../src/harness/service.js';
import { projectContext } from '../src/runtime/context.js';
import { toWireMessages } from '../src/runtime/prompts.js';
import { workingContextBudget } from '../src/runtime/context-budget.js';
import { Kernel } from '../src/kernel/index.js';
import type { Message } from '../src/contracts.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');
mkdirSync(root, { recursive: true });
const NOW = '2026-10-30T00:00:00.000Z';

const message = (id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message =>
  ({ id, taskId: 'wire-task', sessionId: 'main', role, content, createdAt: NOW, ...extra });

/** Real Services + Harness over a private data directory; the runner is not started because these
 *  RED regressions inspect compilation and assembly, not execution. */
async function fixture(t: import('node:test').TestContext) {
  const owned = mkdtempSync(path.join(root, 'readable-reasoning-wire-'));
  const services = new Services(path.join(owned, 'data'), owned, 'http://127.0.0.1:1/provider/v1', owned);
  services.harness = new Harness(services);
  t.after(async () => {
    await services.harness!.stop();
    await services.external.close();
    services.harness!.close();
    services.integrations.close();
    services.kernel.close();
    assert.equal(path.dirname(owned), root);
    rmSync(owned, { recursive: true, force: true });
  });
  return { owned, services, harness: services.harness! };
}

const memoryOnlyChat = { web: false, tools: false, mcp: false, skills: false, projectInstructions: false };

test('Chat compile sends every selected assistant reasoning when the request carries tools', async t => {
  const f = await fixture(t);
  const session = f.harness.store.createSession({ title: 'reasoning wire chat', workspace: f.owned, capabilities: memoryOnlyChat });
  const add = (role: Message['role'], content: string, extra: Partial<Message> = {}) =>
    f.harness.store.addMessage(session.id, { role, content, ...extra });
  const first = 'Round one: list the workspace before answering.';
  const second = 'Round two: the listing is enough, answer now.';
  const final = 'Final answer reasoning from the preceding user turn.';
  add('user', 'First question');
  add('assistant', '', { reasoningContent: first, toolCalls: [{ id: 'call-1', name: 'list_files', arguments: { path: '.' } }] });
  add('tool', 'first tool result', { toolCallId: 'call-1' });
  add('assistant', '', { reasoningContent: second, toolCalls: [{ id: 'call-2', name: 'read_file', arguments: { path: 'a.txt' } }] });
  add('tool', 'second tool result', { toolCallId: 'call-2' });
  add('assistant', 'Final answer', { reasoningContent: final });
  add('user', 'Third question');

  const { body } = await f.harness.chat.preview(session.id);
  const assistants = body.messages.filter((item: any) => item.role === 'assistant');
  assert.equal(assistants.length, 3, 'all three selected assistant turns must reach the wire');
  assert.deepEqual(assistants.map((item: any) => item.reasoning_content), [first, second, final]);
  assert.ok(Array.isArray(body.tools) && body.tools.length > 0, 'the Chat request really carries tools');
  for (const item of body.messages) {
    if (item.role !== 'assistant') assert.equal(item.reasoning_content, undefined, 'reasoning belongs only to assistant messages');
    // Program-generated archive navigation may quote raw stored records verbatim; the no-merge rule
    // applies to the assistant payload itself (reasoning exists only in reasoning_content).
    if (item.role === 'assistant') for (const line of [first, second, final])
      assert.equal(String(item.content ?? '').includes(line), false, 'reasoning must never be merged into assistant content');
    if (item.role === 'system') for (const line of [first, second, final])
      assert.equal(item.content.includes(line), false, 'reasoning must never become a system instruction');
  }
  const budget = workingContextBudget(f.harness.profiles.get('default').provider, body.tools);
  assert.ok(JSON.stringify(body.messages).length <= budget, 'reasoning must stay inside the working-context budget');
  assert.deepEqual(f.harness.store.messages(session.id).filter(item => item.role === 'assistant').map(item => item.reasoningContent),
    [first, second, final], 'compiling a preview never rewrites stored history');
});

test('Work assembly sends every selected assistant reasoning while tools are exposed', async t => {
  const f = await fixture(t);
  const ack = f.services.command({ commandId: 'work-wire-reasoning', type: 'create_task', parameters: {
    title: 'Reasoning wire work', goal: { objective: 'Answer the two questions', constraints: [], acceptance: [], maxModelCalls: 4, maxToolCalls: 10, mode: 'collaborative' },
  } });
  const taskId = ack.taskId!;
  const add = (role: Message['role'], content: string, extra: Partial<Message> = {}) =>
    f.services.kernel.addMessage(taskId, role, content, 'main', extra);
  const first = 'Work round one: inspect the task workspace.';
  const second = 'Work round two: use the inspected file.';
  const final = 'Work final answer reasoning from the preceding user turn.';
  add('user', 'First Work question');
  add('assistant', '', { reasoningContent: first, toolCalls: [{ id: 'work-call-1', name: 'list_files', arguments: { path: '.' } }] });
  add('tool', 'first Work tool result', { toolCallId: 'work-call-1' });
  add('assistant', '', { reasoningContent: second, toolCalls: [{ id: 'work-call-2', name: 'read_file', arguments: { path: 'b.txt' } }] });
  add('tool', 'second Work tool result', { toolCallId: 'work-call-2' });
  add('assistant', 'Work final answer', { reasoningContent: final });
  add('user', 'Second Work question');

  const config = f.harness.profiles.get('default').provider;
  const assembled = await f.services.runner.assembleWork(taskId, config);
  const assistants = assembled.context.messages.filter(item => item.role === 'assistant');
  assert.deepEqual(assistants.filter(item => item.reasoning_content !== undefined).map(item => item.reasoning_content), [first, second, final],
    'Work must replay every selected assistant reasoning, not only the last tool call');
  assert.ok(assembled.tools.length > 0, 'Work really exposes tools');
  const budget = workingContextBudget(config, assembled.tools);
  assert.ok(JSON.stringify(assembled.context.messages).length <= budget, 'Work reasoning must stay inside the working-context budget');
  for (const item of assembled.context.messages) {
    // Archive navigation quotes raw stored records verbatim; only the assistant payload and the
    // system instruction must never absorb reasoning text.
    if (item.role === 'assistant') for (const line of [first, second, final])
      assert.equal(String(item.content ?? '').includes(line), false, 'Work reasoning must never be merged into assistant content');
    if (item.role === 'system') for (const line of [first, second, final])
      assert.equal(String(item.content).includes(line), false, 'Work reasoning must never become a system instruction');
  }
});

test('a projection without tools omits reasoning entirely, while a tools projection adds it', () => {
  const messages: Message[] = [
    message('u1', 'user', 'Question'),
    message('a1', 'assistant', 'Answer', { reasoningContent: 'hidden plan' }),
  ];
  const prefix = [{ role: 'system' as const, content: 'system' }];
  const withTools = projectContext({ messages, prefix, includeReasoning: true } as never);
  assert.equal(withTools.messages.find(item => item.role === 'assistant')?.reasoning_content, 'hidden plan');
  const withoutTools = projectContext({ messages, prefix, includeReasoning: false } as never);
  assert.equal(withoutTools.messages.find(item => item.role === 'assistant')?.reasoning_content, undefined);
  assert.deepEqual(toWireMessages(messages, true as never).map(item => item.reasoning_content), [undefined, 'hidden plan']);
  assert.deepEqual(toWireMessages(messages, false as never).map(item => item.reasoning_content), [undefined, undefined]);
  assert.equal(toWireMessages(messages)[1]?.reasoning_content, undefined, 'the default projection stays without reasoning');
});

test('a constrained budget omits an oversized exchange whole instead of truncating its reasoning', () => {
  const huge = 'reasoning-'.repeat(500);
  const messages: Message[] = [
    message('u-old', 'user', 'Old question'),
    message('a-old', 'assistant', 'old answer', { reasoningContent: huge, toolCalls: [{ id: 'old-call', name: 'read_file', arguments: { path: 'old.txt' } }] }),
    message('t-old', 'tool', 'old tool result', { toolCallId: 'old-call' }),
    message('a-new', 'assistant', 'new answer', { reasoningContent: 'short new reasoning' }),
    message('u-new', 'user', 'New question'),
  ];
  const raw = JSON.stringify(messages);
  const prefix = [{ role: 'system' as const, content: 'system' }];
  const included = projectContext({ messages, prefix, maxChars: 2048, includeReasoning: false } as never);
  assert.ok(included.messages.some(item => item.role === 'assistant' && item.content === 'old answer'),
    'without reasoning the old exchange fits, so the comparison really isolates the reasoning cost');
  const bounded = projectContext({ messages, prefix, maxChars: 2048, includeReasoning: true } as never);
  const wireAssistants = bounded.messages.filter(item => item.role === 'assistant');
  assert.equal(wireAssistants.some(item => item.reasoning_content === huge), false, 'an oversized exchange must be omitted whole');
  assert.equal(wireAssistants.some(item => item.content === 'old answer'), false, 'the exchange content must be omitted with its reasoning');
  assert.ok(wireAssistants.some(item => item.reasoning_content === 'short new reasoning'), 'the newest selected exchange keeps its complete reasoning');
  const originals = new Set(messages.map(item => item.reasoningContent).filter((value): value is string => typeof value === 'string'));
  for (const item of bounded.messages) {
    if (item.reasoning_content !== undefined) assert.ok(originals.has(item.reasoning_content),
      'reasoning must be replayed whole or omitted, never truncated into a fake-complete field');
  }
  assert.ok(bounded.omittedIds.includes('a-old') && bounded.omittedIds.includes('t-old'), 'the omitted exchange is archived by id');
  assert.ok(JSON.stringify(bounded.messages).length <= 2048, 'the bounded projection must not exceed its budget');
  assert.equal(JSON.stringify(messages), raw, 'bounded projection never rewrites raw history');
});

test('the newest required exchange that cannot fit is an explicit budget error, never a silent reasoning drop', () => {
  const huge = 'budget-'.repeat(800);
  const messages: Message[] = [
    message('u1', 'user', 'Question'),
    message('a1', 'assistant', 'answer', { reasoningContent: huge, toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'x.txt' } }] }),
    message('t1', 'tool', 'result', { toolCallId: 'call-1' }),
  ];
  const prefix = [{ role: 'system' as const, content: 's' }];
  assert.throws(() => projectContext({ messages, prefix, maxChars: 2048, includeReasoning: true } as never), /working context budget/);
  const withoutReasoning = projectContext({ messages, prefix, maxChars: 2048, includeReasoning: false } as never);
  assert.equal(withoutReasoning.messages.find(item => item.role === 'assistant')?.content, 'answer',
    'the same exchange fits when reasoning is not projected');
});

test('branch copies sanitize reasoning with the same redaction as content', async t => {
  const f = await fixture(t);
  const secret = 'example-only-value';
  f.services.configuration.set({ apiKey: secret });
  const session = f.harness.store.createSession({ title: 'branch redaction', capabilities: memoryOnlyChat });
  f.harness.store.addMessage(session.id, { role: 'user', content: 'Question' });
  const assistant = f.harness.store.addMessage(session.id, { role: 'assistant', content: 'answer ' + secret, reasoningContent: 'plan ' + secret + ' end' });
  const branch = await f.harness.chat.branch(session.id, { messageId: assistant.id });
  const copied = f.harness.store.messages(branch.id).find(item => item.role === 'assistant');
  assert.equal(copied?.content, 'answer [credential redacted]');
  assert.equal(copied?.reasoningContent, 'plan [credential redacted] end', 'branch reasoning must pass through the content sanitizer');
  const original = f.harness.store.messages(session.id).find(item => item.id === assistant.id);
  assert.equal(original?.reasoningContent, 'plan ' + secret + ' end', 'the original record keeps its exact bytes');
});

test('the Kernel treats blank provider reasoning as absent instead of failing the turn', t => {
  const owned = mkdtempSync(path.join(root, 'readable-reasoning-kernel-'));
  const kernel = new Kernel(path.join(owned, 'kernel'));
  t.after(() => { kernel.close(); rmSync(owned, { recursive: true, force: true }); });
  const ack = kernel.command({ commandId: 'kernel-blank-reasoning', type: 'create_task', parameters: {
    title: 'blank reasoning', goal: { objective: 'answer', constraints: [], acceptance: [], maxModelCalls: 1, mode: 'collaborative' },
  } });
  const taskId = ack.taskId!;
  const blank = kernel.addMessage(taskId, 'assistant', 'answer', 'main', { reasoningContent: '   \n\t ' });
  assert.equal(blank.reasoningContent, undefined, 'whitespace-only reasoning is not persisted as a thinking block');
  assert.equal(kernel.getMessage(blank.id)?.reasoningContent, undefined);
  const normal = kernel.addMessage(taskId, 'assistant', 'answer two', 'main', { reasoningContent: '  kept text  ' });
  assert.equal(normal.reasoningContent, '  kept text  ', 'real reasoning keeps its exact text');
  assert.throws(() => kernel.addMessage(taskId, 'user', 'question', 'main', { reasoningContent: 'not allowed' }),
    (error: any) => String(error?.code ?? '') === 'INVALID_MESSAGE', 'reasoning still belongs only to assistant messages');
});
