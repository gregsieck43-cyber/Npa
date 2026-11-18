import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { attachResourceBudget, ResourceBudget } from '../src/app/resource-budget.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>, ms = 12000) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await pause(25); }
}
async function fixture(mode: 'recover' | 'fail') {
  const directory = await mkdtemp(path.join(process.env.TEMP!, 'watch-'));
  const state = path.join(directory, 'attempts.txt'), source = path.join(directory, 'watch.cs'), helper = path.join(directory, 'watch.exe');
  await writeFile(source, `using System; using System.IO; using System.Threading;
class Watch { static void Main(string[] args) {
  string file = @"${state.replaceAll('"', '""')}";
  int attempt = File.Exists(file) ? Int32.Parse(File.ReadAllText(file)) + 1 : 1;
  File.WriteAllText(file, attempt.ToString());
  Console.WriteLine("{\\"physicalBytes\\":10000,\\"availableBytes\\":5000,\\"limitBytes\\":6000,\\"commitBytes\\":1000,\\"peakCommitBytes\\":1000,\\"workingSetBytes\\":1000,\\"processes\\":1,\\"hardLimited\\":true}");
  if (${mode === 'recover' ? 'attempt == 1' : 'true'}) { Thread.Sleep(100); Environment.Exit(7); }
  while (Console.Read() != -1) {} File.WriteAllText(file + ".closed", "closed");
} }`);
  const compiler = path.join(process.env.SystemRoot!, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const compiled = spawnSync(compiler, ['/nologo', '/platform:x64', `/out:${helper}`, source],
    { windowsHide: true, env: { ...process.env, TEMP: directory, TMP: directory }, encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  return { directory, helper, attempts: async () => Number(await readFile(state, 'utf8')), closed: async () => readFile(state + '.closed', 'utf8').then(() => true, () => false) };
}

test('watcher restart recovers admission and explicit close releases the replacement helper', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const f = await fixture('recover'), budget = new ResourceBudget(); let stop: (() => void) | undefined;
  try {
    stop = await attachResourceBudget(f.helper, true, budget);
    await until(async () => await f.attempts() === 2 && budget.status().pressure === 'normal', 3000);
    assert.equal(budget.concurrency(), 3);
    stop(); await until(f.closed, 2000); await pause(400);
    assert.equal(await f.attempts(), 2, 'close must not restart the monitor');
  } finally { stop?.(); await pause(150); await rm(f.directory, { recursive: true, force: true }); }
});

test('repeated watcher failures exhaust a finite retry budget and leave work recoverably blocked', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const f = await fixture('fail'), budget = new ResourceBudget(); let stop: (() => void) | undefined;
  try {
    stop = await attachResourceBudget(f.helper, true, budget);
    await until(async () => await f.attempts() === 4 && budget.status().pressure === 'unavailable');
    await pause(1200); assert.equal(await f.attempts(), 4);
    assert.match(budget.status().error ?? '', /restart limit/i);
    assert.equal(budget.concurrency(), 0);
  } finally { stop?.(); await pause(150); await rm(f.directory, { recursive: true, force: true }); }
});
