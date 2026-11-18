import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import type { MockCompletion } from '../src/fixtures/mock-provider.js';

/**
 * Settings ↔ Chat/Work integration acceptance.
 *
 * Every case drives the real startBackend HTTP listener, the real Harness request pipeline, the real
 * Kernel/ExternalTools and a local mock provider; no domain class is called instead of the product
 * route under test. Fixtures live under .tmp/settings-integration/b (project-internal), so nothing
 * outside the worktree is written.
 */

const TREE = process.cwd();
const ROOT = path.join(TREE, '.tmp', 'settings-integration', 'b', 'testdata');
mkdirSync(ROOT, { recursive: true });

let sequence = 0;
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const until = async <T>(read: () => T | undefined, label: string, timeoutMs = 30_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label + '.');
    await sleep(25);
  }
};

const systemText = (body: any): string =>
  String((body?.messages ?? []).find((message: any) => message.role === 'system')?.content ?? '');

type Responder = (body: any, index: number) => MockCompletion | Promise<MockCompletion>;
interface SetupOptions {
  responder?: Responder;
  configure?: (owned: string, workspace: string) => void;
}

const setup = async (options: SetupOptions = {}) => {
  const owned = path.join(ROOT, 'run-' + process.pid + '-' + Date.now() + '-' + sequence++);
  const workspace = path.join(owned, 'workspace');
  const dataDir = path.join(owned, 'data');
  mkdirSync(workspace, { recursive: true });
  options.configure?.(owned, workspace);
  const wire: any[] = [];
  const settings = {
    dataDir,
    projectRoot: TREE,
    mockOptions: {
      ...(options.responder ? { responder: options.responder } : {}),
      trace: (body: any) => { wire.push(body); },
    },
  };
  const backend = await startBackend(settings);
  const request = async (method: string, route: string, input?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch('http://127.0.0.1:' + backend.port + route, {
      method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const text = await response.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    return { status: response.status, body: parsed };
  };
  const close = async (): Promise<void> => {
    await backend.close();
    rmSync(owned, { recursive: true, force: true });
  };
  return { backend, owned, workspace, dataDir, wire, settings, request, close };
};
type Env = Awaited<ReturnType<typeof setup>>;

const harness = (env: Env) => env.backend.services.harness!;

/** Register the fixture workspace exactly like Code's project picker does, then use its real id. */
const projectFor = async (env: Env): Promise<string> => {
  const added = await env.request('POST', '/v1/product/workspace/projects', { path: env.workspace });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  return added.body.id as string;
};

const sendWork = async (env: Env, projectId: string, text: string, mode: 'cowork' | 'code' = 'cowork'): Promise<string> => {
  const sent = await env.request('POST', '/v1/product/chat/send', { mode, text, modelId: 'default', permission: 'ask', projectId });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return sent.body.sessionId as string;
};

const waitTaskStatus = (env: Env, taskId: string, wanted: readonly string[], label: string) =>
  until(() => {
    const task = env.backend.services.kernel.getTask(taskId);
    if (!task) return undefined;
    if (task.status === 'failed') throw new Error('Task failed while waiting for ' + label + ': ' + (task.error ?? ''));
    return wanted.includes(task.status) ? task : undefined;
  }, label);

/** Wait for the next settled real model request of the given kind (chat/work), ignoring older rows. */
const waitSettledRequest = (env: Env, sessionId: string, kind: 'chat' | 'work', previousId: string | undefined, label: string) =>
  until(() => {
    const record = harness(env).store.latestRequest(sessionId, kind);
    if (!record || record.id === previousId) return undefined;
    if (record.status === 'failed') throw new Error('Request failed while waiting for ' + label + ': ' + JSON.stringify(record.error));
    return record.status === 'completed' ? record : undefined;
  }, label);

const wireWithSystem = (bodies: any[], marker: string) => bodies.find(body => systemText(body).includes(marker));

test('Work runner honors Settings skill toggles on the real provider wire', { timeout: 150_000 }, async t => {
  const GLOBAL_MARKER = 'WORK_GLOBAL_DIRECTIVE_MARKER_4c1a';
  const SKILL_BODY = 'WORK_SKILL_BODY_MARKER_9f3c. This skill body may only reach a real Work request while Settings enables it.';
  const SKILL_NAME = 'workbench-marker-skill';
  const env = await setup({
    configure: (owned) => {
      const dataDir = path.join(owned, 'data');
      mkdirSync(dataDir, { recursive: true });
      const skillRoot = path.join(owned, 'skills');
      mkdirSync(path.join(skillRoot, 'workbench-marker'), { recursive: true });
      writeFileSync(path.join(skillRoot, 'workbench-marker', 'SKILL.md'), [
        '---',
        'name: ' + SKILL_NAME,
        'description: workbench marker settings integration skill',
        '---',
        SKILL_BODY,
      ].join('\n'), 'utf8');
      const globalPath = path.join(owned, 'global.md');
      writeFileSync(globalPath, GLOBAL_MARKER + '. Global instructions must keep loading while a skill is disabled.', 'utf8');
      writeFileSync(path.join(dataDir, 'configuration.json'), JSON.stringify({
        provider: { mode: 'mock', model: 'mock' }, globalPaths: [globalPath], skillRoots: [skillRoot],
      }), 'utf8');
    },
    responder: body => {
      if (systemText(body).includes('REVIEWER ROLE'))
        return { content: JSON.stringify({ verdict: 'pass', reason: 'Work skill wire assertion.', findings: [] }) };
      return { content: 'Workbench audit acknowledged without side effects.' };
    },
  });
  t.after(() => env.close());
  const projectId = await projectFor(env);

  const listed = await env.request('GET', '/v1/product/settings/skills');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const skill = (listed.body as any[]).find(item => item.name === SKILL_NAME);
  assert.ok(skill, 'the real SKILL.md under the configured skill root is discovered');
  assert.equal(skill.enabled, true, 'a fresh Settings store leaves the skill enabled');
  assert.equal(typeof skill.id, 'string');

  const disabled = await env.request('POST', '/v1/product/settings/skills/' + encodeURIComponent(skill.id) + '/toggle', { enabled: false });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(disabled.body.enabled, false);
  const disabledList = await env.request('GET', '/v1/product/settings/skills');
  assert.equal((disabledList.body as any[]).find(item => item.id === skill.id).enabled, false, 'the toggle is stored, not a projection-only flag');

  const firstWireStart = env.wire.length;
  const firstTask = await sendWork(env, projectId, 'workbench marker audit turn one', 'code');
  const firstRequest = await waitSettledRequest(env, firstTask, 'work', undefined, 'the disabled-skill Work request settles');
  const firstBody = wireWithSystem(env.wire.slice(firstWireStart), 'MAIN ROLE');
  assert.ok(firstBody, 'the real Work request reached the mock provider');
  const firstText = JSON.stringify(firstBody.messages);
  assert.ok(firstText.includes(GLOBAL_MARKER), 'global instructions still reach the Work request');
  assert.ok(!firstText.includes(SKILL_BODY), 'a Settings-disabled skill body must not be injected into a real Work request');
  assert.ok(!firstText.includes(SKILL_NAME), 'a Settings-disabled skill name must not be injected into a real Work request');
  const firstStored = JSON.stringify(firstRequest.body?.messages ?? []);
  assert.ok(!firstStored.includes(SKILL_BODY), 'the stored request body matches what the provider received');
  assert.ok(!(firstRequest.sources ?? []).some((source: any) => String(source.source).includes('SKILL.md')),
    'the recorded instruction sources do not list the disabled skill');

  const enabled = await env.request('POST', '/v1/product/settings/skills/' + encodeURIComponent(skill.id) + '/toggle', { enabled: true });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(enabled.body.enabled, true);

  const secondWireStart = env.wire.length;
  const secondTask = await sendWork(env, projectId, 'workbench marker audit turn two', 'code');
  await waitSettledRequest(env, secondTask, 'work', undefined, 'the enabled-skill Work request settles');
  const secondBody = wireWithSystem(env.wire.slice(secondWireStart), 'MAIN ROLE');
  assert.ok(secondBody, 'the second real Work request reached the mock provider');
  const secondText = JSON.stringify(secondBody.messages);
  assert.ok(secondText.includes(SKILL_BODY), 're-enabling the skill restores its body on the same Work path (not permanently empty)');
  assert.ok(secondText.includes(SKILL_NAME), 're-enabling the skill restores its discovered name on the real wire');
  assert.ok(secondText.includes(GLOBAL_MARKER));
});

test('clearHistory refuses a non-terminal Work task and clears only after it settles', { timeout: 180_000 }, async t => {
  const env = await setup({
    responder: body => {
      if (systemText(body).includes('REVIEWER ROLE'))
        return { content: JSON.stringify({ verdict: 'pass', reason: 'The approved work write receipt is present.', findings: [] }) };
      const toolResults = (body.messages ?? []).filter((message: any) => message.role === 'tool');
      if (!toolResults.length) {
        return { content: '', toolCalls: [{ id: 'settings-work-write', name: 'write_file', arguments: { path: 'settings-work-note.txt', content: 'SETTINGS_WORK_NOTE\n' } }] };
      }
      return { content: 'The approved settings work note exists.' };
    },
  });
  t.after(() => env.close());
  const projectId = await projectFor(env);

  const pinnedChat = await env.request('POST', '/v1/harness/sessions', { title: 'Pinned settings chat', workspace: env.workspace, capabilities: { projectInstructions: true } });
  assert.equal(pinnedChat.status, 200, JSON.stringify(pinnedChat.body));
  const pinnedId = pinnedChat.body.id as string;
  const pinned = await env.request('POST', '/v1/product/sessions/' + encodeURIComponent(pinnedId) + '/update', { pinned: true });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  assert.equal(pinned.body.pinned, true);

  const projectFile = path.join(env.workspace, 'keep-me.txt');
  writeFileSync(projectFile, 'user project data', 'utf8');

  const taskId = await sendWork(env, projectId, 'write the settings work note', 'cowork');
  await waitTaskStatus(env, taskId, ['waiting_approval'], 'the Work task waits for its write approval');
  const detailBefore = await env.request('GET', '/v1/product/sessions/' + taskId);
  assert.equal(detailBefore.status, 200, JSON.stringify(detailBefore.body));
  assert.ok(detailBefore.body.messages.length >= 1);
  const indexBefore = env.backend.services.product!.store.getSession(taskId);
  assert.ok(indexBefore, 'the Work task has a display index row before clearHistory');

  const conflict = await env.request('POST', '/v1/product/settings/clear-history', {});
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, 'busy');
  assert.match(conflict.body.error ?? '', /Work task is still running/);
  const detailAfterConflict = await env.request('GET', '/v1/product/sessions/' + taskId);
  assert.equal(detailAfterConflict.status, 200, 'a rejected clearHistory must not delete the running Work task');
  assert.ok(detailAfterConflict.body.messages.length >= 1, 'a rejected clearHistory must not delete its messages');
  assert.equal(env.backend.services.kernel.getTask(taskId)!.status, 'waiting_approval');
  assert.ok(env.backend.services.product!.store.getSession(taskId), 'the display index row survives the conflict');
  const conflictList = await env.request('GET', '/v1/product/sessions?limit=100');
  assert.ok((conflictList.body.items as any[]).some(item => item.id === pinnedId), 'pinned chat stays after the conflict');

  const pending = await env.request('GET', '/v1/product/approvals?sessionId=' + taskId);
  assert.equal(pending.status, 200);
  assert.equal(pending.body.length, 1, 'the real prepared write is an actionable approval');
  const decided = await env.request('POST', '/v1/product/approvals/decide', { approvalId: pending.body[0].id, approved: true, scope: 'once' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));

  await waitTaskStatus(env, taskId, ['completed'], 'the approved Work task completes');
  assert.equal(readFileSync(path.join(env.workspace, 'settings-work-note.txt'), 'utf8'), 'SETTINGS_WORK_NOTE\n');
  const settledMessages = env.backend.services.kernel.getMessages(taskId).length;
  const auditBefore = harness(env).store.listRequests({ limit: 200 }).requests.length;

  const cleared = await env.request('POST', '/v1/product/settings/clear-history', {});
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.deepEqual(cleared.body, { cleared: true });
  const list = await env.request('GET', '/v1/product/sessions?limit=100');
  const ids = (list.body.items as any[]).map(item => item.id);
  assert.ok(ids.includes(pinnedId), 'pinned chat is never cleared');
  assert.ok(!ids.includes(taskId), 'the terminal non-pinned Work row is cleared from the display index');
  const gone = await env.request('GET', '/v1/product/sessions/' + taskId);
  assert.equal(gone.status, 404, 'the cleared Work session is hidden from the product index');
  assert.ok(env.backend.services.kernel.getTask(taskId), 'the Kernel task audit record stays after clearHistory');
  assert.equal(env.backend.services.kernel.getMessages(taskId).length, settledMessages, 'Kernel messages stay after clearHistory');
  assert.equal(harness(env).store.listRequests({ limit: 200 }).requests.length, auditBefore, 'Inspector request audit rows stay after clearing the display index');
  assert.ok(existsSync(projectFile), 'clearHistory must never delete user project files');
  assert.equal((await env.request('GET', '/v1/product/settings')).status, 200, 'Settings stay readable after clearHistory');
});

test('request-scope prompt override applies once together with a disabled skill and never rewrites old records', { timeout: 150_000 }, async t => {
  const GLOBAL_MARKER = 'CHAT_GLOBAL_DIRECTIVE_MARKER_77ab';
  const SKILL_BODY = 'CHAT_SKILL_BODY_MARKER_31ce. Only an enabled skill may reach this Chat request.';
  const SKILL_NAME = 'chat-override-marker-skill';
  const OVERRIDE = 'REQUEST_OVERRIDE_MARKER_5b2d only this next request may see it.';
  const env = await setup({
    configure: (owned) => {
      const dataDir = path.join(owned, 'data');
      mkdirSync(dataDir, { recursive: true });
      const skillRoot = path.join(owned, 'skills');
      mkdirSync(path.join(skillRoot, 'chat-override-marker'), { recursive: true });
      writeFileSync(path.join(skillRoot, 'chat-override-marker', 'SKILL.md'), [
        '---',
        'name: ' + SKILL_NAME,
        'description: workbench marker chat override skill',
        '---',
        SKILL_BODY,
      ].join('\n'), 'utf8');
      const globalPath = path.join(owned, 'global.md');
      writeFileSync(globalPath, GLOBAL_MARKER + '. Global instructions stay independent from skill switches.', 'utf8');
      writeFileSync(path.join(dataDir, 'configuration.json'), JSON.stringify({
        provider: { mode: 'mock', model: 'mock' }, globalPaths: [globalPath], skillRoots: [skillRoot],
      }), 'utf8');
    },
  });
  t.after(() => env.close());

  const created = await env.request('POST', '/v1/harness/sessions', {
    title: 'Override chat', profileId: 'default', workspace: env.workspace,
    capabilities: { skills: true, projectInstructions: true },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const sessionId = created.body.id as string;

  const sendChat = async (text: string) => {
    const previous = harness(env).store.latestRequest(sessionId, 'chat');
    const sent = await env.request('POST', '/v1/product/chat/send', { sessionId, mode: 'chat', text, attachments: [], permission: 'read-only', modelId: 'default' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    return waitSettledRequest(env, sessionId, 'chat', previous?.id, 'the Chat request settles');
  };
  const wireFor = (text: string): any | undefined =>
    env.wire.find(body => (body.messages ?? []).some((message: any) => message.role === 'user' && String(message.content).includes(text)));

  const skills = await env.request('GET', '/v1/product/settings/skills');
  const skill = (skills.body as any[]).find(item => item.name === SKILL_NAME);
  assert.ok(skill, 'the chat skill is discovered');

  const baseline = await sendChat('workbench marker baseline settings turn');
  const baselineWire = wireFor('workbench marker baseline settings turn');
  assert.ok(baselineWire, 'the positive-control request reached the provider');
  const baselineText = JSON.stringify(baselineWire.messages);
  assert.ok(baselineText.includes(SKILL_BODY), 'the enabled skill is a real part of the positive-control Chat body');
  assert.ok(baselineText.includes(SKILL_NAME));
  assert.ok(baselineText.includes(GLOBAL_MARKER));

  const recordId = baseline.id as string;
  const rawBefore = (await env.request('GET', '/v1/harness/requests/' + recordId)).body;
  const viewListBefore = (await env.request('GET', '/v1/product/inspector/requests?sessionId=' + encodeURIComponent(sessionId))).body as any[];
  const viewBefore = viewListBefore.find(item => item.id === recordId);
  assert.ok(viewBefore, 'the old request is visible through the Inspector route');
  const hashBefore = sha256(JSON.stringify({ body: rawBefore.body, bodyHash: rawBefore.bodyHash, sources: rawBefore.sources }));

  const disabled = await env.request('POST', '/v1/product/settings/skills/' + encodeURIComponent(skill.id) + '/toggle', { enabled: false });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));

  const saved = await env.request('POST', '/v1/product/inspector/prompt', { sessionId, partId: 'request:systemPrompt', content: OVERRIDE, scope: 'request' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.pendingEdits, 1, 'the request-scope override is visible as one pending edit');
  assert.equal(harness(env).store.pendingRequestOverrides(sessionId).length, 1);

  const overridden = await sendChat('workbench marker overridden settings turn');
  const overriddenWire = wireFor('workbench marker overridden settings turn');
  assert.ok(overriddenWire, 'the overridden request reached the provider');
  const overriddenText = JSON.stringify(overriddenWire.messages);
  assert.ok(overriddenText.includes(OVERRIDE), 'the request-scope override text reaches the next real Chat body');
  assert.ok(!overriddenText.includes(SKILL_BODY), 'the Settings-disabled skill is absent from that same request');
  assert.ok(!overriddenText.includes(SKILL_NAME), 'the disabled skill name is absent from that same request');
  assert.ok(overriddenText.includes(GLOBAL_MARKER), 'global instructions still apply alongside the override');
  const overriddenSources = (overridden.sources ?? []) as any[];
  assert.ok(overriddenSources.some(source => source.id === 'request:systemPrompt'), 'the request override is recorded as a source');
  assert.ok(!overriddenSources.some(source => String(source.source).includes('SKILL.md')), 'the disabled skill is not recorded as a source');
  assert.equal(harness(env).store.pendingRequestOverrides(sessionId).length, 0, 'the override was consumed exactly once');
  const promptAfter = await env.request('GET', '/v1/product/inspector/prompt?sessionId=' + encodeURIComponent(sessionId));
  assert.equal(promptAfter.status, 200);
  assert.equal(promptAfter.body.pendingEdits, 0, 'Inspector reports no pending request edit after the send');

  const after = await sendChat('workbench marker after-override settings turn');
  const afterWire = wireFor('workbench marker after-override settings turn');
  assert.ok(afterWire, 'the third request reached the provider');
  assert.ok(!JSON.stringify(afterWire.messages).includes(OVERRIDE), 'the one-shot override is not replayed on the following request');
  assert.ok(!((after.sources ?? []) as any[]).some(source => source.id === 'request:systemPrompt'));

  const rawAfter = (await env.request('GET', '/v1/harness/requests/' + recordId)).body;
  assert.deepEqual(rawAfter, rawBefore, 'an older RequestRecord is byte-for-byte unchanged by later overrides and toggles');
  const viewListAfter = (await env.request('GET', '/v1/product/inspector/requests?sessionId=' + encodeURIComponent(sessionId))).body as any[];
  assert.deepEqual(viewListAfter.find(item => item.id === recordId), viewBefore, 'the Inspector projection of the old record is unchanged field by field');
  assert.equal(sha256(JSON.stringify({ body: rawAfter.body, bodyHash: rawAfter.bodyHash, sources: rawAfter.sources })), hashBefore,
    'the old body and source hashes are unchanged');
});

const MCP_SCRIPT = [
  "import { createInterface } from 'node:readline';",
  "const send = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));",
  "createInterface({ input: process.stdin }).on('line', line => {",
  "  const request = JSON.parse(line);",
  "  if (request.id === undefined) return;",
  "  const reply = result => send({ jsonrpc: '2.0', id: request.id, result });",
  "  if (request.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'rollback-mcp', version: '1.0.0' } });",
  "  if (request.method === 'tools/list') return reply({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] });",
  "  if (request.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'ok' }] });",
  "});",
].join('\n');

test('a failed Settings write restores every section and never re-authorizes invalidated approvals', { timeout: 240_000 }, async t => {
  const env = await setup({
    responder: body => {
      if (systemText(body).includes('REVIEWER ROLE'))
        return { content: JSON.stringify({ verdict: 'pass', reason: 'The approved rollback write receipt is present.', findings: [] }) };
      const toolResults = (body.messages ?? []).filter((message: any) => message.role === 'tool');
      if (!toolResults.some((message: any) => message.tool_call_id === 'rollback-read'))
        return { content: '', toolCalls: [{ id: 'rollback-read', name: 'read_file', arguments: { path: 'rollback-note.txt' } }] };
      if (!toolResults.some((message: any) => message.tool_call_id === 'rollback-write')) {
        return { content: '', toolCalls: [{ id: 'rollback-write', name: 'write_file', arguments: { path: 'rollback-note.txt', content: 'ROLLBACK_NOTE\n' } }] };
      }
      return { content: 'The approved rollback note exists.' };
    },
  });
  t.after(() => env.close());
  const projectId = await projectFor(env);

  const seeded = await env.request('POST', '/v1/product/settings/update', {
    appearance: { theme: 'dark', accent: 'jade', density: 'comfortable' },
    defaults: { mode: 'code', permission: 'full-access', modelId: 'default', sendKey: 'mod-enter' },
    autoReview: { explain: true },
    rules: [{ id: 'rule-allow-md', pattern: '**/*.md', capability: 'read', decision: 'allow' }],
    privacy: { recordContent: false },
    network: { webSearch: false, fetch: false },
  });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));

  // A later successful update deletes the allow rule; this becomes the rollback baseline.
  const baseline = await env.request('POST', '/v1/product/settings/update', { rules: [], privacy: { recordContent: true } });
  assert.equal(baseline.status, 200, JSON.stringify(baseline.body));
  const beforeFailure = await env.request('GET', '/v1/product/settings');
  assert.deepEqual(beforeFailure.body.rules, [], 'the allow rule was really deleted before the failing update');
  const baselineBody = beforeFailure.body;

  // MCP: an approval exists, then the launch artifact changes and invalidates it.
  const serverPath = path.join(env.owned, 'rollback-mcp.mjs');
  writeFileSync(serverPath, MCP_SCRIPT, 'utf8');
  // The launch boundary only accepts a regular project-local command file; a hardlink gives the
  // fixture its own project-local path without copying the Node runtime.
  const localRuntime = path.join(env.owned, 'node.exe');
  linkSync(process.execPath, localRuntime);
  const target = '"' + localRuntime + '" "' + serverPath + '"';
  const savedServer = await env.request('POST', '/v1/product/settings/mcp/save', { name: 'Rollback fixture', transport: 'stdio', target, enabled: true });
  assert.equal(savedServer.status, 200, JSON.stringify(savedServer.body));
  assert.equal(savedServer.body.status, 'disconnected');
  const digestOne = savedServer.body.digest as string;
  assert.match(digestOne, /^[a-f0-9]{64}$/);
  const approvedServer = await env.request('POST', '/v1/product/settings/mcp/save', {
    id: savedServer.body.id, name: 'Rollback fixture', transport: 'stdio', target, enabled: true, approvedDigest: digestOne,
  });
  assert.equal(approvedServer.status, 200, JSON.stringify(approvedServer.body));
  assert.equal(approvedServer.body.status, 'connected');
  assert.ok(approvedServer.body.tools >= 1);
  writeFileSync(serverPath, MCP_SCRIPT + '\n// launch artifact changed after the digest was approved\n', 'utf8');
  const invalidated = await env.request('POST', '/v1/product/settings/mcp/' + approvedServer.body.id + '/reconnect');
  assert.equal(invalidated.status, 200, JSON.stringify(invalidated.body));
  assert.notEqual(invalidated.body.status, 'connected', 'an invalidated digest approval must not report a connected server');
  assert.match(invalidated.body.error ?? '', /approv/i);
  const digestTwo = invalidated.body.digest as string;
  assert.match(digestTwo, /^[a-f0-9]{64}$/);
  assert.notEqual(digestTwo, digestOne, 'the changed launch artifact really produced a new digest');

  // Task one: approve the write for the session, so a session grant exists before the policy change.
  const taskOne = await sendWork(env, projectId, 'write the first rollback note');
  await waitTaskStatus(env, taskOne, ['waiting_approval'], 'the first rollback task waits for approval');
  const approvalOne = (await env.request('GET', '/v1/product/approvals?sessionId=' + taskOne)).body as any[];
  assert.equal(approvalOne.length, 1);
  const granted = await env.request('POST', '/v1/product/approvals/decide', { approvalId: approvalOne[0].id, approved: true, scope: 'session' });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  await waitTaskStatus(env, taskOne, ['completed'], 'the first rollback task completes');
  assert.equal(env.backend.services.kernel.sessionGrants(taskOne).length, 1, 'the session-scope approval created one active grant');

  // Task two: stays prepared and paused; the failing policy change must invalidate it for good.
  const taskTwo = await sendWork(env, projectId, 'write the second rollback note');
  await waitTaskStatus(env, taskTwo, ['waiting_approval'], 'the second rollback task waits for approval');
  const approvalTwo = (await env.request('GET', '/v1/product/approvals?sessionId=' + taskTwo)).body as any[];
  assert.equal(approvalTwo.length, 1);
  const readVersion = env.backend.services.kernel.getReadVersion(taskTwo, path.join(env.workspace, 'rollback-note.txt'));
  assert.ok(readVersion?.sourceIntentId, 'The second task read the existing file through the actual worker');
  assert.equal(readVersion.sha256, sha256('ROLLBACK_NOTE\n'));
  assert.equal(env.backend.services.kernel.getIntent(readVersion.sourceIntentId)!.state, 'applied');
  const paused = await env.request('POST', '/v1/product/tasks/' + taskTwo + '/control', { action: 'pause' });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.status, 'paused');

  const webSettings = path.join(env.dataDir, 'web-settings.json');
  assert.ok(existsSync(webSettings), 'the seeded network section persisted its real settings file');
  chmodSync(webSettings, 0o444);
  let failingBody: any;
  try {
    const failing = await env.request('POST', '/v1/product/settings/update', {
      appearance: { theme: 'light', accent: 'ember' },
      defaults: { mode: 'chat', sendKey: 'enter' },
      autoReview: { explain: false },
      rules: [{ id: 'rule-restored-by-patch', pattern: '**/*.md', capability: 'read', decision: 'allow' }],
      privacy: { recordContent: false },
      network: { webSearch: true },
    });
    assert.equal(failing.status, 500, 'a refused local settings write is a server-side failure: ' + JSON.stringify(failing.body));
    failingBody = failing.body;
    assert.equal(typeof failingBody.error, 'string');
    assert.ok(!/rollback was incomplete/i.test(failingBody.error), 'a write that never applied must not be reported as an incomplete rollback');
    assert.match(failingBody.error, /(EPERM|operation not permitted)/i, 'the 500 keeps the real local storage cause instead of masking it');
  } finally {
    chmodSync(webSettings, 0o666);
  }

  const restored = await env.request('GET', '/v1/product/settings');
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body, baselineBody, 'appearance, defaults, autoReview, rules, privacy and network all return to the pre-failure values');
  assert.deepEqual(restored.body.rules, [], 'the previously deleted allow rule is not resurrected by the rollback');
  assert.equal(restored.body.privacy.recordContent, true, 'the pre-failure privacy value is restored exactly');
  assert.equal(restored.body.appearance.theme, 'dark');
  assert.equal(restored.body.defaults.mode, 'code');
  assert.deepEqual(restored.body.network, { webSearch: false, fetch: false, proxy: '' });

  // Invalidated approvals must stay invalid: rollback restores settings, never stale authority.
  const deniedIntent = env.backend.services.kernel.getIntent(approvalTwo[0].id);
  assert.ok(deniedIntent, 'the supervised intent still exists');
  assert.equal(deniedIntent.state, 'denied', 'the policy change refused the pending write and the rollback did not re-authorize it');
  const pendingAfter = await env.request('GET', '/v1/product/approvals?sessionId=' + taskTwo);
  assert.deepEqual(pendingAfter.body, [], 'no approval comes back after the rollback');
  const toolsAfter = await env.request('GET', '/v1/product/inspector/tools?sessionId=' + taskTwo);
  const deniedCall = (toolsAfter.body.calls as any[]).find(call => call.name === 'write_file');
  assert.ok(deniedCall, 'the refused write is still visible in the Inspector tool inventory');
  assert.equal(deniedCall.status, 'denied', 'the Inspector approval state stays denied');
  assert.equal(env.backend.services.kernel.sessionGrants(taskOne).length, 0, 'the revoked session grant was not re-authorized by the rollback');
  assert.ok(env.backend.services.kernel.sessionGrants(taskOne, true).length >= 1, 'the revoked grant record is retained for audit');
  assert.equal(env.backend.services.kernel.getTask(taskTwo)!.status, 'paused');

  const mcpAfter = await env.request('GET', '/v1/product/settings/mcp');
  const serverAfter = (mcpAfter.body as any[]).find(item => item.id === approvedServer.body.id);
  assert.ok(serverAfter, 'the MCP server record survives the failed Settings update');
  assert.notEqual(serverAfter.status, 'connected', 'the invalidated MCP digest approval is not restored');
  assert.equal(serverAfter.digest, digestTwo);
  assert.match(serverAfter.error ?? '', /approv/i);
});
