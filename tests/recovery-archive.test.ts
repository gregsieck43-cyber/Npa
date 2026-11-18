import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildRecoveryManifest, verifyRecoveryArchive, verifyRecoveryPayload, withRecoveryArchive, type RecoveryManifest } from '../src/adaptation/recovery.js';

const project = resolve(process.cwd());
const temporary = join(project, '.tmp', 'recovery-archive-v03');
const windowsOnly = { skip: process.platform !== 'win32' };
const powershell = (script: string, root: string) => spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PackageRoot', root],
  { cwd: project, encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, TEMP: temporary, TMP: temporary, PSModuleAnalysisCachePath: join(temporary, 'ps-cache') } });

function fixture(t: TestContext) {
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, 'owned-'));
  t.after(() => {
    assert.equal(dirname(root), temporary);
    assert.ok(resolve(root).startsWith(`${temporary}${sep}`));
    rmSync(root, { recursive: true, force: true });
  });
  const payload: Record<string, string> = {
    'NPN-Gamma.exe': 'fixture exe '.repeat(10000), 'graphics.dll': 'fixture dll',
    'resources/runtime/node.exe': 'fixture runtime', 'resources/app/main.js': 'fixture app',
    'locales/zh-CN.pak': 'locale retained', 'NPN-CLI.cmd': 'fixture launcher', 'z-locked.dll': 'locked fixture',
  };
  for (const [name, value] of Object.entries(payload)) {
    mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), value);
  }
  const recovery = join(root, 'resources', 'recovery'); mkdirSync(recovery, { recursive: true });
  const manifestPath = join(recovery, 'manifest.json');
  const manifest = buildRecoveryManifest(root, 'archive-fixture', 'package');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const packed = powershell(join(project, 'scripts', 'package-recovery.ps1'), root);
  assert.equal(packed.status, 0, packed.stderr || packed.error?.message);
  const archivePath = join(recovery, 'bundle.zip');
  const bound = withRecoveryArchive(manifest, archivePath); writeFileSync(manifestPath, JSON.stringify(bound));
  const script = join(recovery, 'restore.ps1'); copyFileSync(join(project, 'src', 'adaptation', 'restore.ps1'), script);
  mkdirSync(join(root, 'data')); writeFileSync(join(root, 'data', 'history.json'), 'immutable task history marker');
  return { root, recovery, manifest: bound, manifestPath, archivePath, script, payload };
}

function assertUntouched(f: ReturnType<typeof fixture>) {
  assert.equal(verifyRecoveryPayload(f.root, f.manifest).valid, true);
  assert.equal(readFileSync(join(f.root, 'data', 'history.json'), 'utf8'), 'immutable task history marker');
  assert.equal(existsSync(join(f.recovery, 'backups')), false);
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.recovery-stage-')), false);
}

interface ZipEntry { name: string; text: string; attributes?: number }
function replaceArchive(f: ReturnType<typeof fixture>, entries: ZipEntry[]) {
  const entriesFile = join(f.root, 'data', 'entries.json'); writeFileSync(entriesFile, JSON.stringify(entries));
  const createScript = join(f.root, 'data', 'replace-archive.ps1');
  writeFileSync(createScript, `param([string]$PackageRoot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$entries = Get-Content -LiteralPath (Join-Path $PackageRoot 'data/entries.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$stream = [IO.File]::Open((Join-Path $PackageRoot 'resources/recovery/bundle.zip'), [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite)
try {
  $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
  try { foreach ($item in $entries) {
    $entry = $zip.CreateEntry([string]$item.name)
    if ($null -ne $item.attributes) { $entry.ExternalAttributes = [int]$item.attributes }
    $output = $entry.Open()
    try { $bytes = [Text.Encoding]::UTF8.GetBytes([string]$item.text); $output.Write($bytes, 0, $bytes.Length) } finally { $output.Dispose() }
  } } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
`, 'utf8');
  const result = powershell(createScript, f.root); assert.equal(result.status, 0, result.stderr);
  // Rebind only the archive identity: individual file hashes must still prevent altered content.
  f.manifest = withRecoveryArchive(f.manifest, f.archivePath);
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
}

test('compressed offline restore repairs every static unit, retains data and keeps a damaged backup', windowsOnly, t => {
  const f = fixture(t);
  assert.equal(f.manifest.schemaVersion, 2);
  assert.equal(verifyRecoveryArchive(f.recovery, f.manifest).valid, true);
  assert.ok(f.manifest.archive!.size < f.manifest.files.reduce((sum, file) => sum + file.size, 0) / 4);
  assert.equal(existsSync(join(f.recovery, 'bundle')), false);
  for (const name of Object.keys(f.payload)) writeFileSync(join(f.root, name), 'damaged');
  const restored = powershell(f.script, f.root);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(verifyRecoveryPayload(f.root, f.manifest).valid, true);
  assert.equal(readFileSync(join(f.root, 'data', 'history.json'), 'utf8'), 'immutable task history marker');
  const backups = readdirSync(join(f.recovery, 'backups')); assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(f.recovery, 'backups', backups[0], 'NPN-Gamma.exe'), 'utf8'), 'damaged');
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.recovery-stage-')), false);
});

test('archive identity corruption is refused before static mutation', windowsOnly, t => {
  const f = fixture(t);
  const bytes = readFileSync(f.archivePath); bytes[30] ^= 1; writeFileSync(f.archivePath, bytes);
  assert.equal(verifyRecoveryArchive(f.recovery, f.manifest).valid, false);
  const rejected = powershell(f.script, f.root);
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /archive hash or size mismatch/i);
  assertUntouched(f);
});

test('rebound archive containing altered bytes still fails individual file identity', windowsOnly, t => {
  const f = fixture(t);
  const entries = Object.entries(f.payload).map(([name, text]) => ({ name, text: name === 'graphics.dll' ? 'x'.repeat(text.length) : text }));
  replaceArchive(f, entries);
  const rejected = powershell(f.script, f.root);
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /hash or size mismatch/i);
  assertUntouched(f);
});

for (const attack of ['traversal', 'duplicate', 'oversized', 'symlink', 'unexpected'] as const) {
  test(`archive ${attack} is refused without changing static files or data`, windowsOnly, t => {
    const f = fixture(t);
    const entries: ZipEntry[] = Object.entries(f.payload).map(([name, text]) => ({ name, text }));
    const index = entries.findIndex(entry => entry.name === 'graphics.dll');
    if (attack === 'traversal') entries[index].name = '../outside.txt';
    if (attack === 'duplicate') entries[index] = { ...entries[0] };
    if (attack === 'oversized') entries[index].text += '!';
    if (attack === 'symlink') entries[index].attributes = -1610612736;
    if (attack === 'unexpected') entries[index].name = 'not-in-manifest.dll';
    replaceArchive(f, entries);
    const rejected = powershell(f.script, f.root);
    assert.notEqual(rejected.status, 0, attack);
    assertUntouched(f);
    assert.equal(existsSync(join(f.root, 'outside.txt')), false);
  });
}

test('compressed activation failure rolls back earlier replacements', windowsOnly, t => {
  const f = fixture(t);
  for (const name of Object.keys(f.payload)) writeFileSync(join(f.root, name), 'original damaged bytes');
  const lockScript = join(f.root, 'data', 'locked-restore.ps1');
  writeFileSync(lockScript, `param([string]$PackageRoot)
$ErrorActionPreference='Stop'
$lock=[IO.File]::Open((Join-Path $PackageRoot 'z-locked.dll'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try { & (Join-Path $PackageRoot 'resources/recovery/restore.ps1') -PackageRoot $PackageRoot } finally { $lock.Dispose() }
`);
  const rejected = powershell(lockScript, f.root); assert.notEqual(rejected.status, 0);
  for (const name of Object.keys(f.payload)) assert.equal(readFileSync(join(f.root, name), 'utf8'), 'original damaged bytes');
  assert.equal(readFileSync(join(f.root, 'data', 'history.json'), 'utf8'), 'immutable task history marker');
});

test('manifest rejects Windows aliases before they can become archive paths', windowsOnly, t => {
  const f = fixture(t);
  for (const name of ['../escape', 'file.', 'dir /file', 'con.txt', 'x\\file', 'C:/escape']) {
    const manifest: RecoveryManifest = { ...f.manifest, target: 'resources/app', files: [{ ...f.manifest.files[0], path: name }] };
    assert.throws(() => verifyRecoveryPayload(f.root, manifest), /relative/);
  }
});
