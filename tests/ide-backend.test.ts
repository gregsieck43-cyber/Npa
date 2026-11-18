import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { BackendClient } from '../src/extensions/client.js';
import { IdeController } from '../src/ide/controller.js';
import { ensureLocalBackend } from '../src/app/launch-backend.js';

test('native IDE attaches projects without tasks and shares durable controls with the existing backend', { timeout: 30000 }, async t => {
  const root = mkdtempSync(path.resolve('.tmp', 'ide-backend-')), dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace'), other = path.join(root, 'other');
  mkdirSync(workspace); mkdirSync(other);
  let backend = await startBackend({ dataDir, projectRoot: process.cwd(), mockOptions: { delayMs: 1000 } });
  await backend.services.runner.stop();
  t.after(async () => { await backend.close(); rmSync(root, { recursive: true, force: true }); });
  const client = new BackendClient({ dataDir });
  const attached = await client.workspace(workspace);
  assert.equal(attached.path, workspace);
  assert.equal(attached.id, (await client.workspace(workspace)).id);
  assert.deepEqual(await client.tasks(workspace), []);
  assert.equal(backend.services.kernel.listTasks().length, 0);
  await assert.rejects(client.workspace(path.resolve('src')), /product|kernel/i);
  await assert.rejects(client.workspace(dataDir), /data|audit/i);
  await assert.rejects(client.workspace('C:\\outside'), /volume that hosts this installation|installation volume/i);

  const create = (folder: string, id: string) => {
    const ack = backend.services.command({ commandId: id, type: 'create_task', parameters: { title: id, workspace: folder } });
    backend.services.command({ commandId: `${id}-pause`, type: 'pause', taskId: ack.taskId });
    return ack.taskId!;
  };
  const taskId = create(workspace, 'local'), otherId = create(other, 'other');
  const controller = new IdeController(client);
  assert.deepEqual((await controller.refresh([workspace])).map(task => task.id), [taskId]);
  await assert.rejects(controller.control(otherId, 'resume'), /workspace/i);
  const before = backend.services.kernel.getMessages(taskId);
  await controller.control(taskId, 'resume');
  assert.equal(backend.services.kernel.getTask(taskId)!.status, 'queued');
  await controller.refresh([workspace]);
  await controller.control(taskId, 'pause');
  assert.equal(backend.services.kernel.getTask(taskId)!.status, 'paused');
  assert.deepEqual(backend.services.kernel.getMessages(taskId), before);
  assert.equal((await client.taskView(taskId)).selectedTask!.id, taskId);

  const reused = await ensureLocalBackend({ dataDir, productRoot: process.cwd(), projectRoot: process.cwd(), runtime: 'missing-runtime', entry: 'missing-entry' });
  assert.equal(reused.pid, process.pid, 'A connected IDE must reuse the backend, not launch another runtime.');
  await backend.close();
  backend = await startBackend({ dataDir, projectRoot: process.cwd() });
  assert.equal((await client.tasks(workspace))[0]!.id, taskId);
  assert.equal((await client.tasks(workspace))[0]!.status, 'paused');
  assert.equal(backend.services.kernel.listTasks().length, 2);
});
