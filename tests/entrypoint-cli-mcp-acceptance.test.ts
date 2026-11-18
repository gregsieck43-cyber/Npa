/**
 * Real-process entrypoint acceptance: the compiled CLI and MCP stdio server talk to a real
 * authenticated loopback backend (fresh full-TypeScript build, worker siblings present) and the
 * durable kernel. No in-process adapters are substituted for the entrypoints under test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { assertProjectFixtureRoot } from './project-boundary.js';

const projectRoot = resolve(process.cwd());
const nodeExecutable = process.execPath;
const compiledRoot = resolve(import.meta.dirname, '..');
const entry = join(compiledRoot, 'src', 'entry.js');
const fixtureParent = join(projectRoot, '.tmp', 'entrypoint-acceptance', 'root');

interface Discovery { port: number; token: string; pid: number; startedAt: string }
interface OwnedProcess { child: ChildProcessWithoutNullStreams; output: string[]; diagnostics: string[]; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; closed: boolean }
interface CliOutcome { code: number | null; stdout: string; stderr: string }
interface SnapshotShape { selectedTask?: { id: string; status: string; modelCalls: number; revision: number }; intents: { id: string; state: string; name: string; digest: string }[]; messages: { role: string; content: string }[]; events: { seq: number; type: string; payload?: Record<string, any> }[]; tasks: { id: string }[] }
const delay = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));
async function deadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
function json<T>(text: string, label: string): T {
  try { return JSON.parse(text) as T; }
  catch (error) { throw new Error(label + ' stdout is not a single JSON document: ' + (error instanceof Error ? error.message : String(error))); }
}

test('CLI and MCP entrypoints operate through the real authenticated backend with durable commands', { timeout: 240_000 }, async t => {
  assert.ok(existsSync(entry), 'Fresh full-TypeScript build must contain src/entry.js beside the compiled tests.');
  for (const sibling of ['src/tools/worker.js', 'src/adaptation/task-module-worker.js', 'src/extensions/dsh-worker.js', 'tests/entrypoint-cli-mcp-acceptance.test.js']) {
    assert.ok(existsSync(join(compiledRoot, sibling)), 'Fresh full-TypeScript build must emit sibling file ' + sibling + '; a single bundle would hide a missing runtime worker.');
  }
  mkdirSync(fixtureParent, { recursive: true });
  const fixtureRoot = mkdtempSync(join(fixtureParent, 'entry-'));
  assertProjectFixtureRoot(fixtureRoot);
  const dataDir = join(fixtureRoot, 'data');
  const workspace = join(fixtureRoot, 'workspace');
  const tempDir = join(fixtureRoot, 'tmp');
  const cacheDir = join(fixtureRoot, 'cache');
  const homeDir = join(fixtureRoot, 'home');
  for (const directory of [dataDir, workspace, tempDir, cacheDir, homeDir, join(dataDir, 'tmp')]) mkdirSync(directory, { recursive: true });
  assert.notEqual(resolve(workspace), resolve(dataDir));
  assert.ok(!resolve(workspace).startsWith(resolve(dataDir)) && !resolve(dataDir).startsWith(resolve(workspace)), 'Fixture workspace and data must not nest.');
  const environment: NodeJS.ProcessEnv = {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    PATH: dirname(nodeExecutable),
    TEMP: tempDir, TMP: tempDir, NODE_COMPILE_CACHE: join(cacheDir, 'node-compile'),
    HOME: homeDir, USERPROFILE: homeDir, APPDATA: join(homeDir, 'appdata'), LOCALAPPDATA: join(homeDir, 'localappdata'),
    npm_config_cache: join(cacheDir, 'npm'), XDG_CACHE_HOME: cacheDir,
    NPN_PROJECT_ROOT: fixtureRoot, PYTHONDONTWRITEBYTECODE: '1',
  };
  const owned: OwnedProcess[] = [];
  const discoveryPath = join(dataDir, 'backend.json');
  let discovery: Discovery | undefined;
  let backend: OwnedProcess | undefined;
  let mcp: McpSession | undefined;
  let taskId = '';
  let mcpTaskId = '';
  let recoveryTaskId = '';
  let preparedBeforeCrash = '';
  const tokenSeenIn: string[] = [];
  const checkNoToken = (label: string, ...values: string[]) => {
    if (!discovery) return;
    for (const value of values) if (value.includes(discovery.token)) tokenSeenIn.push(label);
  };
  const track = (child: ChildProcessWithoutNullStreams): OwnedProcess => {
    const record: OwnedProcess = { child, output: [], diagnostics: [], closed: false, exit: Promise.resolve({ code: null, signal: null }) };
    record.exit = new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { record.closed = true; done({ code, signal }); });
    });
    child.stdout.on('data', (chunk: Buffer) => record.output.push(String(chunk)));
    child.stderr.on('data', (chunk: Buffer) => record.diagnostics.push(String(chunk)));
    owned.push(record);
    return record;
  };
  const startBackend = (): OwnedProcess => {
    const child = spawn(nodeExecutable, [entry, '--backend', '--data-dir', dataDir], { cwd: fixtureRoot, env: environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    return track(child);
  };
  const waitForDiscovery = async (record: OwnedProcess, timeout = 30_000): Promise<Discovery> => {
    const limit = Date.now() + timeout;
    for (;;) {
      if (existsSync(discoveryPath)) {
        const candidate = json<Discovery>(readFileSync(discoveryPath, 'utf8'), 'backend discovery');
        if (candidate.pid === record.child.pid) return candidate;
      }
      assert.equal(record.child.exitCode, null, 'Backend exited during startup. stderr=' + record.diagnostics.join('').slice(0, 2000));
      if (Date.now() > limit) throw new Error('Backend discovery did not appear.');
      await delay(100);
    }
  };
  const request = async (method: string, route: string, body?: unknown): Promise<{ status: number; value: any }> => {
    assert.ok(discovery, 'Backend discovery is required.');
    const response = await fetch('http://127.0.0.1:' + discovery.port + route, {
      method,
      headers: { Authorization: 'Bearer ' + discovery.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, value: text ? JSON.parse(text) : null };
  };
  const command = async (type: string, commandId: string, taskId: string): Promise<any> => {
    const response = await request('POST', '/v1/commands', { commandId, type, taskId });
    assert.equal(response.status, 200, 'Command ' + type + ' failed: ' + JSON.stringify(response.value));
    return response.value;
  };
  const snapshotOf = async (id: string): Promise<SnapshotShape> => {
    const response = await request('GET', '/v1/snapshot?taskId=' + encodeURIComponent(id));
    assert.equal(response.status, 200);
    return response.value as SnapshotShape;
  };
  const waitFor = async <T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, timeout = 30_000): Promise<T> => {
    const limit = Date.now() + timeout;
    for (;;) {
      const value = await read();
      if (ready(value)) return value;
      if (Date.now() > limit) throw new Error('Timed out waiting for ' + label + '.');
      await delay(100);
    }
  };
  const cliRaw = async (args: string[], dataDirectory = dataDir): Promise<CliOutcome> => {
    const child = spawn(nodeExecutable, [entry, '--cli', ...args, '--data-dir', dataDirectory], { cwd: fixtureRoot, env: environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const record = track(child);
    child.stdin.end();
    const outcome = await deadline(record.exit, 20_000, 'CLI ' + (args[0] ?? ''));
    const stdout = record.output.join(''), stderr = record.diagnostics.join('');
    checkNoToken('CLI ' + (args[0] ?? ''), stdout, stderr);
    return { code: outcome.code, stdout, stderr };
  };
  const cli = async (args: string[], dataDirectory = dataDir): Promise<any> => {
    const outcome = await cliRaw(args, dataDirectory);
    assert.equal(outcome.code, 0, 'CLI ' + args[0] + ' failed: ' + outcome.stderr.slice(0, 2000));
    assert.equal(outcome.stderr, '', 'CLI ' + args[0] + ' wrote diagnostics on success.');
    return json<Record<string, any>>(outcome.stdout.trim(), 'CLI ' + args[0]);
  };
  const listedTasks = async (): Promise<{ id: string }[]> => {
    const page = await cli(['list']);
    assert.equal(page.historyWindow, true);
    assert.ok(Array.isArray(page.tasks));
    return page.tasks;
  };
  const taskEvents = async (id: string): Promise<{ type: string }[]> => {
    const page = await cli(['events', id, '--limit', '1000']);
    assert.equal(page.historyWindow, true);
    assert.equal(page.page.nextCursor, null, 'This small entrypoint fixture must fit in one explicit history page.');
    assert.ok(Array.isArray(page.events));
    return page.events;
  };
  const closeMcp = async (): Promise<void> => {
    if (!mcp) return;
    const session = mcp; mcp = undefined;
    await session.close();
  };
  class RpcFailure extends Error { constructor(readonly code: number, message: string) { super(message); this.name = 'RpcFailure'; } }
  class McpSession {
    readonly record: OwnedProcess;
    readonly replies = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    readonly lines: string[] = [];
    protocolError: Error | undefined;
    nextId = 0;
    ready = false;
    constructor(readonly dataDirectory: string) {
      this.record = track(spawn(nodeExecutable, [entry, '--mcp', '--data-dir', dataDirectory], { cwd: fixtureRoot, env: environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
      createInterface({ input: this.record.child.stdout }).on('line', line => {
        this.lines.push(line);
        if (!line.trim()) return;
        let message: any;
        try { message = JSON.parse(line); } catch (error) { this.protocolError = error instanceof Error ? error : new Error(String(error)); return; }
        if (!message || message.jsonrpc !== '2.0') { this.protocolError = new Error('MCP stdout line is not JSON-RPC 2.0: ' + line.slice(0, 200)); return; }
        if (typeof message.id === 'number' && this.replies.has(message.id)) {
          const pending = this.replies.get(message.id)!;
          this.replies.delete(message.id);
          if (message.error) pending.reject(new RpcFailure(Number(message.error.code), String(message.error.message)));
          else pending.resolve(message.result);
        }
      });
    }
    async rpc(method: string, params?: unknown): Promise<any> {
      const id = ++this.nextId;
      const response = new Promise<any>((resolveReply, rejectReply) => this.replies.set(id, { resolve: resolveReply, reject: rejectReply }));
      this.record.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
      return deadline(response, 30_000, 'MCP ' + method);
    }
    notify(method: string): void { this.record.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); }
    async initialize(): Promise<any> {
      const result = await this.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'entrypoint-acceptance', version: '1.0.0' } });
      this.notify('notifications/initialized');
      this.ready = true;
      return result;
    }
    async call(name: string, args: Record<string, unknown>): Promise<any> { return this.rpc('tools/call', { name, arguments: args }); }
    async close(): Promise<void> {
      if (this.record.closed) return;
      this.record.child.stdin.end();
      try { await deadline(this.record.exit, 10_000, 'MCP stdin EOF shutdown'); }
      catch { this.record.child.kill(); await deadline(this.record.exit, 5_000, 'MCP owned-process stop'); }
    }
  }

  try {
    await t.test('fresh build contains runtime workers and the compiled acceptance test', async () => {
      for (const sibling of ['src/tools/worker.js', 'src/adaptation/task-module-worker.js', 'src/extensions/dsh-worker.js']) {
        assert.ok(existsSync(join(compiledRoot, sibling)), sibling);
      }
    });

    await t.test('backend startup creates authenticated discovery for this exact process', async () => {
      backend = startBackend();
      discovery = await waitForDiscovery(backend);
      assert.equal(discovery.pid, backend.child.pid);
      assert.match(discovery.token, /^[a-f0-9]{64}$/);
    });

    await t.test('CLI health and help use the real authenticated backend with clean stdout', async () => {
      const health = await cli(['health']);
      assert.equal(health.status, 'ready');
      assert.equal(health.provider, 'mock', 'Only the loopback mock provider may be used.');
      assert.equal(health.paidApiTested, false);
      assert.equal(health.twentyDayReliability, 'not tested');
      const help = await cliRaw(['help']);
      assert.equal(help.code, 0);
      assert.equal(help.stderr, '');
      assert.match(help.stdout, /^NPN-Gamma CLI/);
    });

    await t.test('CLI creates a task and the authenticated operator pauses it', async () => {
      const submitted = await cli(['submit', 'Create entry-result.txt with the real entry backend', '--workspace', workspace, '--command-id', 'entry-submit-1']);
      assert.equal(submitted.status, 'accepted');
      assert.equal(typeof submitted.taskId, 'string');
      taskId = submitted.taskId;
      assert.equal((await cli(['submit', 'Create entry-result.txt with the real entry backend', '--workspace', workspace, '--command-id', 'entry-submit-1'])).status, 'duplicate');
      const listed = await listedTasks();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].id, taskId);
      const paused = await command('pause', 'entry-pause-1', taskId);
      assert.equal(paused.status, 'accepted');
      assert.equal((await cli(['status', taskId])).status, 'paused');
    });

    await t.test('CLI resume and cancel are durable idempotent commands with one event each', async () => {
      assert.equal((await cli(['resume', taskId, '--command-id', 'entry-resume-1'])).status, 'accepted');
      assert.equal((await cli(['resume', taskId, '--command-id', 'entry-resume-1'])).status, 'duplicate');
      const events = await taskEvents(taskId);
      assert.equal(events.filter((event: any) => event.type === 'task.paused').length, 1);
      assert.equal(events.filter((event: any) => event.type === 'task.resumed').length, 1);
      assert.equal((await cli(['cancel', taskId, '--command-id', 'entry-cancel-1'])).status, 'accepted');
      assert.equal((await cli(['cancel', taskId, '--command-id', 'entry-cancel-1'])).status, 'duplicate');
      const result = await cli(['result', taskId]);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.result, null);
      assert.equal(result.intents.filter((intent: any) => intent.name === 'continue').length, 0);
      const after = await taskEvents(taskId);
      assert.equal(after.filter((event: any) => event.type === 'task.cancelled').length, 1);
      assert.equal((await listedTasks()).length, 1);
    });

    await t.test('MCP stdio lifecycle lists seven tools and calls the real backend after initialization only', async () => {
      mcp = new McpSession(dataDir);
      await assert.rejects(mcp.rpc('tools/list'), (error: unknown) => error instanceof RpcFailure && error.code === -32002);
      const initialized = await mcp.initialize();
      assert.equal(initialized.protocolVersion, '2025-11-25');
      assert.equal(initialized.serverInfo.name, 'npn-gamma');
      assert.equal(initialized.serverInfo.version, JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version);
      const catalog = await mcp.rpc('tools/list');
      assert.deepEqual(catalog.tools.map((tool: any) => tool.name).sort(), ['npn_cancel', 'npn_history', 'npn_query', 'npn_result', 'npn_resume', 'npn_retry', 'npn_submit']);
      await assert.rejects(mcp.rpc('unsupported/method'), (error: unknown) => error instanceof RpcFailure && error.code === -32601);
      const queried = await mcp.call('npn_query', { taskId });
      assert.equal(queried.structuredContent.selectedTask.id, taskId);
      const history = await mcp.call('npn_history', { taskId, kind: 'messages' });
      assert.equal(history.structuredContent.historyWindow, true);
      assert.equal(history.structuredContent.page.nextCursor, null);
      assert.ok(history.structuredContent.messages.some((message: any) => message.content.includes('entry-result.txt')));
      assert.ok(!history.structuredContent.messages.some((message: any) => message.role === 'user' && message.content === 'continue'));
      await assert.rejects(mcp.call('npn_submit', { objective: 'x', mode: 'unlimited' }), (error: unknown) => error instanceof RpcFailure && error.code === -32602 && error.message === 'mode is unsupported.');
    });

    await t.test('MCP submits and cancels with durable dedup through the same backend as CLI', async () => {
      const submitArgs = { objective: 'Create mcp-entry-result.txt through MCP', workspace, commandId: 'entry-mcp-submit-1' };
      const submitted = await mcp!.call('npn_submit', submitArgs);
      assert.equal(submitted.structuredContent.status, 'accepted');
      mcpTaskId = submitted.structuredContent.taskId;
      assert.equal((await mcp!.call('npn_submit', submitArgs)).structuredContent.status, 'duplicate');
      assert.equal((await cli(['status', mcpTaskId])).id, mcpTaskId);
      assert.equal((await listedTasks()).length, 2);
      const result = await mcp!.call('npn_result', { taskId: mcpTaskId });
      assert.equal(result.structuredContent.result, null);
      assert.notEqual(result.structuredContent.status, 'completed');
      assert.equal((await mcp!.call('npn_cancel', { taskId: mcpTaskId, commandId: 'entry-mcp-cancel-1' })).structuredContent.status, 'accepted');
      assert.equal((await mcp!.call('npn_cancel', { taskId: mcpTaskId, commandId: 'entry-mcp-cancel-1' })).structuredContent.status, 'duplicate');
      assert.equal((await cli(['result', mcpTaskId])).status, 'cancelled');
      assert.equal((await listedTasks()).length, 2);
    });

    await t.test('crash recovery invalidates a prepared approval without replaying the effect', async () => {
      const submitted = await cli(['submit', 'Create recovery-result.txt after backend restart', '--workspace', workspace, '--command-id', 'entry-recovery-submit-1']);
      recoveryTaskId = submitted.taskId;
      const waiting = await waitFor(() => snapshotOf(recoveryTaskId), value => value.selectedTask?.status === 'waiting_approval' && value.intents.some(intent => intent.state === 'prepared'), 'prepared approval');
      preparedBeforeCrash = waiting.intents.find(intent => intent.state === 'prepared')!.id;
      assert.equal(existsSync(join(workspace, 'recovery-result.txt')), false, 'No effect may execute before approval.');
      const before = await snapshotOf(recoveryTaskId);
      const beforeEvents = before.events.length;
      const oldToken = discovery!.token;
      backend!.child.kill();
      const exited = await deadline(backend!.exit, 15_000, 'backend crash exit');
      assert.ok(existsSync(discoveryPath), 'A hard-killed backend must leave its discovery file behind (exit=' + String(exited.code) + ').');
      discovery = undefined;
      backend = startBackend();
      const restarted = await waitForDiscovery(backend);
      assert.notEqual(restarted.token, oldToken, 'Restart issues a fresh token.');
      discovery = restarted;
      const recovered = await waitFor(() => snapshotOf(recoveryTaskId), value => value.events.some(event => event.type === 'task.recovered'), 'recovery event');
      assert.ok(recovered.events.length > beforeEvents);
      const denial = recovered.events.find(event => event.type === 'intent.denied' && event.payload?.intentId === preparedBeforeCrash);
      assert.ok(denial, 'Recovery records that the pre-crash approval was invalidated.');
      assert.match(String(denial!.payload?.reason), /invalidated during recovery/);
      const renewed = await waitFor(() => snapshotOf(recoveryTaskId), value => value.selectedTask?.status === 'waiting_approval'
        && value.intents.some(intent => intent.id !== preparedBeforeCrash && intent.state === 'prepared'), 'fresh recovery proposal');
      const invalidated = renewed.intents.find(intent => intent.id === preparedBeforeCrash);
      assert.ok(invalidated, 'The pre-crash intent must still be recorded.');
      assert.equal(invalidated.state, 'denied', 'A proposal sampled under the pre-crash generation cannot be reused.');
      const fresh = renewed.intents.find(intent => intent.id !== preparedBeforeCrash && intent.state === 'prepared')!;
      assert.notEqual(fresh.digest, invalidated.digest, 'The new proposal must require its own approval.');
      const oldGrant = await request('POST', '/v1/commands', { commandId: 'entry-stale-grant', type: 'grant', taskId: recoveryTaskId, parameters: { intentId: preparedBeforeCrash, digest: invalidated.digest } });
      assert.notEqual(oldGrant.status, 200, 'The pre-crash approval cannot authorize the fresh proposal.');
      assert.equal((await snapshotOf(recoveryTaskId)).intents.find(intent => intent.id === fresh.id)?.state, 'prepared');
      assert.deepEqual(renewed.messages.slice(0, before.messages.length), before.messages, 'Recovery preserves exact prior conversation records.');
      assert.equal(renewed.events.some(event => event.type === 'intent.sent'), false, 'No effect may dispatch during recovery without fresh approval.');
      assert.equal(existsSync(join(workspace, 'recovery-result.txt')), false, 'Recovery must not execute the unapproved effect.');
      assert.notEqual(renewed.selectedTask?.status, 'completed');
    });

    await t.test('backend restart preserves tasks and repeated idempotent submissions create no duplicate', async () => {
      const listed = await listedTasks();
      assert.equal(listed.length, 3);
      const first = await cli(['result', taskId]);
      assert.equal(first.status, 'cancelled');
      assert.equal((await cli(['submit', 'Create entry-result.txt with the real entry backend', '--workspace', workspace, '--command-id', 'entry-submit-1'])).status, 'duplicate');
      assert.equal((await listedTasks()).length, 3);
      const allEvents = await Promise.all([taskId, mcpTaskId, recoveryTaskId].map(taskEvents));
      assert.deepEqual(allEvents.map(events => events.filter((event: any) => event.type === 'task.created').length), [1, 1, 1]);
      const mcpSurvived = await mcp!.call('npn_result', { taskId });
      assert.equal(mcpSurvived.structuredContent.status, 'cancelled', 'A long-lived MCP stdio process rereads discovery after backend restart.');
      assert.equal((await cli(['cancel', recoveryTaskId, '--command-id', 'entry-recovery-cancel-1'])).status, 'accepted');
      assert.equal((await cli(['result', recoveryTaskId])).status, 'cancelled');
      assert.equal(existsSync(join(workspace, 'recovery-result.txt')), false);
    });

    await t.test('missing backend discovery and bad bearer tokens produce explicit entrypoint errors', async () => {
      const missing = join(fixtureRoot, 'missing-data');
      mkdirSync(missing);
      const cliMissing = await cliRaw(['health'], missing);
      assert.equal(cliMissing.code, 1);
      assert.equal(cliMissing.stdout, '');
      assert.match(cliMissing.stderr, /Backend discovery is unavailable/);
      const missingMcp = new McpSession(missing);
      try {
        await missingMcp.initialize();
        const failed = await missingMcp.call('npn_submit', { objective: 'must not be created' });
        assert.equal(failed.isError, true);
        assert.match(failed.content[0].text, /Backend discovery is unavailable/);
      } finally { await missingMcp.close(); }
      assert.equal((await listedTasks()).length, 3);

      const authFailure = join(fixtureRoot, 'auth-failure-data');
      mkdirSync(authFailure);
      writeFileSync(join(authFailure, 'backend.json'), JSON.stringify({ port: discovery!.port, token: 'wrong-' + randomUUID(), pid: process.pid, startedAt: new Date().toISOString() }));
      const cliDenied = await cliRaw(['health'], authFailure);
      assert.equal(cliDenied.code, 1);
      assert.equal(cliDenied.stdout, '');
      assert.match(cliDenied.stderr, /authorization required/i);
      const deniedMcp = new McpSession(authFailure);
      try {
        await deniedMcp.initialize();
        const failed = await deniedMcp.call('npn_query', { taskId });
        assert.equal(failed.isError, true);
        assert.match(failed.content[0].text, /authorization required/i);
      } finally { await deniedMcp.close(); }
    });

    await t.test('MCP stdout stayed protocol-only and no entrypoint leaked the access token', async () => {
      assert.equal(mcp!.protocolError, undefined, 'Every MCP stdout line must be protocol JSON.');
      assert.ok(mcp!.lines.length > 0);
      for (const line of mcp!.lines) {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, '2.0');
      }
      checkNoToken('MCP stdout', mcp!.lines.join('\n'));
      await closeMcp();
      assert.deepEqual(tokenSeenIn, []);
    });
  } finally {
    await closeMcp().catch(error => { console.error(String(error)); });
    if (backend && !backend.closed) {
      try {
        if (discovery) await request('POST', '/v1/shutdown', {});
        await deadline(backend.exit, 10_000, 'backend shutdown');
      } catch {
        backend.child.kill();
        await deadline(backend.exit, 5_000, 'backend stop').catch(error => { console.error(String(error)); });
      }
    }
    for (const record of owned.filter(item => !item.closed)) {
      record.child.kill();
      await deadline(record.exit, 5_000, 'owned process cleanup').catch(error => { console.error(String(error)); });
    }
    assert.ok(owned.every(item => item.closed), 'Every owned entrypoint process must exit before fixture cleanup.');
    rmSync(fixtureRoot, { recursive: true, force: true });
    assert.equal(existsSync(fixtureRoot), false);
  }
});
