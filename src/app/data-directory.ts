import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { assertLocalPath } from './local-paths.js';

export interface DataDirectoryAccess {
  directory: string;
  platform: 'windows' | 'posix';
  status: 'private' | 'warning' | 'unverified';
  created: boolean;
  checkedAt: string;
  durationMs: number;
  /** Only the directory boundary is inspected; existing descendants are never traversed. */
  scope: 'directory';
  message: string;
}

type HelperOutputType = 'string' | 'buffer' | 'null' | 'undefined' | 'other';
export interface WindowsDataDirectoryFailureDetails {
  stage: 'windows-permission-helper';
  parentPid: number;
  helperPid: number | null;
  elapsedMs: number;
  timeoutMs: 15000;
  maxBuffer: 65536;
  status: number | null;
  signal: string | null;
  errorName?: string;
  errorCode?: string | number;
  stdoutType: HelperOutputType;
  stderrType: HelperOutputType;
  stdoutBytes: number | null;
  stderrBytes: number | null;
  stdoutProtocolValid: boolean;
}

// Keep only fixed metadata for errors created here. Never retain the native spawn error:
// it can contain spawnargs, encoded commands, paths or other unbounded details.
const permissionFailures = new WeakMap<object, Readonly<WindowsDataDirectoryFailureDetails>>();
export function dataDirectoryFailureDetails(error: unknown): Readonly<WindowsDataDirectoryFailureDetails> | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
  const details = permissionFailures.get(error);
  return details ? Object.freeze({ ...details }) : undefined;
}

function helperFailure(result: { pid?: number; status?: number | null; signal?: unknown; error?: unknown; stdout?: unknown; stderr?: unknown }, started: number): Error {
  const elapsedMs = Math.max(0, performance.now() - started);
  const output = (value: unknown): { type: HelperOutputType; bytes: number | null } => {
    if (typeof value === 'string') return { type: 'string', bytes: Buffer.byteLength(value, 'utf8') };
    if (Buffer.isBuffer(value)) return { type: 'buffer', bytes: value.length };
    return { type: value === null ? 'null' : value === undefined ? 'undefined' : 'other', bytes: null };
  };
  let errorName: string | undefined, errorCode: string | number | undefined;
  try {
    const error = result.error as { name?: unknown; code?: unknown } | undefined;
    if (typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(error.name)) errorName = error.name;
    if (typeof error?.code === 'number' && Number.isFinite(error.code)) errorCode = error.code;
    else if (typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.code)) errorCode = error.code;
  } catch { /* A throwing metadata getter must not replace the fixed initialization failure. */ }
  const stdout = output(result.stdout), stderr = output(result.stderr);
  const details: WindowsDataDirectoryFailureDetails = {
    stage: 'windows-permission-helper', parentPid: process.pid,
    helperPid: Number.isSafeInteger(result.pid) && result.pid! > 0 ? result.pid! : null,
    elapsedMs, timeoutMs: 15000, maxBuffer: 65536,
    status: Number.isSafeInteger(result.status) ? result.status! : null,
    signal: typeof result.signal === 'string' && /^[A-Z0-9_]{1,32}$/.test(result.signal) ? result.signal : null,
    ...(errorName === undefined ? {} : { errorName }), ...(errorCode === undefined ? {} : { errorCode }),
    stdoutType: stdout.type, stderrType: stderr.type, stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes,
    stdoutProtocolValid: typeof result.stdout === 'string' && /^[01],[01]$/.test(result.stdout.trim()),
  };
  const error = new Error('Windows directory permissions could not be verified.');
  permissionFailures.set(error, Object.freeze(details));
  return error;
}

// Windows PowerShell uses .NET Framework's atomic create-with-DACL overload. It leaves an
// existing directory unchanged, including when another launcher wins the creation race.
const WINDOWS_ACCESS = `
$ErrorActionPreference='Stop'
$directory=$env:NPN_DATA_DIRECTORY_CHECK
$created=![System.IO.Directory]::Exists($directory)
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed=@($identity.Value,'S-1-5-18','S-1-5-32-544')
$inherit=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
if ($created) {
  $security=[System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($identity)
  $security.SetAccessRuleProtection($true,$false)
  foreach($sid in $allowed) {
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
  }
  [void][System.IO.Directory]::CreateDirectory($directory,$security)
}
$acl=[System.IO.Directory]::GetAccessControl($directory)
$isPrivate=$acl.AreAccessRulesProtected -and ($allowed -contains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)
$userFull=$false
foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $allowed -notcontains $rule.IdentityReference.Value) { $isPrivate=$false }
  if ($rule.IdentityReference.Value -eq $identity.Value -and $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and ($rule.InheritanceFlags -band $inherit) -eq $inherit -and $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None) { $userFull=$true }
}
$isPrivate=$isPrivate -and $userFull
[System.Console]::WriteLine(('{0},{1}' -f [int]$created,[int]$isPrivate))
`;

/** Run once at each process's startup, before any database, token, cache or log is written.
 * Existing directories are inspected only: ownership and permissions are never migrated.
 */
export function initializeDataDirectory(target: string): DataDirectoryAccess {
  const directory = assertLocalPath(path.resolve(target), 'Data directory');
  const started = performance.now(), existed = existsSync(directory);
  if (existed && !statSync(directory).isDirectory()) throw new Error('Data directory is not a directory.');
  let created = !existed, status: DataDirectoryAccess['status'];
  try {
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) throw new Error('Windows system runtime is unavailable.');
      const runtime = path.join(systemRoot, 'System32/WindowsPowerShell/v1.0');
      // PowerShell creates its TEMP directory during startup. Never let that pre-create data
      // with inherited permissions before the create-with-DACL script gets to run.
      const temporary = path.dirname(directory);
      mkdirSync(temporary, { recursive: true, mode: 0o700 });
      const helperStarted = performance.now();
      let result: ReturnType<typeof spawnSync>;
      try {
        result = spawnSync(path.join(runtime, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_ACCESS, 'utf16le').toString('base64')], {
          windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024,
          env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary, NPN_DATA_DIRECTORY_CHECK: directory, PSModulePath: path.join(runtime, 'Modules'), PSModuleAnalysisCachePath: 'NUL' },
        });
      } catch (error) { throw helperFailure({ error }, helperStarted); }
      if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || !/^[01],[01]$/.test(result.stdout.trim())) throw helperFailure(result, helperStarted);
      const [made, secured] = result.stdout.trim().split(',');
      created = made === '1';
      status = secured === '1' ? 'private' : 'warning';
    } else {
      if (!existed) mkdirSync(directory, { recursive: true, mode: 0o700 });
      const info = statSync(directory);
      status = (info.mode & 0o777) === 0o700 && info.uid === process.getuid?.() ? 'private' : 'warning';
    }
  } catch (error) {
    if (!existed) {
      const failure = new Error('Cannot establish private data directory permissions before startup.', { cause: error });
      const details = dataDirectoryFailureDetails(error);
      if (details) permissionFailures.set(failure, details);
      throw failure;
    }
    status = 'unverified';
  }
  if (!existed && status !== 'private') throw new Error('New data directory permissions are not private; startup was stopped before writing application data.');
  const message = status === 'private'
    ? 'Data directory access is restricted to the current user and OS administrators. Existing descendants were not inspected.'
    : status === 'warning'
      ? 'Existing data directory permissions are not private. They were left unchanged; other local users may have access. Review the directory permissions before storing sensitive content.'
      : 'Existing data directory permissions could not be verified. They were left unchanged; privacy from other local users is not assured.';
  return { directory, platform: process.platform === 'win32' ? 'windows' : 'posix', status, created,
    checkedAt: new Date().toISOString(), durationMs: Math.round((performance.now() - started) * 10) / 10, scope: 'directory', message };
}
