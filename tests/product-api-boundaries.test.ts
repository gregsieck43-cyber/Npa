import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';

/**
 * Real-HTTP boundary coverage for the corrected product API: a real backend, real SQLite
 * persistence, real restarts and real Git/shell fixtures, with the mock provider as the only model.
 *
 * Every test owns its backend, data directory and fixtures, and removes them afterwards.
 * These tests encode the corrected contracts, so they intentionally fail against the
 * pre-correction implementation: a streaming Chat may not be deleted while its request keeps
 * writing, a promoted Work origin must stay byte-identical through edit/regenerate/delete and a
 * restart, workspace paths and terminal temp directories may not follow junctions out of the
 * project, terminal access must be revoked on unregister, and transient SideAsk attachments are
 * denied before any model request is prepared.
 */

const tempRoot = path.resolve(process.env.TEMP ?? '.tmp');
const OUTSIDE_SENTINEL = 'OUTSIDE-REGISTERED-PROJECT-READ-MUST-BE-DENIED';
const DENIAL_CODES = ['denied', 'scope', 'validation'];
const IDLE_STATUSES = ['idle', 'completed', 'failed', 'cancelled'];

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const until = async <T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 30000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state.');
    await pause(30);
  }
};

type Responder = (body: any) => { content: string };

interface SetupOptions { responder?: Responder; delayMs?: number; trace?: any[] }

/** One isolated backend per test: own temp directory, own data directory, own mock provider. */
const setup = async (options: SetupOptions = {}) => {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tempRoot, 'product-api-boundary-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const links: string[] = [];
  const settings = {
    dataDir: path.join(dir, 'data'), projectRoot: process.cwd(),
    mockOptions: {
      ...(options.responder ? { responder: options.responder } : {}),
      ...(options.delayMs ? { delayMs: options.delayMs } : {}),
      ...(options.trace ? { trace: (body: any) => { options.trace!.push(body); } } : {}),
    },
  };
  let backend = await startBackend(settings);
  const current = (): Awaited<ReturnType<typeof startBackend>> => backend;
  const request = async (method: string, route: string, input?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch('http://127.0.0.1:' + backend.port + route, { method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const restart = async (): Promise<void> => { await backend.close(); backend = await startBackend(settings); };
  const removeLinks = (): void => {
    for (const link of links.splice(0)) {
      try { unlinkSync(link); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  };
  const close = async (): Promise<void> => {
    removeLinks();
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { current, dir, workspace, request, restart, close, links };
};

type Env = Awaited<ReturnType<typeof setup>>;

const junction = (target: string, link: string, links: string[]): string => {
  symlinkSync(target, link, 'junction');
  links.push(link);
  return link;
};

/** The harness is recreated by a restart, so every read goes through the current backend. */
const harnessOf = (env: Env) => env.current().services.harness ?? assert.fail('the backend must expose its initialized harness');

const sendChat = async (env: Env, text: string, extra: Record<string, unknown> = {}) => {
  const sent = await env.request('POST', '/v1/product/chat/send', { mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default', ...extra });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return sent.body as { sessionId: string; messageId: string };
};

const waitIdle = (env: Env, sessionId: string) => until(async () => {
  const value = await env.request('GET', '/v1/product/sessions/' + sessionId);
  return value.status === 200 && IDLE_STATUSES.includes(value.body.status) ? value : undefined;
});

const addProject = async (env: Env, projectPath: string): Promise<string> => {
  const added = await env.request('POST', '/v1/product/workspace/projects', { path: projectPath });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  return added.body.id as string;
};

const textOf = (message: any): string => {
  const part = (message?.parts ?? []).find((item: any) => item.kind === 'text');
  return typeof part?.text === 'string' ? part.text : '';
};

test('removing a streaming Chat either rejects as busy or cancels, settles, and never writes afterward', { timeout: 120000 }, async t => {
  const env = await setup({ delayMs: 700 });
  t.after(() => env.close());
  const sent = await sendChat(env, 'Removal must settle the streaming request');
  const sessionId = sent.sessionId;
  assert.ok(harnessOf(env).chat.activeRequestId(sessionId), 'the delayed mock must leave the request active when removal starts');

  const before = await env.request('GET', '/v1/product/events?cursor=0&limit=200');
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const cursor = Number(before.body.nextCursor);
  assert.ok(Number.isSafeInteger(cursor) && cursor >= 0, 'the event log must expose a numeric cursor');

  const removed = await env.request('POST', '/v1/product/sessions/' + sessionId + '/remove');
  if (removed.status === 409) {
    assert.ok(['busy', 'conflict'].includes(removed.body.code), JSON.stringify(removed.body));
    const live = await env.request('GET', '/v1/product/sessions/' + sessionId);
    assert.equal(live.status, 200, 'a busy rejection must keep the Chat session and its request');
    const settled = await waitIdle(env, sessionId);
    assert.equal(settled.body.messages.length, 2, 'a busy rejection must let the streaming request finish normally');
    assert.equal(settled.body.messages[1].role, 'assistant');
    return;
  }

  assert.equal(removed.status, 200, 'expected either a 409 busy rejection or complete removal: ' + JSON.stringify(removed.body));
  assert.equal(harnessOf(env).chat.activeRequestId(sessionId), undefined,
    'a reported removal must already have cancelled and settled the live request');
  assert.equal((await env.request('GET', '/v1/product/sessions/' + sessionId)).status, 404);
  assert.throws(() => harnessOf(env).store.getSession(sessionId), /Chat session not found/, 'the removed Chat record must be gone from the real store');

  await pause(2200);
  assert.equal((await env.request('GET', '/v1/product/sessions/' + sessionId)).status, 404, 'a late write must not resurrect the removed Chat');
  assert.throws(() => harnessOf(env).store.getSession(sessionId), /Chat session not found/);
  const after = await env.request('GET', '/v1/product/events?cursor=' + cursor + '&limit=200&sessionId=' + encodeURIComponent(sessionId));
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.reset, false);
  const late = (after.body.events as any[]).filter(entry => entry.event?.type === 'message.upsert' && entry.event?.sessionId === sessionId);
  assert.deepEqual(late, [], 'no assistant or message write may appear for a Chat that was removed');
  assert.ok(!(await env.request('GET', '/v1/product/sessions?limit=100')).body.items.some((item: any) => item.id === sessionId));
});

test('a promoted Work origin keeps the exact referenced message bytes through edit, regeneration, deletion and restart', { timeout: 120000 }, async t => {
  const env = await setup({ responder: body => {
    const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find(message => message.role === 'user');
    return { content: 'Mock answer for: ' + String(lastUser?.content ?? '').slice(0, 80) };
  } });
  t.after(() => env.close());
  const projectId = await addProject(env, env.workspace);
  const sent = await sendChat(env, 'Original engineering requirement.', { projectId });
  const sessionId = sent.sessionId;
  const settled = await waitIdle(env, sessionId);
  assert.equal(settled.body.messages.length, 2, JSON.stringify(settled.body));
  assert.equal(settled.body.messages[0].role, 'user');
  assert.equal(settled.body.messages[1].role, 'assistant');
  const userId = settled.body.messages[0].id as string;
  const assistantId = settled.body.messages[1].id as string;

  const original = new Map<string, { sha256: string; text: string }>();
  for (const id of [userId, assistantId]) {
    const record = harnessOf(env).store.memory(sessionId).read({ id, field: 'record', length: 12000 });
    assert.ok(record.text.length > 0, 'the raw record must be readable before promotion');
    original.set(id, { sha256: record.sha256, text: record.text });
  }

  const promoted = await env.request('POST', '/v1/product/sessions/' + sessionId + '/promote', { objective: 'Continue the preserved origin as Work', acceptance: ['Preserve the promoted origin bytes'] });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  const taskId = promoted.body.id as string;
  assert.ok(taskId, 'promotion must return the Work task id');

  const assertPromoted = (step: string): void => {
    const memory = harnessOf(env).store.promotedMemory(taskId) ?? assert.fail(step + ': the promoted Work task must keep its source archive link');
    for (const [id, expected] of original) {
      const record = memory.read({ id, field: 'record', length: 12000 });
      assert.equal(record.sha256, expected.sha256, step + ': raw record SHA-256 of ' + id);
      assert.equal(record.text, expected.text, step + ': raw record text of ' + id);
    }
  };
  assertPromoted('after promotion');

  const edited = await env.request('POST', '/v1/product/chat/edit', { sessionId, messageId: userId, text: 'A later edited requirement.' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const afterEdit = await waitIdle(env, sessionId);
  assert.equal(afterEdit.body.messages.length, 2, JSON.stringify(afterEdit.body));
  assert.equal(textOf(afterEdit.body.messages[0]), 'A later edited requirement.', 'the live origin must accept the edit');
  assertPromoted('after editing the origin');

  const currentAssistant = afterEdit.body.messages[1].id as string;
  const regenerated = await env.request('POST', '/v1/product/chat/regenerate', { sessionId, messageId: currentAssistant });
  assert.equal(regenerated.status, 200, JSON.stringify(regenerated.body));
  const afterRegenerate = await waitIdle(env, sessionId);
  assert.equal(afterRegenerate.body.messages.length, 2, JSON.stringify(afterRegenerate.body));
  assert.notEqual(afterRegenerate.body.messages[1].id, currentAssistant, 'the live origin must accept the regeneration');
  assertPromoted('after regenerating the origin');

  const removed = await env.request('POST', '/v1/product/sessions/' + sessionId + '/remove');
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await env.request('GET', '/v1/product/sessions/' + sessionId)).status, 404, 'the origin Chat itself is deleted');
  assert.throws(() => harnessOf(env).store.getSession(sessionId), /Chat session not found/);
  assertPromoted('after deleting the origin Chat');

  await env.restart();
  assert.equal((await env.request('GET', '/v1/product/sessions/' + sessionId)).status, 404, 'the deleted origin must stay deleted after a restart');
  assertPromoted('after a backend restart');
});

test('workspace diff rejects a project-local junction to an outside file and returns its bytes to no one', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const project = path.join(env.dir, 'project');
  const outside = path.join(env.dir, 'outside');
  mkdirSync(project);
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'sentinel.txt'), OUTSIDE_SENTINEL, 'utf8');
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: project, windowsHide: true, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  junction(outside, path.join(project, 'linked'), env.links);
  const projectId = await addProject(env, project);

  const diff = await env.request('GET', '/v1/product/workspace/diff?projectId=' + encodeURIComponent(projectId) + '&path=' + encodeURIComponent('linked/sentinel.txt'));
  assert.ok([400, 403].includes(diff.status), 'a junction diff must be rejected, got ' + diff.status + ' ' + JSON.stringify(diff.body));
  assert.ok(DENIAL_CODES.includes(diff.body.code), JSON.stringify(diff.body));
  assert.ok(!JSON.stringify(diff.body).includes(OUTSIDE_SENTINEL), 'the outside file bytes must never be returned');
});

test('terminal creation rejects a project .tmp junction and creates nothing outside the project', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const project = path.join(env.dir, 'project');
  const outside = path.join(env.dir, 'outside');
  mkdirSync(project);
  mkdirSync(outside);
  junction(outside, path.join(project, '.tmp'), env.links);
  const projectId = await addProject(env, project);

  const terminal = await env.request('POST', '/v1/product/workspace/terminal', { projectId, command: 'exit 0' });
  assert.ok([400, 403].includes(terminal.status), 'a junctioned terminal temp directory must be rejected, got ' + terminal.status + ' ' + JSON.stringify(terminal.body));
  assert.ok(DENIAL_CODES.includes(terminal.body.code), JSON.stringify(terminal.body));
  assert.equal(existsSync(path.join(outside, 'terminal')), false, 'no terminal temp directory may be created outside the registered project');
});

test('unregistering a project stops its running terminal before the later shell effect', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const project = path.join(env.dir, 'project');
  mkdirSync(project);
  const projectId = await addProject(env, project);
  const marker = path.join(project, 'late-effect.txt');
  const command = process.platform === 'win32'
    ? "Start-Sleep -Milliseconds 1800; Set-Content -LiteralPath 'late-effect.txt' -Value 'effect-after-revocation'"
    : "sleep 2; printf effect-after-revocation > late-effect.txt";

  const running = env.request('POST', '/v1/product/workspace/terminal', { projectId, command })
    .catch(error => ({ status: 0, body: { error: String(error) } }));
  await pause(150);
  const removed = await env.request('POST', '/v1/product/workspace/projects/' + projectId + '/remove');
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const settled = await Promise.race([running, pause(15000).then(() => 'timeout' as const)]);
  assert.notEqual(settled, 'timeout', 'the terminal request must settle once its project is unregistered');

  // The shell command itself only writes after ~1800 ms; crossing that window proves there is no late effect.
  await pause(2500);
  assert.equal(existsSync(marker), false, 'an unregistered project must not retain an in-flight shell that writes afterward');
});

test('side ask denies a synthetic credential filename before preparing any model request', { timeout: 120000 }, async t => {
  const trace: any[] = [];
  const env = await setup({ trace });
  t.after(() => env.close());
  const file = path.join(env.workspace, 'API.txt');
  writeFileSync(file, 'Synthetic boundary fixture. This file contains no credential.', 'utf8');

  const side = await env.request('POST', '/v1/product/chat/side-ask', {
    question: 'Read the attached file.', modelId: 'default', attachments: [{ id: 'file', name: 'API.txt', kind: 'file', path: file }], history: [],
  });
  assert.ok([400, 403].includes(side.status), 'a denylisted attachment must be rejected, got ' + side.status + ' ' + JSON.stringify(side.body));
  assert.ok(DENIAL_CODES.includes(side.body.code), JSON.stringify(side.body));
  assert.equal(trace.length, 0, 'a denied attachment must never prepare or send a model request');
});

test('side ask denies a junction attachment before preparing any model request', { timeout: 120000 }, async t => {
  const trace: any[] = [];
  const env = await setup({ trace });
  t.after(() => env.close());
  const target = path.join(env.dir, 'attachment-target');
  mkdirSync(target);
  writeFileSync(path.join(target, 'note.txt'), 'Synthetic source behind a junction.', 'utf8');
  const link = junction(target, path.join(env.dir, 'attachment-link'), env.links);

  const side = await env.request('POST', '/v1/product/chat/side-ask', {
    question: 'Read the selected text.', modelId: 'default',
    attachments: [{ id: 'a1', name: 'note.txt', kind: 'file', path: path.join(link, 'note.txt') }], history: [],
  });
  assert.ok([400, 403].includes(side.status), 'a junction attachment must be rejected, got ' + side.status + ' ' + JSON.stringify(side.body));
  assert.ok(DENIAL_CODES.includes(side.body.code), JSON.stringify(side.body));
  assert.equal(trace.length, 0, 'a denied attachment must never prepare or send a model request');
});

test('side ask still sends an ordinary selected text file and keeps the conversation transient', { timeout: 120000 }, async t => {
  const trace: any[] = [];
  const env = await setup({ trace });
  t.after(() => env.close());
  const file = path.join(env.workspace, 'note.txt');
  writeFileSync(file, 'Ordinary selected text fixture.', 'utf8');

  const side = await env.request('POST', '/v1/product/chat/side-ask', {
    question: 'Summarize the selected text.', modelId: 'default',
    attachments: [{ id: 'a1', name: 'note.txt', kind: 'file', path: file }], history: [],
  });
  assert.equal(side.status, 200, JSON.stringify(side.body));
  assert.ok(String(side.body.answer).length > 0);
  assert.ok(String(side.body.answer).includes('Ordinary selected text fixture'), 'the mock answer must reflect the attached text');
  assert.equal(trace.length, 1, 'the ordinary attachment must produce exactly one prepared provider request');
  assert.match(JSON.stringify(trace[0].messages), /Ordinary selected text fixture/, 'the attached text must reach the prepared request body');
  assert.deepEqual((await env.request('GET', '/v1/product/sessions')).body.items, [], 'side ask must not create a product session');
});
