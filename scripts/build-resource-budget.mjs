import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function buildResourceBudget() {
  if (process.platform !== 'win32') return;
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!existsSync(compiler)) throw new Error('Windows .NET Framework C# compiler is required to build the resource guard.');
  const temp = path.resolve('.tmp', 'resource-compiler');
  mkdirSync(temp, { recursive: true }); mkdirSync('build/native', { recursive: true });
  const result = spawnSync(compiler, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${path.resolve('build/native/resource-budget.exe')}`, path.resolve('native/resource-budget.cs')],
    { stdio: 'inherit', windowsHide: true, env: { ...process.env, TEMP: temp, TMP: temp } });
  if (result.status !== 0) throw new Error('Resource guard compilation failed.');
  const launcher = spawnSync(compiler, ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', '/define:DESKTOP_LAUNCHER', `/out:${path.resolve('build/native/resource-launcher.exe')}`, path.resolve('native/resource-budget.cs')],
    { stdio: 'inherit', windowsHide: true, env: { ...process.env, TEMP: temp, TMP: temp } });
  if (launcher.status !== 0) throw new Error('Desktop resource launcher compilation failed.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/build-resource-budget.mjs')) buildResourceBudget();
