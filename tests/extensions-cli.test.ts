import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { BackendClient, BackendError, type BackendAccess } from '../src/extensions/client.js';
import { runCli } from '../src/extensions/cli.js';
import { Kernel } from '../src/kernel/index.js';
import type { Command, Snapshot } from '../src/contracts.js';

function temp(): string { const root = resolve('.tmp'); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, 'extensions-cli-')); }
function remove(directory: string): void { assert.ok(directory.startsWith(resolve('.tmp') + sep)); rmSync(directory, { recursive: true, force: true }); }
function access(kernel: Kernel): BackendAccess {
  return { health: async () => ({ status: 'healthy' }), events: async (taskId, options) => ({ events: kernel.events(taskId, options?.cursor ?? options?.afterSeq ?? 0) }), snapshot: async (taskId?: string) => ({ tasks: kernel.listTasks(), selectedTask: taskId ? kernel.getTask(taskId) : undefined, messages: taskId ? kernel.getMessages(taskId) : [], events: taskId ? kernel.events(taskId) : [], intents: [], health: {} } as Snapshot), command: async command => kernel.command({ ...command, type: command.type === 'submit' ? 'create_task' : command.type }) };
}
test('CLI submit and repeat controls share durable kernel commands without duplicating history', async () => {
  const directory = temp(); const kernel = new Kernel(directory);
  try {
    const client = access(kernel); let output = ''; let diagnostic = '';
    const options = { dataDir: directory, client, stdout: (text: string) => { output += text; }, stderr: (text: string) => { diagnostic += text; } };
    assert.equal(await runCli(['submit', 'Produce one artifact', '--mode', 'autonomous', '--constraint', 'Stay local', '--accept', 'Verified file', '--command-id', 'submit-stable'], options), 0);
    const ack = JSON.parse(output); const taskId = ack.taskId as string;
    assert.equal(kernel.listTasks().length, 1); assert.equal(kernel.getTask(taskId)!.goal.mode, 'autonomous');
    output = ''; assert.equal(await runCli(['submit', 'Produce one artifact', '--mode', 'autonomous', '--constraint', 'Stay local', '--accept', 'Verified file', '--command-id', 'submit-stable'], options), 0);
    assert.equal(JSON.parse(output).status, 'duplicate');
    output = ''; assert.equal(await runCli(['cancel', taskId, '--command-id', 'cancel-stable'], options), 0);
    assert.equal(JSON.parse(output).status, 'accepted');
    output = ''; assert.equal(await runCli(['cancel', taskId, '--command-id', 'cancel-stable'], options), 0);
    assert.equal(JSON.parse(output).status, 'duplicate'); assert.equal(kernel.events(taskId).filter(event => event.type === 'task.cancelled').length, 1);
    assert.equal(kernel.getMessages(taskId).filter(message => message.content === 'continue').length, 0);
    output = ''; assert.equal(await runCli(['result', taskId], options), 0); assert.equal(JSON.parse(output).status, 'cancelled'); assert.equal(JSON.parse(output).result, null);
    assert.equal(diagnostic, '');
  } finally { kernel.close(); remove(directory); }
});
test('CLI retry and resume preserve stable command content as revisions change', async () => {
  const directory = temp(); const kernel = new Kernel(directory);
  try {
    const task = kernel.command({ commandId: 'create', type: 'create_task', parameters: { title: 'Long goal' } }).taskId!;
    kernel.command({ commandId: 'pause', type: 'pause', taskId: task });
    let output = ''; const options = { dataDir: directory, client: access(kernel), stdout: (text: string) => { output += text; }, stderr: () => {} };
    const revision = kernel.getTask(task)!.revision;
    assert.equal(await runCli(['resume', task, '--command-id', 'resume', '--expected-revision', String(revision)], options), 0);
    output = ''; assert.equal(await runCli(['resume', task, '--command-id', 'resume', '--expected-revision', String(revision)], options), 0); assert.equal(JSON.parse(output).status, 'duplicate');
    kernel.command({ commandId: 'pause-again', type: 'pause', taskId: task });
    output = ''; assert.equal(await runCli(['retry', task, '--command-id', 'retry'], options), 0);
    output = ''; assert.equal(await runCli(['retry', task, '--command-id', 'retry'], options), 0); assert.equal(JSON.parse(output).status, 'duplicate');
  } finally { kernel.close(); remove(directory); }
});
test('CLI invalid arguments fail before backend mutation and use stderr only', async () => {
  let calls = 0; let output = ''; let diagnostic = '';
  const client: BackendAccess = { health: async () => ({}), events: async () => { throw new Error('unexpected events'); }, snapshot: async () => { throw new Error('unexpected snapshot'); }, command: async () => { calls++; throw new Error('unexpected command'); } };
  const options = { dataDir: resolve('.tmp'), client, stdout: (text: string) => { output += text; }, stderr: (text: string) => { diagnostic += text; } };
  assert.equal(await runCli(['submit', 'goal', '--mode', 'unlimited'], options), 1);
  assert.equal(await runCli(['submit', 'goal', '--max-calls', '0'], options), 1);
  assert.equal(await runCli(['cancel'], options), 1);
  assert.equal(await runCli(['submit', 'goal', '--typo', 'x'], options), 1);
  assert.equal(calls, 0); assert.equal(output, ''); assert.match(diagnostic, /mode must/);
});
test('backend discovery authenticates real loopback HTTP, encoded task queries and revision conflicts', async () => {
  const directory = temp(); const seen: { url: string; authorization?: string; body?: Command }[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const body = raw ? JSON.parse(raw) as Command : undefined;
    seen.push({ url: request.url!, authorization: request.headers.authorization, body });
    response.setHeader('Content-Type', 'application/json');
    if (body?.expectedRevision === 999) { response.writeHead(409); response.end(JSON.stringify({ error: 'Revision changed.' })); }
    else response.end(JSON.stringify(body ? { commandId: body.commandId, status: 'accepted' } : { tasks: [], health: { status: 'healthy' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(directory, 'backend.json'), JSON.stringify({ port, token: 'demo-only', pid: process.pid, startedAt: new Date().toISOString() }));
    const client = new BackendClient({ dataDir: directory });
    await client.health(); await client.snapshot('task/with space'); await client.command({ type: 'cancel', commandId: 'control', taskId: 'task' });
    assert.deepEqual(seen.map(item => item.url), ['/health', '/v1/snapshot?taskId=task%2Fwith%20space', '/v1/commands']);
    assert.ok(seen.every(item => item.authorization === 'Bearer demo-only'));
    await assert.rejects(client.command({ type: 'retry', commandId: 'conflict', taskId: 'task', expectedRevision: 999 }), (error: unknown) => error instanceof BackendError && error.status === 409);
    await assert.rejects(new BackendClient({ dataDir: directory, baseUrl: 'https://remote.example', token: 'unused' }).health(), /127.0.0.1/);
  } finally { server.close(); await once(server, 'close'); remove(directory); }
});
