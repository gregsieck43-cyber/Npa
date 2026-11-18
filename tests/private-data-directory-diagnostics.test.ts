import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { inspect } from 'node:util';
import path from 'node:path';
import { dataDirectoryFailureDetails, initializeDataDirectory, type DataDirectoryAccess } from '../src/app/data-directory.js';

// The test runner's normal per-file child process isolates these synchronous hooks.
// Only target exists/stat/parent mkdir are faked; no filesystem mutation or process launch.
const windows = process.platform === 'win32';
const secret = 'DO_NOT_LEAK_HELPER_BODY_OR_SPAWNARGS';
type FakeResult = { pid?: number; status?: number | null; signal?: string | null; error?: unknown; stdout?: unknown; stderr?: unknown };
function invoke(existed: boolean, reply: FakeResult | (() => never)) {
  const directory = path.resolve(process.env.TEMP ?? '.tmp', 'private-directory-diagnostics-memory-only', 'data');
  const original = { spawnSync: childProcess.spawnSync, existsSync: fs.existsSync, statSync: fs.statSync, mkdirSync: fs.mkdirSync, systemRoot: process.env.SystemRoot };
  let calls = 0, parentCreates = 0, access: DataDirectoryAccess | undefined, error: unknown;
  try {
    process.env.SystemRoot ??= 'C:\\Windows';
    fs.existsSync = ((file: fs.PathLike) => path.resolve(String(file)) === directory ? existed : original.existsSync(file)) as typeof fs.existsSync;
    assert.equal(Reflect.set(fs,'statSync',((file: fs.PathLike, ...args: unknown[]) => path.resolve(String(file)) === directory ? { isDirectory: () => true } : Reflect.apply(original.statSync, fs, [file, ...args])) as typeof fs.statSync),true);
    fs.mkdirSync = ((file: fs.PathLike) => { assert.equal(path.resolve(String(file)), path.dirname(directory)); parentCreates++; return undefined; }) as typeof fs.mkdirSync;
    childProcess.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
      calls++;assert.equal(calls,1,'One helper invocation; no retry');
      assert.equal(path.basename(command).toLowerCase(),'powershell.exe');
      assert.deepEqual(args.slice(0,3),['-NoProfile','-NonInteractive','-EncodedCommand']);assert.equal(args.length,4);
      assert.equal(options.timeout,15000);assert.equal(options.maxBuffer,65536);assert.equal(options.windowsHide,true);assert.equal(options.encoding,'utf8');
      assert.equal(options.env?.NPN_DATA_DIRECTORY_CHECK,directory);
      for(const name of ['TEMP','TMP','TMPDIR'])assert.equal(options.env?.[name],path.dirname(directory));
      if(typeof reply==='function')return reply();
      return reply;
    }) as typeof childProcess.spawnSync;
    syncBuiltinESMExports();
    try { access = initializeDataDirectory(directory); } catch (value) { error = value; }
  } finally {
    childProcess.spawnSync=original.spawnSync;fs.existsSync=original.existsSync;assert.equal(Reflect.set(fs,'statSync',original.statSync),true);fs.mkdirSync=original.mkdirSync;syncBuiltinESMExports();
    if(original.systemRoot===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=original.systemRoot;
  }
  assert.equal(childProcess.spawnSync,original.spawnSync);assert.equal(fs.mkdirSync,original.mkdirSync);
  assert.equal(calls,1);assert.equal(parentCreates,1);
  return {access,error,calls};
}
const result=(extra: FakeResult = {}): FakeResult=>({pid:451,status:0,signal:null,stdout:'1,1\r\n',stderr:'',...extra});
function failed(reply: FakeResult | (()=>never)) {
  const actual=invoke(false,reply);assert.equal(actual.access,undefined);assert.ok(actual.error instanceof Error);
  assert.equal(actual.error.message,'Cannot establish private data directory permissions before startup.');
  const details=dataDirectoryFailureDetails(actual.error);assert.ok(details);
  assert.equal(details.stage,'windows-permission-helper');assert.equal(details.parentPid,process.pid);
  assert.equal(details.timeoutMs,15000);assert.equal(details.maxBuffer,65536);assert.ok(Number.isFinite(details.elapsedMs)&&details.elapsedMs>=0);
  assert.deepEqual(dataDirectoryFailureDetails(actual.error.cause),details,'Outer wrapper preserves classification');
  assert.equal(Object.isFrozen(details),true);assert.notEqual(dataDirectoryFailureDetails(actual.error),details,'Getter returns a safe copy');
  assert.equal(inspect(actual.error,{depth:8}).includes(secret),false);assert.equal(JSON.stringify(details).includes(secret),false);
  for(const key of ['message','stack','path','spawnargs','args','env','stdout','stderr','error','cause'])assert.equal(Object.hasOwn(details,key),false);
  return details;
}

test('permission helper timeout retains safe classification without retaining native Error', {skip:!windows},()=>{
  const native=Object.assign(new Error(secret),{code:'ETIMEDOUT',path:secret,spawnargs:[secret]});
  const d=failed(result({status:null,signal:'SIGTERM',error:native,stdout:'',stderr:secret}));
  assert.equal(d.helperPid,451);assert.equal(d.status,null);assert.equal(d.signal,'SIGTERM');assert.equal(d.errorName,'Error');assert.equal(d.errorCode,'ETIMEDOUT');assert.equal(d.stdoutProtocolValid,false);assert.equal(d.stderrBytes,Buffer.byteLength(secret));
});
test('nonzero helper status is distinct from timeout even when protocol is valid',{skip:!windows},()=>{
  const d=failed(result({status:1,stderr:secret}));assert.equal(d.status,1);assert.equal(d.errorCode,undefined);assert.equal(d.stdoutProtocolValid,true);
});
test('malformed helper stdout retains only type size and invalid-protocol flag',{skip:!windows},()=>{
  const d=failed(result({stdout:secret+'汉字',stderr:'é'}));assert.equal(d.status,0);assert.equal(d.stdoutType,'string');assert.equal(d.stdoutBytes,Buffer.byteLength(secret+'汉字'));assert.equal(d.stderrBytes,2);assert.equal(d.stdoutProtocolValid,false);
});
test('unexpected Buffer and null output types remain fail-closed',{skip:!windows},()=>{
  const d=failed(result({stdout:Buffer.from('1,1\n'),stderr:null}));assert.equal(d.stdoutType,'buffer');assert.equal(d.stdoutBytes,4);assert.equal(d.stderrType,'null');assert.equal(d.stderrBytes,null);assert.equal(d.stdoutProtocolValid,false);
});
test('direct spawn throw retains only safe error name and numeric code',{skip:!windows},()=>{
  const d=failed(()=>{throw Object.assign(new TypeError(secret),{code:-110,spawnargs:[secret]});});assert.equal(d.helperPid,null);assert.equal(d.status,null);assert.equal(d.errorName,'TypeError');assert.equal(d.errorCode,-110);assert.equal(d.stdoutType,'undefined');
});
test('throwing and unsafe native error metadata does not escape or mask failure',{skip:!windows},()=>{
  const native=Object.defineProperty({},'name',{get(){throw new Error(secret);}});
  const d=failed(result({error:native}));assert.equal(d.errorName,undefined);assert.equal(d.errorCode,undefined);
  const unsafe=failed(result({error:{name:secret+' ',code:secret+' '}}));assert.equal(unsafe.errorName,undefined);assert.equal(unsafe.errorCode,undefined);
});
test('valid private flags keep the original successful access shape',{skip:!windows},()=>{
  for(const stdout of ['1,1\n','1,1\r\n']){const r=invoke(false,result({stdout}));assert.equal(r.error,undefined);assert.equal(r.access?.status,'private');assert.equal(r.access?.created,true);assert.equal(r.access?.scope,'directory');assert.deepEqual(Object.keys(r.access!).sort(),['checkedAt','created','directory','durationMs','message','platform','scope','status']);}
});
test('valid secured=0 rejects new data but preserves warning for existing data',{skip:!windows},()=>{
  const fresh=invoke(false,result({stdout:'1,0'}));assert.ok(fresh.error instanceof Error);assert.match(fresh.error.message,/New data directory permissions are not private/);assert.equal(dataDirectoryFailureDetails(fresh.error),undefined,'Valid protocol with unsafe ACL is not a helper transport failure');
  const existing=invoke(true,result({stdout:'0,0'}));assert.equal(existing.error,undefined);assert.equal(existing.access?.status,'warning');assert.equal(existing.access?.created,false);
});
test('existing data helper failure remains unverified without extending access shape',{skip:!windows},()=>{
  const r=invoke(true,result({status:null,error:Object.assign(new Error(secret),{code:'ETIMEDOUT'}),stdout:''}));assert.equal(r.error,undefined);assert.equal(r.access?.status,'unverified');assert.equal(r.access?.created,false);assert.equal(Object.hasOwn(r.access!,'diagnostic'),false);assert.equal(Object.hasOwn(r.access!,'failureDetails'),false);
});
test('safe getter ignores unknown errors and does not traverse getters or arbitrary causes',()=>{
  let reads=0;const unknown=new Proxy({},{get(){reads++;throw new Error(secret);}});assert.equal(dataDirectoryFailureDetails(unknown),undefined);assert.equal(reads,0);
  for(const value of [null,undefined,'',0,{},new Error(secret)])assert.equal(dataDirectoryFailureDetails(value),undefined);
});
