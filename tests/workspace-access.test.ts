import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { BackendClient } from '../src/extensions/client.js';
import { assertProjectFixtureRoot } from './project-boundary.js';

test('explicitly selected independent projects connect without making the installation or whole drive writable', { timeout: 30000 }, async t => {
  const tempRoot = path.resolve('.tmp');
  mkdirSync(tempRoot, { recursive: true });
  assertProjectFixtureRoot(tempRoot);
  const root = mkdtempSync(path.join(tempRoot, 'workspace-access-'));
  assertProjectFixtureRoot(root);
  const install = path.join(root, 'installation'), dataDir = path.join(install, 'data');
  const workspace = path.join(root, 'user-project'), neighbor = path.join(root, 'neighbor');
  for (const folder of [install, workspace, neighbor, path.join(install, 'src')]) mkdirSync(folder, { recursive: true });
  let backend = await startBackend({ dataDir, projectRoot: install, productRoot: install });
  await backend.services.runner.stop();
  t.after(async () => { await backend.close(); rmSync(root, { recursive: true, force: true }); });
  const client = new BackendClient({ dataDir });
  await assert.rejects(client.workspace(workspace), /project|授权|选择/i);
  assert.equal(backend.services.kernel.listTasks().length, 0);
  const open = async (folder: string) => {
    const response = await fetch(`http://127.0.0.1:${backend.port}/v1/workspaces/open`, {
      method: 'POST', headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: folder }),
    });
    return { status: response.status, value: await response.json() as any };
  };
  const accepted = await open(workspace);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
  assert.equal(accepted.value.path, workspace);
  assert.equal((await client.workspace(workspace)).path, workspace);
  assert.deepEqual(await client.tasks(workspace), []);
  assert.equal(backend.services.kernel.listTasks().length, 0, 'Opening a project does not create work or invoke a model.');
  await assert.rejects(client.workspace(neighbor), /project|授权|选择/i);
  assert.throws(() => backend.services.assertProjectPath(workspace), /project/i, 'Plugin installation does not inherit workspace grants.');
  for (const folder of ['C:\\outside', 'F:\\', root, install, dataDir, path.join(install, 'src')]) {
    assert.equal((await open(folder)).status, 400, `Protected root was granted: ${folder}`);
  }
  const link = path.join(root, 'linked-project'); symlinkSync(workspace, link, 'junction');
  assert.equal((await open(link)).status, 400, 'A native project choice cannot authorize a junction.');
  const ack = await client.command({ commandId: 'independent-project-goal', type: 'create_task', parameters: { title: 'Explicit project', workspace } });
  assert.equal(backend.services.kernel.getTask(ack.taskId!)!.workspace, workspace);
  await backend.close();
  backend = await startBackend({ dataDir, projectRoot: install, productRoot: install });
  await backend.services.runner.stop();
  assert.equal((await client.workspace(workspace)).id, accepted.value.id);
  await assert.rejects(client.workspace(neighbor), /project|授权|选择/i);
});
