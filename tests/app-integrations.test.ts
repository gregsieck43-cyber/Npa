import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBackend } from '../src/app/backend.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';

async function fixture(t: import('node:test').TestContext, mockOptions: MockProviderOptions = {}) {
    const owned = mkdtempSync(path.resolve('.tmp', 'app-integrations-'));
    const workspace = path.join(owned, 'workspace'); mkdirSync(workspace);
    const settings = { projectRoot: process.cwd(), dataDir: path.join(owned, 'data'), mockOptions };
    let backend = await startBackend(settings);
    t.after(async () => { await backend.close(); rmSync(owned, { recursive: true, force: true }); });
    const call = async (method: string, route: string, body?: unknown, status = 200): Promise<any> => {
        const response = await fetch(`http://127.0.0.1:${backend.port}${route}`, { method, headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
    };
    const until = async (read: () => Promise<any>, ready: (value: any) => boolean, timeoutMs = 45000) => {
        const deadline = Date.now() + timeoutMs; let value;
        do { value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
        assert.fail(`Integration did not settle: ${JSON.stringify(value)}`);
    };
    return { workspace, call, until, get backend() { return backend; }, async restart() { await backend.close(); backend = await startBackend(settings); } };
}

test('HTTP collaboration plan, evidence and shared todo retain original sources across restart', { timeout: 30000 }, async t => {
    const f = await fixture(t);
    await f.backend.services.runner.stop();
    const { taskId } = await f.call('POST', '/v1/commands', { commandId: randomUUID(), type: 'create_task', parameters: { workspace: f.workspace, objective: 'Traceable local collaboration', maxModelCalls: 8 } });
    await f.call('POST', '/v1/commands', { commandId: randomUUID(), type: 'pause', taskId });
    const prefix = `/v1/tasks/${taskId}/integrations`;
    const plan = { id: 'analysis-plan', title: 'Local evidence workflow', nodes: [
        { id: 'discover', title: 'Discover', objective: 'Discover traceable fixture evidence', paths: ['discover'], dependencies: [] },
        { id: 'review', title: 'Review', objective: 'Review fixture evidence', paths: ['review'], dependencies: ['discover'] },
    ] };
    const created = await f.call('POST', `${prefix}/plan`, plan);
    assert.equal(created.nodes.length, 2); assert.equal(created.nodes[0].status, 'paused');
    assert.equal(created.nodes[1].ready, false);
    assert.deepEqual((await f.call('POST', `${prefix}/plan`, plan)).nodes.map((node: any) => node.childTaskId), created.nodes.map((node: any) => node.childTaskId));
    const snapshot = await f.call('GET', `/v1/snapshot?taskId=${taskId}&compact=true`);
    const evidence = await f.call('POST', `${prefix}/evidence`, { kind: 'message', sourceTaskId: taskId, sourceId: snapshot.messages[0].id });
    const resource = await f.call('POST', `${prefix}/resources`, { path: 'discover/report.md', label: 'Local source' });
    const fact = await f.call('POST', `${prefix}/facts`, { resourceId: resource.id, kind: 'hypothesis', statement: 'Planning output still requires execution.', evidenceIds: [evidence.id] });
    const todo = { id: 'review-evidence', title: 'Review source', owner: 'operator', status: 'done', evidenceIds: [evidence.id], expectedRevision: 0 };
    assert.equal((await f.call('POST', `${prefix}/todos`, todo)).revision, 1);
    await f.call('POST', `${prefix}/todos`, todo, 400);
    assert.equal((await f.call('GET', prefix)).facts[0].id, fact.id);
    const processes = await f.call('GET', `${prefix}/processes?q=traceable&limit=2`);
    assert.ok(processes.results.length > 0);
    const source = processes.results[0];
    const original = await f.call('GET', `${prefix}/process?sourceTaskId=${source.taskId}&messageId=${source.sourceId}`);
    assert.ok(JSON.stringify(original).includes('traceable') || JSON.stringify(original).includes('Traceable'));
    await f.restart();
    const recovered = await f.call('GET', prefix);
    assert.equal(recovered.evidence[0].sha256, evidence.sha256);
    assert.equal(recovered.todos[0].revision, 1);
    assert.deepEqual(recovered.plan.nodes.map((node: any) => node.childTaskId), created.nodes.map((node: any) => node.childTaskId));
    const foreign = await f.call('POST', '/v1/commands', { commandId: randomUUID(), type: 'create_task', parameters: { title: 'Different scope' } });
    await f.call('GET', `/v1/tasks/${foreign.taskId}/integrations/process?sourceTaskId=${taskId}&messageId=${snapshot.messages[0].id}`, undefined, 400);
});

test('Work REA call uses real installed CLI only after exact approval and persists its Inspector receipt', { timeout: 100000 }, async t => {
    const wire: any[] = [];
    const f = await fixture(t, { trace: body => wire.push(body), responder: body => {
        if (body.messages.some((message: any) => message.role === 'system' && message.content.includes('REVIEWER ROLE'))) return { content: JSON.stringify({ verdict: 'pass', reason: 'Verify the independent analysis receipt.' }) };
        if (body.messages.some((message: any) => message.role === 'tool')) return { content: 'The approved local static analysis has a durable receipt.' };
        return { content: '', toolCalls: [{ id: 'rea-local-test', name: 'rea_analyze_local', arguments: { paths: ['package.json', 'main.js', 'preload.js'] } }] };
    } });
    const status = await f.call('GET', '/v1/integrations/status');
    if (!status.rea.available && process.env.NPN_REA_LIVE !== '1') { t.skip('Optional pinned REA dependency is not installed. Set NPN_REA_LIVE=1 to require this actual CLI test.'); return; }
    assert.equal(status.rea.available, true);
    assert.equal(status.rea.enabled, false);
    await f.call('POST', '/v1/integrations/rea', { enabled: true });
    writeFileSync(path.join(f.workspace, 'package.json'), JSON.stringify({ name: 'owned-inert-electron-sample', main: 'main.js', dependencies: { electron: '44.6.0' } }));
    writeFileSync(path.join(f.workspace, 'main.js'), "const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const window=new BrowserWindow({webPreferences:{preload:require('node:path').join(__dirname,'preload.js'),contextIsolation:true}});window.loadFile('index.html');});");
    writeFileSync(path.join(f.workspace, 'preload.js'), "const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('ownedFixture',{version:1});");
    const { taskId } = await f.call('POST', '/v1/commands', { commandId: randomUUID(), type: 'create_task', parameters: { workspace: f.workspace, objective: 'Analyze only the authorized inert JavaScript files with REA.', maxModelCalls: 5 } });
    const waiting = await f.until(() => f.call('GET', `/v1/snapshot?taskId=${taskId}&compact=true`), value => value.selectedTask.status === 'waiting_approval');
    const intent = waiting.intents[0];
    assert.equal(intent.name, 'rea_analyze_local'); assert.equal(intent.state, 'prepared');
    assert.equal((await f.backend.services.integrations.tools.queryOutcome(intent.effectKey)).status, 'unknown');
    await f.call('POST', '/v1/commands', { commandId: randomUUID(), type: 'grant', taskId, parameters: { intentId: intent.id, digest: intent.digest } });
    // The CLI has its own 60 s deadline; allow it to settle and surface its receipt before the HTTP assertion times out.
    const done = await f.until(() => f.call('GET', `/v1/snapshot?taskId=${taskId}&compact=true`), value => value.selectedTask.status === 'completed' || value.intents.some((item: any) => item.id === intent.id && item.state === 'failed'), 75000);
    const applied = done.intents.find((item: any) => item.id === intent.id);
    assert.equal(applied.state, 'applied'); assert.equal(applied.receipt.engine, 'rea-cli');
    const requestList = await f.call('GET', `/v1/harness/requests?taskId=${taskId}`);
    const actual = await f.call('GET', `/v1/harness/requests/${requestList.requests.at(-1).id}`);
    assert.ok(wire.some(body => body.tools?.some((tool: any) => tool.function.name === 'rea_analyze_local')));
    assert.ok(wire.some(body => body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'rea-local-test')));
    assert.ok(actual.runId);
    const inspector = await f.call('GET', `/v1/harness/tools?taskId=${taskId}`);
    assert.ok(inspector.calls.some((call: any) => call.name === 'rea_analyze_local' && call.status === 'completed'));
    const result = await f.call('GET', `/v1/tasks/${taskId}/integrations/results?effectKey=${intent.effectKey}&length=1000`);
    assert.equal(result.text.length, 1000); assert.ok(result.nextOffset);
    await f.call('POST', '/v1/integrations/rea', { enabled: false });
    await f.restart();
    assert.equal((await f.call('GET', '/v1/integrations/status')).rea.enabled, false);
    assert.equal((await f.call('GET', `/v1/tasks/${taskId}/integrations/results?effectKey=${intent.effectKey}&length=1000`)).sha256, result.sha256);
    assert.equal((await f.call('GET', `/v1/snapshot?taskId=${taskId}&compact=true`)).selectedTask.status, 'completed');
});
