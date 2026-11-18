/**
 * Real-service IDE entrypoint acceptance. No in-process adapter replaces the code under test:
 *
 *  - the built backend (build/src/app/backend.js) behind its authenticated loopback HTTP routes,
 *    with the durable SQLite kernel/harness state it actually creates;
 *  - the real IDE routes (/v1/ide/workspace, /v1/ide/tasks, /v1/ide/agent, /v1/ide/editors) through
 *    the real IdeController/BackendClient, not a fake transport;
 *  - the real IdeEditors dirty-buffer guard consulted by the real Runner -> ToolGateway write path;
 *  - a real backend restart: process approvals are invalidated, history and model-call budgets stay,
 *    and a dispatched-but-unreceipted effect is reconciled from evidence instead of replayed;
 *  - the startup prerequisites of scripts/test-ide.mjs are inspected statically only.
 *
 * The GUI acceptance script is never executed here: no Electron, Code-OSS or browser is launched,
 * no screenshot is taken and no GUI acceptance is claimed. Model calls use the loopback mock that
 * startBackend installs; there is no public network, paid model call or API.txt use.
 *
 * Fixtures live under .tmp/entrypoint-acceptance/child (workspace and data never nested) and are
 * removed by each test. This test file and its evidence are the only paths this agent writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startBackend } from '../src/app/backend.js';
import { BackendClient } from '../src/extensions/client.js';
import { IdeController } from '../src/ide/controller.js';
import { EditorBusyError } from '../src/ide/editors.js';
import { ideAssets, prepareIde } from '../src/ide/launcher.js';
import type { Command, CommandAck, Message, Snapshot, Task } from '../src/contracts.js';
import { assertProjectFixtureRoot } from './project-boundary.js';

type Backend = Awaited<ReturnType<typeof startBackend>>;
const CHECKOUT = path.resolve(process.cwd());
const CHILD_ROOT = path.join(CHECKOUT, '.tmp', 'entrypoint-acceptance', 'child');
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

function fixture(label: string): { root: string; workspace: string; other: string; dataDir: string } {
  mkdirSync(CHILD_ROOT, { recursive: true });
  const root = mkdtempSync(path.join(CHILD_ROOT, label));
  assertProjectFixtureRoot(root);
  const workspace = path.join(root, 'workspace'), other = path.join(root, 'other'), dataDir = path.join(root, 'data');
  for (const directory of [workspace, other, dataDir]) mkdirSync(directory, { recursive: true });
  for (const [left, right] of [[workspace, dataDir], [dataDir, workspace]] as const) {
    const relative = path.relative(left, right);
    assert.ok(relative !== '' && relative.startsWith('..') && !path.isAbsolute(relative), 'Fixture workspace and data must not nest.');
  }
  return { root, workspace, other, dataDir };
}

async function http(backend: Backend, method: 'GET' | 'POST', route: string, input?: unknown): Promise<{ status: number; value: Record<string, any> }> {
  const response = await fetch('http://127.0.0.1:' + backend.port + route, {
    method,
    headers: { Authorization: 'Bearer ' + backend.token, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, value: await response.json() as Record<string, any> };
}

function command(client: BackendClient, body: Omit<Command, 'commandId'>): Promise<CommandAck> {
  return client.command({ ...body, commandId: randomUUID() });
}

async function createTask(client: BackendClient, workspace: string, objective: string, maxModelCalls = 12): Promise<string> {
  const ack = await command(client, {
    type: 'create_task',
    parameters: { title: objective, workspace, goal: { objective, constraints: [], acceptance: [], maxModelCalls, maxToolCalls: 30, mode: 'collaborative' } },
  });
  assert.ok(ack.taskId, 'create_task must return a task id');
  return ack.taskId;
}

async function waitFor(client: BackendClient, taskId: string, label: string, ready: (snapshot: Snapshot) => boolean, timeout = 20_000): Promise<Snapshot> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const snapshot = await client.taskView(taskId);
    if (ready(snapshot)) return snapshot;
    const status = snapshot.selectedTask?.status;
    if (status === 'failed' || status === 'cancelled') assert.fail(label + ': task ended ' + String(status) + ': ' + String(snapshot.selectedTask?.error ?? ''));
    if (Date.now() > deadline) assert.fail(label + ': timed out; status=' + String(status) + ' intents=' + JSON.stringify(snapshot.intents.map(intent => [intent.name, intent.state])));
    await delay(40);
  }
}

test('authenticated IDE routes expose scoped Agent views, editor state and durable SQLite data', { timeout: 60_000 }, async t => {
  const { root, workspace, other, dataDir } = fixture('ide-routes-');
  const backend = await startBackend({ dataDir, projectRoot: CHECKOUT, mockOptions: { delayMs: 40 } });
  const client = new BackendClient({ dataDir, timeoutMs: 20_000 });
  t.after(async () => {
    try { await backend.close(); }
    finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });

  const local = await client.workspace(workspace), foreign = await client.workspace(other);
  assert.equal(local.path, path.resolve(workspace));
  assert.notEqual(local.id, foreign.id);
  assert.deepEqual(await client.tasks(workspace), [], 'A new IDE workspace must not create tasks.');
  assert.equal(backend.services.kernel.listTasks().length, 0);

  const localTask = await createTask(client, workspace, 'Paused scope check for ide-routes.local.txt');
  let ack = await command(client, { type: 'pause', taskId: localTask });
  assert.equal(ack.status, 'accepted');
  const foreignTask = await createTask(client, other, 'Paused scope check for ide-routes.other.txt');
  ack = await command(client, { type: 'pause', taskId: foreignTask });
  assert.equal(ack.status, 'accepted');

  assert.deepEqual((await client.tasks(workspace)).map(task => task.id), [localTask]);
  assert.deepEqual((await client.tasks(other)).map(task => task.id), [foreignTask]);
  const controller = new IdeController(client);
  assert.deepEqual((await controller.refresh([workspace])).map(task => task.id), [localTask]);
  await assert.rejects(controller.control(foreignTask, 'resume'), /workspace/i);

  const emptyView = await client.agentView(workspace, {});
  assert.deepEqual(emptyView.tasks.map(task => task.id), [localTask]);
  assert.deepEqual(emptyView.chats, []);
  assert.ok(emptyView.profiles.length > 0);
  assert.ok(emptyView.profiles.every(profile => !('credentialFile' in profile)));
  assert.doesNotMatch(JSON.stringify(emptyView), /"token"\s*:|"apiKey"\s*:/);
  const scopedView = await client.agentView(workspace, { taskId: localTask });
  assert.equal(scopedView.task?.id, localTask);
  assert.ok(scopedView.messages.some(message => message.role === 'user' && message.content.includes('Paused scope check')));
  assert.equal(scopedView.totalMessages, scopedView.messages.length);
  const foreignSelection = await http(backend, 'GET', '/v1/ide/agent?workspace=' + encodeURIComponent(other) + '&taskId=' + encodeURIComponent(localTask));
  assert.equal(foreignSelection.status, 400);
  assert.match(String(foreignSelection.value.error), /not in this IDE workspace/i);

  const chat = await client.createChat({ workspace, title: 'IDE shared chat', profileId: 'default', capabilities: { tools: false } });
  const sent = await client.sendChat({ sessionId: chat.id, content: 'IDE_ROUTE_CHAT_MARKER' });
  let chatView = await client.agentView(workspace, { chatId: chat.id });
  const chatDeadline = Date.now() + 20_000;
  while (chatView.request?.status !== 'completed' && Date.now() < chatDeadline) {
    await delay(60);
    chatView = await client.agentView(workspace, { chatId: chat.id });
  }
  assert.equal(chatView.request?.id, sent.requestId);
  assert.equal(chatView.request?.status, 'completed');
  assert.ok(chatView.messages.some(message => message.content.includes('IDE_ROUTE_CHAT_MARKER')));
  assert.ok((chatView.metrics?.steps ?? 0) >= 1);
  assert.equal(backend.services.kernel.listTasks().length, 2, 'A Chat session must not start Work.');

  const recorded = await client.editorState({ owner: 'window-a', workspace, dirtyPaths: ['draft.ts'] });
  assert.equal(recorded.recorded, true);
  const dirtyTarget = path.join(workspace, 'draft.ts');
  assert.throws(() => backend.services.editors.assertWritable(dirtyTarget), (error: unknown) => error instanceof EditorBusyError && error.code === 'EDITOR_DIRTY');
  assert.throws(() => backend.services.editors.assertWorkspaceClean(workspace), EditorBusyError);
  assert.doesNotThrow(() => backend.services.editors.assertWorkspaceClean(other));
  const invalidDirty = await http(backend, 'POST', '/v1/ide/editors', { owner: 'window-a', workspace, dirtyPaths: ['../escape.ts'] });
  assert.equal(invalidDirty.status, 400);
  assert.match(String(invalidDirty.value.error), /outside/i);
  assert.equal(backend.services.kernel.listTasks().length, 2, 'Editor state is live coordination, not task authority.');
  await client.editorState({ owner: 'window-a', workspace, dirtyPaths: [], sequence: 2 });
  assert.doesNotThrow(() => backend.services.editors.assertWritable(dirtyTarget));
  await client.editorState({ owner: 'window-a', remove: true });
  await assert.rejects(client.workspace(dataDir), /data|audit/i);
  await assert.rejects(client.workspace('C:\\outside'), /volume that hosts this installation|installation volume/i);

  const durable = new DatabaseSync(path.join(dataDir, 'kernel.sqlite'));
  try {
    const storedIds = durable.prepare('SELECT id FROM tasks ORDER BY rowid').all().map(row => String((row as { id: unknown }).id)).sort();
    assert.deepEqual(storedIds, [localTask, foreignTask].sort(), 'IDE routes read the same SQLite rows an operator would inspect.');
    assert.equal(Number((durable.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n), 2);
    const storedTask = JSON.parse(String((durable.prepare('SELECT body FROM tasks WHERE id=?').get(localTask) as { body: string }).body)) as Task;
    assert.equal(storedTask.status, 'paused');
    assert.equal(storedTask.workspace, path.resolve(workspace));
  } finally { durable.close(); }
});

test('unsaved IDE buffers and post-preparation human saves block the real Agent write path', { timeout: 120_000 }, async t => {
  const { root, workspace, dataDir } = fixture('ide-write-guard-');
  const backend = await startBackend({ dataDir, projectRoot: CHECKOUT, mockOptions: { delayMs: 30 } });
  const client = new BackendClient({ dataDir, timeoutMs: 20_000 });
  t.after(async () => {
    try { await backend.close(); }
    finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });

  const dirtyTask = await createTask(client, workspace, 'Write dirty-target.txt with the default mock output.');
  const pending = await waitFor(client, dirtyTask, 'dirty-target approval', snapshot => snapshot.selectedTask?.status === 'waiting_approval');
  const dirtyIntent = pending.intents.find(intent => intent.name === 'write_file' && intent.state === 'prepared');
  assert.ok(dirtyIntent, 'The real runner must prepare a write_file intent for approval.');
  const dirtyFile = path.join(workspace, 'dirty-target.txt');
  assert.equal(existsSync(dirtyFile), false, 'Preparation alone never writes.');
  assert.equal(pending.selectedTask?.modelCalls, 1);

  const recorded = await client.editorState({ owner: 'window-a', workspace, dirtyPaths: ['dirty-target.txt'] });
  assert.equal(recorded.recorded, true);
  await command(client, { type: 'grant', taskId: dirtyTask, parameters: { intentId: dirtyIntent.id } });
  const blocked = await waitFor(client, dirtyTask, 'dirty buffer block', snapshot => snapshot.selectedTask?.status === 'waiting_input');
  assert.match(String(blocked.selectedTask?.waitingReason), /unsaved edits/i);
  assert.equal(existsSync(dirtyFile), false, 'A dirty IDE buffer must block the approved Agent write.');
  assert.equal(blocked.intents.find(intent => intent.id === dirtyIntent.id)?.state, 'approved');
  assert.equal(backend.services.kernel.getBudgets(dirtyTask).toolCalls, 0, 'A blocked editor write must not consume the tool budget.');
  assert.ok(blocked.events.some(event => event.type === 'diagnostic.error' && /unsaved edits/i.test(JSON.stringify(event.payload))));

  await client.editorState({ owner: 'window-a', workspace, dirtyPaths: [], sequence: 2 });
  assert.doesNotThrow(() => backend.services.editors.assertWritable(dirtyFile), 'Saving the buffer releases the guard.');

  const cleanTask = await createTask(client, workspace, 'Write clean-target.txt with the default mock output.');
  const cleanPending = await waitFor(client, cleanTask, 'clean-target approval', snapshot => snapshot.selectedTask?.status === 'waiting_approval');
  const cleanIntent = cleanPending.intents.find(intent => intent.name === 'write_file' && intent.state === 'prepared');
  assert.ok(cleanIntent);
  await command(client, { type: 'grant', taskId: cleanTask, parameters: { intentId: cleanIntent.id } });
  const completed = await waitFor(client, cleanTask, 'clean-target completion', snapshot => snapshot.selectedTask?.status === 'completed', 40_000);
  assert.equal(completed.intents.find(intent => intent.id === cleanIntent.id)?.state, 'applied');
  assert.match(readFileSync(path.join(workspace, 'clean-target.txt'), 'utf8'), /NPN-Gamma mock output/);
  assert.equal(existsSync(dirtyFile), false, 'The blocked write must stay unexecuted after another task writes.');
  assert.equal(backend.services.kernel.getTask(dirtyTask)!.status, 'waiting_input');

  const conflictTask = await createTask(client, workspace, 'Write conflict-target.txt with the default mock output.');
  const conflictPending = await waitFor(client, conflictTask, 'conflict-target approval', snapshot => snapshot.selectedTask?.status === 'waiting_approval');
  const conflictIntent = conflictPending.intents.find(intent => intent.name === 'write_file' && intent.state === 'prepared');
  assert.ok(conflictIntent);
  const conflictFile = path.join(workspace, 'conflict-target.txt');
  writeFileSync(conflictFile, 'HUMAN_SAVED_VERSION\n');
  // The disk changed before approval: the Kernel rejects the grant itself, without refreshing its baseline.
  await assert.rejects(command(client, { type: 'grant', taskId: conflictTask, parameters: { intentId: conflictIntent.id } }), /File changed since the bound read/);
  const conflicted = await client.taskView(conflictTask);
  assert.equal(readFileSync(conflictFile, 'utf8'), 'HUMAN_SAVED_VERSION\n', 'A write prepared before the human save must never overwrite it.');
  const stale = conflicted.intents.find(intent => intent.id === conflictIntent.id);
  assert.ok(stale); assert.equal(stale.state, 'prepared');
  assert.equal(stale.digest, conflictIntent.digest); assert.deepEqual(stale.arguments, conflictIntent.arguments);
  assert.equal(conflicted.selectedTask?.status, 'waiting_approval');
  assert.equal(backend.services.kernel.getBudgets(conflictTask).toolCalls, 0, 'Grant rejects the stale read before any dispatch.');
  for (const type of ['intent.approved', 'intent.sent', 'effect.receipted', 'effect.unknown'])
    assert.equal(backend.services.kernel.eventCount(conflictTask, type), 0, type + ' must not occur after a rejected grant');
  const approvalRows = new DatabaseSync(path.join(dataDir, 'kernel.sqlite'), { readOnly: true });
  try { assert.equal(Number((approvalRows.prepare("SELECT COUNT(*) AS n FROM approvals WHERE intent_id=? AND state='granted'").get(conflictIntent.id) as { n: number }).n), 0); }
  finally { approvalRows.close(); }
  assert.equal(conflicted.messages.some(message => message.role === 'tool' && message.toolCallId === conflictIntent.toolCallId), false, 'Approval rejection did not execute the tool or invent its result.');
  assert.throws(() => backend.services.kernel.dispatch(conflictIntent.id), /state|denied|approv/i);
  await command(client, { type: 'cancel', taskId: conflictTask });
});

test('restart invalidates process approvals, keeps history and model calls, and never replays an unknown effect', { timeout: 120_000 }, async t => {
  const { root, workspace, dataDir } = fixture('ide-recovery-');
  let backend: Backend | undefined = await startBackend({ dataDir, projectRoot: CHECKOUT, mockOptions: { delayMs: 30 } });
  const client = new BackendClient({ dataDir, timeoutMs: 20_000 });
  t.after(async () => {
    try { await backend?.close(); }
    finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });

  const recoveryTask = await createTask(client, workspace, 'Write recovery-target.txt with the default mock output.');
  const pending = await waitFor(client, recoveryTask, 'recovery-target approval', snapshot => snapshot.selectedTask?.status === 'waiting_approval');
  const approvedIntent = pending.intents.find(intent => intent.name === 'write_file' && intent.state === 'prepared');
  assert.ok(approvedIntent);
  const before = { generation: pending.selectedTask!.generation, modelCalls: pending.selectedTask!.modelCalls, messages: pending.messages };
  assert.equal(before.modelCalls, 1);
  const recoveryFile = path.join(workspace, 'recovery-target.txt');
  assert.equal(existsSync(recoveryFile), false);

  await backend.services.runner.stop();
  const kernel = backend.services.kernel;
  const unknownTask = await createTask(client, workspace, 'A dispatched effect that never returned a receipt.');
  const run = kernel.createRun(unknownTask);
  kernel.transition(unknownTask, 'running');
  const staged = kernel.prepareIntent(unknownTask, run.id, {
    id: 'entrypoint-staged-effect',
    name: 'write_file',
    arguments: { path: 'staged-unknown.txt', content: 'staged effect that never returned', expectedSha256: null },
  }, { effectKey: 'entrypoint-ide-staged-unknown' });
  kernel.approve(staged.id, { source: 'operator' });
  assert.equal(kernel.dispatch(staged.id).state, 'sent');
  const stagedFile = path.join(workspace, 'staged-unknown.txt');
  assert.equal(existsSync(stagedFile), false);

  await backend.close();
  backend = undefined;

  const durable = new DatabaseSync(path.join(dataDir, 'kernel.sqlite'));
  try {
    const storedTask = JSON.parse(String((durable.prepare('SELECT body FROM tasks WHERE id=?').get(recoveryTask) as { body: string }).body)) as Task;
    assert.equal(storedTask.status, 'waiting_approval', 'Shutdown must persist the waiting state, not invent progress.');
    assert.equal(storedTask.modelCalls, before.modelCalls, 'The model-call budget is durable.');
    const storedMessages = durable.prepare('SELECT body FROM messages WHERE task_id=? ORDER BY rowid').all(recoveryTask).map(row => JSON.parse(String((row as { body: string }).body)) as Message);
    assert.deepEqual(storedMessages, before.messages, 'The recorded conversation is durable and unchanged by shutdown.');
    assert.equal(String((durable.prepare('SELECT state FROM intents WHERE id=?').get(approvedIntent.id) as { state: string }).state), 'prepared');
    assert.equal(String((durable.prepare('SELECT state FROM intents WHERE id=?').get(staged.id) as { state: string }).state), 'sent');
  } finally { durable.close(); }

  backend = await startBackend({ dataDir, projectRoot: CHECKOUT, mockOptions: { delayMs: 30 } });
  assert.deepEqual([...backend.services.recovery.unknownIntents].sort(), [staged.id]);
  assert.ok(backend.services.recovery.requeued.includes(recoveryTask), 'A waiting approval is requeued under a new generation.');
  assert.ok(backend.services.recovery.reconciling.includes(unknownTask), 'A dispatched effect without a receipt must be reconciled.');
  assert.ok((await client.tasks(workspace)).some(task => task.id === recoveryTask), 'Recovered tasks stay visible to the IDE routes.');

  const recovered = await waitFor(client, recoveryTask, 'recovered approval', snapshot => snapshot.selectedTask?.status === 'waiting_approval'
    && snapshot.intents.some(intent => intent.id !== approvedIntent.id && intent.state === 'prepared'));
  const denial = recovered.events.find(event => event.type === 'intent.denied' && event.payload.intentId === approvedIntent.id);
  assert.ok(denial, 'Recovery must invalidate the approval that belonged to the previous process.');
  assert.match(String(denial.payload.reason), /invalidated during recovery/i);
  assert.equal(recovered.intents.find(intent => intent.id === approvedIntent.id)?.state, 'denied', 'The old sampled authority is invalid after recovery.');
  const recoveredIntent = recovered.intents.find(intent => intent.id !== approvedIntent.id && intent.state === 'prepared');
  assert.ok(recoveredIntent, 'Recovery needs a newly sampled proposal and a fresh operator approval.');
  assert.notEqual(recoveredIntent.digest, approvedIntent.digest);
  assert.equal(recoveredIntent?.generation, recovered.selectedTask!.generation);
  assert.equal(recoveredIntent?.error, undefined);
  const oldGrant = await http(backend, 'POST', '/v1/commands', { commandId: randomUUID(), type: 'grant', taskId: recoveryTask, parameters: { intentId: approvedIntent.id, digest: approvedIntent.digest } });
  assert.notEqual(oldGrant.status, 200, 'The old approval cannot authorize the freshly sampled proposal.');
  assert.equal((await client.taskView(recoveryTask)).intents.find(intent => intent.id === recoveredIntent.id)?.state, 'prepared');
  assert.equal(recovered.events.some(event => event.type === 'intent.sent'), false, 'Recovery cannot dispatch either proposal without fresh approval.');
  assert.ok(recovered.selectedTask!.generation > before.generation);
  assert.deepEqual(recovered.messages.slice(0, before.messages.length), before.messages, 'Existing history keeps its exact records.');
  assert.ok(recovered.selectedTask!.modelCalls >= before.modelCalls, 'Recovery must not reset the model-call budget.');
  assert.ok(recovered.events.some(event => event.type === 'task.recovered' && event.payload.status === 'queued'));
  const approvals = new DatabaseSync(path.join(dataDir, 'kernel.sqlite'));
  try {
    assert.equal(Number((approvals.prepare("SELECT COUNT(*) AS n FROM approvals WHERE intent_id=? AND state='granted'").get(approvedIntent.id) as { n: number }).n), 0,
      'The approval granted by the previous process must not survive the restart.');
  } finally { approvals.close(); }
  const staleRevision = await http(backend, 'POST', '/v1/commands', { commandId: randomUUID(), type: 'pause', taskId: recoveryTask, expectedRevision: recovered.selectedTask!.revision - 1 });
  assert.equal(staleRevision.status, 409, 'A stale revision must be refused instead of controlling the recovered task.');
  assert.equal(staleRevision.value.code, 'REVISION_CONFLICT');
  assert.equal(recovered.selectedTask?.status, 'waiting_approval', 'A refused stale control must not pause the recovered task.');
  assert.equal(existsSync(recoveryFile), false, 'Recovery must not execute the previously approved write.');

  const unknownDeadline = Date.now() + 15_000;
  let unknown = await client.taskView(unknownTask);
  while (!unknown.events.some(event => event.type === 'effect.reconciliation_required') && Date.now() < unknownDeadline) {
    await delay(100);
    unknown = await client.taskView(unknownTask);
  }
  assert.ok(unknown.events.some(event => event.type === 'effect.reconciliation_required'), 'The dispatcher must reconcile from evidence.');
  assert.equal(unknown.selectedTask?.status, 'reconciling');
  const unknownIntent = unknown.intents.find(intent => intent.id === staged.id);
  assert.equal(unknownIntent?.state, 'unknown', 'An unreceipted dispatch stays unknown until evidence resolves it.');
  assert.equal(unknownIntent?.receipt, undefined);
  assert.equal(unknown.selectedTask?.modelCalls, 0, 'Reconciliation must not spend model calls.');
  assert.equal(unknown.events.filter(event => event.type === 'effect.receipted').length, 0, 'No receipt may be invented.');
  assert.equal(existsSync(stagedFile), false, 'An unknown effect is never replayed automatically.');
});

test('GUI acceptance startup prerequisites are inspected statically without opening the IDE', { timeout: 60_000, skip: !existsSync(path.join(CHECKOUT, '.deps/ide-host/npn-host.json')) && 'Optional IDE host is not installed' }, async t => {
  const { root } = fixture('ide-gui-prerequisites-');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  for (const relative of ['build/src/app/backend.js', 'build/src/ide/launcher.js', 'build/src/tools/worker.js', 'build/tests/entrypoint-ide-acceptance.test.js',
    'tests/ide-host.ts', 'scripts/test-ide.mjs', 'scripts/ide-ui-checks.mjs', 'scripts/project-paths.mjs', 'scripts/package-ide-extension.py', 'ide/extension/package.json']) {
    assert.ok(existsSync(path.join(CHECKOUT, relative)), 'scripts/test-ide.mjs prerequisite is missing: ' + relative);
  }
  const script = readFileSync(path.join(CHECKOUT, 'scripts', 'test-ide.mjs'), 'utf8');
  assert.match(script, /ideAssets\(project/);
  assert.match(script, /prepareIde\(/);
  assert.match(script, /connectOverCDP/);
  const require = createRequire(import.meta.url);
  assert.match(require.resolve('playwright'), /playwright[\\/]index\.js$/);
  assert.match(require.resolve('esbuild'), /esbuild/);
  assert.match(require.resolve('electron'), /electron/);
  const python = spawnSync('python', ['-I', '-B', '-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'], {
    cwd: CHECKOUT, encoding: 'utf8', timeout: 30_000, env: { ...process.env, TEMP: root, TMP: root },
  });
  assert.equal(python.status, 0, 'The GUI acceptance script packages the extension with python: ' + String(python.error?.message ?? python.stderr));

  const assets = ideAssets(CHECKOUT, path.join(CHECKOUT, 'build'), false);
  const hostManifest = JSON.parse(readFileSync(path.join(CHECKOUT, '.deps', 'ide-host', 'npn-host.json'), 'utf8')) as { directory: string; product: string; brandingApplied: boolean };
  assert.equal(path.resolve(assets.hostDirectory), path.resolve(CHECKOUT, hostManifest.directory));
  assert.equal(hostManifest.brandingApplied, true);
  assert.equal(hostManifest.product, 'NPN Gamma IDE');
  for (const relative of ['VSCodium.exe', 'resources/app/package.json', 'resources/app/product.json', 'resources/app/out/cli.js']) {
    assert.ok(existsSync(path.join(assets.hostDirectory, relative)), 'The portable IDE host is missing ' + relative + '.');
  }
  assert.ok(statSync(path.join(assets.hostDirectory, 'VSCodium.exe')).size > 1_000_000, 'The host must be the packaged editor, not a stub.');
  const product = JSON.parse(readFileSync(path.join(assets.hostDirectory, 'resources/app/product.json'), 'utf8')) as { nameLong?: string; win32AppUserModelId?: string; licenseName?: string };
  assert.equal(product.nameLong, 'NPN Gamma IDE');
  assert.equal(product.win32AppUserModelId, 'NPN.Gamma.IDE');
  assert.equal(product.licenseName, 'MIT', 'Upstream licensing must stay intact.');

  const extensionDirectory = path.join(root, 'extension');
  mkdirSync(extensionDirectory, { recursive: true });
  writeFileSync(path.join(extensionDirectory, 'package.json'), JSON.stringify({ publisher: 'npn-gamma', name: 'npn-ide', version: '0.5.0', main: './extension.cjs' }));
  writeFileSync(path.join(extensionDirectory, 'extension.cjs'), 'exports.activate = () => {};');
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const dataDir = path.join(root, 'data');
  const fixtureHost = path.join(root, 'ide-host');
  mkdirSync(path.join(fixtureHost, 'resources', 'app', 'out'), { recursive: true });
  writeFileSync(path.join(fixtureHost, 'VSCodium.exe'), 'stub-host-binary');
  writeFileSync(path.join(fixtureHost, 'resources', 'app', 'package.json'), '{}');
  writeFileSync(path.join(fixtureHost, 'resources', 'app', 'product.json'), JSON.stringify({ nameLong: 'NPN Gamma IDE' }));
  writeFileSync(path.join(fixtureHost, 'resources', 'app', 'out', 'cli.js'), '');
  const options = {
    productRoot: root, dataDir, hostDirectory: fixtureHost, extensionDirectory, workspace, workspaceBoundary: root,
    environment: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, OPENAI_API_KEY: 'do-not-inherit', NPN_API_KEY: 'do-not-inherit', VSCODE_PORTABLE: 'C:\\unexpected' },
  };
  const spec = prepareIde(options);
  assert.equal(spec.executable, path.join(fixtureHost, 'VSCodium.exe'));
  assert.equal(spec.args.at(-1), path.resolve(workspace));
  for (const flag of ['--new-window', '--user-data-dir', '--extensions-dir', '--disable-telemetry', '--skip-welcome']) assert.ok(spec.args.includes(flag), 'Launch spec is missing ' + flag + '.');
  assert.equal(spec.env.OPENAI_API_KEY, undefined);
  assert.equal(spec.env.NPN_API_KEY, undefined);
  assert.equal(spec.env.VSCODE_PORTABLE, undefined);
  const ideRoot = path.join(dataDir, 'ide');
  for (const key of ['TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'npm_config_cache']) assert.ok(String(spec.env[key]).startsWith(ideRoot), key + ' must stay inside the IDE data directory.');
  assert.equal(spec.env.NPN_IDE_DATA_DIR, dataDir);
  const settings = JSON.parse(readFileSync(path.join(spec.userData, 'User', 'settings.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(settings['npn.openWorkbenchOnStartup'], true);
  assert.equal(settings['npn.dataDirectory'], dataDir);
  assert.equal(settings['telemetry.telemetryLevel'], 'off');
  assert.equal(settings['update.mode'], 'none');
  assert.equal(settings['files.autoSave'], 'off');
  assert.equal(settings['workbench.colorTheme'], 'NPN Warm');
  const installed = path.join(spec.extensions, 'npn-gamma.npn-ide-0.5.0');
  assert.ok(existsSync(path.join(installed, 'extension.cjs')), 'prepareIde installs the bundled extension from the bundle itself.');
  assert.equal(prepareIde(options).extensions, spec.extensions, 'Repeated preparation is idempotent.');
  assert.throws(() => prepareIde({ ...options, dataDir: 'C:\\outside' }), /installation volume|volume that hosts this installation/i);
  const hostIsLinked = lstatSync(path.join(CHECKOUT, '.deps')).isSymbolicLink();
  if (hostIsLinked) {
    assert.throws(() => prepareIde({ ...options, hostDirectory: assets.hostDirectory }), /junctions or symbolic links/i,
      'A junction-backed host path must be refused instead of followed.');
    t.diagnostic('The real IDE host is junction-backed here, so the launch spec must use a local directory; scripts/test-ide.mjs would hit the same guard in this worktree.');
  } else {
    assert.ok(existsSync(prepareIde({ ...options, hostDirectory: assets.hostDirectory }).executable));
  }

  const bundlePresent = existsSync(path.join(assets.extensionDirectory, 'package.json'));
  const realOptions = { ...options, dataDir: path.join(root, 'data-real'), extensionDirectory: assets.extensionDirectory };
  if (bundlePresent) {
    const real = prepareIde(realOptions);
    assert.ok(existsSync(path.join(real.userData, 'User', 'settings.json')));
  } else {
    assert.throws(() => prepareIde(realOptions), /Portable IDE assets are missing/, 'The generated build/ide-extension bundle must exist before the GUI acceptance script can prepare the host.');
  }
  t.diagnostic('GUI acceptance prerequisites: host=' + assets.hostDirectory + '; extensionBundlePresent=' + String(bundlePresent) + '; extensionDirectory=' + assets.extensionDirectory);
});
