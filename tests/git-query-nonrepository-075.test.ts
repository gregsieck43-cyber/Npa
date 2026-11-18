import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ToolGateway } from '../src/tools/gateway.js';
import { gitQuery } from '../src/tools/read-only.js';
import { Kernel } from '../src/kernel/index.js';
import { Runner } from '../src/app/runner.js';
import type { Configuration } from '../src/app/configuration.js';
import type { CandidateManager } from '../src/adaptation/index.js';
import type { WireMessage } from '../src/contracts.js';

const NOT_REPOSITORY = 'Not a Git repository: the selected workspace has no .git metadata.';

async function fixture(t: import('node:test').TestContext) {
  const base = path.resolve(process.env.TEMP ?? '.tmp');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'git-query-nonrepository-075-'));
  const workspace = path.join(root, 'workspace'), receiptDirectory = path.join(root, 'receipts');
  await mkdir(workspace);
  const close: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    for (const dispose of close.reverse()) await dispose();
    assert.equal(path.dirname(root), base);
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, receiptDirectory, close, gateway: new ToolGateway({ workspace, receiptDirectory }) };
}

test('non-repository Git queries settle durable receipts without discovering a parent repository', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  // A parent marker must never make a selected child workspace inherit repository authority.
  await mkdir(path.join(f.root, '.git'));
  await writeFile(path.join(f.workspace, 'source.txt'), 'ordinary workspace input');
  for (const operation of ['status', 'log', 'diff', 'show']) {
    const prepared = await f.gateway.prepare({ name: 'git_query', arguments: { operation, path: 'source.txt' } });
    assert.equal(prepared.mutating, false);
    const result = await f.gateway.execute(prepared, { effectKey: operation });
    assert.equal(result.status, 'applied', result.error);
    assert.equal(result.output, NOT_REPOSITORY);
    assert.equal(result.receipt?.exitCode, 128);
    assert.equal(result.receipt?.truncated, false);
    assert.equal(result.receipt?.digest, prepared.digest);
    assert.equal(result.receipt?.effectKey, operation);
    // If replay actually redispatches this would fail: deliberately replace absence with damage.
    await writeFile(path.join(f.workspace, '.git'), 'gitdir: missing-metadata\n');
    const reopened = new ToolGateway({ workspace: f.workspace, receiptDirectory: f.receiptDirectory });
    assert.deepEqual(await reopened.execute(prepared, { effectKey: operation }), result);
    assert.deepEqual(await reopened.queryOutcome(operation, prepared.digest), result);
    await rm(path.join(f.workspace, '.git'));
  }
  const read = await f.gateway.prepare({ name: 'read_file', arguments: { path: 'source.txt' } });
  assert.equal((await f.gateway.execute(read, { effectKey: 'continue-read' })).output, 'ordinary workspace input');
});

test('a Git marker removed after preparation returns a settled non-repository result', { timeout: 15000 }, async t => {
  const f = await fixture(t), marker = path.join(f.workspace, '.git');
  await mkdir(marker);
  const prepared = await f.gateway.prepare({ name: 'git_query', arguments: { operation: 'status' } });
  await rm(marker, { recursive: true });
  const result = await f.gateway.execute(prepared, { effectKey: 'marker-removed' });
  assert.equal(result.status, 'applied', result.error);
  assert.equal(result.output, NOT_REPOSITORY);
  assert.deepEqual(await f.gateway.queryOutcome('marker-removed', prepared.digest), result);
});

test('damaged Git metadata and missing workspaces are not converted to non-repository results', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, '.git'), 'gitdir: missing-metadata\n');
  const prepared = await f.gateway.prepare({ name: 'git_query', arguments: { operation: 'status' } });
  const failed = await f.gateway.execute(prepared, { effectKey: 'damaged-marker' });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /ENOENT/);
  assert.notEqual(failed.output, NOT_REPOSITORY);
  assert.equal((await f.gateway.queryOutcome('damaged-marker', prepared.digest)).status, 'unknown');
  await assert.rejects(gitQuery(path.join(f.root, 'absent-workspace'), { operation: 'status' }), { code: 'ENOENT' });
  const fileWorkspace = path.join(f.root, 'not-a-directory');
  await writeFile(fileWorkspace, 'file');
  await assert.rejects(gitQuery(fileWorkspace, { operation: 'status' }), /ENOTDIR|ENOENT/);
});

test('a linked Git marker remains denied instead of being treated as missing', { timeout: 15000 }, async t => {
  const f = await fixture(t), other = path.join(f.root, 'other-metadata');
  await mkdir(other);
  await symlink(other, path.join(f.workspace, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
  const prepared = await f.gateway.prepare({ name: 'git_query', arguments: { operation: 'status' } });
  const result = await f.gateway.execute(prepared, { effectKey: 'linked-marker' });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /metadata links/);
  assert.notEqual(result.output, NOT_REPOSITORY);
});

test('an old pending Git receipt remains unknown and is not automatically redispatched', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const prepared = await f.gateway.prepare({ name: 'git_query', arguments: { operation: 'status' } });
  await mkdir(f.receiptDirectory);
  const database = path.join(f.receiptDirectory, 'tool-receipts.sqlite');
  const db = new DatabaseSync(database);
  try {
    db.exec('CREATE TABLE receipts(effect_key TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,prepared TEXT NOT NULL,receipt TEXT)');
    db.prepare('INSERT INTO receipts VALUES(?,?,?,?,NULL)').run('legacy-pending', prepared.digest, 'pending', JSON.stringify(prepared));
  } finally { db.close(); }
  const queried = await f.gateway.queryOutcome('legacy-pending', prepared.digest);
  assert.equal(queried.status, 'unknown');
  assert.equal((await f.gateway.execute(prepared, { effectKey: 'legacy-pending' })).status, 'unknown');
  const check = new DatabaseSync(database, { readOnly: true });
  try { assert.deepEqual({ ...check.prepare('SELECT state,receipt FROM receipts WHERE effect_key=?').get('legacy-pending') }, { state: 'pending', receipt: null }); }
  finally { check.close(); }
});

test('real Work Runner consumes a settled non-repository result and executes its next read', { timeout: 20000 }, async t => {
  const f = await fixture(t), kernel = new Kernel(path.join(f.root, 'kernel'));
  f.close.push(() => kernel.close());
  let calls = 0;
  const configuration = {
    globalPaths: [], skillRoots: [], redact: (value: string) => value, sanitize: (value: unknown) => value,
    client: () => ({ config: {}, complete: async (messages: WireMessage[]) => {
      calls++;
      if (calls === 2) assert.equal(messages.findLast(message => message.role === 'tool')?.content, NOT_REPOSITORY);
      if (calls === 3) assert.equal(messages.findLast(message => message.role === 'tool')?.content, 'READ_AFTER_NON_REPOSITORY');
      assert.ok(calls <= 3, 'No automatic retry or unexpected model continuation');
      const call = calls === 1 ? { id: 'git-status', name: 'git_query', arguments: { operation: 'status' } }
        : calls === 2 ? { id: 'continue-read', name: 'read_file', arguments: { path: 'source.txt' } }
          : { id: 'wait', name: 'ask_user', arguments: { question: 'The ordinary workspace was inspected. What next?', reason: 'blocker' } };
      return { content: '', toolCalls: [call], finishReason: 'tool_calls' };
    } }),
  } as unknown as Configuration;
  const candidates = { snapshotFor: () => ({}), applySnapshot: async (_: unknown, value: string) => value } as unknown as CandidateManager;
  const runner = new Runner(kernel, configuration, candidates, f.root);
  f.close.push(() => runner.stop());
  const taskId = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    objective: 'Inspect this ordinary workspace with Git then read its source.', workspace: f.workspace,
    maxModelCalls: 5, permission: { mode: 'read-only', app: 'work' },
  } }).taskId!;
  await writeFile(path.join(f.workspace, 'source.txt'), 'READ_AFTER_NON_REPOSITORY');
  runner.start();
  const deadline = performance.now() + 10000;
  while (!['waiting_input', 'reconciling', 'failed'].includes(kernel.getTask(taskId)!.status) && performance.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(kernel.getTask(taskId)!.status, 'waiting_input', JSON.stringify({ calls, intents: kernel.intents(taskId).map(intent => ({ name: intent.name, state: intent.state })), error: kernel.getTask(taskId)!.error }));
  assert.equal(calls, 3);
  assert.deepEqual(kernel.intents(taskId).map(intent => ({ name: intent.name, state: intent.state })), [
    { name: 'git_query', state: 'applied' }, { name: 'read_file', state: 'applied' },
  ]);
  assert.equal(kernel.intents(taskId)[0]!.receipt?.exitCode, 128);
  assert.equal(kernel.events(taskId).filter(event => event.type === 'effect.unknown').length, 0);
  assert.equal(kernel.getMessages(taskId).filter(message => message.toolCallId === 'git-status' && message.role === 'tool').length, 1);
  assert.equal(await readFile(path.join(f.workspace, 'source.txt'), 'utf8'), 'READ_AFTER_NON_REPOSITORY');
});
