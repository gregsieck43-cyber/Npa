import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inspectEffects } from '../src/app/verification.js';
import * as verification from '../src/app/verification.js';
import type { Task, Intent } from '../src/contracts.js';
import { ToolGateway } from '../src/tools/gateway.js';
import { Kernel } from '../src/kernel/index.js';
import { randomUUID } from 'node:crypto';
import { startBackend } from '../src/app/backend.js';

test('paged final verification accepts legal multibyte and maximally JSON-escaped writes within a fixed page budget', { timeout: 60000 }, async t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'review-write-011-'));
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const kernel = new Kernel(path.join(root, 'data'));
  t.after(() => { kernel.close(); assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  const taskId = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, objective: 'Validate every legal file write', acceptance: ['file:unicode.txt', 'file:escaped-a.txt', 'file:escaped-b.txt'] } }).taskId!;
  const run = kernel.createRun(taskId); kernel.transition(taskId, 'running');
  const gateway = new ToolGateway({ workspace, receiptDirectory: path.join(root, 'receipts') });
  for (const [filename, content] of [['unicode.txt', '中'.repeat(400000)], ['escaped-a.txt', '\0'.repeat(1000000)], ['escaped-b.txt', '\0'.repeat(1000000)]]) {
    const call = { id: filename!, name: 'write_file', arguments: { path: filename!, content: content! } };
    const prepared = await gateway.prepare(call), intent = kernel.prepareIntent(taskId, run.id, { ...call, arguments: prepared.arguments });
    kernel.approve(intent.id); kernel.dispatch(intent.id);
    const outcome = await gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
    assert.equal(outcome.status, 'applied'); kernel.receipt(intent.id, outcome.receipt!);
  }
  let pages = 0;
  const review = await inspectEffects(kernel.getTask(taskId)!, {
    page: (after, limit) => { const page = kernel.intentPage(taskId, after, limit); pages++; assert.ok(Buffer.byteLength(JSON.stringify(page.items)) <= 8 * 1024 * 1024); return page; },
    isLatestWrite: intent => kernel.isLatestAppliedWrite(taskId, intent.id, String(intent.arguments.path)),
  }, gateway, undefined, path.join(root, 'artifacts'));
  assert.equal(pages, 2); assert.equal(review.receiptCount, 3); assert.equal(review.passed, true, JSON.stringify(review.findings));
});

test('independent effect review checks every receipt without retaining every receipt in reviewer input', async t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'review-011-'));
  t.after(() => { assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  const task = { id: 'large-review', workspace: root, goal: { acceptance: ['fixture:count=1'] } } as Task;
  const intents = Array.from({ length: 1200 }, (_, i) => ({ id: 'intent-' + i, taskId: task.id, name: 'fixture_increment', arguments: { amount: 1 }, state: 'applied', effectKey: 'effect-' + i, toolCallId: 'call-' + i } as unknown as Intent));
  let queries = 0;
  const gateway = { queryOutcome: async () => { queries++; return { status: 'applied', receipt: { fixtureValue: 1, opaqueEvidence: 'r'.repeat(4096) } }; } } as unknown as ToolGateway;
  const review = await inspectEffects(task, intents, gateway, undefined, root);
  assert.equal(queries, intents.length, 'bounded reviewer input must not weaken independent validation');
  assert.equal(review.passed, true);
  assert.ok(JSON.stringify(review).length < 32000, 'reviewer input must not grow with the lifetime receipt count');
  const detail = (review as unknown as { detail: { path: string; records: number } }).detail;
  assert.ok(detail.records >= intents.length);
  assert.match(readFileSync(detail.path, 'utf8'), /intent-1199/);
});

test('paged effect review retains late failures even when only a bounded sample is returned', async t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'review-page-011-'));
  t.after(() => { assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  const task = { id: 'paged-review', workspace: root, goal: { acceptance: ['manual:operator checks quality'] } } as Task;
  let read = 0, calls = 0;
  const source = {
    page(after: number, limit: number) {
      assert.equal(limit, 100); calls++;
      const count = Math.min(limit, 235 - after); read += count;
      return { items: Array.from({ length: count }, (_, offset) => ({ id: 'effect-' + (after + offset), state: after + offset < 210 ? 'applied' : 'unknown', name: 'read_file', arguments: {}, effectKey: 'effect-' + (after + offset) } as unknown as Intent)), nextCursor: after + count < 235 ? after + count : null };
    },
    isLatestWrite: () => false,
  };
  const gateway = { queryOutcome: async () => ({ status: 'applied', receipt: { fixtureValue: 1 } }) } as unknown as ToolGateway;
  const review = await inspectEffects(task, source, gateway, undefined, root);
  assert.equal(calls, 3); assert.equal(read, 235);
  assert.equal(review.receiptCount, 210); assert.equal(review.findingCount, 26);
  assert.equal(review.hardFindingCount, 25);
  assert.equal(review.findings.length, 20); assert.equal(review.passed, false); assert.equal(review.manualAcceptance, true);
  const detail = readFileSync(review.detail!.path, 'utf8');
  assert.match(detail, /effect-234/); assert.match(detail, /Manual acceptance needed/);
});

test('manual acceptance cannot hide a late hard failure outside the returned finding sample', async t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'review-hard-011-'));
  t.after(() => { assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  const task = { id: 'manual-sample', workspace: root, goal: { acceptance: [...Array.from({ length: 25 }, (_, i) => 'manual:' + i), 'file:missing.txt'] } } as Task;
  const review = await inspectEffects(task, [], {} as ToolGateway, undefined, root);
  assert.equal(review.findings.length, 20); assert.equal(review.hardFindingCount, 1);
  assert.ok(review.findings.every(finding => !finding.includes('missing.txt')));
});

test('review evidence paging bounds large records and reconstructs exact Unicode bytes', async t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'review-read-011-'));
  t.after(() => { assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  const filename = path.join(root, 'evidence.jsonl');
  const original = JSON.stringify({ receipt: '证据😀'.repeat(10000) }) + '\n' + Array.from({ length: 85 }, (_, i) => JSON.stringify({ record: i }) + '\n').join('');
  writeFileSync(filename, original);
  const readPage = (verification as unknown as { readReviewEvidence?: (filename: string, cursor: number, limit: number, maxBytes: number) => Promise<{ text: string; nextCursor: number | null; records: number }> }).readReviewEvidence;
  assert.equal(typeof readPage, 'function', 'reviewer must have a scoped bounded raw-evidence reader');
  let cursor = 0, restored = '', pages = 0;
  do {
    const page = await readPage!(filename, cursor, 7, 1024);
    assert.ok(Buffer.byteLength(page.text) <= 1024); assert.ok(page.records <= 7);
    restored += page.text; pages++;
    if (page.nextCursor === null) break;
    assert.ok(page.nextCursor > cursor); cursor = page.nextCursor;
  } while (pages < 200);
  assert.equal(restored, original); assert.ok(pages > 50);
});

test('file evidence streams boundary-spanning acceptance and detects a larger changed output', async t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'review-file-011-'));
  t.after(() => { assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(path.join(root, 'output.txt'), 'a'.repeat(65534) + '跨边界😀结论' + 'b'.repeat(2 * 1024 * 1024));
  const task = { id: 'stream-review', workspace: root, goal: { acceptance: ['contains:output.txt:跨边界😀结论'] } } as Task;
  const intent = { id: 'write', name: 'write_file', arguments: { path: 'output.txt', content: 'original output' }, state: 'applied', effectKey: 'write', toolCallId: 'write' } as unknown as Intent;
  const gateway = { queryOutcome: async () => ({ status: 'applied', receipt: { path: 'output.txt' } }) } as unknown as ToolGateway;
  const review = await inspectEffects(task, [intent], gateway, undefined, root);
  assert.equal(review.findingCount, 1); assert.match(review.findings[0]!, /Artifact changed/);
  assert.equal(review.artifactCount, 1);
});

test('completion reviewer reads only the current evidence archive through the bounded tool', async t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'review-runner-011-'));
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const requests: any[] = [];
  const backend = await startBackend({ dataDir: path.join(root, 'data'), projectRoot: process.cwd(), mockOptions: { responder: body => {
    requests.push(body);
    if (requests.length === 1) return { content: 'Inspecting exact evidence.', toolCalls: [{ id: 'scope', name: 'read_review_evidence', arguments: { source: 'effects', cursor: 0, path: '../private.txt' } }] };
    if (requests.length === 2) return { content: 'Only the current archive is allowed.', toolCalls: [{ id: 'read', name: 'read_review_evidence', arguments: { source: 'effects', cursor: 0, limit: 1 } }] };
    return { content: JSON.stringify({ verdict: 'unknown', reason: 'No independent output exists.' }) };
  } } });
  await backend.services.runner.stop();
  t.after(async () => { await backend.close(); assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  const kernel = backend.services.kernel;
  const taskId = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, objective: 'Check archived evidence', maxModelCalls: 8 } }).taskId!;
  const run = kernel.createRun(taskId); kernel.transition(taskId, 'running');
  const runner = backend.services.runner;
  const selected = await backend.services.product!.models.save({ name: 'Selected completion reviewer', provider: 'Fixture', model: 'review/selected', mode: 'mock',
    contextWindow: 65536, maxOutputTokens: 1024, supportsReasoning: true, reasoningLevels: ['high'], reasoningMapping: { reasoning_effort: '{{level}}' } });
  runner.selection = () => ({ profileId: selected.id, reasoningEffort: 'high' });
  const selectedConfig = backend.services.harness!.profiles.get(selected.id);
  selectedConfig.set({ ...selectedConfig.provider, mode: 'live', baseUrl: 'https://local-fixture.invalid/v1', apiKey: 'harmless-fixture-only', authorizePaid: true, maxRequests: 3 });
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://local-fixture.invalid/v1/chat/completions');
    return originalFetch(new URL('chat/completions', backend.mock.url.replace(/\/?$/, '/')), { ...init, headers: { 'Content-Type': 'application/json' } });
  });
  await (runner as unknown as { finish: (taskId: string, runId: string, result: unknown, gateway: ToolGateway, signal: AbortSignal, cursor: number) => Promise<void> }).finish(taskId, run.id, { content: 'Proposed completion', toolCalls: [], finishReason: 'stop' }, runner.gateway(kernel.getTask(taskId)!), new AbortController().signal, kernel.latestUserCursor(taskId));
  assert.equal(requests.length, 3);
  assert.ok(requests.every(body => body.model === 'review/selected' && body.reasoning_effort === 'high'), 'Every evidence review turn retains the task-selected provider and reasoning');
  assert.equal(selectedConfig.view().remainingLiveRequests, 0, 'Every one of the three actual local HTTP review requests spends one authorized attempt');
  const records = backend.services.harness!.store.listRequests({ sessionId: taskId, limit: 10 }).requests;
  assert.equal(records.length, 3);
  assert.ok(records.every(record => record.status === 'completed' && record.profileId === selected.id && record.draft === record.response?.content), 'Reusing a reviewer creates independent completed request records and drafts');
  assert.equal(requests[0].tools[0].function.name, 'read_review_evidence');
  assert.match(requests[1].messages.find((item: any) => item.role === 'tool').content, /Only the current immutable evidence/);
  const page = JSON.parse(requests[2].messages.find((item: any) => item.role === 'tool').content);
  assert.equal(page.records, 1); assert.match(page.text, /No independently observed output/);
  assert.ok(requests.every(body => JSON.stringify(body.messages).length <= 32000));
  assert.equal(kernel.getTask(taskId)!.status, 'waiting_input');
  assert.equal(kernel.eventCount(taskId, 'verification.evidence_read'), 1);
});
