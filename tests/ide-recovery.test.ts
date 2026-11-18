import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('offline recovery refuses an active bundled IDE before parsing or mutating payload', t => {
  const root = mkdtempSync(path.resolve('.tmp', 'ide-recovery-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'resources', 'recovery'), { recursive: true });
  writeFileSync(path.join(root, 'resources', 'recovery', 'manifest.json'), '{}');
  const quote = (value: string) => value.replaceAll("'", "''");
  const script = `$fixture='${quote(root)}'; function Get-Process { param([string[]]$Name,[string]$ErrorAction) if ($Name -contains 'VSCodium') { [pscustomobject]@{Path=(Join-Path $fixture 'resources/ide-host/VSCodium.exe')} } }; try { & '${quote(path.resolve('src/adaptation/restore.ps1'))}' -PackageRoot $fixture; throw 'Recovery unexpectedly proceeded' } catch { [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $_.Exception.Message | ConvertTo-Json -Compress }`;
  const child = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20000, env: { ...process.env, TEMP: root, TMP: root, APPDATA: root, LOCALAPPDATA: root, USERPROFILE: root, PSModuleAnalysisCachePath: path.join(root, 'analysis') },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(JSON.parse(child.stdout.trim()), /Stop.*IDE.*before offline recovery/);
});
