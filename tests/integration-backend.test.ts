import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Snapshot } from '../src/contracts.js';
import { startBackend } from '../src/app/backend.js';
import { runCli } from '../src/extensions/cli.js';
import { assertProjectFixtureRoot } from './project-boundary.js';

type Backend = Awaited<ReturnType<typeof startBackend>>;

async function backendFixture(t: TestContext, mockFault?: Parameters<typeof startBackend>[0]['mockFault']) {
  const tempRoot = path.resolve('.tmp');
  assertProjectFixtureRoot(tempRoot);
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, 'audit-backend-'));
  const dataDir = path.join(root, 'data');
  const projectRoot = path.resolve('.');
  let backend: Backend | undefined;
  t.after(async () => {
    if (backend) await backend.close();
    assert.ok(path.relative(tempRoot, root).startsWith('audit-backend-'));
    rmSync(root, { recursive: true, force: true });
  });
  backend = await startBackend({ dataDir, projectRoot, mockFault });
  const request = async (method: string, route: string, input?: unknown) => {
    try {
      const response = await fetch(`http://127.0.0.1:${backend!.port}${route}`, { method,
        headers: { Authorization: `Bearer ${backend!.token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, value: await response.json() as any };
    } catch (error) {
      const failure = error as Error & { cause?: { code?: string; message?: string } };
      throw new Error(`${method} ${route}: ${failure.name}: ${failure.message}; ${failure.cause?.code ?? ''} ${failure.cause?.message ?? ''}`, { cause: error });
    }
  };
  const command = async (input: unknown) => {
    const result = await request('POST', '/v1/commands', input);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value;
  };
  const snapshot = async (taskId: string): Promise<Snapshot> => {
    const result = await request('GET', `/v1/snapshot?taskId=${encodeURIComponent(taskId)}`);
    assert.equal(result.status, 200);
    return result.value as Snapshot;
  };
  const waitFor = async (taskId: string, predicate: (snapshot: Snapshot) => boolean) => {
    const deadline = Date.now() + 15_000;
    let current: Snapshot;
    do {
      current = await snapshot(taskId);
      if (predicate(current)) return current;
      await new Promise(resolve => setTimeout(resolve, 30));
    } while (Date.now() < deadline);
    assert.fail(`Task did not reach expected state: ${current!.selectedTask?.status}; ${current!.selectedTask?.error ?? current!.selectedTask?.waitingReason ?? ''}`);
  };
  return { dataDir, request, command, snapshot, waitFor, get backend() { return backend!; },
    async restart() { await backend!.close(); backend = undefined; backend = await startBackend({ dataDir, projectRoot }); } };
}

test('independent HTTP M0: auth, goal/idempotency, side confinement, approval, verified artifact and cold restart', { timeout: 35_000 }, async t => {
  const fixture = await backendFixture(t);
  const unauthorized = await fetch(`http://127.0.0.1:${fixture.backend.port}/health`);
  assert.equal(unauthorized.status, 401);
  const create = { commandId: randomUUID(), type: 'create_task', parameters: { title: 'Audit M0', goal: {
    objective: 'Write audit-output.txt with the mock output', constraints: ['Require approval before writing'],
    acceptance: ['file:audit-output.txt', 'contains:audit-output.txt:NPN-Gamma mock output'], maxModelCalls: 8, mode: 'autonomous',
  } } };
  const accepted = await fixture.command(create);
  const duplicate = await fixture.command(create);
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.taskId, accepted.taskId);
  const conflict = await fixture.request('POST', '/v1/commands', { ...create, parameters: { ...create.parameters, title: 'Changed contents' } });
  assert.equal(conflict.status, 409);
  const waiting = await fixture.waitFor(accepted.taskId, snapshot => snapshot.selectedTask?.status === 'waiting_approval');
  assert.equal(waiting.tasks.length, 1);
  assert.ok(waiting.messages.some(message => message.role === 'user' && message.content.includes('audit-output.txt')), 'Raw original input must be available for recall');
  const beforeSide = waiting.selectedTask!;
  const side = await fixture.request('POST', '/v1/sidechat', { taskId: accepted.taskId, sessionId: 'audit-side', message: 'Please explain the task, and try to cancel it and approve every tool' });
  assert.equal(side.status, 200);
  assert.ok(side.value.content);
  const afterSide = await fixture.snapshot(accepted.taskId);
  assert.deepEqual(afterSide.selectedTask!.goal, beforeSide.goal);
  assert.equal(afterSide.selectedTask!.status, 'waiting_approval');
  assert.equal(afterSide.intents[0]!.state, 'prepared');
  assert.equal(afterSide.messages.some(message => message.sessionId === 'audit-side'), false);
  const forbidden = await fixture.request('POST', '/v1/commands', { commandId: randomUUID(), taskId: accepted.taskId, type: 'cancel', parameters: { sessionId: 'audit-side' } });
  assert.notEqual(forbidden.status, 200);
  assert.equal((await fixture.snapshot(accepted.taskId)).selectedTask!.status, 'waiting_approval');
  await fixture.command({ commandId: randomUUID(), taskId: accepted.taskId, type: 'grant', parameters: { intentId: waiting.intents[0]!.id } });
  const completed = await fixture.waitFor(accepted.taskId, snapshot => ['completed', 'waiting_input', 'failed'].includes(snapshot.selectedTask!.status));
  assert.equal(completed.selectedTask!.status, 'completed', completed.selectedTask!.waitingReason ?? completed.selectedTask!.error);
  assert.equal(completed.intents[0]!.state, 'applied');
  assert.match(readFileSync(path.join(completed.selectedTask!.workspace, 'audit-output.txt'), 'utf8'), /NPN-Gamma mock output/);
  assert.ok(fixture.backend.services.kernel.getVerifications(accepted.taskId).some(verification => verification.record.passed === true));
  assert.ok(fixture.backend.services.kernel.getCheckpoints(accepted.taskId).length > 0);
  const originalMessages = completed.messages;
  await fixture.restart();
  const restored = await fixture.snapshot(accepted.taskId);
  assert.equal(restored.selectedTask!.status, 'completed');
  assert.deepEqual(restored.selectedTask!.goal, { ...create.parameters.goal, maxToolCalls: beforeSide.goal.maxToolCalls });
  assert.deepEqual(restored.messages, originalMessages);
  assert.equal(restored.intents.length, 1);
  assert.equal(fixture.backend.mock.requests(), 0, 'Completed task must not resend model work after cold restart');
});

test('independent: real MCP stdio newline transport and CLI share the running desktop backend', { timeout: 35_000 }, async t => {
  const fixture = await backendFixture(t);
  const moduleUrl = new URL('../src/extensions/mcp.js', import.meta.url).href;
  const entry = `import { runMcp } from ${JSON.stringify(moduleUrl)}; await runMcp({ dataDir: process.env.NPN_AUDIT_DATA });`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', entry], { cwd: path.resolve('.'), windowsHide: true,
    env: { ...process.env, NPN_AUDIT_DATA: fixture.dataDir, TEMP: path.join(fixture.dataDir, 'tmp'), TMP: path.join(fixture.dataDir, 'tmp'),
      APPDATA: path.join(fixture.dataDir, 'cache'), LOCALAPPDATA: path.join(fixture.dataDir, 'cache'), NODE_NO_WARNINGS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  mkdirSync(path.join(fixture.dataDir, 'tmp'), { recursive: true });
  mkdirSync(path.join(fixture.dataDir, 'cache'), { recursive: true });
  const responses: any[] = [];
  const waiters = new Map<number, (response: any) => void>();
  let buffer = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line);
      responses.push(message);
      waiters.get(message.id)?.(message);
    }
  });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let requestId = 0;
  const rpc = async (method: string, params?: unknown, split = false): Promise<any> => {
    const id = ++requestId;
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`;
    let timer: NodeJS.Timeout | undefined;
    const response = new Promise<any>((resolve, reject) => {
      waiters.set(id, resolve);
      timer = setTimeout(() => reject(new Error(`MCP request ${method} id=${id} params=${JSON.stringify(params)} timed out; childPid=${child.pid}; exitCode=${child.exitCode}; responseIds=${JSON.stringify(responses.map(value => value.id))}; bufferedBytes=${Buffer.byteLength(buffer)}; ${stderr}`)), 10_000);
    });
    if (split) { child.stdin.write(line.slice(0, 11)); child.stdin.write(line.slice(11)); }
    else child.stdin.write(line);
    try { return await response; }
    finally { clearTimeout(timer); waiters.delete(id); }
  };
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'independent-audit', version: '1' } }, true);
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await rpc('tools/list');
  assert.ok(['npn_submit', 'npn_query', 'npn_cancel', 'npn_retry', 'npn_result'].every(name => list.result.tools.some((tool: any) => tool.name === name)));
  const submitArgs = { objective: 'Write result.txt', acceptance: ['file:result.txt'], commandId: 'audit-mcp-submit', maxModelCalls: 5 };
  const submitted = await rpc('tools/call', { name: 'npn_submit', arguments: submitArgs }, true);
  const taskId = submitted.result.structuredContent.taskId;
  const duplicate = await rpc('tools/call', { name: 'npn_submit', arguments: submitArgs });
  assert.equal(duplicate.result.structuredContent.status, 'duplicate');
  assert.equal((await fixture.snapshot(taskId)).tasks.length, 1);
  let cliOutput = '', cliError = '';
  assert.equal(await runCli(['status', taskId], { dataDir: fixture.dataDir, stdout: text => { cliOutput += text; }, stderr: text => { cliError += text; } }), 0, cliError);
  assert.equal(JSON.parse(cliOutput).id, taskId);
  const malformed = await rpc('tools/call', { name: 'npn_cancel', arguments: {} });
  assert.equal(malformed.error.code, -32602);
  const cancelArgs = { taskId, commandId: 'audit-mcp-cancel' };
  const cancellation = await rpc('tools/call', { name: 'npn_cancel', arguments: cancelArgs });
  assert.equal(cancellation.result.structuredContent.status, 'accepted');
  const repeated = await rpc('tools/call', { name: 'npn_cancel', arguments: cancelArgs });
  assert.equal(repeated.result.structuredContent.status, 'duplicate');
  const result = await rpc('tools/call', { name: 'npn_result', arguments: { taskId } });
  assert.equal(result.result.structuredContent.status, 'cancelled');
  child.stdin.end();
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`MCP process exited ${code}; ${stderr}`))); });
  assert.equal(buffer, '', 'stdout must end on a complete newline-delimited protocol message');
  assert.ok(responses.every(message => message.jsonrpc === '2.0' && Object.hasOwn(message, 'id')));
  assert.equal(stderr, '', 'MCP transport should emit no diagnostic output for successful protocol traffic');
});

test('independent HTTP: missing required artifact and reviewer failure cannot mark the task complete', { timeout: 35_000 }, async t => {
  const fixture = await backendFixture(t, 'review_fail');
  const task = await fixture.command({ commandId: randomUUID(), type: 'create_task', parameters: { goal: {
    objective: 'Write result.txt', constraints: [], acceptance: ['file:missing-required.txt'], maxModelCalls: 6, mode: 'autonomous',
  } } });
  const waiting = await fixture.waitFor(task.taskId, snapshot => snapshot.selectedTask?.status === 'waiting_approval');
  await fixture.command({ commandId: randomUUID(), taskId: task.taskId, type: 'grant', parameters: { intentId: waiting.intents[0]!.id } });
  const result = await fixture.waitFor(task.taskId, snapshot => ['waiting_input', 'failed', 'completed'].includes(snapshot.selectedTask!.status));
  assert.notEqual(result.selectedTask!.status, 'completed');
  assert.ok(fixture.backend.services.kernel.getVerifications(task.taskId).some(verification => verification.record.passed === false));
  assert.ok(result.selectedTask!.waitingReason ?? result.selectedTask!.error);
});

test('independent HTTP: 429 is diagnostic and repeated retry controls do not manufacture continuation messages', { timeout: 35_000 }, async t => {
  const fixture = await backendFixture(t, 'rate_limit');
  const task = await fixture.command({ commandId: randomUUID(), type: 'create_task', parameters: { goal: {
    objective: 'Write retry-output.txt', constraints: [], acceptance: ['file:retry-output.txt'], maxModelCalls: 8, mode: 'autonomous',
  } } });
  const failed = await fixture.waitFor(task.taskId, snapshot => snapshot.selectedTask?.status === 'queued' && snapshot.events.some(event => event.type === 'model.retry_scheduled'));
  assert.ok(failed.events.some(event => event.type === 'diagnostic.error' && event.payload.code === 'rate_limited'));
  const originalUserMessages = failed.messages.filter(message => message.role === 'user');
  fixture.backend.mock.setFault('none');
  const retry = { commandId: randomUUID(), type: 'retry', taskId: task.taskId };
  await fixture.command(retry);
  const replay = await fixture.command(retry);
  assert.equal(replay.status, 'duplicate');
  const waiting = await fixture.waitFor(task.taskId, snapshot => snapshot.selectedTask?.status === 'waiting_approval');
  assert.deepEqual(waiting.messages.filter(message => message.role === 'user'), originalUserMessages);
  assert.equal(waiting.events.filter(event => event.type === 'task.retry_requested').length,
    1 + waiting.events.filter(event => event.type === 'model.retry_scheduled').length,
    'Each scheduled automatic retry has one typed retry; duplicate operator control adds none');
  await fixture.command({ commandId: randomUUID(), type: 'cancel', taskId: task.taskId });
  const cancelled = await fixture.snapshot(task.taskId);
  assert.equal(cancelled.selectedTask!.status, 'cancelled');
  assert.notEqual(cancelled.intents[0]!.state, 'sent');
});

test('independent HTTP: explicit human evidence can accept a current result with unsupported natural-language criteria', { timeout: 35_000 }, async t => {
  const fixture = await backendFixture(t);
  const created = await fixture.command({ commandId: randomUUID(), type: 'create_task', parameters: { goal: {
    objective: 'Write result.txt', constraints: [], acceptance: ['The explanation is useful to the operator'], maxModelCalls: 6, mode: 'collaborative',
  } } });
  const pending = await fixture.waitFor(created.taskId, snapshot => snapshot.selectedTask?.status === 'waiting_approval');
  await fixture.command({ commandId: randomUUID(), type: 'grant', taskId: created.taskId, parameters: { intentId: pending.intents[0]!.id } });
  const awaiting = await fixture.waitFor(created.taskId, snapshot => snapshot.selectedTask?.status === 'waiting_input');
  const rejected = await fixture.request('POST', '/v1/accept-result', { taskId: created.taskId, accepted: true,
    expectedRevision: awaiting.selectedTask!.revision - 1, evidence: 'Stale evidence must not be accepted' });
  assert.notEqual(rejected.status, 200);
  const accepted = await fixture.request('POST', '/v1/accept-result', { taskId: created.taskId, accepted: true,
    expectedRevision: awaiting.selectedTask!.revision, evidence: 'I read the recorded current result.txt and confirm the explanation meets my criterion.' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
  assert.equal((await fixture.snapshot(created.taskId)).selectedTask!.status, 'completed');
  assert.ok(fixture.backend.services.kernel.getVerifications(created.taskId).some(verification => verification.record.reviewer === 'local-operator' && verification.record.passed === true));
});

test('independent HTTP: clarification survives cold restart and the answer admits a fresh run', { timeout: 35_000 }, async t => {
  const fixture = await backendFixture(t);
  await fixture.backend.services.runner.stop();
  const created = await fixture.command({ commandId: randomUUID(), type: 'create_task', parameters: { goal: {
    objective: 'Write question-output.txt after choosing a format', constraints: [], acceptance: ['file:question-output.txt'], maxModelCalls: 6, mode: 'collaborative',
  } } });
  // A stored, parsed model tool proposal drives the public question/input state machine.
  fixture.backend.services.kernel.addMessage(created.taskId, 'assistant', 'A required format choice is unresolved.', 'main', {
    toolCalls: [{ id: 'audit-question', name: 'ask_user', arguments: { question: 'Use plain text or Markdown?' } }],
  });
  fixture.backend.services.runner.start();
  const waiting = await fixture.waitFor(created.taskId, snapshot => snapshot.selectedTask?.status === 'waiting_input');
  assert.equal(waiting.selectedTask!.waitingReason, 'Use plain text or Markdown?');
  await fixture.restart();
  const restored = await fixture.snapshot(created.taskId);
  assert.equal(restored.selectedTask!.status, 'waiting_input');
  assert.deepEqual(restored.messages, waiting.messages);
  await fixture.command({ commandId: randomUUID(), type: 'answer', taskId: created.taskId, parameters: { content: 'Use plain text' } });
  const resumed = await fixture.waitFor(created.taskId, snapshot => snapshot.selectedTask!.modelCalls > 0 && ['waiting_input', 'waiting_approval', 'completed', 'failed'].includes(snapshot.selectedTask!.status));
  assert.notEqual(resumed.selectedTask!.status, 'failed', resumed.selectedTask!.error);
  assert.ok(resumed.messages.some(message => message.role === 'user' && message.content === 'Use plain text'));
  assert.equal(resumed.events.filter(event => event.type === 'question.asked').length, 1);
  assert.ok(fixture.backend.services.kernel.getRuns(created.taskId).length >= 2);
});

test('independent HTTP: delegated worker executes in its owned workspace and parent explicitly accepts verified result', { timeout: 35_000 }, async t => {
  const fixture = await backendFixture(t);
  const parent = await fixture.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: 'Audit parent', goal: {
    objective: 'Write parent-output.txt', constraints: ['Children must keep separate file ownership'],
    acceptance: ['file:parent-output.txt'], maxModelCalls: 12, mode: 'collaborative',
  } } });
  const parentPending = await fixture.waitFor(parent.taskId, snapshot => snapshot.selectedTask?.status === 'waiting_approval');
  await fixture.command({ commandId: randomUUID(), type: 'delegate', taskId: parent.taskId, parameters: { title: 'Audit child', goal: {
    objective: 'Write child-output.txt', constraints: ['Only the assigned child workspace'],
    acceptance: ['file:child-output.txt'], maxModelCalls: 6, mode: 'autonomous',
  } } });
  const delegated = await fixture.snapshot(parent.taskId);
  const child = delegated.tasks.find(task => task.parentId === parent.taskId)!;
  assert.ok(child);
  assert.notEqual(child.workspace, parentPending.selectedTask!.workspace);
  assert.ok(path.relative(parentPending.selectedTask!.workspace, child.workspace).startsWith('subtasks'));
  const premature = await fixture.request('POST', '/v1/commands', { commandId: randomUUID(), type: 'accept_result', taskId: parent.taskId,
    parameters: { childTaskId: child.id } });
  assert.notEqual(premature.status, 200);
  const childPending = await fixture.waitFor(child.id, snapshot => snapshot.selectedTask?.status === 'waiting_approval');
  await fixture.command({ commandId: randomUUID(), type: 'grant', taskId: child.id, parameters: { intentId: childPending.intents[0]!.id } });
  const childDone = await fixture.waitFor(child.id, snapshot => ['completed', 'failed', 'waiting_input'].includes(snapshot.selectedTask!.status));
  assert.equal(childDone.selectedTask!.status, 'completed', childDone.selectedTask!.error ?? childDone.selectedTask!.waitingReason);
  assert.match(readFileSync(path.join(child.workspace, 'child-output.txt'), 'utf8'), /NPN-Gamma mock output/);
  assert.ok(fixture.backend.services.kernel.getVerifications(child.id).some(value => value.record.passed === true));
  await fixture.command({ commandId: randomUUID(), type: 'accept_result', taskId: parent.taskId, parameters: { childTaskId: child.id } });
  assert.equal(fixture.backend.services.kernel.delegations(parent.taskId)[0]!.state, 'accepted');
  const charged = await fixture.snapshot(parent.taskId);
  assert.ok(charged.selectedTask!.modelCalls >= childDone.selectedTask!.modelCalls);
  await fixture.command({ commandId: randomUUID(), type: 'grant', taskId: parent.taskId, parameters: { intentId: parentPending.intents[0]!.id } });
  const parentDone = await fixture.waitFor(parent.taskId, snapshot => ['completed', 'failed', 'waiting_input'].includes(snapshot.selectedTask!.status));
  assert.equal(parentDone.selectedTask!.status, 'completed', parentDone.selectedTask!.error ?? parentDone.selectedTask!.waitingReason);
  assert.match(readFileSync(path.join(parentDone.selectedTask!.workspace, 'parent-output.txt'), 'utf8'), /NPN-Gamma mock output/);
});

test('independent HTTP: synthetic session credential is removed before goals, IDE writes, journals and artifacts persist', { timeout: 35_000 }, async t => {
  const fixture = await backendFixture(t);
  await fixture.backend.services.runner.stop();
  const canary = `audit-nonproduction-credential-${randomUUID()}`;
  const configured = await fixture.request('POST', '/v1/config', { mode: 'mock', apiKey: canary });
  assert.equal(configured.status, 200);
  assert.equal(JSON.stringify(configured.value).includes(canary), false, 'Configuration response must never expose the credential');
  const created = await fixture.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    title: `Do not save ${canary}`, goal: { objective: `Write private-output.txt without ${canary}`,
      constraints: [`Protect ${canary}`], acceptance: [`contains:private-output.txt:${canary}`], maxModelCalls: 6, mode: 'autonomous' },
  } });
  await fixture.command({ commandId: randomUUID(), type: 'pause', taskId: created.taskId });
  const proposal = await fixture.request('POST', '/v1/files', { taskId: created.taskId, requestId: randomUUID(),
    path: 'private-output.txt', content: `Known session secret must be redacted: ${canary}\n` });
  assert.equal(proposal.status, 200);
  fixture.backend.services.runner.start();
  const pending = await fixture.waitFor(created.taskId, snapshot => snapshot.selectedTask?.status === 'waiting_approval');
  assert.equal(JSON.stringify(pending).includes(canary), false, 'Goal, constraints, raw messages, command events and intent must exclude the known credential');
  await fixture.command({ commandId: randomUUID(), type: 'grant', taskId: created.taskId, parameters: { intentId: pending.intents[0]!.id } });
  const result = await fixture.waitFor(created.taskId, snapshot => ['completed', 'failed', 'waiting_input'].includes(snapshot.selectedTask!.status));
  assert.equal(result.selectedTask!.status, 'completed', result.selectedTask!.error ?? result.selectedTask!.waitingReason);
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.ok(fixture.backend.mock.requests() > 0, 'The test must exercise real local mock model requests');
  await fixture.backend.close();
  const inspect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.isFile()) assert.equal(readFileSync(file).includes(Buffer.from(canary)), false,
        'Known synthetic credential must be absent from persisted state, receipt, artifact and log bytes');
    }
  };
  inspect(fixture.dataDir);
});
