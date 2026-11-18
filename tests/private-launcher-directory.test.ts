import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { initializeDataDirectory } from '../src/app/data-directory.js';

const windows = process.platform === 'win32';
const ownedFixtures: string[] = [];
const temporary = path.resolve('.tmp/continuation-20261117-launcher/fixtures');
const ownedChildren = new Set<ChildProcess>();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
function closed(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (!running(child) && (!child.stdout || child.stdout.destroyed) && (!child.stderr || child.stderr.destroyed)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener('close', done); reject(new Error(`Owned launcher process ${child.pid} did not close`)); }, timeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    child.once('close', done);
  });
}
async function killTree(pid: number): Promise<void> {
  const killer = spawn(path.join(process.env.SystemRoot!, 'System32/taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  await closed(killer, 6000);
}
async function stopChild(child: ChildProcess): Promise<void> {
  const finished = closed(child);
  await Promise.all([finished, running(child) && child.pid ? killTree(child.pid) : Promise.resolve()]);
  ownedChildren.delete(child);
}
async function stopBackend(root: string): Promise<void> {
  const filename = path.join(root, 'data/backend.json');
  if (!existsSync(filename)) return;
  const discovery = JSON.parse(readFileSync(filename, 'utf8')) as { pid: number; port: number; token: string };
  assert.ok(Number.isSafeInteger(discovery.pid) && discovery.pid > 0, 'Fixture discovery must contain a process ID');
  const alive = () => { try { process.kill(discovery.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
  if (!alive()) return;
  await fetch(`http://127.0.0.1:${discovery.port}/v1/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${discovery.token}` }, signal: AbortSignal.timeout(2000) }).catch(() => undefined);
  for (let count = 0; count < 30 && alive(); count++) await delay(100);
  if (!alive()) return;
  // A discovery PID alone is insufficient after exit/reuse: verify the fixture executable before killing its tree.
  const script = `(Get-Process -Id ${discovery.pid} -ErrorAction SilentlyContinue).Path`;
  const actual = await runProcess(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], root, '', 5000);
  assert.equal(actual.status, 0, actual.stderr || actual.error?.message);
  if (!actual.stdout.trim() && !alive()) return;
  assert.equal(path.resolve(actual.stdout.trim()).toLowerCase(), path.join(root, 'resources/runtime/node.exe').toLowerCase(), 'Refuse to stop a process outside this launcher fixture');
  await killTree(discovery.pid);
  for (let count = 0; count < 50 && alive(); count++) await delay(100);
  assert.equal(alive(), false, 'Owned backend must exit before deleting its fixture');
}
after(async () => {
  for (const child of [...ownedChildren]) await stopChild(child);
  for (const root of ownedFixtures) {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith('private-launcher-'));
    await stopBackend(root);
    // Windows can retain the just-exited monitor's executable handle briefly after backend exit.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
function fixture(runtime = true) {
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(path.join(temporary, 'private-launcher-'));
  ownedFixtures.push(root);
  const source = readFileSync(path.resolve('scripts/package.mjs'),'utf8');
  const matches = [...source.matchAll(/writeFileSync\(path\.join\(releaseRoot, '([^']+\.cmd)'\), ('(?:\\.|[^'\\])*')\);/g)];
  assert.equal(matches.length,4,'Exercise the actual four generated CMD strings without executing packaging');
  for (const [,name,literal] of matches) writeFileSync(path.join(root,name!),JSON.parse('"'+literal!.slice(1,-1).replaceAll('"','\\"').replaceAll("\\'","'")+'"'));
  if (runtime) {
    mkdirSync(path.join(root,'resources/runtime'),{recursive:true}); linkSync(process.execPath,path.join(root,'resources/runtime/node.exe'));
    cpSync(fileURLToPath(new URL('../src',import.meta.url)),path.join(root,'resources/app/src'),{recursive:true});
    cpSync(path.resolve('build/native'),path.join(root,'resources/app/native'),{recursive:true});
    writeFileSync(path.join(root,'resources/app/package.json'),JSON.stringify({name:'npn-gamma-agent',version:'0.0.0',type:'module'}));
  }
  return root;
}
function runProcess(executable: string, args: string[], root: string, input = '', timeoutMs = 20000, signal?: AbortSignal, windowsVerbatimArguments = false): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  const child = spawn(executable, args, {
    cwd:root,windowsHide:true,windowsVerbatimArguments,stdio:['pipe','pipe','pipe'],
    env:{...process.env,NODE_DISABLE_COMPILE_CACHE:'1',PSModuleAnalysisCachePath:'NUL',PSModulePath:path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/Modules')},
  });
  ownedChildren.add(child);
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', error: Error | undefined;
    child.stdout!.on('data', chunk => { stdout += String(chunk); }); child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.stdin!.on('error', () => undefined); child.stdin!.end(input);
    child.once('error', value => { error = value; });
    const abort = () => { error ??= new Error('Launcher command timed out or was cancelled'); void stopChild(child).catch(reject); };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('close', status => { clearTimeout(timer); signal?.removeEventListener('abort', abort); ownedChildren.delete(child); resolve({ status: error ? null : status, stdout, stderr, ...(error ? { error } : {}) }); });
    if (signal?.aborted) abort();
  });
}
function command(root:string,name:string,args='',input='',signal?:AbortSignal) {
  return runProcess(process.env.ComSpec ?? path.join(process.env.SystemRoot!,'System32/cmd.exe'),['/d','/s','/c',`""${path.join(root,name)}" ${args}"`],root,input,20000,signal,true);
}
function acl(root:string) {
  // Inspect the OS descriptor independently of the backend's health response.
  const script = `$ErrorActionPreference='Stop'
$sidType=[System.Security.Principal.SecurityIdentifier]
$acl=[IO.Directory]::GetAccessControl($env:NPN_TEST_ACL)
[Console]::WriteLine([int]$acl.AreAccessRulesProtected)
[Console]::WriteLine([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
[Console]::WriteLine($acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All))
foreach($rule in $acl.GetAccessRules($true,$true,$sidType)){[Console]::WriteLine($rule.IdentityReference.Value+' '+$rule.AccessControlType.ToString())}`;
  const started = performance.now();
  const result = spawnSync(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script,'utf16le').toString('base64')],
    {encoding:'utf8', windowsHide:true, timeout:15000, env:{...process.env, PSModuleAnalysisCachePath:'NUL',
      PSModulePath:path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/Modules'), NPN_TEST_ACL:root}});
  assert.equal(result.status, 0, JSON.stringify({ stage: 'read-back-acl', elapsedMs: Math.round(performance.now()-started),
    status: result.status, signal: result.signal, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code }));
  const [flag, sid, sddl, ...lines] = result.stdout.trim().split(/\r?\n/);
  assert.ok(flag === '0' || flag === '1');
  assert.match(sid ?? '', /^S-1-/); assert.ok(sddl && lines.length);
  const rules = lines.map(line => {
    const match = /^(S-1-[\d-]+) (Allow|Deny)$/.exec(line);
    assert.ok(match, 'Expected one Windows SID and access control type per rule');
    return { sid: match[1]!, type: match[2]! };
  });
  return { protected: flag === '1', sid: sid!, sddl, rules };
}
function privateAcl(actual:ReturnType<typeof acl>) {
  assert.equal(actual.protected,true);
  const allowed=new Set([actual.sid,'S-1-5-18','S-1-5-32-544']);
  assert.ok(actual.rules.every(rule=>rule.type!=='Allow'||allowed.has(rule.sid)));
}

test('direct packaged entry --backend initializes private data despite its own early TEMP assignment', {skip:!windows,timeout:45000}, async t => {
  const root=fixture(), dataDir=path.join(root,'data');
  const child=spawn(path.join(root,'resources/runtime/node.exe'),[path.join(root,'resources/app/src/entry.js'),'--backend','--data-dir',dataDir],{cwd:root,env:{...process.env,NPN_PROJECT_ROOT:root,NODE_DISABLE_COMPILE_CACHE:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  ownedChildren.add(child);
  let stderr=''; child.stderr.on('data',chunk=>{stderr+=String(chunk)});
  try {
    const started=Date.now(), deadline=started+10000;
    while(!existsSync(path.join(dataDir,'backend.json')) && child.exitCode===null && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,50));
    const discovered = existsSync(path.join(dataDir,'backend.json'));
    if (!discovered) {
      // Read only fixed startup markers. Discovery itself contains the API token.
      const markers = ['instance-lock.sqlite', 'harness.sqlite', 'product.sqlite'].filter(name => existsSync(path.join(dataDir, name)));
      t.diagnostic(JSON.stringify({ stage: 'waiting-for-backend-discovery', elapsedMs: Date.now()-started,
        pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, dataDirCreated: existsSync(dataDir), markers }));
    }
    assert.ok(discovered,stderr || 'Backend did not start');
    const discovery=JSON.parse(readFileSync(path.join(dataDir,'backend.json'),'utf8'));
    const response=await fetch(`http://127.0.0.1:${discovery.port}/health`,{headers:{Authorization:`Bearer ${discovery.token}`},signal:AbortSignal.any([t.signal,AbortSignal.timeout(5000)])});
    const health=await response.json() as any, actual=acl(dataDir);
    t.diagnostic(JSON.stringify({root,backendCheck:health.dataDirectoryAccess,actual}));
    assert.equal(health.dataDirectoryAccess.status,'private'); privateAcl(actual);
  } finally { try { await stopBackend(root); } finally { await stopChild(child); } }
});

for (const [name,args,input] of [['NPN-CLI.cmd','--help',''],['NPN-MCP.cmd','','{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n']]) {
  test(`generated ${name} performs a read-only entry request without creating default data`, {skip:!windows,timeout:40000}, async t => {
    const root=fixture(), result=await command(root,name!,args,input,t.signal);
    assert.equal(result.status,0,result.stderr || result.error?.message);
    assert.match(result.stdout,name==='NPN-CLI.cmd'?/NPN-Gamma CLI/:/"id":1/);
    assert.equal(existsSync(path.join(root,'data')),false,`${name} must not pre-create data before the private initializer`);
  });
}

test('generated IDE CMD reaches real backend initialization with a private directory before any GUI host', {skip:!windows,timeout:60000}, async t => {
  const root=fixture(), dataDir=path.join(root,'data');
  assert.equal(existsSync(path.join(root,'resources/ide-host.json')),false,'No IDE host is provided: the real entry stops before launching GUI');
  try {
    const result=await command(root,'NPN-IDE.cmd','','',t.signal);
    assert.ok(existsSync(path.join(dataDir,'backend.json')),JSON.stringify({error:result.error?.message,status:result.status,stdout:result.stdout,stderr:result.stderr,root}));
    const discovery=JSON.parse(readFileSync(path.join(dataDir,'backend.json'),'utf8'));
    assert.equal(result.status,1,'The real IDE entry must stop at intentionally absent host metadata/assets');
    assert.match(result.stderr,/ide-host|Portable IDE assets|ENOENT/i);
    const response=await fetch(`http://127.0.0.1:${discovery.port}/health`,{headers:{Authorization:`Bearer ${discovery.token}`},signal:AbortSignal.any([t.signal,AbortSignal.timeout(5000)])});
    const health=await response.json() as any;
    const actual=acl(dataDir);
    t.diagnostic(JSON.stringify({root,backendCheck:health.dataDirectoryAccess,actual}));
    assert.equal(health.dataDirectoryAccess.status,'private'); privateAcl(actual);
  } finally { await stopBackend(root); }
});

test('generated offline recovery CMD restores a real known-good payload without pre-creating data', {skip:!windows,timeout:60000}, async t => {
  const root=fixture(false), recovery=path.join(root,'resources/recovery'), app=path.join(root,'resources/app');
  mkdirSync(app,{recursive:true}); mkdirSync(path.join(recovery,'app'),{recursive:true});
  writeFileSync(path.join(app,'marker.txt'),'old payload');
  const content='known-good synthetic payload'; writeFileSync(path.join(recovery,'app/marker.txt'),content);
  writeFileSync(path.join(recovery,'manifest.json'),JSON.stringify({schemaVersion:1,target:'resources/app',releaseVersion:'0.0.0',files:[{path:'marker.txt',size:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')}]}));
  cpSync(path.resolve('src/adaptation/restore.ps1'),path.join(recovery,'restore.ps1'));
  const result=await command(root,'恢复已知良好版本.cmd','','\r\n',t.signal);
  assert.equal(result.status,0,result.stderr || result.error?.message);
  assert.match(result.stdout,/Recovered known-good release/);
  assert.equal(readFileSync(path.join(app,'marker.txt'),'utf8'),content);
  assert.equal(existsSync(path.join(root,'data')),false,'Offline recovery must not create an unprotected future application data root');
  const state=initializeDataDirectory(path.join(root,'data'));
  assert.equal(state.status,'private'); assert.equal(state.created,true);
  const actual=acl(path.join(root,'data')); privateAcl(actual);
  t.diagnostic(JSON.stringify({root,subsequentFirstStartup:state,actual}));
});
