import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { ProductStore } from '../src/product/store.js';
import { ProductWorkspace } from '../src/product/workspace.js';
import { ProductError, type ProductErrorCode, type ProductRuntime } from '../src/product/shared.js';

function errorCode(code: ProductErrorCode) {
  return (error: unknown): boolean => error instanceof ProductError && error.code === code;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

async function fixture(t: TestContext, prefix: string) {
  const tempRoot = path.resolve(process.env.TEMP ?? '.tmp');
  mkdirSync(tempRoot, { recursive: true });
  const owned = mkdtempSync(path.join(tempRoot, prefix));
  const install = path.join(owned, 'install'), dataDir = path.join(install, 'data');
  mkdirSync(dataDir, { recursive: true });
  const wire: unknown[] = [];
  const backend = await startBackend({
    dataDir, projectRoot: install,
    mockOptions: { trace: (body: unknown) => { wire.push(body); } },
  });
  const store = new ProductStore(dataDir);
  const rt: ProductRuntime = { services: backend.services, harness: backend.services.harness!, store, append: () => {} };
  const workspace = new ProductWorkspace(rt);
  t.after(async () => {
    try {
      store.close();
    } finally {
      try {
        await backend.close();
      } finally {
        rmSync(owned, { recursive: true, force: true });
      }
    }
  });
  return { backend, workspace, wire, owned, install, project: path.join(owned, 'project'), repo: path.join(owned, 'repo') };
}

function createRepository(repo: string): void {
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Product Workspace Test']);
  git(repo, ['config', 'user.email', 'product-workspace@example.invalid']);
  writeFileSync(path.join(repo, 'a.txt'), 'alpha\nbeta\ngamma\n');
  writeFileSync(path.join(repo, 'b.txt'), 'one\ntwo\n');
  writeFileSync(path.join(repo, 'd.txt'), 'delta\n');
  git(repo, ['add', '--', 'a.txt', 'b.txt', 'd.txt']);
  git(repo, ['commit', '-m', 'initial']);
}

function statusCodes(repo: string): Map<string, string> {
  const codes = new Map<string, string>();
  for (const line of git(repo, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean)) codes.set(line.slice(3), line.slice(0, 2));
  return codes;
}

test('Git source control reports real branch, changes and line counts without touching the main project', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'product-workspace-git-');
  createRepository(f.repo);
  writeFileSync(path.join(f.repo, 'a.txt'), 'alpha changed\nbeta\ngamma\n');
  writeFileSync(path.join(f.repo, 'd.txt'), 'delta changed\n');
  git(f.repo, ['add', '--', 'a.txt', 'd.txt']);
  writeFileSync(path.join(f.repo, 'b.txt'), 'one changed\ntwo\n');
  writeFileSync(path.join(f.repo, 'c.txt'), 'added one\nadded two\n');
  const view = await f.workspace.addProject(f.repo);
  assert.equal(view.branch, 'main');
  assert.equal(view.changedFiles, 4);

  const sc = await f.workspace.sourceControl(view.id);
  assert.equal(sc.branch, 'main');
  assert.equal(sc.ahead, 0);
  assert.equal(sc.behind, 0);
  const changes = new Map(sc.changes.map(change => [change.path, change]));
  assert.equal(changes.get('a.txt')?.status, 'M');
  assert.equal(changes.get('b.txt')?.status, 'M');
  assert.equal(changes.get('c.txt')?.status, '?');
  assert.equal(changes.get('d.txt')?.status, 'M');
  assert.equal(changes.get('a.txt')?.additions, 1);
  assert.equal(changes.get('a.txt')?.deletions, 1);
  assert.equal(changes.get('b.txt')?.additions, 1);
  assert.equal(changes.get('b.txt')?.deletions, 1);
  assert.equal(changes.get('c.txt')?.additions, 0);
  assert.equal(changes.get('c.txt')?.deletions, 0);
  assert.ok(!sc.changes.some(change => change.path.includes('..')));
  assert.equal(f.wire.length, 0, 'Git inspection never calls the model provider.');
  assert.equal(f.backend.services.kernel.listTasks().length, 0, 'Git inspection never creates Agent tasks.');
});

test('fileDiff returns real hunks for modified and untracked files', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'product-workspace-diff-');
  createRepository(f.repo);
  writeFileSync(path.join(f.repo, 'a.txt'), 'alpha changed\nbeta\ngamma\n');
  writeFileSync(path.join(f.repo, 'c.txt'), 'added one\nadded two\n');
  const view = await f.workspace.addProject(f.repo);

  const modified = await f.workspace.fileDiff(view.id, 'a.txt');
  assert.equal(modified.path, 'a.txt');
  assert.equal(modified.status, 'modified');
  assert.equal(modified.additions, 1);
  assert.equal(modified.deletions, 1);
  assert.equal(modified.applied, false);
  assert.ok(modified.hunks.length >= 1);
  assert.ok(modified.hunks[0]!.header.startsWith('@@'));
  const addedLine = modified.hunks[0]!.lines.find(line => line.kind === 'add');
  assert.equal(addedLine?.text, 'alpha changed');
  assert.equal(addedLine?.newNo, 1);
  assert.ok(modified.hunks[0]!.lines.some(line => line.kind === 'del' && line.text === 'alpha'));

  const untracked = await f.workspace.fileDiff(view.id, 'c.txt');
  assert.equal(untracked.status, 'added');
  assert.equal(untracked.additions, 2);
  assert.equal(untracked.deletions, 0);
  assert.equal(untracked.hunks.length, 1);
  assert.equal(untracked.hunks[0]!.header, '@@ -0,0 +1,2 @@');
  assert.deepEqual(untracked.hunks[0]!.lines.map(line => line.kind), ['add', 'add']);

  await assert.rejects(f.workspace.fileDiff(view.id, 'ghost.txt'), errorCode('not_found'));
});

test('commit includes only the selected paths and preserves unrelated staged and unstaged changes', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'product-workspace-commit-');
  createRepository(f.repo);
  writeFileSync(path.join(f.repo, 'a.txt'), 'alpha changed\nbeta\ngamma\n');
  writeFileSync(path.join(f.repo, 'd.txt'), 'delta changed\n');
  git(f.repo, ['add', '--', 'a.txt', 'd.txt']);
  writeFileSync(path.join(f.repo, 'b.txt'), 'one changed\ntwo\n');
  writeFileSync(path.join(f.repo, 'c.txt'), 'added one\nadded two\n');
  const view = await f.workspace.addProject(f.repo);
  const headBefore = git(f.repo, ['rev-parse', 'HEAD']).trim();

  const committed = await f.workspace.commit(view.id, 'commit only alpha', ['a.txt']);
  assert.match(committed.commit, /^[0-9a-f]{40}$/);
  assert.notEqual(committed.commit, headBefore);
  const committedFiles = git(f.repo, ['show', '--name-only', '--format=', 'HEAD']).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(committedFiles, ['a.txt']);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']).trim(), committed.commit);

  const codes = statusCodes(f.repo);
  assert.equal(codes.get('a.txt'), undefined, 'The committed file is clean.');
  assert.equal(codes.get('b.txt'), ' M', 'Unrelated unstaged edits stay unstaged.');
  assert.equal(codes.get('d.txt'), 'M ', 'Unrelated staged edits stay staged.');
  assert.equal(codes.get('c.txt'), '??', 'Unrelated untracked files stay untracked.');
  assert.deepEqual(git(f.repo, ['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean), ['d.txt']);

  const untrackedCommit = await f.workspace.commit(view.id, 'add untracked file', ['c.txt']);
  assert.notEqual(untrackedCommit.commit, committed.commit);
  assert.deepEqual(git(f.repo, ['show', '--name-only', '--format=', 'HEAD']).split(/\r?\n/).filter(Boolean), ['c.txt']);
  const after = statusCodes(f.repo);
  assert.equal(after.get('c.txt'), undefined);
  assert.equal(after.get('b.txt'), ' M');
  assert.equal(after.get('d.txt'), 'M ');

  await assert.rejects(f.workspace.commit(view.id, 'unknown path', ['missing.txt']), errorCode('validation'));
  await assert.rejects(f.workspace.commit(view.id, '', ['b.txt']), errorCode('validation'));
  await assert.rejects(f.workspace.commit(view.id, 'x'.repeat(2001), ['b.txt']), errorCode('validation'));
  await assert.rejects(f.workspace.commit(view.id, 'no paths', []), errorCode('validation'));
  await assert.rejects(f.workspace.commit(view.id, 'outside', ['../escape.txt']), errorCode('validation'));
  await assert.rejects(f.workspace.commit(view.id, 'credential', ['.env']), errorCode('denied'));
  assert.equal(f.backend.services.kernel.listTasks().length, 0, 'Committing never creates Agent tasks.');
  assert.equal(f.wire.length, 0, 'Committing never calls the model provider.');
});

test('Git operations report unavailable instead of inventing results outside a repository', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'product-workspace-nogit-');
  mkdirSync(f.project);
  writeFileSync(path.join(f.project, 'file.txt'), 'plain\n');
  const view = await f.workspace.addProject(f.project);
  await assert.rejects(f.workspace.sourceControl(view.id), errorCode('unavailable'));
  await assert.rejects(f.workspace.fileDiff(view.id, 'file.txt'), errorCode('unavailable'));
  await assert.rejects(f.workspace.commit(view.id, 'message', ['file.txt']), errorCode('unavailable'));
  assert.ok(existsSync(path.join(f.project, 'file.txt')));
});
