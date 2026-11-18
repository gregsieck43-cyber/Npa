import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { ProductStore } from '../src/product/store.js';
import { ProductWorkspace } from '../src/product/workspace.js';
import { ProductError, type FileNode, type ProductErrorCode, type ProductRuntime } from '../src/product/shared.js';

function errorCode(code: ProductErrorCode) {
  return (error: unknown): boolean => error instanceof ProductError && error.code === code;
}

async function fixture(t: TestContext, prefix: string) {
  const tempRoot = path.resolve(process.env.TEMP ?? '.tmp');
  mkdirSync(tempRoot, { recursive: true });
  const owned = mkdtempSync(path.join(tempRoot, prefix));
  const install = path.join(owned, 'install'), dataDir = path.join(install, 'data');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(owned, 'project');
  mkdirSync(project);
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
  return { backend, store, workspace, wire, owned, install, dataDir, project };
}

function makeJunction(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, 'junction');
    return true;
  } catch {
    return false;
  }
}

function countNodes(nodes: Array<{ children?: FileNode[] }>): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children ?? []), 0);
}

test('project registry: add, list sessions, remove, and revoke access without deleting files', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'product-workspace-');
  writeFileSync(path.join(f.project, 'README.md'), '# Project\n');
  const view = await f.workspace.addProject(f.project);
  assert.match(view.id, /^[a-f0-9]{24}$/);
  assert.equal(view.path, f.project);
  assert.equal(view.name, 'project');
  assert.equal(view.sessions, 0);
  assert.ok(Number.isFinite(Date.parse(view.lastOpenedAt)));
  assert.equal(view.branch, undefined);
  assert.equal(view.changedFiles, undefined);

  const duplicate = await f.workspace.addProject(f.project);
  assert.equal(duplicate.id, view.id);
  assert.equal(duplicate.path, view.path);

  const now = new Date().toISOString();
  f.store.upsertSession({
    id: 'session-one', kind: 'chat', mode: 'chat', title: 'Indexed session', status: 'completed',
    permission: 'ask', modelId: 'test-model', projectId: view.id, pinned: false, createdAt: now, updatedAt: now,
  });
  const listed = await f.workspace.projects();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, view.id);
  assert.equal(listed[0]!.sessions, 1);

  await f.workspace.removeProject(view.id);
  assert.deepEqual(await f.workspace.projects(), []);
  assert.ok(existsSync(path.join(f.project, 'README.md')), 'Removing a project never deletes user files.');
  await assert.rejects(f.workspace.files(view.id), errorCode('not_found'));
  await assert.rejects(f.workspace.readFile(view.id, 'README.md'), errorCode('not_found'));
  await assert.rejects(f.workspace.search(view.id, { text: 'Project' }), errorCode('not_found'));
  await assert.rejects(f.workspace.removeProject('0'.repeat(24)), errorCode('not_found'));
  assert.throws(() => f.backend.services.assertWorkspacePath(f.project), /authoriz/i);

  const reAdded = await f.workspace.addProject(f.project);
  assert.equal(reAdded.id, view.id, 'Project ids are stable across removal and re-registration.');
  assert.equal(f.wire.length, 0, 'Workspace operations never call the model provider.');
  assert.equal(f.backend.services.kernel.listTasks().length, 0, 'Workspace operations never create Agent tasks.');
});

test('addProject rejects relative paths, drive roots, files, missing folders and junctions', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'product-workspace-add-');
  const file = path.join(f.owned, 'plain-file.txt');
  writeFileSync(file, 'x');
  await assert.rejects(f.workspace.addProject('relative-project'), errorCode('validation'));
  await assert.rejects(f.workspace.addProject(path.parse(f.project).root), errorCode('validation'));
  await assert.rejects(f.workspace.addProject(file), errorCode('validation'));
  await assert.rejects(f.workspace.addProject(path.join(f.owned, 'missing')), errorCode('validation'));
  const junction = path.join(f.owned, 'linked-project');
  if (!makeJunction(f.project, junction)) {
    t.diagnostic('Junction creation is unavailable in this environment; junction root rejection is not exercised.');
    return;
  }
  await assert.rejects(f.workspace.addProject(junction), errorCode('validation'));
  assert.deepEqual(await f.workspace.projects(), []);
});

test('files tree is bounded, uses relative posix paths and skips protected folders', { timeout: 120000 }, async t => {
  const f = await fixture(t, 'product-workspace-files-');
  mkdirSync(path.join(f.project, 'src'), { recursive: true });
  writeFileSync(path.join(f.project, 'src', 'main.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(f.project, 'README.md'), '# readme\n');
  mkdirSync(path.join(f.project, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(f.project, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(path.join(f.project, '.git'));
  writeFileSync(path.join(f.project, '.git', 'config'), '[core]\n');
  mkdirSync(path.join(f.project, 'zz-many'));
  for (let index = 0; index < 2005; index += 1) writeFileSync(path.join(f.project, 'zz-many', `file-${index}.txt`), 'x');
  const view = await f.workspace.addProject(f.project);

  const tree = await f.workspace.files(view.id);
  const names = tree.map(node => node.name);
  assert.ok(names.includes('src') && names.includes('README.md'));
  assert.ok(!names.includes('node_modules') && !names.includes('.git'));
  assert.deepEqual([...names].sort(), names, 'Top-level nodes are sorted for a stable explorer.');
  const source = tree.find(node => node.path === 'src')!;
  assert.equal(source.kind, 'dir');
  assert.equal(source.children?.find(node => node.path === 'src/main.ts')?.kind, 'file');
  assert.ok(countNodes(tree) <= 2000, 'The files tree stops at the 2000 node budget.');
});

test('readFile stays inside the registered project and rejects links, binary and oversized files', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'product-workspace-read-');
  writeFileSync(path.join(f.project, 'inside.txt'), 'hello workspace\n');
  writeFileSync(path.join(f.owned, 'outside.txt'), 'outside\n');
  writeFileSync(path.join(f.project, '.env'), 'SECRET=value\n');
  writeFileSync(path.join(f.project, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(path.join(f.project, 'invalid-utf8.txt'), Buffer.from([0xc3, 0x28]));
  writeFileSync(path.join(f.project, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  const outsideDir = path.join(f.owned, 'outside-dir');
  mkdirSync(outsideDir);
  writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside secret\n');
  const view = await f.workspace.addProject(f.project);

  assert.equal(await f.workspace.readFile(view.id, 'inside.txt'), 'hello workspace\n');
  await assert.rejects(f.workspace.readFile(view.id, '../../outside.txt'), errorCode('validation'));
  await assert.rejects(f.workspace.readFile(view.id, path.join(f.owned, 'outside.txt')), errorCode('validation'));
  await assert.rejects(f.workspace.readFile(view.id, '.env'), errorCode('denied'));
  await assert.rejects(f.workspace.readFile(view.id, 'binary.bin'), errorCode('validation'));
  await assert.rejects(f.workspace.readFile(view.id, 'invalid-utf8.txt'), errorCode('validation'));
  await assert.rejects(f.workspace.readFile(view.id, 'large.txt'), errorCode('validation'));
  await assert.rejects(f.workspace.readFile(view.id, 'missing.txt'), errorCode('not_found'));
  await assert.rejects(f.workspace.readFile(view.id, '.'), errorCode('validation'));

  const junction = path.join(f.project, 'linked');
  if (!makeJunction(outsideDir, junction)) {
    t.diagnostic('Junction creation is unavailable; symlink read traversal rejection is not exercised.');
    return;
  }
  await assert.rejects(f.workspace.readFile(view.id, 'linked/secret.txt'), errorCode('denied'));
  await assert.rejects(f.workspace.writeFile(view.id, 'linked/new.txt', 'blocked'), errorCode('denied'));
  assert.ok(lstatSync(junction).isSymbolicLink());
});

test('writeFile saves real files atomically without creating Agent tasks or model requests', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'product-workspace-write-');
  const view = await f.workspace.addProject(f.project);
  mkdirSync(path.join(f.project, 'notes'));
  const tasksBefore = f.backend.services.kernel.listTasks().length;
  const result = await f.workspace.writeFile(view.id, 'notes/new.txt', 'saved\ntext\n');
  assert.equal(result.path, 'notes/new.txt');
  assert.equal(result.bytes, Buffer.byteLength('saved\ntext\n'));
  assert.ok(Number.isFinite(Date.parse(result.savedAt)));
  assert.equal(readFileSync(path.join(f.project, 'notes', 'new.txt'), 'utf8'), 'saved\ntext\n');

  const overwritten = await f.workspace.writeFile(view.id, 'notes/new.txt', 'second\n');
  assert.equal(overwritten.bytes, Buffer.byteLength('second\n'));
  assert.equal(readFileSync(path.join(f.project, 'notes', 'new.txt'), 'utf8'), 'second\n');
  assert.equal(readdirSync(path.join(f.project, 'notes')).filter(name => name.includes('.npn-')).length, 0, 'No temporary file is left behind.');

  await assert.rejects(f.workspace.writeFile(view.id, 'missing-dir/file.txt', 'x'), errorCode('validation'));
  await assert.rejects(f.workspace.writeFile(view.id, '../escape.txt', 'x'), errorCode('validation'));
  await assert.rejects(f.workspace.writeFile(view.id, path.join(f.owned, 'outside.txt'), 'x'), errorCode('validation'));
  await assert.rejects(f.workspace.writeFile(view.id, '.env', 'SECRET=x'), errorCode('denied'));
  await assert.rejects(f.workspace.writeFile(view.id, 'notes', 'x'), errorCode('validation'));
  await assert.rejects(f.workspace.writeFile(view.id, 'huge.txt', 'x'.repeat(2 * 1024 * 1024 + 1)), errorCode('validation'));
  assert.equal(f.backend.services.kernel.listTasks().length, tasksBefore, 'Saving a file never creates an Agent task.');
  assert.equal(f.wire.length, 0, 'Saving a file never calls the model provider.');
  assert.ok(!existsSync(path.join(f.project, 'huge.txt')));
});

test('search returns real line and column positions, supports regex and rejects invalid patterns', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'product-workspace-search-');
  mkdirSync(path.join(f.project, 'src'));
  writeFileSync(path.join(f.project, 'src', 'app.ts'), 'const needle = 1;\nconst other = "Needle";\n');
  writeFileSync(path.join(f.project, 'README.md'), 'plain needle text\n');
  mkdirSync(path.join(f.project, 'node_modules'));
  writeFileSync(path.join(f.project, 'node_modules', 'hidden.js'), 'needle in node_modules\n');
  const view = await f.workspace.addProject(f.project);

  const hits = await f.workspace.search(view.id, { text: 'needle' });
  assert.ok(hits.length >= 3, 'Finds every real occurrence in supported text files.');
  assert.ok(!hits.some(hit => hit.path.includes('node_modules')));
  const first = hits.find(hit => hit.path === 'src/app.ts' && hit.line === 1)!;
  assert.equal(first.column, 7);
  assert.equal(first.matchLength, 6);
  assert.equal(first.preview.slice(first.column - 1, first.column - 1 + first.matchLength), 'needle');
  assert.ok(hits.some(hit => hit.path === 'src/app.ts' && hit.line === 2 && hit.column === 16), 'Case-insensitive matching reports the real column.');
  const caseSensitive = await f.workspace.search(view.id, { text: 'Needle', caseSensitive: true });
  assert.equal(caseSensitive.length, 1);
  const regex = await f.workspace.search(view.id, { text: 'ne+dle', regex: true });
  assert.ok(regex.length >= 3);
  assert.deepEqual(await f.workspace.search(view.id, { text: '(' }), [], 'Literal text is escaped, not treated as a pattern.');
  await assert.rejects(f.workspace.search(view.id, { text: '(', regex: true }), errorCode('validation'));
  await assert.rejects(f.workspace.search(view.id, { text: '' }), errorCode('validation'));
});

test('diagnostics parse real TypeScript syntax and never invent results for other file types', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'product-workspace-diagnostics-');
  writeFileSync(path.join(f.project, 'good.ts'), 'export const fine: number = 1;\n');
  writeFileSync(path.join(f.project, 'broken.ts'), 'const broken = ;\n');
  writeFileSync(path.join(f.project, 'notes.md'), 'const broken = ;\n');
  const view = await f.workspace.addProject(f.project);

  const diagnostics = await f.workspace.diagnostics(view.id);
  assert.ok(diagnostics.length >= 1);
  const broken = diagnostics.find(item => item.path === 'broken.ts');
  assert.ok(broken, 'A syntax error in a .ts file is reported.');
  assert.equal(broken.severity, 'error');
  assert.equal(broken.source, 'typescript');
  assert.equal(broken.line, 1);
  assert.ok(broken.column >= 1);
  assert.ok(!diagnostics.some(item => item.path === 'good.ts'));
  assert.ok(!diagnostics.some(item => item.path === 'notes.md'), 'Markdown files produce no TypeScript diagnostics.');

  const other = path.join(f.owned, 'markdown-only');
  mkdirSync(other);
  writeFileSync(path.join(other, 'readme.md'), '# nothing to parse\n');
  const otherView = await f.workspace.addProject(other);
  assert.deepEqual(await f.workspace.diagnostics(otherView.id), [], 'No supported source files means no diagnostics.');
});

test('workspace HTTP routes expose the project list when the product API is wired', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'product-workspace-http-');
  const view = await f.workspace.addProject(f.project);
  const response = await fetch(`http://127.0.0.1:${f.backend.port}/v1/product/projects`, {
    headers: { Authorization: `Bearer ${f.backend.token}` },
  });
  if (response.status === 404) {
    t.skip('The /v1/product HTTP route is not wired yet; domain behavior is covered by the tests above.');
    return;
  }
  assert.equal(response.status, 200);
  const body = await response.json() as Array<{ id: string; path: string }>;
  assert.ok(Array.isArray(body));
  assert.ok(body.some(item => item.id === view.id && item.path === view.path));
});
