import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { isLocalPath } from '../src/app/local-paths.js';
import type { EvidenceReview } from '../src/app/verification.js';
import { assertInsideProject, assertProjectFixtureRoot } from './project-boundary.js';

type Backend = Awaited<ReturnType<typeof startBackend>>;

test('activated display adaptation preserves raw results, repeated tool IDs and archived evidence through restart', { timeout: 35_000 }, async t => {
  const tempRoot = path.resolve('.tmp');
  assertProjectFixtureRoot(tempRoot);
  for (const name of ['TEMP', 'TMP']) {
    const value = process.env[name];
    assert.ok(value, name + ' must point at an isolated directory inside the project checkout.');
    assertInsideProject(value, name);
    assert.equal(isLocalPath(value), true, name + ' must stay on the volume that hosts this installation.');
  }
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, 'adaptation-display-'));
  const dataDir = path.join(root, 'data');
  const projectRoot = path.resolve('.');
  let backend: Backend | undefined;
  t.after(async () => {
    if (backend) await backend.close();
    assert.ok(path.relative(tempRoot, root).startsWith('adaptation-display-'));
    rmSync(root, { recursive: true, force: true });
  });
  backend = await startBackend({ dataDir, projectRoot });
  const command = (taskId: string, type: string, parameters?: Record<string, unknown>) =>
    backend!.services.command({ commandId: randomUUID(), taskId, type, parameters });
  const waitFor = async (taskId: string, status: string) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const snapshot = backend!.services.snapshot(taskId);
      if (snapshot.selectedTask?.status === status) return snapshot;
      assert.notEqual(snapshot.selectedTask?.status, 'failed', snapshot.selectedTask?.error);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const task = backend!.services.task(taskId);
    assert.fail(`Expected ${status}; observed ${task.status}: ${task.error ?? task.waitingReason ?? ''}`);
  };

  // Synchronous commands pause this freshly created task before the scheduler can run.
  const created = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    title: 'Adaptation display regression', goal: {
      objective: 'Write display-output.txt with the mock output', constraints: ['Approve exact file writes'],
      acceptance: ['file:display-output.txt', 'contains:display-output.txt:NPN-Gamma mock output'],
      maxModelCalls: 10, mode: 'autonomous',
    },
  } });
  const taskId = created.taskId!;
  command(taskId, 'pause');
  assert.equal(backend.services.task(taskId).modelCalls, 0);
  const prefix = '[Approved task display] ';
  const candidate = backend.services.candidates.create({ taskId, name: 'Display prefix', transform: { kind: 'prefix', value: prefix } });
  const tested = backend.services.candidates.test(candidate.id);
  assert.equal(tested.testReport?.passed, true);
  backend.services.candidate('approve', {
    id: candidate.id, taskId, artifactDigest: candidate.artifactDigest,
    expectedVersion: candidate.baseVersion, capabilityDiff: candidate.capabilityDiff,
  });
  backend.services.candidate('activate', { id: candidate.id });
  command(taskId, 'resume');
  const firstApproval = await waitFor(taskId, 'waiting_approval');
  const firstIntent = firstApproval.intents[0]!;
  command(taskId, 'grant', { intentId: firstIntent.id });
  const firstComplete = await waitFor(taskId, 'completed');
  const firstAnswer = firstComplete.messages.filter(message => message.role === 'assistant' && !message.toolCalls?.length).at(-1)!;
  assert.equal(firstAnswer.displayContent, prefix + firstAnswer.content);
  assert.equal(firstAnswer.content.startsWith(prefix), false);
  assert.equal(firstComplete.selectedTask!.result, firstAnswer.content);

  // A later assistant turn may reuse the provider's call ID; it still owns a new effect.
  command(taskId, 'send_message', { content: 'Also write later-output.txt with the additional requested content.' });
  command(taskId, 'pause');
  const secondContent = 'Independent later write with the same provider tool call ID.\n';
  backend.services.kernel.addMessage(taskId, 'assistant', 'Write the additional requested artifact.', 'main', {
    toolCalls: [{ id: firstIntent.toolCallId, name: 'write_file', arguments: { path: 'later-output.txt', content: secondContent } }],
  });
  command(taskId, 'resume');
  const secondApproval = await waitFor(taskId, 'waiting_approval');
  const secondIntent = secondApproval.intents.find(intent => intent.arguments.path === 'later-output.txt')!;
  assert.ok(secondIntent, 'A reused provider call ID must create the later turn\'s independent intent');
  assert.equal(secondIntent.toolCallId, firstIntent.toolCallId);
  assert.notEqual(secondIntent.effectKey, firstIntent.effectKey);
  command(taskId, 'grant', { intentId: secondIntent.id });
  const completed = await waitFor(taskId, 'completed');
  assert.equal(completed.intents.length, 2);
  assert.ok(completed.intents.every(intent => intent.state === 'applied'));
  const answer = completed.messages.filter(message => message.role === 'assistant' && !message.toolCalls?.length).at(-1)!;
  assert.equal(answer.displayContent, prefix + answer.content);
  assert.equal(answer.content.startsWith(prefix), false);
  assert.equal(completed.selectedTask!.result, answer.content);
  assert.equal(readFileSync(path.join(completed.selectedTask!.workspace, 'later-output.txt'), 'utf8'), secondContent);
  const verifications = backend.services.kernel.getVerifications(taskId);
  const verification = verifications.at(-1)!;
  assert.equal(verification.record.passed, true);
  const evidence = verification.record.evidence as EvidenceReview;
  assert.equal(evidence.artifacts.length, 2);
  for (const artifact of evidence.artifacts) {
    assert.ok(artifact.archivePath, 'Independent acceptance must retain the verified artifact bytes');
    assert.equal(path.dirname(artifact.archivePath), path.join(dataDir, 'artifacts'));
    const actual = readFileSync(path.join(completed.selectedTask!.workspace, artifact.path));
    assert.deepEqual(readFileSync(artifact.archivePath), actual);
    assert.equal(artifact.sha256, createHash('sha256').update(actual).digest('hex'));
  }
  const adaptation = backend.services.candidates.snapshotFor(taskId);
  assert.equal(adaptation.candidateId, candidate.id);

  await backend.close();
  backend = undefined;
  backend = await startBackend({ dataDir, projectRoot });
  const restored = backend.services.snapshot(taskId);
  assert.equal(restored.selectedTask!.status, 'completed');
  assert.equal(restored.selectedTask!.result, answer.content);
  assert.deepEqual(restored.messages, completed.messages);
  assert.deepEqual(restored.intents, completed.intents);
  assert.deepEqual(restored.verifications, verifications);
  assert.deepEqual(backend.services.candidates.snapshotFor(taskId), adaptation);
  assert.equal(backend.mock.requests(), 0, 'Cold restart must retain completed metadata without replaying model work');
  for (const artifact of evidence.artifacts) {
    assert.deepEqual(readFileSync(artifact.archivePath!), readFileSync(path.join(restored.selectedTask!.workspace, artifact.path)));
  }
});
