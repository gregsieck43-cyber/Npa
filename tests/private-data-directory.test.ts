import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startBackend } from '../src/app/backend.js';
import { initializeDataDirectory } from '../src/app/data-directory.js';
import { ensureLocalBackend } from '../src/app/launch-backend.js';

function root() { return mkdtempSync(path.join(process.cwd(), '.tmp/private-data-')); }
function acl(paths: string[]) {
  const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rows=@(); foreach($p in ($env:NPN_TEST_ACL_PATHS | ConvertFrom-Json)) { $a=Get-Acl -LiteralPath $p; $rows+=@{path=$p;protected=$a.AreAccessRulesProtected;sddl=$a.Sddl;owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();inherited=$_.IsInherited;inheritance=$_.InheritanceFlags.ToString();rights=[int]$_.FileSystemRights} })} }; @{sid=$sid;rows=$rows} | ConvertTo-Json -Depth 6 -Compress`;
  const result = spawnSync(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/Modules'), PSModuleAnalysisCachePath: 'NUL', NPN_TEST_ACL_PATHS: JSON.stringify(paths) },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout.trim()) as { sid: string; rows: {path:string;protected:boolean;sddl:string;owner:string;rules:{sid:string;type:string;inherited:boolean;inheritance:string;rights:number}[]}[] };
}
async function health(backend: {port:number;token:string}, endpoint = '/health') {
  const response = await fetch(`http://127.0.0.1:${backend.port}${endpoint}`, {headers:{Authorization:`Bearer ${backend.token}`}});
  assert.equal(response.status, 200);
  return await response.json() as any;
}

test('new backend data and actual SQLite/discovery descendants are private; reopen preserves the DACL', {skip: process.platform !== 'win32'}, async t => {
  const projectRoot = root(), dataDir = path.join(projectRoot, 'data');
  let backend = await startBackend({projectRoot, dataDir});
  try {
    const actual = acl([dataDir, path.join(dataDir, 'harness.sqlite'), path.join(dataDir, 'backend.json')]);
    const allowed = new Set([actual.sid, 'S-1-5-18', 'S-1-5-32-544']);
    assert.deepEqual(actual.rows.flatMap(row => row.rules.filter(rule => rule.type === 'Allow' && !allowed.has(rule.sid))), [], 'data must not grant other local principals access');
    assert.equal(actual.rows[0].protected, true);
    const state = (await health(backend)).dataDirectoryAccess;
    assert.equal(state.status, 'private');
    assert.equal(state.created, true);
    assert.equal((await health(backend, '/v1/product/connection')).message, undefined);
    t.diagnostic(JSON.stringify({stage:'new-backend', access:state, actual}));
    const checkedAt = state.checkedAt;
    for (let count=0; count<3; count++) assert.equal((await health(backend)).dataDirectoryAccess.checkedAt, checkedAt);
    await backend.close();
    backend = await startBackend({projectRoot, dataDir});
    assert.equal((await health(backend)).dataDirectoryAccess.created, false);
    assert.equal((await health(backend)).dataDirectoryAccess.status, 'private');
    assert.equal(acl([dataDir]).rows[0].sddl, actual.rows[0].sddl);
    t.diagnostic(JSON.stringify({stage:'reopen-backend', access:(await health(backend)).dataDirectoryAccess}));
  } finally { await backend.close(); }
});

test('an existing broadly inherited data directory reports a warning and is not migrated', {skip: process.platform !== 'win32'}, async t => {
  const projectRoot = root(), dataDir = path.join(projectRoot, 'existing-data');
  mkdirSync(dataDir);
  const before = acl([dataDir]);
  assert.ok(before.rows[0].rules.some(rule => ['S-1-5-11','S-1-5-32-545'].includes(rule.sid)), 'fixture parent must reproduce broad inherited ACL');
  const backend = await startBackend({projectRoot, dataDir});
  try {
    const state = (await health(backend)).dataDirectoryAccess;
    assert.equal(state?.status, 'warning', 'existing broad ACL must not be reported private');
    assert.equal(state.created, false);
    assert.match(state.message, /existing|unchanged/i);
    assert.deepEqual(await health(backend, '/v1/product/connection'), {status:'online',demo:false,message:state.message});
    assert.equal(acl([dataDir]).rows[0].sddl, before.rows[0].sddl);
    t.diagnostic(JSON.stringify({stage:'existing-wide',access:state,before}));
  } finally { await backend.close(); }
});

test('permission inspection failure stops a new directory before data, but existing directories remain unchanged and unverified', {skip: process.platform !== 'win32'}, async () => {
  const projectRoot = root(), dataDir = path.join(projectRoot, 'new-data'), existingDir = path.join(projectRoot, 'existing');
  mkdirSync(existingDir);
  writeFileSync(path.join(existingDir, 'keep.txt'), 'existing synthetic data');
  const before = acl([existingDir]).rows[0].sddl;
  const previous = process.env.SystemRoot;
  try {
    process.env.SystemRoot = path.join(projectRoot, 'missing-windows-runtime');
    await assert.rejects(startBackend({dataDir,projectRoot}), /Cannot establish private/);
    assert.equal(existsSync(dataDir), false);
    const access = initializeDataDirectory(existingDir);
    assert.equal(access.status, 'unverified');
    assert.equal(access.created, false);
    assert.match(access.message, /could not be verified/);
    const backend = await startBackend({dataDir:existingDir,projectRoot});
    try {
      assert.equal((await health(backend)).dataDirectoryAccess.status,'unverified');
      const connection=await health(backend,'/v1/product/connection');
      assert.equal(connection.status,'online');
      assert.match(connection.message,/could not be verified/);
    } finally { await backend.close(); }
  } finally { if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous; }
  assert.equal(acl([existingDir]).rows[0].sddl, before);
  const invalid = path.join(projectRoot, 'not-a-directory');
  writeFileSync(invalid, 'keep');
  assert.throws(() => initializeDataDirectory(invalid), /not a directory/);
});

test('desktop preparation is reused by the launcher; standalone launcher and actual CLI/backend entry share private data', {skip: process.platform !== 'win32', timeout:45000}, async t => {
  const entry = fileURLToPath(new URL('../src/entry.js', import.meta.url));
  for (const desktopPrepared of [true,false]) {
    const projectRoot = root(), dataDir = path.join(projectRoot, 'data');
    const started = performance.now();
    const prepared = desktopPrepared ? initializeDataDirectory(dataDir) : undefined;
    if (prepared) for (const folder of ['desktop-cache','tmp','logs','crash']) mkdirSync(path.join(dataDir,folder));
    const launched = await ensureLocalBackend({dataDir, projectRoot, productRoot:projectRoot, runtime:process.execPath, entry,
      ...(prepared ? {dataDirectoryAccess:prepared} : {})});
    try {
      const startupMs = performance.now() - started;
      assert.notEqual(launched.pid, process.pid);
      const native = await health(launched);
      assert.equal(native.dataDirectoryAccess.status, 'private');
      assert.equal(native.dataDirectoryAccess.created, false, 'launcher creates the directory before backend startup');
      const actual = acl([dataDir, path.join(dataDir,'logs/backend-start.log'), path.join(dataDir,'backend.json'),path.join(dataDir,'kernel.sqlite')]);
      const allowed = new Set([actual.sid,'S-1-5-18','S-1-5-32-544']);
      assert.ok(actual.rows.every(row => row.rules.every(rule => rule.type !== 'Allow' || allowed.has(rule.sid))));
      const cli = spawnSync(process.execPath,[entry,'--cli','health','--data-dir',dataDir], {cwd:projectRoot,env:process.env,encoding:'utf8',windowsHide:true,timeout:10000});
      assert.equal(cli.status,0,cli.stderr);
      assert.equal(JSON.parse(cli.stdout).dataDirectoryAccess.checkedAt,native.dataDirectoryAccess.checkedAt,'CLI reads the existing startup snapshot');
      const reused = await ensureLocalBackend({dataDir, projectRoot, productRoot:projectRoot, runtime:'not-used', entry:'not-used'});
      assert.equal(reused.pid,launched.pid);
      t.diagnostic(JSON.stringify({stage:desktopPrepared?'desktop-launch-backend':'standalone-launch-backend',startupMs:Math.round(startupMs),desktopPreparationMs:prepared?.durationMs,backendCheckMs:native.dataDirectoryAccess.durationMs,actual}));
    } finally {
      process.kill(launched.pid);
      for (let count=0;count<40;count++) { try { process.kill(launched.pid,0); } catch { break; } await new Promise(resolve=>setTimeout(resolve,50)); }
    }
  }
});

test('POSIX new mode is 0700 and existing broad mode is reported without chmod', {skip:process.platform==='win32'}, () => {
  const dataDir=path.join(root(),'data');
  assert.equal(initializeDataDirectory(dataDir).status,'private');
  assert.equal(statSync(dataDir).mode & 0o777,0o700);
  chmodSync(dataDir,0o755);
  assert.equal(initializeDataDirectory(dataDir).status,'warning');
  assert.equal(statSync(dataDir).mode & 0o777,0o755);
});
