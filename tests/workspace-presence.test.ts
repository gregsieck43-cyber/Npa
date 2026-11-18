import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { WorkspacePresence } from '../src/app/workspace-presence.js';

function setup(t: import('node:test').TestContext) {
  const base = realpathSync(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'presence-'));
  const workspace = path.join(root, 'workspace'), outside = path.join(root, 'outside'); mkdirSync(workspace); mkdirSync(outside);
  const instances: WorkspacePresence[] = [], links: string[] = []; let now = 0;
  const authorize = (value: string) => { assert.equal(path.resolve(value), workspace, 'Workspace not authorized'); return workspace; };
  const create = () => { const value = new WorkspacePresence(authorize, { clock: () => now }); instances.push(value); return value; };
  t.after(async () => {
    for (const instance of instances) await instance.close().catch(() => {});
    for (const link of links) if (existsSync(link)) unlinkSync(link);
    assert.equal(path.dirname(root), base); assert.equal(realpathSync(root), root); rmSync(root, { recursive: true, force: true });
  });
  const publication = { workspace, label: 'NPN Gamma', objective: 'Maintain local work', claims: ['src/example.ts'], participants: [{ label: 'Task summary', status: 'running' }] };
  const directory = path.join(workspace, '.npn/presence');
  return { workspace, outside, root, links, publication, directory, create, advance: (ms: number) => { now += ms; } };
}
const document = (overrides: Record<string, unknown> = {}) => ({ schema: 1, label: 'Independent editor', objective: 'Read source', claims: ['src/example.ts'], participants: [{ label: 'External work', status: 'working' }], heartbeatAt: '2999-01-01T00:00:00.000Z', sequence: 1, ...overrides });
function externalWrite(file: string, value: unknown) {
  const result = spawnSync(process.execPath, ['-e', "const fs=require('node:fs');fs.writeFileSync(process.argv[1]+'.next',process.argv[2]);fs.renameSync(process.argv[1]+'.next',process.argv[1]);", file, JSON.stringify(value)], { env: process.env, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('independent external writer is advisory, expires by local observation and rejoins on real change', async t => {
  const f = setup(t), presence = f.create(); await presence.sync([f.publication]);
  const file = path.join(f.directory, 'external.json'); externalWrite(file, document()); f.advance(15000);
  const joined = await presence.sync([f.publication]); assert.equal(joined.changes[0]!.joined.length, 1);
  const first = presence.snapshot(f.workspace).items[0]!;
  assert.equal(first.source, 'external'); assert.equal(first.advisory, true); assert.match(first.id, /^external-/);
  assert.deepEqual(first.claims, ['src/example.ts']); assert.equal('taskId' in first, false);
  f.advance(15000); const ordinary = await presence.sync([f.publication]); assert.equal(ordinary.changes[0]!.changed.length, 0); assert.equal(presence.snapshot(f.workspace).items.length, 1);
  f.advance(15000); const expired = await presence.sync([f.publication]); assert.deepEqual(expired.changes[0]!.left, [first.id]); assert.equal(presence.snapshot(f.workspace).items.length, 0, 'a future heartbeat cannot prolong a locally unchanged file');
  externalWrite(file, document({ sequence: 2, heartbeatAt: '2000-01-01T00:00:00.000Z' })); f.advance(15000);
  const renewed = await presence.sync([f.publication]); assert.equal(renewed.changes[0]!.joined[0]!.id, first.id);
  externalWrite(file, document({ sequence: 3, label: 'Changed objective', heartbeatAt: '2000-01-01T00:00:00.000Z' })); f.advance(15000);
  const changed = await presence.sync([f.publication]); assert.equal(changed.changes[0]!.changed[0]!.label, 'Changed objective');
});

test('two NPN owners share one workspace without impersonating internal participants or overwriting files', async t => {
  const f = setup(t), first = f.create(), second = f.create();
  assert.notEqual(first.ownerId, second.ownerId);
  await first.sync([f.publication]); await second.sync([{ ...f.publication, label: 'Other NPN instance' }]); f.advance(15000); await first.sync([f.publication]);
  assert.equal(readdirSync(f.directory).filter(file => file.endsWith('.json')).length, 2);
  assert.equal(first.snapshot(f.workspace).items[0]!.label, 'Other NPN instance'); assert.equal(second.snapshot(f.workspace).items[0]!.source, 'external');
  await first.close(); assert.ok(existsSync(path.join(f.directory, second.ownerId + '.json'))); assert.equal(existsSync(path.join(f.directory, first.ownerId + '.json')), false);
});

test('publication refresh is throttled and close never removes a changed owner file', async t => {
  const f = setup(t), presence = f.create(); await presence.sync([f.publication]); const own = path.join(f.directory, presence.ownerId + '.json');
  const first = readFileSync(own, 'utf8'); f.advance(14000); await presence.sync([f.publication]); assert.equal(readFileSync(own, 'utf8'), first);
  f.advance(1000); await presence.sync([f.publication]); assert.notEqual(readFileSync(own, 'utf8'), first);
  externalWrite(own, document({ label: 'Foreign replacement' })); f.advance(15000);
  const changed = await presence.sync([f.publication]); assert.ok(changed.errors.some(error => error.code === 'PRESENCE_OWNER_CHANGED'));
  assert.equal(presence.snapshot(f.workspace).items[0]!.label, 'Foreign replacement'); await presence.close();
  assert.equal(JSON.parse(readFileSync(own, 'utf8')).label, 'Foreign replacement');
});

test('malformed, oversized, escaping, forged identity and hardlinked documents are rejected', async t => {
  const f = setup(t), presence = f.create(); await presence.sync([f.publication]);
  const bad: [string, unknown][] = [['identity', document({ source: 'internal', taskId: 'task-forged', epoch: 'forged' })], ['escape', document({ claims: ['../outside.txt'] })], ['absolute', document({ claims: ['J:/outside.txt'] })], ['long', document({ label: 'x'.repeat(161) })], ['participants', document({ participants: Array.from({ length: 9 }, () => ({ label: 'x' })) })]];
  for (const [name, value] of bad) writeFileSync(path.join(f.directory, name + '.json'), JSON.stringify(value));
  writeFileSync(path.join(f.directory, 'large.json'), ' '.repeat(16385)); writeFileSync(path.join(f.directory, 'broken.json'), '{');
  writeFileSync(path.join(f.directory, 'utf8.json'), Buffer.from([0xff, 0xfe]));
  const outside = path.join(f.outside, 'linked.json'); writeFileSync(outside, JSON.stringify(document())); linkSync(outside, path.join(f.directory, 'hardlink.json'));
  f.advance(15000); await presence.sync([f.publication]);
  const snapshot = presence.snapshot(f.workspace); assert.equal(snapshot.items.length, 0); assert.equal(snapshot.rejected, bad.length + 4);
  assert.equal(readFileSync(outside, 'utf8'), JSON.stringify(document()));
});

test('publication input is bounded and copied before asynchronous writes', async t => {
  const f = setup(t), presence = f.create();
  await assert.rejects(presence.sync([{ ...f.publication, objective: 'x'.repeat(401) }]), /PRESENCE_FIELD/);
  assert.equal(existsSync(f.directory), false);
  const publication = structuredClone(f.publication), pending = presence.sync([publication]);
  publication.objective = 'Mutated after sync'; publication.claims.push('different.ts'); publication.participants[0]!.label = 'Mutated participant';
  await pending;
  const written = JSON.parse(readFileSync(path.join(f.directory, presence.ownerId + '.json'), 'utf8'));
  assert.equal(written.objective, f.publication.objective); assert.deepEqual(written.claims, f.publication.claims); assert.deepEqual(written.participants, f.publication.participants);
});

test('unauthorized roots and junctions cannot redirect presence reads or writes', async t => {
  const f = setup(t), presence = f.create();
  const unauthorized = await presence.sync([{ ...f.publication, workspace: f.outside }]); assert.ok(unauthorized.errors.length); assert.equal(existsSync(path.join(f.outside, '.npn')), false);
  const junction = path.join(f.workspace, '.npn'); symlinkSync(f.outside, junction, process.platform === 'win32' ? 'junction' : 'dir'); f.links.push(junction);
  const redirected = await presence.sync([f.publication]); assert.ok(redirected.errors.length); assert.deepEqual(readdirSync(f.outside), []);
  unlinkSync(junction); f.links.length = 0; mkdirSync(junction);
  const nested = path.join(junction, 'presence'); symlinkSync(f.outside, nested, process.platform === 'win32' ? 'junction' : 'dir'); f.links.push(nested); f.advance(15000);
  const deeper = await presence.sync([f.publication]); assert.ok(deeper.errors.length); assert.deepEqual(readdirSync(f.outside), []);
});

test('directory scans and retained snapshots remain bounded and workspace removal releases only own publication', async t => {
  const f = setup(t), presence = f.create(); await presence.sync([f.publication]);
  for (let i = 0; i < 80; i++) writeFileSync(path.join(f.directory, `peer-${i}.json`), JSON.stringify(document({ sequence: i })));
  f.advance(15000); await presence.sync([f.publication]); const snapshot = presence.snapshot(f.workspace);
  assert.equal(snapshot.truncated, true); assert.ok(snapshot.items.length <= 64);
  for (let i = 0; i < 10; i++) { await presence.sync([{ ...f.publication, objective: 'Changed local summary ' + i }]); assert.ok(presence.snapshot(f.workspace).items.length <= 64); }
  const removed = await presence.sync([]); assert.ok(removed.changes[0]!.left.length > 0); assert.equal(existsSync(path.join(f.directory, presence.ownerId + '.json')), false);
  assert.equal(readdirSync(f.directory).filter(file => file.endsWith('.json')).length, 80);
});
