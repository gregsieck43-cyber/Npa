import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Command, Task } from '../src/contracts.js';
import { IdeController, selectionObjective } from '../src/ide/controller.js';
import { createIdeLaunchSpec, installIdeExtension } from '../src/ide/launcher.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.resolve('.tmp', 'ide-unit-'));
  t.after(() => { assert.ok(root.startsWith(path.resolve('.tmp') + path.sep)); rmSync(root, { recursive: true, force: true }); });
  for (const name of ['host', 'extension', 'workspace', 'data']) mkdirSync(path.join(root, name));
  writeFileSync(path.join(root, 'host', 'VSCodium.exe'), 'fixture');
  writeFileSync(path.join(root, 'extension', 'package.json'), JSON.stringify({ publisher: 'npn-gamma', name: 'npn-ide', version: '0.5.0', main: './extension.cjs' }));
  writeFileSync(path.join(root, 'extension', 'extension.cjs'), 'fixture');
  return root;
}
const task = (id: string, workspace: string): Task => ({ id, workspace, title: id, goal: { objective: id, constraints: [], acceptance: [], maxModelCalls: 20, mode: 'collaborative' }, status: 'paused', revision: 3, generation: 1, goalVersion: 1, policyEpoch: 1, owner: 'main', modelCalls: 0, createdAt: '', updatedAt: '' });

test('IDE refresh and opening a workspace never create or resume an Agent task', async () => {
  const commands: Command[] = [];
  const controller = new IdeController({ workspace: async value => ({ id: 'workspace', path: value }), tasks: async workspace => [task('existing', workspace)],
    command: async command => { commands.push(command); return { commandId: command.commandId, status: 'accepted' }; } });
  assert.equal((await controller.refresh(['F:\\projects\\one']))[0]!.id, 'existing');
  await controller.refresh([]);
  assert.deepEqual(commands, []);
});

test('IDE controls keep the same command after an unknown transport result, not a new resume message', async () => {
  const commands: Command[] = [];
  const controller = new IdeController({ workspace: async value => ({ id: 'workspace', path: value }), tasks: async workspace => [task('existing', workspace)],
    command: async command => { commands.push(command); if (commands.length === 1) throw new Error('network disconnected'); return { commandId: command.commandId, status: 'duplicate' }; } });
  await controller.refresh(['F:\\projects\\one']);
  await assert.rejects(controller.control('existing', 'resume'), /disconnected/);
  await controller.control('existing', 'resume');
  assert.deepEqual(commands[1], commands[0]);
  assert.equal(commands[0]!.expectedRevision, 3);
  assert.equal(commands[0]!.type, 'resume');
  assert.equal(commands[0]!.parameters, undefined);
});

test('IDE task creation requires an explicitly attached workspace and does not silently pick another project', async () => {
  const commands: Command[] = [];
  const controller = new IdeController({ workspace: async value => ({ id: 'workspace', path: value }), tasks: async () => [], command: async command => { commands.push(command); return { commandId: command.commandId, status: 'accepted', taskId: 'created' }; } });
  await controller.refresh(['F:\\projects\\one']);
  await assert.rejects(controller.createTask('F:\\projects\\other', 'Goal'), /workspace/i);
  const ack = await controller.createTask('F:\\projects\\one', 'Goal');
  assert.equal(ack.taskId, 'created');
  assert.equal(commands[0]!.type, 'create_task');
  assert.equal(commands[0]!.parameters!.workspace, 'F:\\projects\\one');
  assert.throws(() => selectionObjective('Inspect', '.env', 'private', 1), /protected/i);
  assert.match(selectionObjective('Inspect', 'src/main.ts', 'const answer = 42;', 3), /src\/main.ts:3/);
});

test('IDE launch keeps data and caches local, strips inherited credentials and does not use a shell', t => {
  const root = fixture(t);
  const spec = createIdeLaunchSpec({ productRoot: root, dataDir: path.join(root, 'data'), hostDirectory: path.join(root, 'host'), extensionDirectory: path.join(root, 'extension'), workspace: path.join(root, 'workspace'),
    environment: { SystemRoot: 'C:\\Windows', PATH: 'fixture-path', OPENAI_API_KEY: 'do-not-inherit', NPN_API_KEY: 'do-not-inherit', VSCODE_PORTABLE: 'C:\\unexpected' } });
  assert.equal(spec.executable, path.join(root, 'host', 'VSCodium.exe'));
  assert.ok(spec.args.includes('--new-window'));
  assert.equal(spec.args.at(-1), path.join(root, 'workspace'));
  assert.equal(spec.env.OPENAI_API_KEY, undefined);
  assert.equal(spec.env.NPN_API_KEY, undefined);
  assert.equal(spec.env.VSCODE_PORTABLE, undefined);
  for (const key of ['TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'npm_config_cache']) assert.ok(spec.env[key]!.startsWith(path.join(root, 'data')));
  assert.equal(spec.env.NPN_IDE_DATA_DIR, path.join(root, 'data'));
  assert.throws(() => createIdeLaunchSpec({ productRoot: root, dataDir: 'C:\\outside', hostDirectory: path.join(root, 'host'), extensionDirectory: path.join(root, 'extension') }), /volume that hosts this installation|installation volume/i);
});

test('bundled IDE extension installation is idempotent and never replaces different installed bytes', t => {
  const root = fixture(t), source = path.join(root, 'extension'), target = path.join(root, 'data', 'extensions');
  const installed = installIdeExtension(source, target);
  assert.equal(installIdeExtension(source, target), installed);
  writeFileSync(path.join(source, 'extension.cjs'), 'changed');
  assert.throws(() => installIdeExtension(source, target), /version|different/i);
});

test('reopening the IDE detects modified installed extension bytes, not just a matching marker', t => {
  const root = fixture(t), source = path.join(root, 'extension'), target = path.join(root, 'data', 'extensions');
  const installed = installIdeExtension(source, target);
  writeFileSync(path.join(installed, 'extension.cjs'), 'tampered installed bundle');
  assert.throws(() => installIdeExtension(source, target), /modified|different|integrity/i);
});
