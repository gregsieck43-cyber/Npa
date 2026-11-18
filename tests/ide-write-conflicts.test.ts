import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolGateway } from '../src/tools/gateway.js';

test('an approved Agent write cannot overwrite a file changed after preparation', async () => {
  const root = await mkdtemp(path.resolve('.tmp', 'ide-write-version-')), workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  try {
    const target = path.join(workspace, 'shared.txt'); await writeFile(target, 'base');
    const gateway = new ToolGateway({ workspace, receiptDirectory: path.join(root, 'receipts') });
    const read = await gateway.prepare({ name: 'read_file', arguments: { path: 'shared.txt' } });
    const observed = await gateway.execute(read, { effectKey: 'read-base' });
    assert.equal(observed.status, 'applied', observed.error); assert.ok(observed.receipt);
    assert.equal(observed.receipt.output, 'base');
    const prepared = await gateway.prepare({ name: 'write_file', arguments: { path: 'shared.txt', content: 'agent proposal' } });
    assert.equal(prepared.arguments.expectedSha256, observed.receipt.sha256);
    assert.equal((prepared.arguments.readVersion as { sourceIntentId: string }).sourceIntentId, 'read-base');
    await writeFile(target, 'human saved a newer version');
    const outcome = await gateway.execute(prepared, { effectKey: 'stale-write', approvedDigest: prepared.digest });
    assert.notEqual(outcome.status, 'applied');
    assert.equal(await readFile(target, 'utf8'), 'human saved a newer version');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an approved new-file proposal cannot overwrite a file created meanwhile', async () => {
  const root = await mkdtemp(path.resolve('.tmp', 'ide-write-create-')), workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  try {
    const gateway = new ToolGateway({ workspace, receiptDirectory: path.join(root, 'receipts') });
    const prepared = await gateway.prepare({ name: 'write_file', arguments: { path: 'new.txt', content: 'agent proposal' } });
    await writeFile(path.join(workspace, 'new.txt'), 'human-created file');
    const outcome = await gateway.execute(prepared, { effectKey: 'new-write', approvedDigest: prepared.digest });
    assert.notEqual(outcome.status, 'applied');
    assert.equal(await readFile(path.join(workspace, 'new.txt'), 'utf8'), 'human-created file');
  } finally { await rm(root, { recursive: true, force: true }); }
});
