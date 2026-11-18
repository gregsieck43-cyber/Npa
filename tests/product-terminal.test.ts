import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { ProductStore } from '../src/product/store.js';
import { ProductWorkspace } from '../src/product/workspace.js';
import { ProductError, type ProductErrorCode, type ProductRuntime } from '../src/product/shared.js';

function errorCode(code: ProductErrorCode) {
  return (error: unknown): boolean => error instanceof ProductError && error.code === code;
}

function normalize(value: string): string {
  return path.resolve(value).toLowerCase();
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
  return { backend, store, workspace, wire, owned, install, project };
}

const windows = process.platform === 'win32';

test('terminal runs in the registered project with project-local TEMP and real exit codes', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'product-terminal-');
  writeFileSync(path.join(f.project, 'file.txt'), 'terminal fixture\n');
  const view = await f.workspace.addProject(f.project);
  const tasksBefore = f.backend.services.kernel.listTasks().length;

  const cwdResult = await f.workspace.terminal(view.id, windows ? '(Get-Location).Path' : 'pwd');
  assert.equal(cwdResult.command, windows ? '(Get-Location).Path' : 'pwd');
  assert.equal(normalize(cwdResult.output.trim()), normalize(view.path));
  assert.equal(cwdResult.exitCode, 0);
  assert.ok(cwdResult.durationMs >= 0);
  assert.equal(path.resolve(cwdResult.cwd), path.resolve(view.path));

  const tempDir = path.join(view.path, '.tmp', 'terminal');
  assert.ok(readdirSync(tempDir).length >= 0);
  const tempResult = await f.workspace.terminal(view.id, windows ? '$env:TEMP' : 'printf %s "$TMP"');
  assert.equal(normalize(tempResult.output.trim()), normalize(tempDir));
  const tmpResult = await f.workspace.terminal(view.id, windows ? '$env:TMP' : 'printf %s "$TMP"');
  assert.equal(normalize(tmpResult.output.trim()), normalize(tempDir));

  const exitResult = await f.workspace.terminal(view.id, 'exit 3');
  assert.equal(exitResult.exitCode, 3);
  assert.equal(f.backend.services.kernel.listTasks().length, tasksBefore, 'Terminal commands never create Agent tasks.');
  assert.equal(f.wire.length, 0, 'Terminal commands never call the model provider.');
});

test('terminal output is bounded and commands are validated', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'product-terminal-bounds-');
  const view = await f.workspace.addProject(f.project);
  const command = windows ? "Write-Output ('x' * 200000)" : "head -c 200000 /dev/zero | tr '\\0' 'x'";
  const result = await f.workspace.terminal(view.id, command);
  const marker = '[output truncated at 131072 bytes]';
  assert.ok(result.output.includes(marker), 'Large output is explicitly truncated.');
  assert.ok(result.output.length <= 131072 + marker.length + 2);
  assert.ok(result.output.startsWith('x'));

  await assert.rejects(f.workspace.terminal(view.id, 'x'.repeat(4001)), errorCode('validation'));
  await assert.rejects(f.workspace.terminal(view.id, ''), errorCode('validation'));
  await assert.rejects(f.workspace.terminal(view.id, '   '), errorCode('validation'));
  await assert.rejects(f.workspace.terminal(view.id, 'Write-Output first\nWrite-Output second'), errorCode('validation'));
  await assert.rejects(f.workspace.terminal(view.id, 'Write-Output first\u0001second'), errorCode('validation'));
  await assert.rejects(f.workspace.terminal('0'.repeat(24), 'exit 0'), errorCode('not_found'));
  assert.equal(f.backend.services.kernel.listTasks().length, 0);
  assert.equal(f.wire.length, 0);
});
