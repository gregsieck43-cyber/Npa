import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startBackend } from '../src/app/backend.js';
import { resourceBudget } from '../src/app/resource-budget.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';
import type { GatewayEvent, ToolInventory } from '../src/frontend/api/types.js';

type Entry = { id: number; event: GatewayEvent };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t: TestContext, mockOptions?: MockProviderOptions) {
  const parent = path.resolve(process.env.TEMP ?? '.tmp', 'approval-resume-ui-delta');
  mkdirSync(parent, { recursive: true });
  const owned = mkdtempSync(path.join(parent, 'http-'));
  const phases: { phase: string; at: string; elapsedMs: number; status?: number }[] = [];
  const started = performance.now();
  const mark = (phase: string, status?: number) => { phases.push({ phase, at: new Date().toISOString(), elapsedMs: performance.now() - started, ...(status === undefined ? {} : { status }) }); if (phases.length > 128) phases.shift(); };
  const diagnose = (value: unknown) => { try { t.diagnostic(JSON.stringify(value)); } catch { /* Diagnostics must not replace the test's original error. */ } };
  const errorCode = (error: unknown) => {
    const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined;
    const safe = (part: unknown) => typeof part === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(part) ? part : undefined;
    return { name: safe(value?.name), code: safe(value?.code), causeCode: safe(value?.cause?.code) };
  };
  let succeeded = false, failed = false;
  const failure = (error?: unknown) => {
    if (failed) return;
    failed = true;
    try {
    const metadata: Record<string, unknown> = { fixture: owned, at: new Date().toISOString(), error: errorCode(error), phases: [...phases] };
    const read = (database: string, queries: Record<string, string>) => {
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(path.join(owned, 'data', database + '.sqlite'), { readOnly: true });
        db.exec('PRAGMA busy_timeout=0');
        for (const [key, sql] of Object.entries(queries)) {
          try { metadata[key] = db.prepare(sql).all(); } catch (cause) { metadata[key] = { diagnosticError: errorCode(cause) }; }
        }
      } catch (cause) { metadata[database] = { diagnosticError: errorCode(cause) }; }
      finally { try { db?.close(); } catch (cause) { metadata[database + 'Close'] = { diagnosticError: errorCode(cause) }; } }
    };
    // Fixed field/row limits: never serialize goals, prompts, response bodies, credentials or receipt output.
    read('kernel', {
      tasks: `SELECT id,status,revision,json_extract(body,'$.generation') generation,json_extract(body,'$.updatedAt') updatedAt FROM tasks LIMIT 4`,
      runs: `SELECT id,task_id,generation,policy_epoch,status,json_extract(body,'$.startedAt') startedAt,json_extract(body,'$.endedAt') endedAt FROM runs ORDER BY rowid DESC LIMIT 12`,
      events: `SELECT seq,task_id,type,created_at,json_extract(payload,'$.runId') runId,json_extract(payload,'$.intentId') intentId,json_extract(payload,'$.requestId') requestId,json_extract(payload,'$.modelCalls') modelCalls,json_extract(payload,'$.phase') phase,json_extract(payload,'$.code') errorCode FROM events ORDER BY seq DESC LIMIT 128`,
      intents: `SELECT id,task_id,run_id,state,prepared_at,json_extract(body,'$.name') name,json_extract(body,'$.receipt.appliedAt') appliedAt FROM intents ORDER BY rowid DESC LIMIT 12`,
      effects: `SELECT intent_id,task_id,state,created_at,json_extract(receipt,'$.appliedAt') appliedAt,json_extract(receipt,'$.digest') digest FROM effects ORDER BY rowid DESC LIMIT 12`,
      owners: `SELECT task_id,owner FROM task_execution_owners LIMIT 4`,
      presence: `SELECT task_id,epoch,activation,generation,policy_epoch,state,heartbeat_at FROM coordination_presence LIMIT 4`,
      budgets: `SELECT task_id,max_model_calls,model_calls FROM budgets LIMIT 4`,
      schedule: `SELECT task_id,due,consecutive_failures FROM task_schedule LIMIT 4`,
    });
    read('harness', { requests: `SELECT id,task_id,status,created_at,json_extract(record,'$.runId') runId,json_extract(record,'$.kind') kind,json_extract(record,'$.startedAt') startedAt,json_extract(record,'$.updatedAt') updatedAt,json_extract(record,'$.durationMs') durationMs,json_extract(record,'$.error.code') errorCode FROM requests ORDER BY seq DESC LIMIT 16` });
    const resources = resourceBudget.status();
    metadata.resources = { activeLeases: resources.activeLeases, waitingLeases: resources.waitingLeases, pressure: resources.pressure, monitoring: resources.monitoring, sampledAt: resources.sampledAt };
    try { writeFileSync(path.join(owned, 'inspector-failure.json'), JSON.stringify(metadata, null, 2) + '\n'); }
    catch (cause) { diagnose({ diagnosticWriteError: errorCode(cause) }); }
    diagnose({ retainedFixture: owned, diagnostic: path.join(owned, 'inspector-failure.json') });
    } catch (cause) { diagnose({ retainedFixture: owned, diagnosticError: errorCode(cause) }); }
  };
  mark('backend-start');
  const backend = await startBackend({ projectRoot: process.cwd(), dataDir: path.join(owned, 'data'), mockOptions }).catch(error => { failure(error); throw error; });
  mark('backend-ready');
  const request = async (method: string, route: string, body?: unknown): Promise<any> => {
    mark(method + ' ' + route.split('?')[0]);
    const response = await fetch(`http://127.0.0.1:${backend.port}/v1/product${route}`, {
      method, headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    mark('http-response', response.status);
    assert.equal(response.status, 200, JSON.stringify({ route, value }));
    return value;
  };
  return { request, failure, passed() { succeeded = true; }, async close() {
    if (!succeeded || t.signal.aborted) failure(t.signal.reason);
    mark('backend-close-start');
    try { await backend.close(); } catch (error) { failure(error); throw error; }
    finally { mark('backend-close-end'); diagnose({ fixture: owned, cleanup: phases.slice(-2) }); }
    if (!failed) {
      // Only this test's mkdtemp child is removable, never a replaced symlink/junction.
      if (path.dirname(owned) !== parent || lstatSync(parent).isSymbolicLink() || lstatSync(owned).isSymbolicLink()) throw new Error('Inspector fixture ownership changed.');
      mark('fixture-remove-start');
      try { rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
      catch (error) { failure(error); throw error; }
      finally { mark('fixture-remove-end'); diagnose({ fixture: owned, cleanup: phases.slice(-2) }); }
    } else {
      try { writeFileSync(path.join(owned, 'inspector-cleanup.json'), JSON.stringify({ fixture: owned, retained: true, phases }, null, 2) + '\n'); }
      catch (cause) { diagnose({ retainedFixture: owned, cleanupDiagnosticError: errorCode(cause) }); }
    }
  } };
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    assert.ok(Date.now() < deadline, 'Timed out: ' + JSON.stringify(value).slice(-1000));
    await sleep(20);
  }
}

test('mounted Work Inspector refreshes on pause/resume approval changes and execution settlement', { timeout: 45_000 }, async t => {
  const env = await setup(t);
  t.after(() => env.close());
  try {
  const sent = await env.request('POST', '/chat/send', { mode: 'cowork', text: 'increment counter once', attachments: [], permission: 'ask', modelId: 'default' });
  const id = sent.sessionId as string;
  const pending = (): Promise<any[]> => env.request('GET', '/approvals?sessionId=' + id);
  const task = () => env.request('GET', '/tasks/' + id);
  const tools = (): Promise<ToolInventory> => env.request('GET', '/inspector/tools?sessionId=' + id);
  const first = (await until(pending, rows => rows.length === 1))[0];
  let cached = await tools();
  const firstCall = cached.calls.find(call => call.approvalId === first.id)!;
  assert.ok(firstCall, 'initial mount exposes the first actual approval');
  let cursor = 0;
  const poll = async (): Promise<Entry[]> => {
    const page = await env.request('GET', `/events?sessionId=${id}&cursor=${cursor}&limit=200`);
    assert.equal(page.reset, false);
    cursor = page.nextCursor;
    const entries = page.events as Entry[];
    // Match useInspectorData's public contract: a mounted panel reloads only on invalidation.
    if (entries.some(entry => entry.event.type === 'inspector.invalidated')) cached = await tools();
    return entries;
  };
  const initial = await poll();
  await env.request('POST', `/tasks/${id}/control`, { action: 'pause' });
  await until(task, value => value.status === 'paused');
  const paused = await poll();
  const pausedCalls = cached.calls;
  await env.request('POST', `/tasks/${id}/control`, { action: 'resume' });
  const current = (await until(pending, rows => rows.length === 1 && rows[0].id !== first.id))[0];
  const resumed = await poll();
  t.diagnostic(JSON.stringify({ firstApproval: first.id, currentApproval: current.id, cached: cached.calls.map(call => ({ id: call.id, status: call.status, approvalId: call.approvalId })), invalidations: [initial, paused, resumed].map(entries => entries.filter(entry => entry.event.type === 'inspector.invalidated').length) }));
  const active = cached.calls.find(call => call.approvalId === current.id);
  assert.ok(active, 'mounted Inspector must receive an invalidation and display the resumed request approval');
  assert.notEqual(active.requestId, firstCall.requestId);
  assert.equal(cached.calls.length, 2);
  assert.equal(cached.calls.find(call => call.id === firstCall.id)!.status, 'denied');
  assert.equal(pausedCalls.find(call => call.id === firstCall.id)!.status, 'denied');
  assert.ok(pausedCalls.every(call => call.approvalId === undefined));
  for (const entries of [initial, paused, resumed]) assert.ok(entries.some(entry => entry.event.type === 'inspector.invalidated'), 'each settled phase invalidates the mounted Inspector');
  assert.ok(paused.some(entry => entry.event.type === 'approval.resolved' && entry.event.approvalId === first.id));
  assert.ok(resumed.some(entry => entry.event.type === 'approval.requested' && entry.event.approval.id === current.id));
  await env.request('POST', '/approvals/decide', { approvalId: current.id, approved: true, scope: 'once' });
  await until(task, value => value.status === 'completed');
  const settled = await poll();
  assert.ok(settled.some(entry => entry.event.type === 'inspector.invalidated'));
  assert.equal(cached.calls.find(call => call.id === active.id)!.status, 'succeeded');
  assert.ok(cached.calls.every(call => call.approvalId === undefined));
  assert.deepEqual(await pending(), []);
  assert.equal((await poll()).length, 0, 'idle event polling does not generate repeated invalidations');
  env.passed();
  } catch (error) { env.failure(error); throw error; }
});

test('Work stream tokens do not invalidate Inspector before the durable response settles', { timeout: 30_000 }, async t => {
  const env = await setup(t, { responder: body => ({ content: (body.messages ?? []).some((message: any) => message.role === 'system' && String(message.content).includes('REVIEWER ROLE'))
    ? JSON.stringify({ verdict: 'pass', reason: 'Local fixture accepted.', findings: [] }) : 'A readable Work response. '.repeat(50) }), streamChunkChars: 8, streamDelayMs: 8 });
  t.after(() => env.close());
  try {
  const sent = await env.request('POST', '/chat/send', { mode: 'cowork', text: 'Write a response without tools', attachments: [], permission: 'ask', modelId: 'default' });
  const id = sent.sessionId as string;
  const entries: Entry[] = [];
  let cursor = 0;
  await until(async () => {
    const page = await env.request('GET', `/events?sessionId=${id}&cursor=${cursor}&limit=200`);
    assert.equal(page.reset, false);
    cursor = page.nextCursor;
    entries.push(...page.events);
    return entries;
  }, rows => rows.some(entry => entry.event.type === 'message.upsert' && entry.event.message.role === 'assistant' && entry.event.message.status === 'done'));
  const streaming = entries.filter(entry => entry.event.type === 'message.upsert' && entry.event.message.status === 'streaming');
  assert.ok(streaming.length >= 2, 'the real local SSE provider must expose multiple live updates');
  const first = streaming[0]!.id, last = streaming.at(-1)!.id;
  assert.equal(entries.filter(entry => entry.event.type === 'inspector.invalidated' && entry.id > first && entry.id < last).length, 0, 'stream deltas must not trigger request/Tools panel reloads');
  assert.ok(entries.some(entry => entry.event.type === 'inspector.invalidated' && entry.id > last), 'the durable response must invalidate Inspector');
  t.diagnostic(JSON.stringify({ streamingUpdates: streaming.length, inspectorInvalidations: entries.filter(entry => entry.event.type === 'inspector.invalidated').length }));
  env.passed();
  } catch (error) { env.failure(error); throw error; }
});
