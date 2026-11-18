import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdaptationError, applyTransform, canonicalJson, digestOf, testArtifact, validateSpec,
  type ActiveProfile, type AdaptationSnapshot, type Candidate, type CandidateApproval, type CandidateArtifact, type CandidateSpec, type CandidateTestReport } from './candidate-contract.js';
import { runTaskModule, taskModuleDigest, TaskModuleError } from './pure-task-module.js';

interface CandidateState { schemaVersion: 1; revision: number; candidates: Candidate[]; profiles: ActiveProfile[] }
interface StateEnvelope { digest: string; state: CandidateState }

/** Called by the backend's single writer. Module source only executes in the bounded child worker. */
export class CandidateManager {
  private readonly root: string;
  private readonly statePath: string;
  private state: CandidateState;

  constructor(private readonly dataDir: string) {
    this.root = join(dataDir, 'adaptation');
    this.statePath = join(this.root, 'state.json');
    mkdirSync(join(this.root, 'artifacts'), { recursive: true });
    this.state = existsSync(this.statePath) ? this.readState() :
      { schemaVersion: 1, revision: 0, candidates: [], profiles: [] };
  }

  create(spec: CandidateSpec): Candidate {
    const artifact = validateSpec(spec);
    const profile = this.profile(spec.taskId);
    const baseVersion = spec.baseVersion ?? profile.version;
    if (baseVersion !== profile.version) throw new AdaptationError('VERSION_CONFLICT', 'Task adaptation version changed.');
    const digest = digestOf(artifact);
    const artifactPath = this.artifactPath(digest);
    const bytes = canonicalJson(artifact);
    if (existsSync(artifactPath)) {
      if (readFileSync(artifactPath, 'utf8') !== bytes) throw new AdaptationError('ARTIFACT_CORRUPT', 'Existing content-addressed artifact was changed.');
    } else {
      writeFileSync(artifactPath, bytes, { encoding: 'utf8', flag: 'wx' });
    }
    const previousCapabilities = profile.activeCandidateId ? this.loadArtifact(this.find(profile.activeCandidateId)).capabilities : [];
    const candidate: Candidate = { id: randomUUID(), taskId: artifact.taskId, name: artifact.name,
      artifactDigest: digest, artifactVersion: artifact.artifactVersion, baseVersion,
      capabilityDiff: capabilityDifference(previousCapabilities, artifact.capabilities), status: 'draft', createdAt: new Date().toISOString() };
    this.change(state => { state.candidates.push(candidate); });
    return structuredClone(candidate);
  }

  test(id: string): Candidate {
    const candidate = this.find(id);
    this.assertMutable(candidate);
    const artifact = this.loadArtifact(candidate);
    if (artifact.source.module) throw new AdaptationError('ASYNC_TEST_REQUIRED', 'Task module source requires testAsync in the independent worker.');
    return this.saveTest(id, testArtifact(artifact, candidate.artifactDigest));
  }

  async testAsync(id: string, signal?: AbortSignal): Promise<Candidate> {
    const candidate = this.find(id);
    this.assertMutable(candidate);
    const artifact = this.loadArtifact(candidate);
    const module = artifact.source.module;
    if (!module) return this.test(id);
    const revision = this.state.revision;
    const report = testArtifact(artifact, candidate.artifactDigest);
    report.validatorVersion = 2;
    report.moduleSourceDigest = taskModuleDigest(module.source);
    const inputs = module.fixtures.map(fixture => fixture.input);
    try {
      // Explicit fixture outputs are the behavior oracle; a second fresh realm detects retained state.
      const outputs = await runTaskModule(module, [...inputs, ...inputs], this.dataDir, signal);
      report.checks.push({ name: 'task module explicit fixture outputs', passed: module.fixtures.every((fixture, index) => outputs[index] === fixture.expected) },
        { name: 'task module repeatability in fresh realms', passed: inputs.every((_, index) => outputs[index] === outputs[index + inputs.length]) });
    } catch (error) {
      if (!(error instanceof TaskModuleError) || error.code === 'MODULE_CANCELLED') throw error;
      report.checks.push({ name: `task module worker result: ${error.code}`, passed: false });
    }
    // An asynchronous test cannot replace an approval/profile changed while its worker was running.
    if (this.state.revision !== revision) throw new AdaptationError('TEST_STALE', 'Candidate state changed while the module test ran; rerun the test.');
    this.assertMutable(this.find(id));
    report.passed = report.checks.every(check => check.passed);
    return this.saveTest(id, report);
  }

  /** Principal must be assigned by the trusted operator endpoint, never model input. */
  approve(id: string, approval: CandidateApproval): Candidate {
    const candidate = this.find(id);
    this.assertMutable(candidate);
    const artifact = this.loadArtifact(candidate);
    if (!this.hasBoundTest(candidate, artifact)) {
      throw new AdaptationError('TEST_REQUIRED', 'Candidate must pass independent fixed contract tests before approval.');
    }
    if (approval.artifactDigest !== candidate.artifactDigest || approval.taskId !== candidate.taskId ||
        approval.expectedVersion !== candidate.baseVersion || approval.expectedVersion !== this.profile(candidate.taskId).version ||
        canonicalJson(approval.capabilityDiff) !== canonicalJson(candidate.capabilityDiff)) {
      throw new AdaptationError('APPROVAL_BINDING', 'Approval must bind this artifact, task, current version and exact capability difference.');
    }
    if (typeof approval.principal !== 'string' || !approval.principal.trim()) {
      throw new AdaptationError('OPERATOR_REQUIRED', 'An authenticated operator approval is required.');
    }
    if (approval.expiresAt !== undefined && (!Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now())) {
      throw new AdaptationError('APPROVAL_EXPIRED', 'Approval expiration must be in the future.');
    }
    this.change(state => {
      const target = state.candidates.find(item => item.id === id)!;
      target.approval = { ...structuredClone(approval), approvedAt: new Date().toISOString() };
      target.status = 'approved';
    });
    return this.get(id);
  }

  activate(id: string, context?: { taskStatus: string }): ActiveProfile {
    const candidate = this.find(id);
    const artifact = this.loadArtifact(candidate);
    const profile = this.profile(candidate.taskId);
    if (candidate.status !== 'approved' || !candidate.approval) throw new AdaptationError('APPROVAL_REQUIRED', 'Activation requires an operator approval.');
    if (candidate.approval.expectedVersion !== profile.version || candidate.baseVersion !== profile.version) {
      throw new AdaptationError('VERSION_CONFLICT', 'Approval belongs to an older task adaptation version.');
    }
    if (candidate.approval.expiresAt && Date.parse(candidate.approval.expiresAt) <= Date.now()) {
      throw new AdaptationError('APPROVAL_EXPIRED', 'Candidate approval expired.');
    }
    if (artifact.source.module && context?.taskStatus !== 'paused') {
      throw new AdaptationError('PAUSE_REQUIRED', 'Pause the task before activating task module source.');
    }
    // Artifact integrity and report are rechecked at admission, before active state changes.
    const report = testArtifact(artifact, candidate.artifactDigest);
    if (!report.passed || !this.hasBoundTest(candidate, artifact) || candidate.approval.artifactDigest !== candidate.artifactDigest ||
        candidate.approval.taskId !== candidate.taskId ||
        canonicalJson(candidate.approval.capabilityDiff) !== canonicalJson(candidate.capabilityDiff)) {
      throw new AdaptationError('APPROVAL_BINDING', 'Tested artifact no longer matches the approval.');
    }
    this.change(state => {
      const targetProfile = ensureProfile(state, candidate.taskId);
      targetProfile.history.push(targetProfile.activeCandidateId ?? null);
      if (targetProfile.activeCandidateId) state.candidates.find(item => item.id === targetProfile.activeCandidateId)!.status = 'inactive';
      targetProfile.activeCandidateId = id;
      targetProfile.version++;
      state.candidates.find(item => item.id === id)!.status = 'active';
    });
    return this.activeFor(candidate.taskId);
  }

  rollback(taskId: string, expectedVersion?: number): ActiveProfile {
    const profile = this.profile(taskId);
    if (expectedVersion !== undefined && expectedVersion !== profile.version) throw new AdaptationError('VERSION_CONFLICT', 'Task adaptation version changed.');
    if (!profile.history.length) throw new AdaptationError('NO_ROLLBACK', 'No previous task adaptation is available.');
    const previousId = profile.history.at(-1);
    if (previousId) this.loadArtifact(this.find(previousId));
    this.change(state => {
      const target = ensureProfile(state, taskId);
      if (target.activeCandidateId) state.candidates.find(item => item.id === target.activeCandidateId)!.status = 'inactive';
      target.activeCandidateId = target.history.pop() ?? undefined;
      if (target.activeCandidateId) state.candidates.find(item => item.id === target.activeCandidateId)!.status = 'active';
      target.version++;
    });
    return this.activeFor(taskId);
  }

  list(taskId?: string): Candidate[] { return structuredClone(this.state.candidates.filter(item => !taskId || item.taskId === taskId)); }
  get(id: string): Candidate { return structuredClone(this.find(id)); }
  activeFor(taskId: string): ActiveProfile { return structuredClone(this.profile(taskId)); }
  snapshotFor(taskId: string): AdaptationSnapshot {
    const profile = this.profile(taskId);
    const candidate = profile.activeCandidateId ? this.find(profile.activeCandidateId) : undefined;
    const artifact = candidate ? this.loadArtifact(candidate) : undefined;
    return structuredClone({ version: profile.version, candidateId: candidate?.id, artifactDigest: candidate?.artifactDigest,
      promptSuffix: artifact?.source.promptSuffix ?? '', transform: artifact?.source.transform ?? { kind: 'identity' },
      ...(artifact?.source.module ? { module: { ...artifact.source.module, sourceDigest: taskModuleDigest(artifact.source.module.source) } } : {}) });
  }
  promptSuffixFor(taskId: string): string { return this.activeArtifact(taskId)?.source.promptSuffix ?? ''; }
  transformFor(taskId: string, text: string): string {
    const artifact = this.activeArtifact(taskId);
    if (artifact?.source.module) throw new AdaptationError('ASYNC_TRANSFORM_REQUIRED', 'Use applySnapshot for active task module source.');
    return artifact ? applyTransform(artifact.source.transform, text) : text;
  }

  /** Run admission pins this snapshot. Later activation/rollback never changes an admitted run. */
  async applySnapshot(snapshot: AdaptationSnapshot, text: string, signal?: AbortSignal): Promise<string> {
    let transformed = text;
    if (snapshot.module) {
      if (snapshot.module.sourceDigest !== taskModuleDigest(snapshot.module.source)) {
        throw new AdaptationError('ARTIFACT_CORRUPT', 'Pinned task module source digest changed.');
      }
      [transformed] = await runTaskModule(snapshot.module, [text], this.dataDir, signal);
    }
    return applyTransform(snapshot.transform, transformed);
  }

  private hasBoundTest(candidate: Candidate, artifact: CandidateArtifact): boolean {
    const report = candidate.testReport;
    return Boolean(report?.passed && report.artifactDigest === candidate.artifactDigest && (!artifact.source.module ||
      (report.validatorVersion === 2 && report.moduleSourceDigest === taskModuleDigest(artifact.source.module.source))));
  }
  private saveTest(id: string, report: CandidateTestReport): Candidate {
    this.change(state => {
      const target = state.candidates.find(item => item.id === id)!;
      target.testReport = report;
      target.approval = undefined;
      target.status = report.passed ? 'tested' : 'failed';
    });
    return this.get(id);
  }

  private activeArtifact(taskId: string): CandidateArtifact | undefined {
    const id = this.profile(taskId).activeCandidateId;
    return id ? this.loadArtifact(this.find(id)) : undefined;
  }
  private profile(taskId: string): ActiveProfile {
    return this.state.profiles.find(item => item.taskId === taskId) ?? { taskId, version: 0, history: [] };
  }
  private find(id: string): Candidate {
    const candidate = this.state.candidates.find(item => item.id === id);
    if (!candidate) throw new AdaptationError('NOT_FOUND', 'Candidate was not found.');
    return candidate;
  }
  private assertMutable(candidate: Candidate): void {
    if (['active', 'inactive'].includes(candidate.status)) throw new AdaptationError('IMMUTABLE_ACTIVATION', 'Create a new candidate to revise a previously activated artifact.');
  }
  private artifactPath(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new AdaptationError('ARTIFACT_CORRUPT', 'Artifact digest is invalid.');
    return join(this.root, 'artifacts', `${digest}.json`);
  }
  private loadArtifact(candidate: Candidate): CandidateArtifact {
    const artifactPath = this.artifactPath(candidate.artifactDigest);
    if (!existsSync(artifactPath)) throw new AdaptationError('ARTIFACT_MISSING', 'Candidate artifact is missing.');
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as CandidateArtifact;
    if (digestOf(artifact) !== candidate.artifactDigest || artifact.taskId !== candidate.taskId || artifact.artifactVersion !== candidate.artifactVersion) {
      throw new AdaptationError('ARTIFACT_CORRUPT', 'Candidate artifact digest or ownership changed.');
    }
    return artifact;
  }
  private readState(): CandidateState {
    const envelope = JSON.parse(readFileSync(this.statePath, 'utf8')) as StateEnvelope;
    if (!envelope.state || envelope.state.schemaVersion !== 1 || !Number.isSafeInteger(envelope.state.revision) ||
        !Array.isArray(envelope.state.candidates) || !Array.isArray(envelope.state.profiles) || envelope.digest !== digestOf(envelope.state)) {
      throw new AdaptationError('STATE_CORRUPT', 'Candidate state checksum failed; preserve data and recover the application payload.');
    }
    return envelope.state;
  }
  private change(mutator: (state: CandidateState) => void): void {
    if (existsSync(this.statePath) && this.readState().revision !== this.state.revision) {
      throw new AdaptationError('WRITER_CONFLICT', 'Candidate state was changed by another writer.');
    }
    const next = structuredClone(this.state);
    mutator(next);
    next.revision++;
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx');
    try {
      writeFileSync(fd, canonicalJson({ digest: digestOf(next), state: next }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, this.statePath);
    this.state = next;
  }
}

function ensureProfile(state: CandidateState, taskId: string): ActiveProfile {
  let profile = state.profiles.find(item => item.taskId === taskId);
  if (!profile) { profile = { taskId, version: 0, history: [] }; state.profiles.push(profile); }
  return profile;
}
function capabilityDifference(previous: string[], next: string[]): string[] {
  return [...next.filter(capability => !previous.includes(capability)).map(capability => `+${capability}`),
    ...previous.filter(capability => !next.includes(capability)).map(capability => `-${capability}`)].sort();
}
