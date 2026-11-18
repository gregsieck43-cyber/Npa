import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { startBackend } from '../src/app/backend.js';
import { resourceBudget } from '../src/app/resource-budget.js';
import { loadInstructions } from '../src/runtime/instructions.js';
import { skillTool } from '../src/runtime/skill-tools.js';
import type { MockCompletion } from '../src/fixtures/mock-provider.js';

const ROOT = path.resolve('.tmp/skills-discovery-20261104/tests');
const QUERY = '请整理刚拿到的表格，使日期格式保持一致。';
const BODY = 'UNREQUESTED_SKILL_BODY_MUST_NOT_BE_INJECTED';

type SkillBackend = Awaited<ReturnType<typeof startBackend>>;
type SkillDiagnostic = ReturnType<typeof skillDiagnostic>;
function skillDiagnostic(t: TestContext) {
  const started = performance.now(), delay = monitorEventLoopDelay({ resolution: 20 });
  const phases: Record<string, unknown>[] = [];
  let owned: string | undefined, backend: SkillBackend | undefined, taskId: string | undefined, sessionId: string | undefined;
  let failed = false, passed = false, closing = false, backendClosed = false, firstError: unknown, snapshot: unknown;
  let dropped = 0, diagnosticErrors = 0, wireCount = 0, waitStarted = 0;
  const token = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : undefined;
  const skillCode = (value: unknown) => typeof value === 'string' ? value.match(/^(SKILL_[A-Z_]+|SKILLS_DISABLED)(?::|$)/)?.[1] : undefined;
  const errorFields = (error: unknown) => {
    const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined;
    return { name: token(value?.name), code: token(value?.code), causeCode: token(value?.cause?.code) };
  };
  const log = (value: unknown) => { try { t.diagnostic(JSON.stringify(value)); } catch { diagnosticErrors++; } };
  const mark = (phase: string, details: Record<string, unknown> = {}) => {
    if (phases.length === 128) { dropped++; return; }
    phases.push({ phase, at: new Date().toISOString(), elapsedMs: performance.now() - started, ...details });
  };
  const capture = () => {
    try {
      const kernel = backend?.services.kernel, store = backend?.services.harness?.store;
      const task = taskId ? kernel?.getTask(taskId) : undefined;
      const events = taskId ? kernel?.events(taskId, 0, 256) ?? [] : [];
      const requests = taskId || sessionId ? store?.listRequests({ taskId, sessionId, limit: 32 }) : undefined;
      const resources = resourceBudget.status();
      snapshot = { at: new Date().toISOString(), task: task && { id: task.id, status: task.status, executionPhase: task.executionPhase,
        revision: task.revision, generation: task.generation, modelCalls: task.modelCalls, hasError: !!task.error, hasWaitingReason: !!task.waitingReason },
        eventsAtLimit: events.length === 256, events: events.map(event => {
          const patch = event.payload.patch as Record<string, unknown> | undefined;
          return { seq: event.seq, type: token(event.type), createdAt: event.createdAt, requestId: token(event.payload.requestId),
            toolCallId: token(event.payload.toolCallId), code: token(event.payload.code), status: token(event.payload.status ?? patch?.status),
            failureStage: token(patch?.failureStage), skillCode: skillCode(patch?.error) };
        }),
        requestsAtLimit: requests?.nextCursor != null, requests: requests?.requests.map(request => ({ id: request.id, kind: request.kind,
          status: request.status, createdAt: request.createdAt, startedAt: request.startedAt, updatedAt: request.updatedAt,
          durationMs: request.durationMs, errorCode: token(request.error?.code) })),
        resources: { pressure: resources.pressure,
          activeLeases: 'activeLeases' in resources ? resources.activeLeases : undefined,
          waitingLeases: 'waitingLeases' in resources ? resources.waitingLeases : undefined, monitoring: resources.monitoring } };
    } catch (error) { diagnosticErrors++; snapshot = { unavailable: errorFields(error) }; }
  };
  const save = () => {
    if (!failed || !owned) return;
    try {
      if (path.dirname(owned) !== ROOT || lstatSync(ROOT).isSymbolicLink() || lstatSync(owned).isSymbolicLink()) throw new Error('Diagnostic fixture ownership changed');
      writeFileSync(path.join(owned, 'skills-failure.json'), JSON.stringify({ fixture: owned, firstError, phases, dropped, diagnosticErrors,
        taskId, sessionId, backendClosed, snapshot }, null, 2) + '\n');
      log({ fixture: owned, fixturePresent: existsSync(owned), diagnosticWritten: true, diagnostic: path.join(owned, 'skills-failure.json') });
    } catch (error) { diagnosticErrors++; log({ fixture: owned, fixturePresent: existsSync(owned), diagnosticWritten: false, diagnosticWriteError: errorFields(error) }); }
  };
  const failure = (error: unknown) => {
    if (!failed) { firstError = errorFields(error); failed = true; if (!closing) capture(); else snapshot = { unavailable: 'failure-during-cleanup' }; }
    mark('failure', { error: errorFields(error) }); save();
  };
  return {
    mark, failure,
    fixture(value: string) { owned = value; mark('fixture.created'); },
    ready(value: SkillBackend) { backend = value; mark('backend.ready'); },
    task(value: string | undefined, status: string) { taskId = value; mark('command.ack', { taskId, status: token(status) }); },
    session(value: string) { sessionId = value; },
    passed() { passed = true; },
    wire(body: any) {
      try {
        const tools = body.messages.filter((message: any) => message.role === 'tool');
        mark('provider.request.received', { index: ++wireCount, messages: body.messages.length, toolsTruncated: tools.length > 12,
          tools: tools.slice(-12).map((message: any) => {
            let value: any; try { value = JSON.parse(message.content); } catch { return { parsed: false }; }
            return { parsed: true, toolCallId: token(message.tool_call_id), skillCount: Array.isArray(value?.skills) ? value.skills.length : undefined,
              hasError: typeof value?.error === 'string', skillCode: skillCode(value?.error) };
          }) });
      } catch { diagnosticErrors++; }
    },
    waitBegin() { waitStarted = performance.now(); delay.enable(); delay.reset(); mark('wait.begin'); },
    waitEnd(deadline: number) { delay.disable(); mark('wait.end', { waitMs: performance.now() - waitStarted,
      deadlineOverrunMs: Math.max(0, Date.now() - deadline), maxEventLoopDelayMs: delay.max / 1e6 }); },
    async close(value: SkillBackend | undefined, finishFixture: (retain: boolean) => void) {
      if ((!passed || t.signal.aborted) && !failed) failure(t.signal.reason);
      const primaryFailed = failed; closing = true; mark('backend.close.begin');
      try {
        await value?.close(); backendClosed = value !== undefined; mark('backend.close.end');
        finishFixture(failed); mark(failed ? 'fixture.retained' : 'fixture.removed');
      } catch (error) { failure(error); if (!primaryFailed) throw error; }
      finally { delay.disable(); save(); }
    },
  };
}

async function fixture(t: TestContext, responder?: (body: any) => MockCompletion, diagnostic?: SkillDiagnostic) {
  mkdirSync(ROOT, { recursive: true });
  const owned = mkdtempSync(path.join(ROOT, 'wire-')), workspace = path.join(owned, 'workspace'), skills = path.join(owned, 'skills');
  diagnostic?.fixture(owned);
  mkdirSync(workspace); mkdirSync(path.join(skills, 'table-hygiene'), { recursive: true });
  writeFileSync(path.join(skills, 'table-hygiene', 'SKILL.md'), `---\nname: table-hygiene\ndescription: spreadsheet normalization and date consistency\n---\n${BODY}`);
  const wire: any[] = [];
  const start = async () => {
    diagnostic?.mark('backend.start');
    const value = await startBackend({ dataDir: path.join(owned, 'data'), projectRoot: process.cwd(), mockOptions: {
      trace: body => { wire.push(body); diagnostic?.wire(body); }, responder: responder ?? (() => ({ content: 'Local fixture response.' })),
    } });
    diagnostic?.ready(value); return value;
  };
  let backend: SkillBackend;
  const finishFixture = (retain = false) => {
    assert.equal(path.dirname(owned), ROOT); if (!retain) rmSync(owned, { recursive: true, force: true });
  };
  if (diagnostic) t.after(async () => { await diagnostic.close(backend, finishFixture); });
  backend = await start();
  backend.services.configuration.set({ skillRoots: [skills] });
  if (!diagnostic) t.after(async () => { await backend.close(); finishFixture(); });
  return { get backend() { return backend; }, workspace, skills, wire,
    restart: async () => { diagnostic?.mark('restart.close.begin'); await backend.close(); diagnostic?.mark('restart.close.end'); backend = await start(); } };
}

for (const mode of ['chat', 'work'] as const) {
  test(`actual ${mode} tools keep persisted disabled skills unreadable after backend restart`, async t => {
    const diagnostic = skillDiagnostic(t);
    try {
      let previous: Record<string, unknown>, catalog: any, denied: string | undefined;
      const f = await fixture(t, body => {
        if (body.messages.some((message: any) => message.role === 'system' && String(message.content).includes('REVIEWER ROLE'))) {
          return { content: JSON.stringify({ verdict: 'pass', reason: 'Disabled procedure stayed unreadable', findings: [] }) };
        }
        for (const message of body.messages.filter((message: any) => message.role === 'tool')) {
          let value: any; try { value = JSON.parse(message.content); } catch { continue; }
          if (Array.isArray(value?.skills)) catalog = value;
          if (typeof value?.error === 'string') denied = value.error;
        }
        if (denied) return { content: 'The procedure is disabled.' };
        if (catalog) return { content: '', toolCalls: [{ id: 'old-skill-read', name: 'read_skill', arguments: previous }] };
        return { content: '', toolCalls: [{ id: 'disabled-skill-list', name: 'list_skills', arguments: {} }] };
      }, diagnostic);
      const listed = JSON.parse(await skillTool({ workspace: f.workspace, skillRoots: [f.skills] }, { name: 'list_skills', arguments: {} }));
      previous = { id: listed.skills[0].id, sha256: listed.skills[0].sha256, scope: listed.scope };
      await f.backend.services.instructionSettings.toggleSkill(listed.skills[0].id, false, { skillRoots: [f.skills] });
      await f.restart();
      assert.deepEqual(f.backend.services.configuration.skillRoots, [f.skills]);
      assert.deepEqual(f.backend.services.instructionSettings.disabledSkillIds(), [listed.skills[0].id]);
      if (mode === 'chat') {
        const harness = f.backend.services.harness!;
        const session = harness.store.createSession({ workspace: f.workspace,
          capabilities: { web: false, tools: false, mcp: false, skills: true, projectInstructions: false } });
        diagnostic.session(session.id);
        await harness.chat.send({ sessionId: session.id, content: QUERY });
      } else {
        const ack = f.backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: QUERY, workspace: f.workspace, permissionMode: 'read-only',
          goal: { objective: QUERY, maxModelCalls: 6, maxToolCalls: 5 } } });
        diagnostic.task(ack.taskId, ack.status);
      }
      await until(() => !!denied, 'a stale skill read must fail in the actual tool loop after restart', diagnostic);
      assert.deepEqual(catalog.skills, []); assert.notEqual(catalog.scope, listed.scope);
      assert.match(denied!, /SKILL_SCOPE_STALE/);
      assert.equal(JSON.stringify(f.wire).includes(BODY), false);
      diagnostic.passed();
    } catch (error) { diagnostic.failure(error); throw error; }
  });
}

test('Chat skills-off persists after restart, hides both tools and denies a provider-supplied invocation', async t => {
  let denied: string | undefined;
  const f = await fixture(t, body => {
    for (const message of body.messages.filter((message: any) => message.role === 'tool')) {
      let value: any; try { value = JSON.parse(message.content); } catch { continue; }
      if (typeof value?.error === 'string') denied = value.error;
    }
    return denied ? { content: 'Skills remain off.' } : { content: '', toolCalls: [{ id: 'unexposed-skill-list', name: 'list_skills', arguments: {} }] };
  });
  const session = f.backend.services.harness!.store.createSession({ workspace: f.workspace,
    capabilities: { web: false, tools: false, mcp: false, skills: false, projectInstructions: false } });
  await f.restart();
  assert.equal(f.backend.services.harness!.store.getSession(session.id).capabilities.skills, false);
  await f.backend.services.harness!.chat.send({ sessionId: session.id, content: QUERY });
  await until(() => !!denied, 'unexposed skill invocation must return a permission error');
  assert.match(denied!, /enabled.*exposed/);
  for (const request of f.wire) {
    const names: string[] = request.tools?.map((tool: any) => tool.function.name) ?? [];
    assert.equal(names.includes('list_skills'), false); assert.equal(names.includes('read_skill'), false);
  }
  assert.equal(JSON.stringify(f.wire).includes(BODY), false);
});

for (const mode of ['chat', 'work'] as const) {
  test(`actual ${mode} model tools discover a non-keyword skill and read its exact version into the next wire request`, async t => {
    let catalog: any, read: any;
    const f = await fixture(t, body => {
      if (body.messages.some((message: any) => message.role === 'system' && String(message.content).includes('REVIEWER ROLE'))) {
        return { content: JSON.stringify({ verdict: 'pass', reason: 'Read-only workflow fixture completed', findings: [] }) };
      }
      for (const message of body.messages.filter((message: any) => message.role === 'tool')) {
        let value: any; try { value = JSON.parse(message.content); } catch { continue; }
        if (Array.isArray(value?.skills)) catalog = value;
        if (typeof value?.content === 'string' && value.guidanceOnly === true) read = value;
      }
      if (read) return { content: 'Consulted the scoped procedure.' };
      if (catalog?.skills?.length) {
        const selected = catalog.skills[0];
        return { content: '', toolCalls: [{ id: 'skill-read', name: 'read_skill', arguments: { id: selected.id, sha256: selected.sha256, scope: catalog.scope, limit: 4000 } }] };
      }
      return { content: '', toolCalls: [{ id: 'skill-list', name: 'list_skills', arguments: { limit: 10 } }] };
    });
    if (mode === 'chat') {
      const harness = f.backend.services.harness!;
      const session = harness.store.createSession({ title: 'Read discovered skill', workspace: f.workspace,
        capabilities: { web: false, tools: false, mcp: false, skills: true, projectInstructions: false } });
      await harness.chat.send({ sessionId: session.id, content: QUERY });
    } else {
      f.backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: QUERY, workspace: f.workspace, permissionMode: 'read-only',
        goal: { objective: QUERY, maxModelCalls: 6, maxToolCalls: 5 } } });
    }
    await until(() => !!read, 'the real follow-up request must contain the read_skill result');
    assert.equal(catalog.skills.length, 1);
    assert.equal(read.id, catalog.skills[0].id); assert.equal(read.sha256, catalog.skills[0].sha256);
    assert.ok(read.content.includes(BODY));
    assert.equal(JSON.stringify(f.wire[0].messages).includes(BODY), false);
    assert.ok(f.wire.slice(1).some(request => request.messages.some((message: any) => message.role === 'tool' && String(message.content).includes(BODY))));
  });
}

async function until(predicate: () => boolean, label: string, diagnostic?: SkillDiagnostic) {
  const end = Date.now() + 10_000;
  diagnostic?.waitBegin();
  try {
    while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), label);
  } finally { diagnostic?.waitEnd(end); }
}

for (const mode of ['chat', 'work'] as const) {
  test(`actual ${mode} provider wire exposes on-demand skill discovery for a cross-language goal without injecting all bodies`, async t => {
    const f = await fixture(t);
    const loaded = await loadInstructions({ workspace: f.workspace, skillRoots: [f.skills], query: QUERY });
    assert.equal(loaded.skills.length, 1); assert.equal(loaded.skills[0]!.selected, false);
    assert.equal(loaded.text.includes(BODY), false, 'the keyword selector misses this cross-language goal');
    if (mode === 'chat') {
      const harness = f.backend.services.harness!;
      const session = harness.store.createSession({ title: 'Discover skills', workspace: f.workspace,
        capabilities: { web: false, tools: false, mcp: false, skills: true, projectInstructions: false } });
      await harness.chat.send({ sessionId: session.id, content: QUERY });
    } else {
      f.backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: QUERY, workspace: f.workspace, permissionMode: 'read-only',
        goal: { objective: QUERY, maxModelCalls: 2, maxToolCalls: 5 } } });
    }
    await until(() => f.wire.length > 0, 'the real loopback provider must receive a request');
    const request = f.wire[0], names: string[] = request.tools?.map((tool: any) => tool.function.name) ?? [];
    assert.equal(JSON.stringify(request.messages).includes(BODY), false);
    assert.ok(names.includes('list_skills'), 'the model needs a discoverable catalog tool despite the keyword miss');
    assert.ok(names.includes('read_skill'), 'the model needs a scoped, version-bound body reader');
  });
}
