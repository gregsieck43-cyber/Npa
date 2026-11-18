import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');
const until = async <T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 30000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state.');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};

type Responder = (body: any, index: number) => { content: string } | Promise<{ content: string }>;
type SetupOptions = {
  responder?: Responder;
  trace?: any[];
  configure?: (dir: string, workspace: string) => void;
};

const setup = async (options: SetupOptions = {}) => {
  const dir = mkdtempSync(path.join(root, 'settings-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  options.configure?.(dir, workspace);
  const settings = { dataDir: path.join(dir, 'data'), projectRoot: process.cwd(),
    mockOptions: { ...(options.responder ? { responder: options.responder } : {}), ...(options.trace ? { trace: (body: any) => options.trace!.push(body) } : {}) } };
  let backend = await startBackend(settings);
  const request = async (method: string, route: string, input?: unknown) => {
    const response = await fetch('http://127.0.0.1:' + backend.port + route, { method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const restart = async () => { await backend.close(); backend = await startBackend(settings); };
  const close = async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); };
  return { backend, dir, workspace, settings, request, restart, close };
};
type Env = Awaited<ReturnType<typeof setup>>;

const waitIdle = (env: Env, sessionId: string) => until(async () => {
  const value = await env.request('GET', '/v1/product/sessions/' + sessionId);
  return value.status === 200 && ['idle', 'completed', 'failed', 'cancelled'].includes(value.body.status) ? value : undefined;
});
const sendChat = (env: Env, text: string, extra: Record<string, unknown> = {}) =>
  env.request('POST', '/v1/product/chat/send', { mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default', ...extra });

/** Real stdio MCP server used to prove the Settings routes launch and persist a connected server. */
const MCP_SERVER = [
  "import { createInterface } from 'node:readline';",
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync('launched.txt', new Date().toISOString());",
  "const send = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));",
  "const reply = (id, result) => send({ jsonrpc: '2.0', id, result });",
  "createInterface({ input: process.stdin }).on('line', line => {",
  "  const request = JSON.parse(line);",
  "  if (request.id === undefined) return;",
  "  if (request.method === 'initialize') return reply(request.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'settings-route-fixture', version: '1.0.0' } });",
  "  if (request.method === 'tools/list') return reply(request.id, { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] });",
  "  if (request.method === 'tools/call') return reply(request.id, { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] });",
  "});",
].join('\n');

test('settings HTTP validates deep partial patches without side effects', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const initial = await env.request('GET', '/v1/product/settings');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.appearance, { theme: 'light', accent: 'ember', density: 'comfortable', motion: 'full', fontScale: 1, ambient: true });
  assert.equal(initial.body.defaults.mode, 'chat');
  assert.equal(initial.body.defaults.modelId, 'default');
  assert.deepEqual(initial.body.rules, []);
  assert.deepEqual(initial.body.privacy, { recordContent: true, redactSecrets: true });
  assert.deepEqual(initial.body.network, { webSearch: true, fetch: true, proxy: '' });
  assert.equal(initial.body.autoReview.reviewerModelId, '');
  assert.equal(initial.body.autoReview.explain, false);

  const attempts: [Record<string, unknown>, number][] = [
    [{ appearance: { theme: 'dark' }, surprise: true }, 400],
    [{ appearance: { theme: 'neon' } }, 400],
    [{ appearance: { fontScale: 2 } }, 400],
    [{ appearance: { fontScale: 1.04, glow: true } }, 400],
    [{ appearance: { ambient: 'yes' } }, 400],
    [{ defaults: { mode: 'sneak' } }, 400],
    [{ defaults: { modelId: 'missing-model' } }, 400],
    [{ autoReview: { reviewerModelId: 'missing-model' } }, 400],
    [{ autoReview: { explain: 'sure' } }, 400],
    [{ privacy: { recordContent: 'yes' } }, 400],
    [{ privacy: { redactSecrets: false } }, 400],
    [{ rules: [{ id: '1', pattern: '*', capability: 'root', decision: 'allow' }] }, 400],
    [{ network: { webSearch: 'no' } }, 400],
    [{ network: { proxy: 'http://127.0.0.1:8080' } }, 501],
  ];
  for (const [patch, status] of attempts) {
    const response = await env.request('POST', '/v1/product/settings/update', patch);
    assert.equal(response.status, status, 'unexpected status for ' + JSON.stringify(patch) + ': ' + JSON.stringify(response.body));
  }
  const after = await env.request('GET', '/v1/product/settings');
  assert.deepEqual(after.body, initial.body, 'rejected patches must not change any section');
});

test('settings update persists appearance, defaults, autoReview, rules, privacy and network across restart', { timeout: 180000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const patch = {
    appearance: { theme: 'dark', accent: 'jade', density: 'compact', motion: 'reduced', fontScale: 1.1, ambient: true },
    defaults: { mode: 'code', permission: 'full-access', modelId: 'default', sendKey: 'mod-enter' },
    autoReview: { reviewerModelId: 'default', escalateAt: 'critical', explain: true },
    rules: [
      { id: '1', pattern: '**/*.md', capability: 'read', decision: 'allow' },
      { id: '2', pattern: '*.secret', capability: 'read', decision: 'deny' },
    ],
    privacy: { recordContent: false },
    network: { webSearch: false, fetch: false, proxy: '' },
  };
  const updated = await env.request('POST', '/v1/product/settings/update', patch);
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.appearance, patch.appearance);
  assert.deepEqual(updated.body.defaults, patch.defaults);
  assert.deepEqual(updated.body.autoReview, patch.autoReview);
  assert.deepEqual(updated.body.rules, patch.rules);
  assert.equal(updated.body.privacy.recordContent, false);
  assert.equal(updated.body.privacy.redactSecrets, true);
  assert.deepEqual(updated.body.network, { webSearch: false, fetch: false, proxy: '' });

  await env.restart();
  const persisted = await env.request('GET', '/v1/product/settings');
  assert.deepEqual(persisted.body.appearance, patch.appearance);
  assert.deepEqual(persisted.body.defaults, patch.defaults);
  assert.deepEqual(persisted.body.autoReview, patch.autoReview);
  assert.deepEqual(persisted.body.rules, patch.rules);
  assert.equal(persisted.body.privacy.recordContent, false);
  assert.deepEqual(persisted.body.network, { webSearch: false, fetch: false, proxy: '' });

  const legacy = await env.request('GET', '/v1/harness/settings');
  assert.equal(legacy.body.autoReview.profileId, 'default');
  assert.equal(legacy.body.autoReview.explain, true);
  assert.equal(legacy.body.recordContent, false);
});

test('partial patches merge over current values instead of resetting sibling fields', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const full = {
    appearance: { theme: 'dark', accent: 'jade', density: 'compact', motion: 'reduced', fontScale: 1.1, ambient: true },
    defaults: { mode: 'code', permission: 'full-access', modelId: 'default', sendKey: 'mod-enter' },
    autoReview: { reviewerModelId: 'default', escalateAt: 'critical', explain: true },
    privacy: { recordContent: false },
    network: { webSearch: false, fetch: false },
  };
  const seeded = await env.request('POST', '/v1/product/settings/update', full);
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));

  const appearance = await env.request('POST', '/v1/product/settings/update', { appearance: { theme: 'light' } });
  assert.equal(appearance.status, 200, JSON.stringify(appearance.body));
  assert.equal(appearance.body.appearance.theme, 'light');
  assert.equal(appearance.body.appearance.accent, 'jade');
  assert.equal(appearance.body.appearance.fontScale, 1.1);
  assert.equal(appearance.body.defaults.mode, 'code');

  const defaults = await env.request('POST', '/v1/product/settings/update', { defaults: { sendKey: 'enter' } });
  assert.equal(defaults.body.defaults.sendKey, 'enter');
  assert.equal(defaults.body.defaults.mode, 'code');
  assert.equal(defaults.body.defaults.permission, 'full-access');
  assert.equal(defaults.body.defaults.modelId, 'default');

  const review = await env.request('POST', '/v1/product/settings/update', { autoReview: { explain: false } });
  assert.equal(review.body.autoReview.explain, false);
  assert.equal(review.body.autoReview.reviewerModelId, 'default');
  assert.equal(review.body.autoReview.escalateAt, 'critical');

  const privacy = await env.request('POST', '/v1/product/settings/update', { privacy: { redactSecrets: true } });
  assert.equal(privacy.status, 200);
  assert.equal(privacy.body.privacy.recordContent, false);
  assert.equal(privacy.body.privacy.redactSecrets, true);

  const network = await env.request('POST', '/v1/product/settings/update', { network: { webSearch: true } });
  assert.equal(network.body.network.webSearch, true);
  assert.equal(network.body.network.fetch, false);
});

test('concurrent independent appearance patches preserve both committed values', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const [dark, jade] = await Promise.all([
    env.request('POST', '/v1/product/settings/update', { appearance: { theme: 'dark' } }),
    env.request('POST', '/v1/product/settings/update', { appearance: { accent: 'jade' } }),
  ]);
  assert.equal(dark.status, 200, JSON.stringify(dark.body));
  assert.equal(jade.status, 200, JSON.stringify(jade.body));
  const settings = await env.request('GET', '/v1/product/settings');
  assert.equal(settings.body.appearance.theme, 'dark');
  assert.equal(settings.body.appearance.accent, 'jade');
});

test('exact profile identities are enforced for defaults and automatic review', { timeout: 180000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const spare = {
    id: 'provider-11111111-1111-1111-1111-111111111111',
    name: 'Spare mock',
    provider: { mode: 'mock', model: 'mock' },
  };
  const created = await env.request('POST', '/v1/harness/profiles', spare);
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const setDefault = await env.request('POST', '/v1/product/settings/update', { defaults: { modelId: spare.id } });
  assert.equal(setDefault.status, 200, JSON.stringify(setDefault.body));
  const guarded = await env.request('POST', '/v1/product/models/' + spare.id + '/remove');
  assert.equal(guarded.status, 409);
  assert.match(guarded.body.error ?? '', /default for new sessions/);

  await env.request('POST', '/v1/product/settings/update', { defaults: { modelId: 'default' }, autoReview: { reviewerModelId: spare.id } });
  const reviewerGuard = await env.request('POST', '/v1/product/models/' + spare.id + '/remove');
  assert.equal(reviewerGuard.status, 409);
  assert.match(reviewerGuard.body.error ?? '', /automatic review|reviewer/i);

  await env.request('POST', '/v1/product/settings/update', { autoReview: { reviewerModelId: '' } });
  const removed = await env.request('POST', '/v1/product/models/' + spare.id + '/remove');
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  const bogus = await env.request('POST', '/v1/product/settings/update', { autoReview: { reviewerModelId: 'provider-22222222-2222-2222-2222-222222222222' } });
  assert.equal(bogus.status, 400);
  const exact = await env.request('POST', '/v1/product/settings/update', { autoReview: { reviewerModelId: 'default' } });
  assert.equal(exact.status, 200);
  const harness = await env.request('GET', '/v1/harness/settings');
  assert.equal(harness.body.autoReview.reviewerModelId, 'default');
  assert.equal(harness.body.autoReview.profileId, 'default');
});

test('recordContent really gates stored Inspector bodies but never the wire request', { timeout: 180000 }, async t => {
  const wire: any[] = [];
  const env = await setup({ trace: wire });
  t.after(() => env.close());
  const first = await sendChat(env, 'first recorded message');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await waitIdle(env, first.body.sessionId);
  const firstRecord = env.backend.services.harness!.store.latestRequest(first.body.sessionId);
  assert.ok(firstRecord, 'the request must be recorded');
  assert.equal(firstRecord!.recordContent, true);
  assert.ok(firstRecord!.body, 'recordContent=true must persist the real body');
  assert.ok(JSON.stringify(firstRecord!.body).includes('first recorded message'));

  const off = await env.request('POST', '/v1/product/settings/update', { privacy: { recordContent: false } });
  assert.equal(off.status, 200);
  const second = await sendChat(env, 'second unrecorded message', { sessionId: first.body.sessionId });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  await waitIdle(env, first.body.sessionId);
  const secondRecord = env.backend.services.harness!.store.latestRequest(first.body.sessionId);
  assert.equal(secondRecord!.recordContent, false);
  assert.equal(secondRecord!.body, undefined);
  assert.deepEqual(secondRecord!.sources, []);
  assert.ok(wire.length >= 2);
  assert.ok(JSON.stringify(wire[wire.length - 1].messages).includes('second unrecorded message'),
    'the provider still receives the real request while storage is metadata-only');

  await env.request('POST', '/v1/product/settings/update', { privacy: { recordContent: true } });
  const third = await sendChat(env, 'third recorded again', { sessionId: first.body.sessionId });
  assert.equal(third.status, 200);
  await waitIdle(env, first.body.sessionId);
  assert.ok(env.backend.services.harness!.store.latestRequest(first.body.sessionId)!.body);
});

test('network switches block real web operations and proxy support is reported honestly', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const off = await env.request('POST', '/v1/product/settings/update', { network: { webSearch: false, fetch: false } });
  assert.equal(off.status, 200);
  const search = await env.request('POST', '/v1/web/search', { query: 'settings test' });
  assert.equal(search.status, 409, JSON.stringify(search.body));
  assert.equal(search.body.code, 'NETWORK_DISABLED');
  assert.match((search.body.error ?? '') + (search.body.code ?? ''), /disabled/i);
  const fetchPage = await env.request('POST', '/v1/web/fetch', { url: 'https://example.com/' });
  assert.equal(fetchPage.status, 409, JSON.stringify(fetchPage.body));
  assert.equal(fetchPage.body.code, 'NETWORK_DISABLED');
  assert.match((fetchPage.body.error ?? '') + (fetchPage.body.code ?? ''), /disabled/i);
  const proxy = await env.request('POST', '/v1/product/settings/update', { network: { proxy: 'http://127.0.0.1:9' } });
  assert.equal(proxy.status, 501);
  assert.equal(proxy.body.code, 'unsupported');
  const after = await env.request('GET', '/v1/product/settings');
  assert.equal(after.body.network.proxy, '');
  assert.equal(after.body.network.webSearch, false);
});

test('clearHistory refuses active work, removes only non-pinned rows and keeps audit and project files', { timeout: 180000 }, async t => {
  let release!: () => void;
  let block = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const env = await setup({ responder: async () => {
    if (!block) return { content: 'pinned reply' };
    await gate;
    return { content: 'released' };
  } });
  t.after(() => env.close());

  const file = path.join(env.workspace, 'keep-me.txt');
  writeFileSync(file, 'user project data', 'utf8');
  const pinnedChat = await sendChat(env, 'pinned conversation');
  assert.equal(pinnedChat.status, 200, JSON.stringify(pinnedChat.body));
  await waitIdle(env, pinnedChat.body.sessionId);
  const pinned = { body: { id: pinnedChat.body.sessionId } };
  const pinnedUpdate = await env.request('POST', '/v1/product/sessions/' + pinned.body.id + '/update', { pinned: true });
  assert.equal(pinnedUpdate.status, 200, JSON.stringify(pinnedUpdate.body));

  block = true;
  const running = await sendChat(env, 'hold the request');
  assert.equal(running.status, 200, JSON.stringify(running.body));
  const sessionId = running.body.sessionId;
  await until(() => env.backend.services.harness!.chat.activeRequestId(sessionId));
  const conflict = await env.request('POST', '/v1/product/settings/clear-history', {});
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, 'busy');
  assert.ok(await env.request('GET', '/v1/product/sessions/' + sessionId), 'conflict must not delete the running session');
  release();
  await waitIdle(env, sessionId);

  const requestsBefore = env.backend.services.harness!.store.listRequests({}).requests.length;
  const cleared = await env.request('POST', '/v1/product/settings/clear-history', {});
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.deepEqual(cleared.body, { cleared: true });
  const list = await env.request('GET', '/v1/product/sessions');
  const ids = list.body.items.map((item: any) => item.id);
  assert.ok(ids.includes(pinned.body.id), 'pinned chats stay');
  assert.ok(!ids.includes(sessionId), 'non-pinned chats are cleared');
  assert.ok(existsSync(file), 'clearHistory must never delete user project files');
  const audit = env.backend.services.harness!.store.listRequests({}).requests.length;
  assert.equal(audit, requestsBefore, 'Inspector request audit rows stay after clearing the display index');
  const settings = await env.request('GET', '/v1/product/settings');
  assert.equal(settings.status, 200);
  const models = await env.request('GET', '/v1/product/models');
  assert.ok((models.body as any[]).some((item: any) => item.id === 'default'), 'models stay');
});

test('instructions and skills share real discovery, and disabling a skill removes it from real Chat bodies', { timeout: 180000 }, async t => {
  const wire: any[] = [];
  const env = await setup({ trace: wire, configure: (dir, workspace) => {
    const dataDir = path.join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const globalDir = path.join(dir, 'global');
    const skillRoot = path.join(dir, 'skills');
    const skillDir = path.join(skillRoot, 'marker-skill');
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    const globalFile = path.join(globalDir, 'AGENTS.md');
    writeFileSync(globalFile, 'Global marker: settings-global-marker.', 'utf8');
    writeFileSync(path.join(skillDir, 'SKILL.md'),
      ['---', 'name: settings-marker-skill', 'description: Unique settings toggle marker skill.', '---', 'When active, mention settings-skill-body-marker.'].join('\n'), 'utf8');
    writeFileSync(path.join(dataDir, 'configuration.json'), JSON.stringify({
      provider: { mode: 'mock', model: 'mock' }, globalPaths: [globalFile], skillRoots: [skillRoot],
    }), 'utf8');
    void workspace;
  } });
  t.after(() => env.close());

  const instructions = await env.request('GET', '/v1/product/settings/instructions');
  assert.equal(instructions.status, 200, JSON.stringify(instructions.body));
  const globalEntry = instructions.body.find((entry: any) => entry.scope === 'global');
  assert.ok(globalEntry, 'configured global instruction path is listed even when present');
  assert.equal(globalEntry.status, 'loaded');
  assert.ok(globalEntry.sha256);
  const projects = await env.request('GET', '/v1/product/workspace/projects');
  const registered = new Set((projects.body as any[]).map((item: any) => item.id));
  for (const entry of instructions.body.filter((item: any) => item.scope === 'project')) {
    assert.ok(registered.has(entry.projectId), 'project instruction rows only come from registered projects');
  }

  const skills = await env.request('GET', '/v1/product/settings/skills');
  assert.equal(skills.status, 200);
  const skill = skills.body.find((item: any) => item.name === 'settings-marker-skill');
  assert.ok(skill, 'the real SKILL.md is discovered');
  assert.equal(skill.enabled, true);

  const session = await env.request('POST', '/v1/harness/sessions', {
    title: 'Skill session', profileId: 'default', workspace: env.workspace,
    capabilities: { skills: true, projectInstructions: true },
  });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  const first = await sendChat(env, 'use the configured skill', { sessionId: session.body.id });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await waitIdle(env, session.body.id);
  assert.ok(JSON.stringify(wire[wire.length - 1].messages).includes('settings-skill-body-marker'));

  const toggled = await env.request('POST', '/v1/product/settings/skills/' + encodeURIComponent(skill.id) + '/toggle', { enabled: false });
  assert.equal(toggled.status, 200, JSON.stringify(toggled.body));
  assert.equal(toggled.body.enabled, false);
  const disabled = await env.request('GET', '/v1/product/settings/skills');
  assert.equal(disabled.body.find((item: any) => item.id === skill.id).enabled, false);

  const second = await sendChat(env, 'this request must exclude the skill', { sessionId: session.body.id });
  assert.equal(second.status, 200);
  await waitIdle(env, session.body.id);
  const secondBody = JSON.stringify(wire[wire.length - 1].messages);
  assert.ok(!secondBody.includes('settings-skill-body-marker'), 'a disabled skill is never injected into a later real request');
  assert.ok(!secondBody.includes('settings-marker-skill'));
  assert.ok(secondBody.includes('settings-global-marker'), 'global instructions still load');

  await env.restart();
  const afterRestart = await env.request('GET', '/v1/product/settings/skills');
  assert.equal(afterRestart.body.find((item: any) => item.id === skill.id).enabled, false);
});

test('MCP and plugin settings routes expose real state and unsupported transports are honest', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const empty = await env.request('GET', '/v1/product/settings/mcp');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, []);

  const unsupported = await env.request('POST', '/v1/product/settings/mcp/save', {
    name: 'remote', transport: 'http', target: 'https://example.invalid/mcp', enabled: true,
  });
  assert.equal(unsupported.status, 501, JSON.stringify(unsupported.body));
  assert.equal(unsupported.body.code, 'unsupported');

  const runtime = path.join(env.dir, 'node.exe');
  linkSync(process.execPath, runtime);
  const server = path.join(env.dir, 'mcp-server.mjs');
  writeFileSync(server, MCP_SERVER, 'utf8');
  const target = '"' + runtime + '" "' + server + '"';
  const launched = path.join(env.dir, 'launched.txt');
  assert.equal(existsSync(launched), false);
  const unapproved = await env.request('POST', '/v1/product/settings/mcp/save', {
    name: 'Route fixture', transport: 'stdio', target, enabled: true,
  });
  assert.equal(unapproved.status, 200, JSON.stringify(unapproved.body));
  assert.equal(unapproved.body.status, 'disconnected');
  assert.equal(unapproved.body.tools, 0);
  assert.match(unapproved.body.digest ?? '', /^[a-f0-9]{64}$/);
  assert.match(unapproved.body.error ?? '', /approv/i);
  assert.equal(existsSync(launched), false, 'no process is launched without exact digest approval');

  const approved = await env.request('POST', '/v1/product/settings/mcp/save', {
    id: unapproved.body.id, name: 'Route fixture', transport: 'stdio', target, enabled: true,
    approvedDigest: unapproved.body.digest,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, 'connected');
  assert.ok(approved.body.tools >= 1);
  assert.ok(existsSync(launched), 'the approved stdio server really launched');

  await env.restart();
  const listed = await env.request('GET', '/v1/product/settings/mcp');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].status, 'disconnected');
  assert.equal(listed.body[0].tools, 0);
  const reconnected = await env.request('POST', '/v1/product/settings/mcp/' + approved.body.id + '/reconnect');
  assert.equal(reconnected.status, 200, JSON.stringify(reconnected.body));
  assert.equal(reconnected.body.status, 'connected');
  assert.ok(reconnected.body.tools >= 1);

  const disabled = await env.request('POST', '/v1/product/settings/mcp/save', {
    id: approved.body.id, name: 'Route fixture', transport: 'stdio', target, enabled: false,
    approvedDigest: approved.body.digest,
  });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(disabled.body.status, 'disconnected');
  const removed = await env.request('POST', '/v1/product/settings/mcp/' + approved.body.id + '/remove');
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const afterRemove = await env.request('GET', '/v1/product/settings/mcp');
  assert.deepEqual(afterRemove.body, []);

  const plugins = await env.request('GET', '/v1/product/settings/plugins');
  assert.equal(plugins.status, 200);
  assert.ok(Array.isArray(plugins.body));
  for (const plugin of plugins.body) {
    assert.ok(['active', 'pending_approval', 'disabled'].includes(plugin.status));
    assert.ok(Array.isArray(plugin.capabilities));
  }

  const removeMissing = await env.request('POST', '/v1/product/settings/mcp/does-not-exist/remove');
  assert.ok([404, 400].includes(removeMissing.status));
});

test('clearHistory checks and removes unpinned rows beyond both 2000-row windows and publishes committed removals', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const product = env.backend.services.product!.store;
  const kernel = env.backend.services.kernel;
  const workId = kernel.command({ commandId: crypto.randomUUID(), type: 'create_task',
    parameters: { title: 'Oldest Work', workspace: env.workspace, initialStatus: 'paused' } }).taskId!;
  assert.equal((await env.request('GET', '/v1/product/sessions/' + workId)).status, 200);
  const pinned = await sendChat(env, 'Keep my conversation');
  await waitIdle(env, pinned.body.sessionId);
  assert.equal((await env.request('POST', '/v1/product/sessions/' + pinned.body.sessionId + '/update', { pinned: true })).status, 200);
  const auditBefore = env.backend.services.harness!.store.listRequests({}).requests.length;
  const database = new DatabaseSync(product.path());
  try {
    for (const kind of ['chat', 'work']) {
      database.prepare(`WITH RECURSIVE indices(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM indices WHERE i<2001)
        INSERT INTO session_index(id,kind,mode,title,status,permission,model_id,pinned,created_at,updated_at)
        SELECT ? || i,?,?, 'Display row','idle','ask','default',0,'2099','2099' FROM indices`).run(kind, kind, kind === 'chat' ? 'chat' : 'cowork');
    }
    database.prepare('ATTACH DATABASE ? AS harness').run(path.join(env.settings.dataDir, 'harness.sqlite'));
    database.prepare(`INSERT INTO harness.chat_sessions(id,updated_at,record)
      SELECT h.id,h.updated_at,json_set(origin.record,'$.id',h.id)
      FROM session_index h CROSS JOIN harness.chat_sessions origin
      WHERE h.kind='chat' AND h.pinned=0 AND origin.id=?`).run(pinned.body.sessionId);
    database.exec('DETACH DATABASE harness');
    const count = (sql: string) => Number(database.prepare(sql).get()!.n);
    const clear = () => env.request('POST', '/v1/product/settings/clear-history', {});
    const before = count('SELECT COUNT(*) AS n FROM session_index');
    assert.equal(before, 4004);
    const refused = await clear();
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(count('SELECT COUNT(*) AS n FROM session_index'), before);
    assert.equal(count("SELECT COUNT(*) AS n FROM product_events WHERE type='session.removed'"), 0);
    kernel.command({ commandId: crypto.randomUUID(), type: 'cancel', taskId: workId });
    const done = await clear();
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(count("SELECT COUNT(*) AS n FROM session_index"), 1);
    assert.ok(product.getSession(pinned.body.sessionId)?.pinned);
    assert.equal(count("SELECT COUNT(DISTINCT session_id) AS n FROM product_events WHERE type='session.removed'"), 4003);
    const replay = await env.request('GET', '/v1/product/events?cursor=0&limit=100&sessionId=' + workId);
    assert.equal(replay.status, 200);
    const event = replay.body.events.find((item: { event: { type: string } }) => item.event.type === 'session.removed');
    assert.deepEqual(event?.event, { type: 'session.removed', sessionId: workId });
    assert.equal((await clear()).status, 200);
    assert.equal(count("SELECT COUNT(*) AS n FROM product_events WHERE type='session.removed'"), 4003);
    assert.equal(env.backend.services.harness!.store.listRequests({}).requests.length, auditBefore);
    assert.equal(kernel.getTask(workId)?.status, 'cancelled');
  } finally { database.close(); }
  await env.restart();
  const hidden = await env.request('GET', '/v1/product/sessions/' + workId);
  assert.equal(hidden.status, 404, JSON.stringify(hidden.body));
  assert.deepEqual((await env.request('GET', '/v1/product/sessions')).body.items.map((item: { id: string }) => item.id), [pinned.body.sessionId]);
});

test('clearHistory can retry after native Chat deletion and a failed product commit', async t => {
  const env = await setup();
  t.after(() => env.close());
  const chat = await sendChat(env, 'Retry this removal');
  const id = chat.body.sessionId as string;
  await waitIdle(env, id);
  const product = env.backend.services.product!.store;
  const database = new DatabaseSync(product.path());
  try {
    database.exec("CREATE TRIGGER fail_removal BEFORE INSERT ON product_events WHEN new.type='session.removed' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    const clear = () => env.request('POST', '/v1/product/settings/clear-history', {});
    const failed = await clear();
    assert.ok(failed.status >= 400, JSON.stringify(failed.body));
    assert.throws(() => env.backend.services.harness!.store.getSession(id), /Chat session not found/);
    assert.ok(product.getSession(id));
    const removed = () => product.eventsAfter(0, 200, id).events.filter(item => item.event.type === 'session.removed');
    assert.equal(removed().length, 0);
    database.exec('DROP TRIGGER fail_removal');
    const done = await clear();
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(product.getSession(id), undefined);
    assert.equal(removed().length, 1);
    assert.equal((await clear()).status, 200);
    assert.equal(removed().length, 1);
  } finally { database.close(); }
});

test('clearHistory keeps legacy Work tombstones across startup and another 2001 dismissals', async t => {
  const env = await setup();
  t.after(() => env.close());
  const product = env.backend.services.product!.store;
  const kernel = env.backend.services.kernel;
  const id = kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: 'Legacy hidden Work', workspace: env.workspace, initialStatus: 'paused' } }).taskId!;
  kernel.command({ commandId: crypto.randomUUID(), type: 'cancel', taskId: id });
  product.setMeta('dismissedSessions', [id]);
  product.removeSession(id);
  const filename = product.path();
  await env.restart();
  const detail = () => env.request('GET', '/v1/product/sessions/' + id);
  assert.equal((await detail()).status, 404);
  const database = new DatabaseSync(filename);
  try {
    database.exec(`WITH RECURSIVE indices(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM indices WHERE i<2001)
      INSERT INTO session_index(id,kind,mode,title,status,permission,model_id,created_at,updated_at)
      SELECT 'work-'||i,'work','cowork','Work','completed','ask','default','2099','2099' FROM indices`);
  } finally { database.close(); }
  assert.equal((await env.request('POST', '/v1/product/settings/clear-history', {})).status, 200);
  await env.restart();
  assert.equal((await detail()).status, 404);
  assert.equal((await env.request('GET', '/v1/product/sessions')).body.items.length, 0);
});
