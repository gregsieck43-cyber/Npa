import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceRoots } from '../src/app/workspace-roots.js';
import { ProductError, type ProductErrorCode, type ProductRuntime } from '../src/product/shared.js';
import { ProductWorkspace } from '../src/product/workspace.js';

const windows = process.platform === 'win32';
const linkDenials: ProductErrorCode[] = ['denied', 'scope', 'validation'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function codeIn(codes: ProductErrorCode[]) {
  return (error: unknown): boolean => error instanceof ProductError && codes.includes(error.code);
}

interface BoundaryFixture {
  project: string;
  outside: string;
  workspace: ProductWorkspace;
  id: string;
  link(name: string): string;
}

/**
 * 与 evidence 下的独立复现脚本相同的运行时形状：真实 ProductWorkspace + WorkspaceRoots + mkdtemp 夹具，
 * 不启动整个后端；链接清理必须先于递归删除，否则 rmSync 会穿过 junction 删除外部目录。
 */
function fixture(t: TestContext): BoundaryFixture {
  const tempRoot = path.resolve(process.env.TEMP ?? '.tmp');
  mkdirSync(tempRoot, { recursive: true });
  const owned = mkdtempSync(path.join(tempRoot, 'product-workspace-boundary-'));
  const project = path.join(owned, 'project');
  const outside = path.join(owned, 'outside');
  const data = path.join(owned, 'data');
  for (const dir of [project, outside, data]) mkdirSync(dir);
  const roots = new WorkspaceRoots(data);
  const record = roots.add(project);
  const links: string[] = [];
  const runtime = {
    services: {
      dataDir: data,
      projectRoot: path.join(owned, 'install'),
      assertWorkspacePath: (value: string) => { assert.equal(value, roots.resolve(record.id)); },
    },
    store: { projectSessionCount: () => 0 },
  } as unknown as ProductRuntime;
  const workspace = new ProductWorkspace(runtime);
  t.after(() => {
    for (const link of links) {
      try { unlinkSync(link); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    assert.equal(path.dirname(owned), tempRoot, 'Fixtures always stay inside the worker TEMP directory.');
    rmSync(owned, { recursive: true, force: true });
  });
  return {
    project, outside, workspace, id: record.id,
    link(name: string): string {
      const link = path.join(project, name);
      symlinkSync(outside, link, 'junction');
      links.push(link);
      return link;
    },
  };
}

test('untracked file diff cannot read through a directory junction outside the registered project', async t => {
  const f = fixture(t);
  git(f.project, ['init', '--quiet']);
  writeFileSync(path.join(f.outside, 'sentinel.txt'), 'OUTSIDE-REGISTERED-PROJECT-READ-MUST-BE-DENIED');
  f.link('linked');
  await assert.rejects(f.workspace.fileDiff(f.id, 'linked/sentinel.txt'), codeIn(linkDenials));
});

test('terminal temporary directory cannot follow a project-local junction', async t => {
  const f = fixture(t);
  f.link('.tmp');
  await assert.rejects(f.workspace.terminal(f.id, 'exit 0'), codeIn(linkDenials));
  assert.equal(existsSync(path.join(f.outside, 'terminal')), false, 'No terminal temp directory may be created outside the project.');
});

test('unregistering a project stops its running terminal before a later write', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const marker = path.join(f.project, 'late-effect.txt');
  const command = windows
    ? "Start-Sleep -Milliseconds 1800; Set-Content -LiteralPath 'late-effect.txt' -Value 'effect-after-revocation'"
    : "sleep 2; printf effect-after-revocation > late-effect.txt";
  const running = f.workspace.terminal(f.id, command).then(value => ({ value }), (error: unknown) => ({ error }));
  await new Promise(resolve => setTimeout(resolve, 150));
  await f.workspace.removeProject(f.id);
  assert.equal(existsSync(marker), false, 'Removing a project must stop the in-flight shell before it writes.');
  const settled = await running;
  assert.ok('error' in settled, 'The stopped command settles as revoked instead of reporting success.');
  assert.ok(settled.error instanceof ProductError);
  assert.equal(settled.error.code, 'not_found');
  // 原命令在约 1800ms 后才写入；越过这个时间窗口确认没有任何晚到的副作用。
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(existsSync(marker), false, 'No late effect appears after the terminal settled.');
  await assert.rejects(f.workspace.terminal(f.id, 'exit 0'), codeIn(['not_found']));
});

test('ordinary file diff still returns real hunks for modified and untracked files', async t => {
  const f = fixture(t);
  git(f.project, ['init', '--quiet', '-b', 'main']);
  git(f.project, ['config', 'user.name', 'Workspace Boundary Fixture']);
  git(f.project, ['config', 'user.email', 'workspace-boundary@example.invalid']);
  writeFileSync(path.join(f.project, 'tracked.txt'), 'alpha\nbeta\n');
  git(f.project, ['add', '--', 'tracked.txt']);
  git(f.project, ['commit', '-m', 'initial']);
  writeFileSync(path.join(f.project, 'tracked.txt'), 'alpha changed\nbeta\n');
  writeFileSync(path.join(f.project, 'added.txt'), 'one\ntwo\n');

  const modified = await f.workspace.fileDiff(f.id, 'tracked.txt');
  assert.equal(modified.path, 'tracked.txt');
  assert.equal(modified.status, 'modified');
  assert.equal(modified.additions, 1);
  assert.equal(modified.deletions, 1);
  assert.equal(modified.applied, false);
  assert.ok(modified.hunks.length >= 1);
  assert.ok(modified.hunks[0]!.header.startsWith('@@'));
  assert.equal(modified.hunks[0]!.lines.find(line => line.kind === 'add')?.text, 'alpha changed');

  const added = await f.workspace.fileDiff(f.id, 'added.txt');
  assert.equal(added.status, 'added');
  assert.equal(added.additions, 2);
  assert.equal(added.deletions, 0);
  assert.equal(added.hunks[0]?.header, '@@ -0,0 +1,2 @@');
});

test('ordinary terminal still runs in the project with real exit code, output and cwd', { timeout: 90000 }, async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.project, 'file.txt'), 'terminal fixture\n');
  const command = windows ? '(Get-Location).Path; exit 5' : 'pwd; exit 5';
  const result = await f.workspace.terminal(f.id, command);
  assert.equal(result.command, command);
  assert.equal(result.exitCode, 5);
  assert.ok(result.durationMs >= 0);
  assert.equal(path.resolve(result.cwd).toLowerCase(), path.resolve(f.project).toLowerCase());
  const printed = result.output.trim().split(/\r?\n/).filter(Boolean).at(-1)!;
  assert.equal(path.resolve(printed).toLowerCase(), path.resolve(f.project).toLowerCase());

  const tempDir = path.join(f.project, '.tmp', 'terminal');
  assert.ok(existsSync(tempDir), 'The ordinary terminal keeps its project-local temp directory.');
  const temp = await f.workspace.terminal(f.id, windows ? '$env:TEMP' : 'printf %s "$TEMP"');
  assert.equal(path.resolve(temp.output.trim()).toLowerCase(), path.resolve(tempDir).toLowerCase());
});
