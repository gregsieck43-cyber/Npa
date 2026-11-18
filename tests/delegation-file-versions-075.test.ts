import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kernel, KernelError } from '../src/kernel/index.js';
import { ToolGateway } from '../src/tools/gateway.js';
import { inspectEffects } from '../src/app/verification.js';

const root = path.resolve('.tmp/continuation-20261117-delegation'); mkdirSync(root, { recursive: true });
const code = (expected: string) => (error: unknown) => error instanceof KernelError && error.code === expected;
async function childResult(options: { rewriteSource?: boolean; missingInput?: boolean; mutateAfterEvidence?: 'source.txt' | 'result.txt' } = {}) {
    const directory = mkdtempSync(path.join(root, 'flow-'));
    let kernel = new Kernel(path.join(directory, 'data'));
    try {
        const parentId = kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: 'Accept versioned child result' } }).taskId!;
        kernel.command({ commandId: crypto.randomUUID(), taskId: parentId, type: 'delegate', parameters: { objective: 'Produce result from a source', acceptance: ['file:result.txt'] } });
        const child = kernel.getTask(kernel.delegations(parentId)[0]!.childTaskId)!; mkdirSync(child.workspace, { recursive: true });
        const run = kernel.createRun(child.id); kernel.transition(child.id, 'running');
        const gateway = new ToolGateway({ workspace: child.workspace, receiptDirectory: path.join(directory, 'receipts'), workerPath: fileURLToPath(new URL('../src/tools/worker.js', import.meta.url)), getReadVersion: target => kernel.getReadVersion(child.id, target) });
        const execute = async (name: 'read_file' | 'write_file', filename: string, content?: string) => {
            const prepared = await gateway.prepare({ name, arguments: { path: filename, ...(content === undefined ? {} : { content }) } });
            const intent = kernel.prepareIntent(child.id, run.id, { id: crypto.randomUUID(), name, arguments: prepared.arguments });
            kernel.approve(intent.id); kernel.dispatch(intent.id);
            const outcome = await gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
            assert.equal(outcome.status, 'applied', outcome.error); kernel.receipt(intent.id, outcome.receipt!);
        };
        if (!options.missingInput) writeFileSync(path.join(child.workspace, 'source.txt'), 'source v1');
        await execute('read_file', 'source.txt');
        if (options.rewriteSource) await execute('write_file', 'source.txt', 'legitimate source update');
        await execute('write_file', 'result.txt', 'verified result');
        const evidence = await inspectEffects(kernel.getTask(child.id)!, kernel.intents(child.id), gateway);
        assert.equal(evidence.passed, true, evidence.findings.join('; '));
        if (options.mutateAfterEvidence) writeFileSync(path.join(child.workspace, options.mutateAfterEvidence), 'changed during independent review');
        kernel.verify(child.id, run.id, { passed: true, reviewer: 'independent-test-reviewer', evidence });
        kernel.transition(child.id, 'completed', { result: 'Result is ready' }); kernel.finishRun(run.id, 'completed');
        return { get kernel() { return kernel; }, parentId, child, directory,
            reopen() { kernel.close(); kernel = new Kernel(path.join(directory, 'data')); },
            close() { kernel.close(); assert.ok(directory.startsWith(root + path.sep)); rmSync(directory, { recursive: true, force: true }); } };
    } catch (error) { kernel.close(); assert.ok(directory.startsWith(root + path.sep)); rmSync(directory, { recursive: true, force: true }); throw error; }
}

for (const filename of ['result.txt', 'source.txt']) test(`child acceptance refuses externally changed ${filename} after a real passing verification`, async () => {
    const f = await childResult();
    try {
        writeFileSync(path.join(f.child.workspace, filename), filename === 'result.txt' ? 'modified result' : 'source v2');
        assert.throws(() => f.kernel.command({ commandId: crypto.randomUUID(), taskId: f.parentId, type: 'accept_result', parameters: { childTaskId: f.child.id } }), code('STALE_VERIFICATION'));
        assert.equal(f.kernel.delegations(f.parentId)[0]!.state, 'assigned');
    } finally { f.close(); }
});

for (const filename of ['source.txt', 'result.txt'] as const) test(`a passing review cannot seal ${filename} changed during the review window`, async () => {
    await assert.rejects(childResult({ mutateAfterEvidence: filename }), code('STALE_VERIFICATION'));
});

test('unchanged child versions survive reopen and a task own output supersedes its earlier read baseline', async () => {
    const f = await childResult({ rewriteSource: true });
    try {
        f.reopen();
        const verification = f.kernel.latestVerification(f.child.id)!;
        assert.deepEqual(Object.keys(verification.record.fileVersions as object).sort(), ['count', 'sha256', 'version']);
        assert.equal((verification.record.fileVersions as { count: number }).count, 2);
        f.kernel.command({ commandId: crypto.randomUUID(), taskId: f.parentId, type: 'accept_result', parameters: { childTaskId: f.child.id } });
        assert.equal(f.kernel.delegations(f.parentId)[0]!.state, 'accepted');
        writeFileSync(path.join(f.child.workspace, 'source.txt'), 'changed after acceptance');
        const run = f.kernel.createRun(f.parentId); f.kernel.transition(f.parentId, 'running');
        f.kernel.verify(f.parentId, run.id, { passed: true, reviewer: 'independent-parent-reviewer' });
        assert.throws(() => f.kernel.transition(f.parentId, 'completed'), code('STALE_VERIFICATION'));
    } finally { f.close(); }
});

test('an explicitly absent input is versioned and a later external creation invalidates acceptance', async () => {
    const f = await childResult({ missingInput: true });
    try {
        f.reopen();
        writeFileSync(path.join(f.child.workspace, 'source.txt'), 'created after verification');
        assert.throws(() => f.kernel.command({ commandId: crypto.randomUUID(), taskId: f.parentId, type: 'accept_result', parameters: { childTaskId: f.child.id } }), code('STALE_VERIFICATION'));
    } finally { f.close(); }
});
