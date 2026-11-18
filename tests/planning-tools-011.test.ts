import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ToolGateway } from '../src/tools/gateway.js';
import { classifyTool } from '../src/kernel/permissions.js';

function fixture(t: import('node:test').TestContext) {
  const base = path.resolve(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'planning-tools-011-'));
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const gateway = new ToolGateway({ workspace, receiptDirectory: path.join(root, 'receipts') });
  t.after(() => { assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, gateway };
}

test('structured literal search reads bounded text and excludes protected files', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.workspace, 'source.txt'), 'x'.repeat(40000) + 'needle\n' + 'needle '.repeat(20000));
  writeFileSync(path.join(f.workspace, '.env'), 'needle SECRET_VALUE');
  const prepared = await f.gateway.prepare({ name: 'search_text', arguments: { query: 'needle', limit: 2 } });
  assert.equal(prepared.mutating, false); assert.equal(classifyTool('search_text')!.capability, 'read');
  const result = await f.gateway.execute(prepared, { effectKey: 'search' });
  assert.equal(result.status, 'applied', result.error);
  const page = JSON.parse(result.output);
  assert.equal(page.matches.length, 2); assert.ok(page.matches.every((item: any) => item.path === 'source.txt'));
  assert.ok(Buffer.byteLength(result.output) <= 32768); assert.ok(!result.output.includes('SECRET_VALUE'));
  await assert.rejects(f.gateway.prepare({ name: 'search_text', arguments: { query: 'needle', paths: ['../'] } }), /outside|protected/);
});

test('fixed Git queries expose scoped history without invoking repository filters or option injection', async t => {
  const f = fixture(t);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.workspace, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } });
  git('init', '--quiet'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  writeFileSync(path.join(f.workspace, 'source.txt'), 'version one\n'); git('add', 'source.txt'); git('commit', '--quiet', '-m', 'initial fixture');
  writeFileSync(path.join(f.workspace, 'source.txt'), 'version two\n');
  writeFileSync(path.join(f.workspace, 'filter.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('filter-executed.txt','bad');process.stdin.pipe(process.stdout);");
  writeFileSync(path.join(f.workspace, '.gitattributes'), 'source.txt filter=unsafe diff=unsafe\n');
  const command = '"' + process.execPath.replace(/\\/g, '/') + '" filter.mjs';
  git('config', 'filter.unsafe.clean', command); git('config', 'filter.unsafe.process', command); git('config', 'filter.unsafe.required', 'true'); git('config', 'diff.unsafe.textconv', command); git('config', 'core.fsmonitor', command);
  for (const operation of ['status', 'log', 'diff', 'show']) {
    const prepared = await f.gateway.prepare({ name: 'git_query', arguments: { operation, path: 'source.txt', limit: 20 } });
    assert.equal(prepared.mutating, false); assert.equal(classifyTool('git_query')!.capability, 'read');
    const result = await f.gateway.execute(prepared, { effectKey: operation });
    assert.equal(result.status, 'applied', result.error); assert.equal(result.receipt!.exitCode, 0, result.output);
    assert.ok(Buffer.byteLength(result.output) <= 32768);
    if (operation === 'show') assert.match(result.output, /version one/);
    if (operation === 'diff') assert.match(result.output, /version two/);
  }
  assert.equal(existsSync(path.join(f.workspace, 'filter-executed.txt')), false);
  for (const args of [{ operation: 'reset' }, { operation: 'show', path: 'source.txt', revision: '--output=leak' }, { operation: 'diff', path: '.env' }, { operation: 'show', path: '../source.txt' }, { operation: 'diff' }])
    await assert.rejects(f.gateway.prepare({ name: 'git_query', arguments: args }));
});
