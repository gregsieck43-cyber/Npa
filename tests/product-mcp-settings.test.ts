import assert from 'node:assert/strict';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Configuration } from '../src/app/configuration.js';
import { ExternalTools } from '../src/app/external-tools.js';
import { ProductMcpSettings, type McpServerSaveInput } from '../src/product/mcp-settings.js';
import { ProductError, type ProductRuntime } from '../src/product/shared.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');
mkdirSync(root, { recursive: true });

/** A real MCP stdio server: one echo tool, a launch marker and a heartbeat that proves the process is alive. */
const SERVER = `
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
writeFileSync('launched.txt', new Date().toISOString());
let beats = 0;
const heartbeat = () => {
  writeFileSync('heartbeat.next', JSON.stringify({ pid: process.pid, sequence: beats++ }));
  renameSync('heartbeat.next', 'heartbeat.txt');
};
// Publish a complete initial record before answering initialization. Replacing the file avoids
// exposing the empty truncation window of writeFileSync to the test's independent process.
heartbeat();
setInterval(heartbeat, 30);
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let changed = false;
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
  if (request.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'product-settings-fixture', version: '1.0.0' } });
  if (request.method === 'tools/list') return reply({ tools: existsSync('tools.json') ? JSON.parse(readFileSync('tools.json', 'utf8')) : [{ name: 'echo', inputSchema: { type: 'object' }, ...(existsSync('catalog.json') ? JSON.parse(readFileSync('catalog.json', 'utf8')) : {}), ...(changed ? { annotations: { readOnlyHint: false } } : {}) }] });
  if (request.method === 'tools/call') {
    if (request.params.arguments.notifyCatalog) { changed = true; send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); }
    const count = existsSync('calls.txt') ? Number(readFileSync('calls.txt', 'utf8')) : 0;
    writeFileSync('calls.txt', String(count + 1));
    return reply({ content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] });
  }
});
`;

/**
 * Only external tools, credential redaction and the project root belong to this slice. The other
 * ProductRuntime services drive unrelated domains, so the fixture builds the real ExternalTools and
 * Configuration instead of booting the whole backend.
 */
function runtimeFor(external: ExternalTools, configuration = new Configuration('http://127.0.0.1:9/v1')): ProductRuntime {
  return { services: { external, configuration, projectRoot: process.cwd() } } as unknown as ProductRuntime;
}

interface McpFixture {
  dir: string;
  dataDir: string;
  server: string;
  target: string;
  external: ExternalTools;
  settings: ProductMcpSettings;
  launched: string;
  heartbeat: string;
  calls: string;
  restart(): { external: ExternalTools; settings: ProductMcpSettings };
  cleanup(): Promise<void>;
}

function fixture(): McpFixture {
  const dir = mkdtempSync(path.join(root, 'product-mcp-settings-'));
  const runtime = path.join(dir, 'node.exe');
  // The launch boundary only accepts a regular project-local command file; a hardlink gives the
  // fixture its own path without copying the Node runtime.
  linkSync(process.execPath, runtime);
  const server = path.join(dir, 'server.mjs');
  writeFileSync(server, SERVER);
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir);
  const externals: ExternalTools[] = [];
  const open = () => {
    const external = new ExternalTools({ dataDir, projectRoot: process.cwd() });
    externals.push(external);
    return { external, settings: new ProductMcpSettings(runtimeFor(external)) };
  };
  const opened = open();
  return {
    dir, dataDir, server, target: `"${runtime}" "${server}"`,
    external: opened.external, settings: opened.settings,
    launched: path.join(dir, 'launched.txt'),
    heartbeat: path.join(dir, 'heartbeat.txt'),
    calls: path.join(dir, 'calls.txt'),
    restart: open,
    cleanup: async () => {
      for (const external of externals) await external.close();
      assert.equal(path.dirname(dir), root, 'Fixtures stay inside the worker TEMP directory.');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
interface Heartbeat { pid: number; sequence: number }
const readHeartbeat = (f: McpFixture): Heartbeat => {
  const value = JSON.parse(readFileSync(f.heartbeat, 'utf8')) as Heartbeat;
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0, 'heartbeat identifies its actual child process');
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence >= 0, 'heartbeat carries a complete monotone sequence');
  return value;
};

test('an MCP catalog notification invalidates prepared reads until discovery refreshes the real catalog', async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.dir, 'catalog.json'), JSON.stringify({ annotations: { readOnlyHint: true } }));
    const input: McpServerSaveInput = { name: 'Notify fixture', transport: 'stdio', target: f.target, enabled: true };
    const saved = await f.settings.save(input);
    await f.settings.save({ ...input, id: saved.id, approvedDigest: saved.digest });
    const call = { name: 'mcp_read', arguments: { serverId: saved.id, toolName: 'echo', arguments: {} } };
    const prepared = f.external.prepare(call)!;
    const notify = f.external.prepare({ name: 'mcp_call', arguments: { ...call.arguments, arguments: { notifyCatalog: true } } })!;
    await f.external.execute(notify, { effectKey: 'notify', approvedDigest: notify.digest });
    assert.throws(() => f.external.prepare(call), /catalog changed/i);
    const stale = await f.external.execute(prepared, { effectKey: 'stale-catalog', approvedDigest: prepared.digest });
    assert.equal(stale.status, 'failed');
    const catalog = await f.settings.catalog(saved.id);
    assert.equal(catalog.tools[0]!.chatAllowed, false);
    assert.throws(() => f.external.prepare(call), /read.only/i);
    assert.equal(readFileSync(f.calls, 'utf8'), '1', 'no read was dispatched after the catalog notification');
  } finally { await f.cleanup(); }
});

test('MCP discovery and settings materialize only the selected page or tool schema', async () => {
  const f = fixture();
  try {
    const items = Array.from({ length: 101 }, (_, index) => ({ name: `read-${index}`, inputSchema: { type: 'object', description: 'x'.repeat(4000) }, annotations: { readOnlyHint: true } }));
    writeFileSync(path.join(f.dir, 'tools.json'), JSON.stringify(items));
    const input: McpServerSaveInput = { name: 'Paged fixture', transport: 'stdio', target: f.target, enabled: true };
    const saved = await f.settings.save(input);
    await f.settings.save({ ...input, id: saved.id, approvedDigest: saved.digest });
    const first = await f.settings.catalog(saved.id);
    assert.equal(first.total, 101); assert.equal(first.tools.length, 40);
    const last = await f.settings.catalog(saved.id, 80);
    assert.equal(last.tools.length, 21); assert.equal(last.tools[0]!.name, 'read-80');
    const names = await f.external.chatMcpTools({ serverId: saved.id, offset: 40 });
    assert.ok(JSON.stringify(names).length < 4000, 'discovery does not clone or return unused schemas');
    const detail = await f.external.chatMcpTools({ serverId: saved.id, toolName: 'read-100' });
    assert.ok(JSON.stringify(detail).includes('x'.repeat(4000)));
  } finally { await f.cleanup(); }
});

test('Chat MCP requires an approved server and read-only metadata, preserves receipts across restart and disable', async () => {
  const f = fixture();
  try {
    const input: McpServerSaveInput = { name: 'Read fixture', transport: 'stdio', target: f.target, enabled: true };
    const saved = await f.settings.save(input);
    assert.throws(() => f.external.prepare({ name: 'mcp_read', arguments: { serverId: saved.id, toolName: 'echo', arguments: {} } }), /connect/i);
    await f.settings.save({ ...input, id: saved.id, approvedDigest: saved.digest });
    const settings = f.settings;
    const catalog = await settings.catalog(saved.id);
    assert.equal(catalog.tools[0]!.chatAllowed, false, 'unknown tool behavior is unavailable in Chat');
    const call = { name: 'mcp_read', arguments: { serverId: saved.id, toolName: 'echo', arguments: { query: 'hello' } } };
    assert.throws(() => f.external.prepare(call), /read.only/i);
    assert.equal(existsSync(f.calls), false);
    writeFileSync(path.join(f.dir, 'catalog.json'), JSON.stringify({ annotations: { readOnlyHint: true } }));
    await f.external.tools(saved.id);
    const prepared = f.external.prepare(call)!;
    assert.ok(prepared, 'a trusted server read tool is executable through the read adapter');
    const result = await f.external.execute(prepared, { effectKey: 'read-once', approvedDigest: prepared.digest });
    assert.equal(result.status, 'applied');
    assert.equal(readFileSync(f.calls, 'utf8'), '1');
    await f.external.close();
    const reopened = f.restart();
    await reopened.settings.reconnect(saved.id);
    assert.equal((await reopened.settings.catalog(saved.id)).tools[0]!.chatAllowed, true);
    const pending = reopened.external.prepare(call)!;
    await reopened.settings.save({ ...input, id: saved.id, enabled: false });
    const denied = await reopened.external.execute(pending, { effectKey: 'revoked', approvedDigest: pending.digest });
    assert.equal(denied.status, 'failed', 'revocation before dispatch is a known non-effect');
    assert.equal(readFileSync(f.calls, 'utf8'), '1');
    const replay = await reopened.external.execute(prepared, { effectKey: 'read-once', approvedDigest: prepared.digest });
    assert.equal(replay.status, 'applied', 'an existing receipt remains authoritative after revocation');
    assert.equal(readFileSync(f.calls, 'utf8'), '1');
  } finally { await f.cleanup(); }
});

test('Chat MCP freezes the actual tool definition and denies destructive metadata even with a read-only hint', async () => {
  const f = fixture();
  try {
    const input: McpServerSaveInput = { name: 'Read fixture', transport: 'stdio', target: f.target, enabled: true };
    const saved = await f.settings.save(input);
    await f.settings.save({ ...input, id: saved.id, approvedDigest: saved.digest });
    writeFileSync(path.join(f.dir, 'catalog.json'), JSON.stringify({ annotations: { readOnlyHint: true } }));
    await f.external.tools(saved.id);
    const call = { name: 'mcp_read', arguments: { serverId: saved.id, toolName: 'echo', arguments: {} } };
    const prepared = f.external.prepare(call)!;
    writeFileSync(path.join(f.dir, 'catalog.json'), JSON.stringify({ description: 'changed definition', annotations: { readOnlyHint: true } }));
    await f.external.tools(saved.id);
    assert.equal((await f.external.execute(prepared, { effectKey: 'stale-tool', approvedDigest: prepared.digest })).status, 'failed');
    writeFileSync(path.join(f.dir, 'catalog.json'), JSON.stringify({ annotations: { readOnlyHint: true, destructiveHint: true } }));
    await f.external.tools(saved.id);
    assert.throws(() => f.external.prepare(call), /read.only/i);
    assert.equal(existsSync(f.calls), false);
  } finally { await f.cleanup(); }
});

async function expectAlive(f: McpFixture): Promise<void> {
  const before = readHeartbeat(f);
  // Keep the previous 120 + 150 ms total wait budget, but wait for the actual condition instead
  // of assuming two arbitrary samples land on different timer ticks or complete file writes.
  const deadline = performance.now() + 270;
  let after = before;
  while (performance.now() < deadline && after.sequence === before.sequence) {
    await wait(Math.min(10, Math.max(0, deadline - performance.now())));
    after = readHeartbeat(f);
    assert.equal(after.pid, before.pid, 'the heartbeat must belong to the same connected process');
    assert.ok(after.sequence >= before.sequence, 'a running process cannot rewind its heartbeat');
  }
  assert.ok(after.sequence > before.sequence, `the live fixture must advance its heartbeat within the original wait budget: ${JSON.stringify({ before, after })}`);
}

async function expectStopped(f: McpFixture): Promise<void> {
  const stopped = readHeartbeat(f);
  await wait(150);
  assert.deepEqual(readHeartbeat(f), stopped, 'the stopped fixture must not publish another heartbeat');
  assert.throws(() => process.kill(stopped.pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
    'the fixture process has actually exited, not merely stopped publishing heartbeats');
}

test('an unapproved save persists the configuration but never launches the stdio server', async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.settings.list(), []);
    const saved = await f.settings.save({ name: 'Fixture server', transport: 'stdio', target: f.target, enabled: true });
    assert.equal(saved.status, 'disconnected');
    assert.equal(saved.tools, 0);
    assert.equal(saved.transport, 'stdio');
    assert.equal(saved.enabled, true);
    assert.match(saved.digest ?? '', /^[a-f0-9]{64}$/);
    assert.ok(saved.error?.includes(saved.digest!), 'the error names the digest that needs approval');
    assert.match(saved.error ?? '', /approv/i);
    assert.equal(existsSync(f.launched), false, 'no process is launched without the exact digest approval');
    const stored = JSON.parse(readFileSync(path.join(f.dataDir, 'mcp-servers.json'), 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].config.command, path.join(f.dir, 'node.exe'));
    assert.deepEqual(stored[0].config.args, [f.server]);
    assert.equal(stored[0].digest, saved.digest);
    assert.equal(stored[0].enabled, true);
    assert.equal(stored[0].approvedDigest, undefined);
    const listed = f.settings.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, saved.id);
    assert.equal(listed[0]!.status, 'disconnected');
    assert.equal(listed[0]!.tools, 0);
    assert.equal(existsSync(f.launched), false);
  } finally { await f.cleanup(); }
});

test('http and sse transports are refused as unsupported without persisting anything', async () => {
  const f = fixture();
  try {
    for (const transport of ['http', 'sse'] as const) {
      await assert.rejects(
        f.settings.save({ name: 'Remote server', transport, target: 'https://example.org/mcp', enabled: true }),
        (error: unknown) => error instanceof ProductError && error.code === 'unsupported' && error.status === 501,
      );
    }
    assert.deepEqual(f.settings.list(), []);
    assert.equal(existsSync(path.join(f.dataDir, 'mcp-servers.json')), false);
  } finally { await f.cleanup(); }
});

test('invalid targets and fields are rejected before persistence', async () => {
  const f = fixture();
  try {
    const runtime = path.join(f.dir, 'node.exe');
    const rejected = [
      '',
      `"${runtime}" "${f.server}`,
      `"${runtime}" "${f.server}" | whoami`,
      `"${runtime}" "${f.server}"; whoami`,
      `"${runtime}" "${f.server}" \`whoami\``,
      `"${runtime}" "${f.server}" $(whoami)`,
      `"${runtime}" "${f.server}"\nrm -rf .`,
      `"${runtime}" "${f.server}" ticket\u0000hidden`,
    ];
    for (const target of rejected) {
      await assert.rejects(
        f.settings.save({ name: 'Invalid target', transport: 'stdio', target, enabled: true }),
        (error: unknown) => error instanceof ProductError && error.code === 'validation',
      );
    }
    const invalidInputs: unknown[] = [
      { name: 'Invalid', transport: 'stdio', target: f.target, enabled: true, extra: 'unknown-field' },
      { name: 'Invalid', transport: 'stdio', target: f.target, enabled: 'yes' },
      { name: '', transport: 'stdio', target: f.target, enabled: true },
      { name: 'Invalid', transport: 'stdio', target: f.target, enabled: true, approvedDigest: 'not-a-digest' },
      { name: 'Invalid', transport: 'stdio', target: 'relative-command', enabled: true },
    ];
    for (const input of invalidInputs) {
      await assert.rejects(
        f.settings.save(input as unknown as McpServerSaveInput),
        (error: unknown) => error instanceof ProductError && error.code === 'validation',
      );
    }
    assert.deepEqual(f.settings.list(), []);
    assert.equal(existsSync(path.join(f.dataDir, 'mcp-servers.json')), false);
    assert.equal(existsSync(f.launched), false);
  } finally { await f.cleanup(); }
});

test('a matching explicit digest launches the server and exposes its real tools', async () => {
  const f = fixture();
  try {
    const saved = await f.settings.save({ name: 'Fixture server', transport: 'stdio', target: f.target, enabled: true });
    const connected = await f.settings.save({ id: saved.id, name: 'Fixture server', transport: 'stdio', target: f.target, enabled: true, approvedDigest: saved.digest! });
    assert.equal(connected.status, 'connected');
    assert.equal(connected.tools, 1);
    assert.equal(connected.id, saved.id);
    assert.equal(connected.digest, saved.digest);
    assert.equal(connected.error, undefined);
    assert.equal(existsSync(f.launched), true, 'the approved launch really spawns the fixture server');
    const listed = f.settings.list()[0]!;
    assert.equal(listed.status, 'connected');
    assert.equal(listed.tools, 1);
    const prepared = f.external.prepare({ name: 'mcp_call', arguments: { serverId: connected.id, toolName: 'echo', arguments: { text: 'hello from settings' } } });
    assert.ok(prepared);
    const outcome = await f.external.execute(prepared, { effectKey: 'product-mcp-settings-echo', approvedDigest: prepared.digest });
    assert.equal(outcome.status, 'applied');
    assert.match(outcome.output ?? '', /hello from settings/);
    assert.equal(readFileSync(f.calls, 'utf8'), '1');
    await expectAlive(f);
  } finally { await f.cleanup(); }
});

test('a mismatched approval digest never launches the server or records the bogus approval', async () => {
  const f = fixture();
  try {
    const saved = await f.settings.save({ name: 'Gated server', transport: 'stdio', target: f.target, enabled: true });
    const stale = await f.settings.save({ id: saved.id, name: 'Gated server', transport: 'stdio', target: f.target, enabled: true, approvedDigest: 'b'.repeat(64) });
    assert.equal(stale.status, 'disconnected');
    assert.equal(stale.tools, 0);
    assert.ok(stale.error?.includes(saved.digest!), 'the mismatch error names the current digest');
    assert.equal(existsSync(f.launched), false);
    assert.equal(f.external.mcpServerStates()[0]!.approvedDigest, undefined);
    assert.equal(existsSync(f.launched), false);
  } finally { await f.cleanup(); }
});

test('disabling stops the real process and never reports the server as connected again', async () => {
  const f = fixture();
  try {
    const saved = await f.settings.save({ name: 'Toggle server', transport: 'stdio', target: f.target, enabled: true });
    const connected = await f.settings.save({ id: saved.id, name: 'Toggle server', transport: 'stdio', target: f.target, enabled: true, approvedDigest: saved.digest! });
    assert.equal(connected.status, 'connected');
    await expectAlive(f);
    const disabled = await f.settings.save({ id: saved.id, name: 'Toggle server', transport: 'stdio', target: f.target, enabled: false });
    assert.equal(disabled.status, 'disconnected');
    assert.equal(disabled.tools, 0);
    assert.equal(disabled.enabled, false);
    await expectStopped(f);
    assert.throws(
      () => f.external.prepare({ name: 'mcp_call', arguments: { serverId: connected.id, toolName: 'echo', arguments: {} } }),
      /Connect and approve/,
    );
    const stored = JSON.parse(readFileSync(path.join(f.dataDir, 'mcp-servers.json'), 'utf8'));
    assert.equal(stored[0].enabled, false);
    assert.equal(stored[0].approvedDigest, saved.digest, 'the approval still belongs to this exact artifact');
    assert.equal(f.settings.list()[0]!.status, 'disconnected');
    await assert.rejects(
      f.settings.reconnect(connected.id),
      (error: unknown) => error instanceof ProductError && error.code === 'conflict',
    );
  } finally { await f.cleanup(); }
});

test('removal stops the process, deletes the saved configuration and survives a restart', async () => {
  const f = fixture();
  try {
    const saved = await f.settings.save({ name: 'Removable server', transport: 'stdio', target: f.target, enabled: true });
    const connected = await f.settings.save({ id: saved.id, name: 'Removable server', transport: 'stdio', target: f.target, enabled: true, approvedDigest: saved.digest! });
    await f.settings.remove(connected.id);
    assert.deepEqual(f.settings.list(), []);
    assert.deepEqual(JSON.parse(readFileSync(path.join(f.dataDir, 'mcp-servers.json'), 'utf8')), []);
    await expectStopped(f);
    await assert.rejects(
      f.settings.remove(connected.id),
      (error: unknown) => error instanceof ProductError && error.code === 'not_found' && error.status === 404,
    );
    const restarted = f.restart();
    assert.deepEqual(restarted.settings.list(), []);
  } finally { await f.cleanup(); }
});

test('a restart lists disconnected servers and reconnect reuses only the recorded digest approval', async () => {
  const f = fixture();
  try {
    const saved = await f.settings.save({ name: 'Restart server', transport: 'stdio', target: f.target, enabled: true });
    const connected = await f.settings.save({ id: saved.id, name: 'Restart server', transport: 'stdio', target: f.target, enabled: true, approvedDigest: saved.digest! });
    assert.equal(connected.status, 'connected');
    await f.external.close();
    rmSync(f.launched, { force: true });
    const second = f.restart();
    const listed = second.settings.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.status, 'disconnected');
    assert.equal(listed[0]!.tools, 0);
    assert.equal(listed[0]!.digest, saved.digest);
    const reconnected = await second.settings.reconnect(listed[0]!.id);
    assert.equal(reconnected.status, 'connected');
    assert.equal(reconnected.tools, 1);
    assert.equal(existsSync(f.launched), true);
    await second.external.close();
    appendFileSync(f.server, '\n// artifact changed: the recorded approval no longer covers this file\n');
    rmSync(f.launched, { force: true });
    const third = f.restart();
    const changed = third.settings.list()[0]!;
    assert.notEqual(changed.digest, saved.digest);
    assert.equal(changed.status, 'disconnected');
    const refused = await third.settings.reconnect(changed.id);
    assert.equal(refused.status, 'error');
    assert.equal(refused.tools, 0);
    assert.ok(refused.error?.includes(changed.digest!), 'the refusal names the current digest');
    assert.match(refused.error ?? '', /approv/i);
    assert.equal(refused.digest, changed.digest);
    assert.equal(existsSync(f.launched), false, 'a stale approval never relaunches the changed artifact');
    assert.ok(third.settings.list()[0]!.error?.includes(changed.digest!));
  } finally { await f.cleanup(); }
});

test('credentials are redacted from targets and error text', async () => {
  const f = fixture();
  const secret = 'fixture-only-value';
  const configuration = new Configuration('http://127.0.0.1:9/v1');
  configuration.set({ apiKey: secret }, false);
  try {
    const settings = new ProductMcpSettings(runtimeFor(f.external, configuration));
    const target = `"${path.join(f.dir, 'node.exe')}" "${f.server}" "--token=${secret}"`;
    const saved = await settings.save({ name: 'Credential server', transport: 'stdio', target, enabled: true });
    assert.match(saved.target ?? '', /\[credential redacted\]/);
    assert.equal((saved.target ?? '').includes(secret), false);
    assert.equal((saved.error ?? '').includes(secret), false);
    const listed = settings.list()[0]!;
    assert.equal((listed.target ?? '').includes(secret), false);
    assert.match(listed.target ?? '', /\[credential redacted\]/);
    await assert.rejects(
      settings.save({ name: 'Credential server', transport: 'stdio', target: `"${path.join(f.dir, 'node.exe')}" "--token=${secret}`, enabled: true }),
      (error: unknown) => error instanceof ProductError && error.code === 'validation' && !error.message.includes(secret),
    );
    assert.equal(existsSync(f.launched), false);
  } finally { await f.cleanup(); }
});

test('a failed connection is reported as an error view while the saved configuration stays durable', async () => {
  const f = fixture();
  try {
    const missing = path.join(f.dir, 'missing-server.mjs');
    const target = `"${path.join(f.dir, 'node.exe')}" "${missing}"`;
    const saved = await f.settings.save({ name: 'Broken server', transport: 'stdio', target, enabled: true });
    const failed = await f.settings.save({ id: saved.id, name: 'Broken server', transport: 'stdio', target, enabled: true, approvedDigest: saved.digest! });
    assert.equal(failed.status, 'error');
    assert.equal(failed.tools, 0);
    assert.match(failed.error ?? '', /MCP|disconnect|launch/i);
    assert.doesNotMatch(failed.error ?? '', /undefined|\[object Object\]/);
    const stored = JSON.parse(readFileSync(path.join(f.dataDir, 'mcp-servers.json'), 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].config.command, path.join(f.dir, 'node.exe'));
    assert.deepEqual(stored[0].config.args, [missing]);
    const listed = f.settings.list()[0]!;
    assert.equal(listed.status, 'error');
    assert.equal(listed.tools, 0);
    assert.equal(existsSync(f.launched), false);
  } finally { await f.cleanup(); }
});

test('reconnect without a recorded approval refuses with the actionable digest and launches nothing', async () => {
  const f = fixture();
  try {
    const saved = await f.settings.save({ name: 'Unapproved server', transport: 'stdio', target: f.target, enabled: true });
    const refused = await f.settings.reconnect(saved.id);
    assert.equal(refused.status, 'error');
    assert.equal(refused.tools, 0);
    assert.ok(refused.error?.includes(saved.digest!));
    assert.match(refused.error ?? '', /approv/i);
    assert.equal(existsSync(f.launched), false);
    await assert.rejects(
      f.settings.reconnect('missing-server'),
      (error: unknown) => error instanceof ProductError && error.code === 'not_found',
    );
  } finally { await f.cleanup(); }
});
