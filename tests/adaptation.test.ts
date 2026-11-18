import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { AdaptationError, CandidateManager, applyTransform, buildRecoveryManifest, verifyRecoveryPayload, type Candidate } from '../src/adaptation/index.js';

const projectRoot = resolve(process.cwd());
const tempRoot = join(projectRoot, '.tmp');
mkdirSync(tempRoot, { recursive: true });

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tempRoot, 'adaptation-test-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(`${resolve(tempRoot)}\\`) || resolve(root).startsWith(`${resolve(tempRoot)}/`));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function approve(manager: CandidateManager, candidate: Candidate): void {
  manager.approve(candidate.id, { artifactDigest: candidate.artifactDigest, taskId: candidate.taskId,
    expectedVersion: candidate.baseVersion, capabilityDiff: candidate.capabilityDiff, principal: 'operator:local' });
}
function expectCode(operation: () => unknown, code: string): void {
  assert.throws(operation, (error: unknown) => error instanceof AdaptationError && error.code === code);
}

test('candidate is isolated, independently tested, operator approved, persistent and reversible', t => {
  const dataDir = fixture(t);
  const manager = new CandidateManager(dataDir);
  const candidate = manager.create({ taskId: 'task-main', name: 'Concise report', promptSuffix: 'Prefer three concise bullet points.', transform: { kind: 'trim' } });
  assert.deepEqual(candidate.capabilityDiff, ['+task.output.transform', '+task.prompt']);
  assert.equal(manager.promptSuffixFor('task-main'), '');
  assert.equal(manager.transformFor('task-main', '  done  '), '  done  ');
  expectCode(() => manager.activate(candidate.id), 'APPROVAL_REQUIRED');
  expectCode(() => approve(manager, candidate), 'TEST_REQUIRED');
  const tested = manager.test(candidate.id);
  assert.equal(tested.testReport?.passed, true);
  assert.equal(tested.testReport?.checks.length, 5);
  approve(manager, tested);
  assert.equal(manager.activate(candidate.id).version, 1);
  assert.equal(manager.transformFor('task-main', '  done  '), 'done');
  const admittedRun = manager.snapshotFor('task-main');
  assert.equal(manager.promptSuffixFor('task-main'), 'Prefer three concise bullet points.');
  assert.equal(manager.transformFor('task-side', '  done  '), '  done  ');
  expectCode(() => manager.test(candidate.id), 'IMMUTABLE_ACTIVATION');
  const restarted = new CandidateManager(dataDir);
  assert.equal(restarted.transformFor('task-main', '  done  '), 'done');
  assert.equal(restarted.rollback('task-main', 1).version, 2);
  assert.equal(restarted.promptSuffixFor('task-main'), '');
  assert.equal(restarted.transformFor('task-main', '  done  '), '  done  ');
  assert.equal(admittedRun.promptSuffix, 'Prefer three concise bullet points.');
  assert.equal(applyTransform(admittedRun.transform, '  done  '), 'done');
});

test('candidate schema cannot introduce executable transforms or protected kernel capabilities', t => {
  const manager = new CandidateManager(fixture(t));
  expectCode(() => manager.create({ taskId: 'task', name: 'Unsafe', capabilities: ['network'] }), 'CAPABILITY_ESCALATION');
  expectCode(() => manager.create({ taskId: 'task', name: 'Unsafe', kernel: 'changed' } as never), 'PROTECTED_SCOPE');
  expectCode(() => manager.create({ taskId: 'task', name: 'Unsafe', transform: { kind: 'eval', value: 'process.exit()' } } as never), 'PROTECTED_SCOPE');
  const candidate = manager.test(manager.create({ taskId: 'task', name: 'Literal data', transform: { kind: 'prefix', value: 'process.exit(); ' } }).id);
  approve(manager, candidate);
  manager.activate(candidate.id);
  assert.equal(manager.transformFor('task', 'text'), 'process.exit(); text');
});

test('approval binds exact artifact, task, version and capability diff', t => {
  const manager = new CandidateManager(fixture(t));
  const candidate = manager.test(manager.create({ taskId: 'task', name: 'Task format', transform: { kind: 'suffix', value: '\nChecked.' } }).id);
  const bound = { artifactDigest: candidate.artifactDigest, taskId: candidate.taskId,
    expectedVersion: candidate.baseVersion, capabilityDiff: candidate.capabilityDiff, principal: 'operator' };
  for (const update of [{ artifactDigest: '0'.repeat(64) }, { taskId: 'other-task' }, { expectedVersion: 1 }, { capabilityDiff: [] }]) {
    expectCode(() => manager.approve(candidate.id, { ...bound, ...update }), 'APPROVAL_BINDING');
  }
  expectCode(() => manager.approve(candidate.id, { ...bound, principal: '' }), 'OPERATOR_REQUIRED');
  expectCode(() => manager.approve(candidate.id, { ...bound, expiresAt: '2020-01-01T00:00:00Z' }), 'APPROVAL_EXPIRED');
  manager.approve(candidate.id, bound);
  manager.activate(candidate.id);
  expectCode(() => manager.rollback('task', 0), 'VERSION_CONFLICT');
});

test('digest swap after approval is rejected before activation', t => {
  const dataDir = fixture(t);
  const manager = new CandidateManager(dataDir);
  const candidate = manager.test(manager.create({ taskId: 'task', name: 'First', transform: { kind: 'trim' } }).id);
  approve(manager, candidate);
  const second = manager.create({ taskId: 'task', name: 'Different', transform: { kind: 'prefix', value: 'changed' } });
  const artifacts = join(dataDir, 'adaptation', 'artifacts');
  copyFileSync(join(artifacts, `${second.artifactDigest}.json`), join(artifacts, `${candidate.artifactDigest}.json`));
  expectCode(() => manager.activate(candidate.id), 'ARTIFACT_CORRUPT');
  assert.equal(manager.activeFor('task').version, 0);
});

test('stale approvals and competing writers cannot replace newer adaptation state', t => {
  const dataDir = fixture(t);
  const manager = new CandidateManager(dataDir);
  const staleWriter = new CandidateManager(dataDir);
  const first = manager.test(manager.create({ taskId: 'task', name: 'First', transform: { kind: 'trim' } }).id);
  const second = manager.test(manager.create({ taskId: 'task', name: 'Second' }).id);
  approve(manager, first);
  approve(manager, second);
  manager.activate(first.id);
  expectCode(() => manager.activate(second.id), 'VERSION_CONFLICT');
  expectCode(() => staleWriter.create({ taskId: 'other', name: 'Stale writer' }), 'WRITER_CONFLICT');
});

test('rollback restores prior candidate and state checksum corruption fails closed', t => {
  const dataDir = fixture(t);
  const manager = new CandidateManager(dataDir);
  const first = manager.test(manager.create({ taskId: 'task', name: 'First', transform: { kind: 'prefix', value: 'First: ' } }).id);
  approve(manager, first);
  manager.activate(first.id);
  const second = manager.test(manager.create({ taskId: 'task', name: 'Second', transform: { kind: 'suffix', value: ' second' } }).id);
  assert.deepEqual(second.capabilityDiff, []);
  approve(manager, second);
  manager.activate(second.id);
  assert.equal(manager.transformFor('task', 'text'), 'text second');
  manager.rollback('task', 2);
  assert.equal(manager.transformFor('task', 'text'), 'First: text');
  const statePath = join(dataDir, 'adaptation', 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.state.profiles[0].version = 100;
  writeFileSync(statePath, JSON.stringify(state));
  expectCode(() => new CandidateManager(dataDir), 'STATE_CORRUPT');
});

test('recovery manifest detects tampering and excludes secrets or mutable state', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'main.js'), 'export const version = 1;');
  const manifest = buildRecoveryManifest(root, 'test-1');
  assert.equal(verifyRecoveryPayload(root, manifest).valid, true);
  writeFileSync(join(root, 'main.js'), 'corrupted');
  assert.equal(verifyRecoveryPayload(root, manifest).valid, false);
  writeFileSync(join(root, 'API.txt'), 'fixture-only-not-a-secret');
  assert.throws(() => buildRecoveryManifest(root, 'test-1'), /forbidden/i);
  assert.throws(() => verifyRecoveryPayload(root, { ...manifest, files: [{ ...manifest.files[0], path: '../escape' }] }), /relative/);
});

test('offline PowerShell restore repairs packaged payload and preserves data and corrupted backup', { skip: process.platform !== 'win32' }, t => {
  const root = fixture(t);
  const recovery = join(root, 'resources', 'recovery');
  const good = join(recovery, 'app');
  const app = join(root, 'resources', 'app');
  mkdirSync(good, { recursive: true });
  mkdirSync(app, { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(good, 'main.js'), 'known-good-payload');
  writeFileSync(join(app, 'main.js'), 'damaged-payload');
  writeFileSync(join(root, 'data', 'state.json'), 'history-retained');
  writeFileSync(join(recovery, 'manifest.json'), JSON.stringify(buildRecoveryManifest(good, 'offline-test')));
  const script = join(recovery, 'restore.ps1');
  copyFileSync(join(projectRoot, 'src', 'adaptation', 'restore.ps1'), script);
  const invoke = () => spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PackageRoot', root],
    { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, TEMP: tempRoot, TMP: tempRoot } });
  const restored = invoke();
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(readFileSync(join(app, 'main.js'), 'utf8'), 'known-good-payload');
  assert.equal(readFileSync(join(root, 'data', 'state.json'), 'utf8'), 'history-retained');
  const backups = readdirSync(join(recovery, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(recovery, 'backups', backups[0], 'resources', 'app', 'main.js'), 'utf8'), 'damaged-payload');
  writeFileSync(join(good, 'main.js'), 'corrupt-known-good');
  const rejected = invoke();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /hash or size mismatch/i);
  assert.equal(readFileSync(join(app, 'main.js'), 'utf8'), 'known-good-payload');
});

test('offline package restore repairs EXE, runtime, application, DLL and launcher while excluding data', { skip: process.platform !== 'win32' }, t => {
  const root = fixture(t);
  const recovery = join(root, 'resources', 'recovery');
  const good = join(recovery, 'bundle');
  const payload: Record<string, string> = {
    'NPN-Gamma.exe': 'known-good-exe', 'graphics.dll': 'known-good-dll',
    'resources/runtime/node.exe': 'known-good-runtime', 'resources/app/main.js': 'known-good-application',
    'locales/en.pak': 'known-good-locale', 'NPN-CLI.cmd': 'known-good-cli',
  };
  for (const [path, bytes] of Object.entries(payload)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'history.json'), 'preserved-task-history');
  mkdirSync(recovery, { recursive: true });
  const manifest = buildRecoveryManifest(root, 'package-test', 'package');
  assert.ok(manifest.units?.includes('NPN-Gamma.exe'));
  assert.ok(manifest.units?.includes('resources/runtime'));
  assert.ok(!manifest.files.some(file => file.path.startsWith('data/') || file.path.startsWith('resources/recovery/')));
  for (const file of manifest.files) {
    mkdirSync(join(good, file.path, '..'), { recursive: true });
    copyFileSync(join(root, file.path), join(good, file.path));
  }
  writeFileSync(join(recovery, 'manifest.json'), JSON.stringify(manifest));
  const script = join(recovery, 'restore.ps1');
  copyFileSync(join(projectRoot, 'src', 'adaptation', 'restore.ps1'), script);
  for (const path of Object.keys(payload)) writeFileSync(join(root, path), 'damaged');
  const restored = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PackageRoot', root],
    { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, TEMP: tempRoot, TMP: tempRoot } });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(verifyRecoveryPayload(root, manifest).valid, true);
  for (const [path, bytes] of Object.entries(payload)) assert.equal(readFileSync(join(root, path), 'utf8'), bytes);
  assert.equal(readFileSync(join(root, 'data', 'history.json'), 'utf8'), 'preserved-task-history');
  assert.equal(readFileSync(join(good, 'NPN-Gamma.exe'), 'utf8'), 'known-good-exe');
});

test('offline package activation failure rolls back earlier EXE replacement', { skip: process.platform !== 'win32' }, t => {
  const root = fixture(t);
  const recovery = join(root, 'resources', 'recovery');
  const good = join(recovery, 'bundle');
  const payload = ['NPN-Gamma.exe', 'resources/runtime/node.exe', 'resources/app/main.js', 'z-locked.dll'];
  for (const path of payload) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'known-good');
  }
  mkdirSync(recovery, { recursive: true });
  const manifest = buildRecoveryManifest(root, 'rollback-test', 'package');
  for (const file of manifest.files) {
    mkdirSync(join(good, file.path, '..'), { recursive: true });
    copyFileSync(join(root, file.path), join(good, file.path));
    writeFileSync(join(root, file.path), 'original-damaged');
  }
  writeFileSync(join(recovery, 'manifest.json'), JSON.stringify(manifest));
  const script = join(recovery, 'restore.ps1');
  copyFileSync(join(projectRoot, 'src', 'adaptation', 'restore.ps1'), script);
  mkdirSync(join(root, 'data'), { recursive: true });
  const lockScript = join(root, 'data', 'locked-restore-test.ps1');
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  writeFileSync(lockScript, `$ErrorActionPreference='Stop'\n$lock=[System.IO.File]::Open(${literal(join(root, 'z-locked.dll'))},[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read)\ntry { & ${literal(script)} -PackageRoot ${literal(root)} } finally { $lock.Dispose() }`, 'utf8');
  const rejected = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lockScript],
    { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, TEMP: tempRoot, TMP: tempRoot } });
  assert.notEqual(rejected.status, 0);
  for (const path of payload) assert.equal(readFileSync(join(root, path), 'utf8'), 'original-damaged');
  assert.equal(readFileSync(join(good, 'NPN-Gamma.exe'), 'utf8'), 'known-good');
});
