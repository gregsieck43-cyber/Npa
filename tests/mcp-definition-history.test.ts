import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, linkSync, rmSync, existsSync, lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { startBackend } from '../src/app/backend.js';
import { dataDirectoryFailureDetails } from '../src/app/data-directory.js';
import { resourceBudget } from '../src/app/resource-budget.js';
import { digestValue } from '../src/tools/policy.js';

const diagnostics = new WeakMap<TestContext, ReturnType<typeof mcpDiagnostic>>();

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) { const result = read(); if (result !== undefined) return result; assert.ok(Date.now() < deadline, label); await wait(15); }
}
const definition = (version: string) => ({ name: 'lookup', description: 'Historical definition ' + version,
  inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: [version] } }, required: ['topic'] },
  annotations: { readOnlyHint: true, title: 'Lookup ' + version } });

async function fixture(t: import('node:test').TestContext, recordContent: boolean, businessError = false) {
  const owned = mkdtempSync(path.join(process.env.TEMP!, 'mcp-history-')), server = path.join(owned, 'server.mjs'), runtime = path.join(owned, 'node.exe');
  const diag = mcpDiagnostic(t, owned); let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  t.after(async () => diag.finish(async () => { if (backend) await diag.close(() => backend!.close()); }, () => {
    assert.equal(path.dirname(owned), path.resolve(process.env.TEMP!));
    if (!diag.retain) rmSync(owned, { recursive: true, force: true });
  }));
  linkSync(process.execPath, runtime); writeFileSync(path.join(owned, 'catalog.json'), JSON.stringify(definition('v1')));
  writeFileSync(server, `import { createInterface } from 'node:readline'; import { readFileSync, appendFileSync } from 'node:fs';
    createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;
      const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
      if(r.method==='initialize')return reply({protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'history',version:'1'}});
      if(r.method==='tools/list')return reply({tools:[JSON.parse(readFileSync('catalog.json','utf8'))]});
      if(r.method==='tools/call'){appendFileSync('calls','called\\n');return reply({content:[{type:'text',text:'observed-business-result'}],isError:${businessError}});}
    });`);
  const options = { projectRoot: process.cwd(), dataDir: path.join(owned, 'data'), mockOptions: { responder: (body: any) => {
    diag.model();
    if (body.messages.some((m: any) => m.role === 'system' && m.content.includes('REVIEWER ROLE'))) return { content: JSON.stringify({ verdict: 'pass', reason: 'fixture', findings: [] }) };
    if (body.messages.some((m: any) => m.role === 'tool')) return { content: 'Finished fixture read' };
    const name = body.tools?.some((tool: any) => tool.function.name === 'mcp_read') ? 'mcp_read' : 'mcp_call';
    return { content: '', toolCalls: [{ id: 'lookup-call', name, arguments: { serverId: 'history', toolName: 'lookup', arguments: { topic: 'private-argument-v1' } } }] };
  } } };
  backend = await diag.start(() => startBackend(options));
  backend.services.harness!.store.setSetting('recordContent', recordContent);
  const config = { id: 'history', name: 'History fixture', command: runtime, args: [server], cwd: owned };
  const pending = await diag.phase('mcp.digest', () => backend!.services.external.connect(config));
  await diag.phase('mcp.approved-connect', () => backend!.services.external.connect({ ...config, approvedDigest: pending.digest }));
  const start = async (mode: 'chat' | 'work') => {
    if (mode === 'chat') {
      const h = backend!.services.harness!, session = h.store.createSession({ capabilities: { mcp: true, web: false, tools: false, skills: false, projectInstructions: false } });
      diag.bind('chat', session.id);
      await h.chat.send({ sessionId: session.id, content: 'Read historical MCP definition' }); diag.ack('returned'); return session.id;
    }
    diag.bind('work');
    const created = backend!.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: 'MCP history',
      permission: { app: 'work', mode: 'full-access' }, goal: { objective: 'Read the MCP history fixture', constraints: [], acceptance: [], maxModelCalls: 4, maxToolCalls: 3, mode: 'collaborative' } } });
    diag.ack(created.status, created.taskId); return created.taskId!;
  };
  const observed = (id: string) => {
    const h = backend!.services.harness!; h.workTrace.sync();
    return h.store.toolCalls({ sessionId: id }).find(tool => tool.intentId && backend!.services.kernel.getIntent(tool.intentId)?.state === 'applied');
  };
  return { owned, diag, start, observed, serverDigest: pending.digest, get backend() { return backend!; },
    restart: async () => { await diag.close(() => backend!.close()); backend = await diag.start(() => startBackend(options)); await diag.phase('tools.ready', () => backend!.services.harness!.tools.ready); backend.services.harness!.workTrace.sync(); } };
}

for (const mode of ['chat', 'work'] as const) for (const recordContent of [true, false]) {
  test(`${mode} captures its actual MCP definition once, preserves historical catalog and honors recordContent=${recordContent}`, { timeout: 25000 }, async t => {
    await observedCase(t, async () => {
    const f = await fixture(t, recordContent), id = await f.start(mode);
    const observed = await f.diag.phase('wait.receipt', () => until(() => f.observed(id), 'actual MCP receipt'));
    const record = f.backend.services.harness!.store.getTool(observed.id) as any;
    const snapshot = record.mcpDefinition;
    assert.ok(snapshot, 'actual prepared inner tool definition must be recorded');
    assert.equal(snapshot.serverId, 'history'); assert.equal(snapshot.toolName, 'lookup');
    assert.equal(snapshot.digest, digestValue({ serverDigest: f.serverDigest, tool: definition('v1') }));
    assert.equal(snapshot.available, recordContent);
    if (recordContent) {
      assert.deepEqual(snapshot.inputSchema, definition('v1').inputSchema);
      assert.equal(snapshot.description, definition('v1').description); assert.deepEqual(snapshot.annotations, definition('v1').annotations);
    } else {
      assert.deepEqual(Object.keys(snapshot).sort(), ['available', 'digest', 'serverId', 'toolName']);
      assert.ok(!JSON.stringify(f.backend.services.kernel.events(record.taskId)).includes('Historical definition v1'), 'private dynamic metadata must not be persisted first in the Kernel event log');
    }
    assert.ok(!JSON.stringify(snapshot).includes('private-argument-v1'), 'definition snapshot never duplicates call arguments');
    const preserved = JSON.stringify(snapshot);
    f.backend.services.harness!.store.setSetting('recordContent', !recordContent);
    writeFileSync(path.join(f.owned, 'catalog.json'), JSON.stringify(definition('v2')));
    await f.diag.phase('mcp.refresh-catalog', () => f.backend.services.external.tools('history'));
    const current = f.backend.services.external.chatMcpCatalog('history').tools[0]!;
    assert.notEqual(current.digest, snapshot.digest);
    assert.equal(JSON.stringify((f.backend.services.harness!.store.getTool(record.id) as any).mcpDefinition), preserved);
    await f.diag.phase('mcp.disconnect', () => f.backend.services.external.disconnect('history')); await f.restart();
    assert.equal(JSON.stringify((f.backend.services.harness!.store.getTool(record.id) as any).mcpDefinition), preserved);
    assert.equal(readFileSync(path.join(f.owned, 'calls'), 'utf8').trim().split('\n').length, 1);
    });
  });
}

for (const mode of ['chat', 'work'] as const) {
  test(`${mode} preserves an applied MCP receipt but reports a legal isError result as business failure`, { timeout: 25000 }, async t => {
    await observedCase(t, async () => {
    const f = await fixture(t, true, true), id = await f.start(mode);
    const record = await f.diag.phase('wait.receipt', () => until(() => f.observed(id), 'observed MCP error result'));
    assert.equal(record.status, 'failed', 'legal isError must not look like completed success');
    const intent = f.backend.services.kernel.getIntent(record.intentId!)!;
    assert.equal(intent.state, 'applied'); assert.equal((intent.receipt!.result as any).isError, true);
    assert.equal(record.failureStage, 'execution'); assert.match(record.error ?? '', /MCP.*(?:error|isError)/i);
    const messages = mode === 'chat' ? f.backend.services.harness!.store.allMessages(id) : f.backend.services.kernel.tailMessages(id);
    const message = messages.find(message => message.role === 'tool' && message.toolCallId === 'lookup-call');
    assert.ok(message); assert.equal(JSON.parse(message.content).isError, true, 'the actual observed error result reaches the next model turn');
    await f.restart(); const recovered = f.backend.services.harness!.store.getTool(record.id);
    assert.equal(recovered.status, 'failed'); assert.equal(f.backend.services.kernel.getIntent(record.intentId!)!.state, 'applied');
    assert.equal(readFileSync(path.join(f.owned, 'calls'), 'utf8').trim().split('\n').length, 1);
    });
  });
}

async function observedCase(t: TestContext, action: () => Promise<void>): Promise<void> {
  try { await action(); diagnostics.get(t)?.pass(); }
  catch (error) { diagnostics.get(t)?.fail(error); throw error; }
}

/** Test-owned bounded metadata; normal cases do not write a diagnostic. No runtime hooks. */
function mcpDiagnostic(t: TestContext, owned: string) {
  const started = performance.now(), phases: Record<string, unknown>[] = [], delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined, mode: 'chat' | 'work' | undefined, sessionId: string | undefined;
  let failed = false, passed = false, closed = true, starting = false, dropped = 0, diagnosticErrors = 0, modelRequests = 0;
  let firstError: Record<string, unknown> | undefined, snapshot: Record<string, unknown> | undefined;
  const atom = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : undefined;
  const errorMeta = (error: unknown) => {
    const e = error as { name?: unknown; code?: unknown; kind?: unknown; cause?: { code?: unknown } } | null;
    return { name: atom(e?.name), code: atom(e?.code), kind: atom(e?.kind), causeCode: atom(e?.cause?.code), thrownType: typeof error,
      dataDirectoryFailure: dataDirectoryFailureDetails(error) };
  };
  const observe = (action: () => void) => { try { action(); } catch { diagnosticErrors++; } };
  const diagnostic = (value: unknown) => { try { t.diagnostic(JSON.stringify(value)); } catch { diagnosticErrors++; } };
  const mark = (phase: string, fields: Record<string, unknown> = {}) => observe(() => {
    if (phases.length >= 128) { dropped++; return; }
    phases.push({ phase, at: new Date().toISOString(), elapsedMs: performance.now() - started, ...fields });
  });
  const resources = () => { const s = resourceBudget.status(); return { pressure: s.pressure, monitoring: s.monitoring,
    activeLeases: 'activeLeases' in s ? s.activeLeases : undefined, waitingLeases: 'waitingLeases' in s ? s.waitingLeases : undefined }; };
  const boundary = (phase: string) => observe(() => mark(phase, { resources: resources() }));
  const plainFile = (file: string) => {
    const relative = path.relative(owned, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Outside fixture');
    for (let cursor = file; ; cursor = path.dirname(cursor)) {
      try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('Linked fixture path'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      if (cursor === owned) break;
    }
  };
  const bytes = (file: string, limit: number): Buffer | undefined => {
    plainFile(file);
    try { const info = statSync(file); if (!info.isFile() || info.size > limit) throw new Error('Metadata limit'); return readFileSync(file); }
    catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  function capture() {
    if (snapshot) return;
    snapshot = { at: new Date().toISOString() };
    observe(() => { snapshot!.resources = resources(); const marker = bytes(path.join(owned, 'calls'), 4096);
      snapshot!.calls = { exists: !!marker, bytes: marker?.length ?? 0, sha256: marker ? createHash('sha256').update(marker).digest('hex') : undefined }; });
    if (!backend || closed) { snapshot.storeUnavailable = true; return; }
    observe(() => {
      const { kernel, harness } = backend!.services, store = harness!.store;
      const optionalStore = store as unknown as {
        latestChatToolBinding?: (id: string) => { taskId: string } | undefined;
        workProjectionVersion?: (kind: 'task' | 'tool', id: string) => number;
      };
      const optionalKernel = kernel as unknown as {
        intentPage?: (id: string, after: number, limit: number) => { items: NonNullable<ReturnType<typeof kernel.getIntent>>[]; nextCursor: number | null };
      };
      const hasBinding = typeof optionalStore.latestChatToolBinding === 'function';
      const hasProjection = typeof optionalStore.workProjectionVersion === 'function';
      const hasIntents = typeof optionalKernel.intentPage === 'function';
      snapshot!.coverage = { chatTaskBinding: mode === 'work' ? 'not-required' : hasBinding ? 'available' : 'unavailable',
        taskProjectionCursor: hasProjection ? 'available' : 'unavailable', boundedIntents: hasIntents ? 'available' : 'unavailable' };
      const taskId = mode === 'work' ? sessionId : sessionId && hasBinding ? optionalStore.latestChatToolBinding!(sessionId)?.taskId : undefined;
      const task = taskId ? kernel.getTask(taskId) : undefined;
      snapshot!.sessionId = atom(sessionId); snapshot!.taskId = atom(taskId);
      snapshot!.task = task && { id: task.id, status: task.status, executionPhase: 'executionPhase' in task ? atom(task.executionPhase) : undefined, revision: task.revision, generation: task.generation, modelCalls: task.modelCalls, hasError: !!task.error };
      const requests = sessionId ? store.listRequests({ sessionId, limit: 32 }) : { requests: [], nextCursor: null };
      snapshot!.requests = requests.requests.map(r => ({ id: r.id, kind: r.kind, status: r.status, createdAt: r.createdAt, startedAt: r.startedAt, updatedAt: r.updatedAt, durationMs: r.durationMs, errorCode: atom(r.error?.code) }));
      const events = task ? kernel.events(task.id, 0, 256) : [];
      snapshot!.events = events.map(e => ({ seq: e.seq, type: atom(e.type), createdAt: e.createdAt, requestId: atom(e.payload.requestId), intentId: atom(e.payload.intentId), code: atom(e.payload.code) }));
      const tools = sessionId ? store.toolCalls({ sessionId, limit: 32 }) : [];
      snapshot!.tools = tools.map(tool => ({ id: tool.id, taskId: tool.taskId, intentId: tool.intentId, status: tool.status, failureStage: tool.failureStage, hasDefinition: !!tool.mcpDefinition }));
      const intents = task && hasIntents ? optionalKernel.intentPage!(task.id, 0, 32) : { items: [], nextCursor: null };
      snapshot!.intents = hasIntents ? intents.items.map(i => ({ id: i.id, name: i.name, state: i.state, hasReceipt: !!i.receipt, hasError: !!i.error })) : undefined;
      snapshot!.atLimit = requests.nextCursor !== null || events.length === 256 || tools.length === 32 || intents.nextCursor !== null;
      const projectionError = store.getSetting<{ cursor?: unknown; message?: unknown } | null>('workTraceError', null);
      snapshot!.projection = { kernelCursor: store.getSetting('kernelCursor', 0), taskCursor: task && hasProjection ? optionalStore.workProjectionVersion!('task', task.id) : undefined,
        errorPresent: !!projectionError, errorCursor: typeof projectionError?.cursor === 'number' ? projectionError.cursor : undefined,
        errorMessageSha256: typeof projectionError?.message === 'string' ? createHash('sha256').update(projectionError.message).digest('hex') : undefined };
      snapshot!.externalReceipts = hasIntents ? intents.items.filter(i => ['mcp_read', 'mcp_call'].includes(i.name)).map(intent => {
        const content = bytes(path.join(owned, 'data/external-receipts', digestValue(intent.effectKey) + '.json'), 262144);
        if (!content) return { intentId: intent.id, exists: false };
        const record = JSON.parse(content.toString('utf8'));
        return { intentId: intent.id, exists: true, status: atom(record.status), digest: atom(record.digest), appliedAt: record.receipt?.appliedAt, hasReceipt: !!record.receipt, errorCode: atom(record.diagnostic?.code) };
      }) : undefined;
    });
  }
  function save(stage: string) {
    let diagnosticWritten = false;
    try {
      plainFile(path.join(owned, 'mcp-history-failure.json'));
      writeFileSync(path.join(owned, 'mcp-history-failure.json'), JSON.stringify({ caseName: t.name, pid: process.pid, fixture: owned, stage, firstError, phases, snapshot,
        dropped, diagnosticErrors, modelRequests, backendClosed: closed, startOutcomeUnknown: starting, maxEventLoopDelayMs: delay.max / 1e6 }, null, 2) + '\n');
      diagnosticWritten = true;
    } catch (error) { diagnosticErrors++; diagnostic({ diagnosticError: errorMeta(error) }); }
    diagnostic({ fixture: owned, fixturePresent: existsSync(owned), diagnosticWritten, diagnosticErrors });
  }
  function fail(error: unknown) {
    if (failed) return;
    failed = true; firstError = errorMeta(error); mark('case.failure', firstError); capture(); save('before-close');
  }
  const diag = {
    get retain() { return failed || diagnosticErrors > 0 || starting; },
    fail, pass() { passed = true; }, model() { modelRequests++; mark('provider.request', { ordinal: modelRequests }); },
    bind(kind: 'chat' | 'work', id?: string) { mode = kind; sessionId = id; mark('command.begin', { mode, id: atom(id) }); },
    ack(status: unknown, id = sessionId) { sessionId = id; mark('command.ack', { mode, id: atom(id), status: atom(status) }); },
    async phase<T>(name: string, action: () => Promise<T>): Promise<T> {
      const began = performance.now(); mark(name + '.begin');
      try { const value = await action(); mark(name + '.end', { durationMs: performance.now() - began }); return value; }
      catch (error) { mark(name + '.error', { ...errorMeta(error), durationMs: performance.now() - began }); throw error; }
    },
    async start(action: () => Promise<Awaited<ReturnType<typeof startBackend>>>) {
      starting = true; closed = false; boundary('backend.start.begin');
      try { backend = await action(); starting = false; boundary('backend.start.end'); return backend; }
      catch (error) { fail(error); throw error; }
    },
    async close(action: () => Promise<void>) {
      boundary('backend.close.begin'); await action(); closed = !starting; boundary('backend.close.end');
    },
    async finish(close: () => Promise<void>, cleanup: () => void) {
      let secondary: unknown, hasSecondary = false;
      if (!passed && !failed) {
        failed = true;
        if (!firstError) {
          firstError = { category: 'test-incomplete', reasonUnavailable: true };
          observe(() => { firstError = { ...errorMeta(t.signal.reason), category: t.signal.aborted ? 'test-aborted' : 'test-incomplete' }; });
        }
        mark('case.incomplete', firstError); capture(); save('before-close-incomplete');
      }
      try { await close(); } catch (error) { if (failed) { diagnosticErrors++; mark('cleanup.secondary', errorMeta(error)); } else { fail(error); secondary = error; hasSecondary = true; } }
      try { cleanup(); } catch (error) { if (failed) { diagnosticErrors++; mark('cleanup.secondary', errorMeta(error)); } else { fail(error); secondary = error; hasSecondary = true; } }
      delay.disable();
      if (failed || diagnosticErrors) save('after-close');
      if (hasSecondary) throw secondary;
    },
  };
  diagnostics.set(t, diag); boundary('fixture.created'); return diag;
}
