import { createHash } from 'node:crypto';
import { validateTaskModule, type PureTaskModule, type PinnedTaskModule } from './pure-task-module.js';

export type TransformKind = 'identity' | 'trim' | 'prefix' | 'suffix';
export interface TextTransform { kind: TransformKind; value?: string }
export interface CandidateSpec {
  taskId: string;
  name: string;
  promptSuffix?: string;
  transform?: TextTransform;
  module?: PureTaskModule;
  capabilities?: string[];
  baseVersion?: number;
}
export interface CandidateArtifact {
  schemaVersion: 1;
  artifactVersion: 1 | 2;
  taskId: string;
  name: string;
  source: { promptSuffix: string; transform: TextTransform; module?: PureTaskModule };
  capabilities: string[];
}
export interface CandidateTestReport {
  artifactDigest: string;
  validatorVersion: 1 | 2;
  moduleSourceDigest?: string;
  passed: boolean;
  checkedAt: string;
  checks: { name: string; passed: boolean }[];
}
export interface CandidateApproval {
  artifactDigest: string;
  taskId: string;
  expectedVersion: number;
  capabilityDiff: string[];
  principal: string;
  expiresAt?: string;
  approvedAt?: string;
}
export interface Candidate {
  id: string;
  taskId: string;
  name: string;
  artifactDigest: string;
  artifactVersion: 1 | 2;
  baseVersion: number;
  capabilityDiff: string[];
  status: 'draft' | 'tested' | 'approved' | 'active' | 'inactive' | 'failed';
  createdAt: string;
  testReport?: CandidateTestReport;
  approval?: CandidateApproval;
}
export interface ActiveProfile {
  taskId: string;
  version: number;
  activeCandidateId?: string;
  history: (string | null)[];
}
export interface AdaptationSnapshot {
  version: number;
  candidateId?: string;
  artifactDigest?: string;
  promptSuffix: string;
  transform: TextTransform;
  module?: PinnedTaskModule;
}
export class AdaptationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AdaptationError';
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function validateSpec(spec: CandidateSpec): CandidateArtifact {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new AdaptationError('INVALID_SPEC', 'Candidate must be a task-local JSON configuration.');
  }
  const allowed = ['taskId', 'name', 'promptSuffix', 'transform', 'module', 'capabilities', 'baseVersion'];
  if (Object.keys(spec).some(key => !allowed.includes(key))) {
    throw new AdaptationError('PROTECTED_SCOPE', 'Only task prompt and text transform configuration can be adapted.');
  }
  if (typeof spec.taskId !== 'string' || !spec.taskId.trim() || spec.taskId.length > 256 ||
      typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 128) {
    throw new AdaptationError('INVALID_SPEC', 'A task ID and a candidate name are required.');
  }
  if (spec.baseVersion !== undefined && (!Number.isSafeInteger(spec.baseVersion) || spec.baseVersion < 0)) {
    throw new AdaptationError('INVALID_SPEC', 'baseVersion must be a non-negative integer.');
  }
  const promptSuffix = spec.promptSuffix ?? '';
  if (typeof promptSuffix !== 'string' || promptSuffix.length > 8192) {
    throw new AdaptationError('INVALID_SPEC', 'Task prompt suffix must be text of at most 8192 characters.');
  }
  const transform = spec.transform ?? { kind: 'identity' };
  if (!transform || typeof transform !== 'object' || Array.isArray(transform) ||
      Object.keys(transform).some(key => !['kind', 'value'].includes(key)) ||
      !['identity', 'trim', 'prefix', 'suffix'].includes(transform.kind)) {
    throw new AdaptationError('PROTECTED_SCOPE', 'Transform must use an installed pure text operation; executable code is not allowed.');
  }
  if (transform.value !== undefined && (typeof transform.value !== 'string' || transform.value.length > 2048)) {
    throw new AdaptationError('INVALID_SPEC', 'Transform value must be text of at most 2048 characters.');
  }
  if (['identity', 'trim'].includes(transform.kind) && transform.value !== undefined) {
    throw new AdaptationError('INVALID_SPEC', 'identity and trim do not take a value.');
  }
  const capabilities = [
    ...(promptSuffix ? ['task.prompt'] : []),
    ...(transform.kind !== 'identity' ? ['task.output.transform'] : []),
    ...(spec.module ? ['task.output.module'] : []),
  ];
  if (spec.capabilities !== undefined && (!Array.isArray(spec.capabilities) ||
      spec.capabilities.some(capability => !capabilities.includes(capability)) ||
      new Set(spec.capabilities).size !== spec.capabilities.length)) {
    throw new AdaptationError('CAPABILITY_ESCALATION', 'Candidates cannot request file, network, process, approval, audit, verifier or kernel capabilities.');
  }
  const module = spec.module !== undefined ? validateTaskModule(spec.module) : undefined;
  return { schemaVersion: 1, artifactVersion: module ? 2 : 1, taskId: spec.taskId, name: spec.name,
    source: { promptSuffix, transform: { ...transform }, ...(module ? { module } : {}) }, capabilities: capabilities.sort() };
}

export function applyTransform(transform: TextTransform, text: string): string {
  switch (transform.kind) {
    case 'identity': return text;
    case 'trim': return text.trim();
    case 'prefix': return `${transform.value ?? ''}${text}`;
    case 'suffix': return `${text}${transform.value ?? ''}`;
  }
}

export function testArtifact(artifact: CandidateArtifact, digest: string): CandidateTestReport {
  const validated = validateSpec({ taskId: artifact.taskId, name: artifact.name,
    promptSuffix: artifact.source.promptSuffix, transform: artifact.source.transform,
    module: artifact.source.module, capabilities: artifact.capabilities });
  const sample = '  contract sample  ';
  const transformed = applyTransform(artifact.source.transform, sample);
  const operationOracle = {
    identity: '  contract sample  ', trim: 'contract sample',
    prefix: `${artifact.source.transform.value ?? ''}  contract sample  `,
    suffix: `  contract sample  ${artifact.source.transform.value ?? ''}`,
  };
  const fixedOperations = [
    [applyTransform({ kind: 'identity' }, '  alpha  '), '  alpha  '],
    [applyTransform({ kind: 'trim' }, '  alpha  '), 'alpha'],
    [applyTransform({ kind: 'prefix', value: 'before:' }, 'alpha'), 'before:alpha'],
    [applyTransform({ kind: 'suffix', value: ':after' }, 'alpha'), 'alpha:after'],
  ];
  const checks = [
    { name: 'artifact schema and fixed capabilities', passed: digestOf(validated) === digest },
    { name: 'pure text transform against fixed independent oracles', passed: fixedOperations.every(([actual, expected]) => actual === expected) && transformed === operationOracle[artifact.source.transform.kind] },
    { name: 'bounded output growth', passed: transformed.length <= sample.length + 2048 },
    { name: 'stable task ownership', passed: validated.taskId === artifact.taskId },
    { name: 'protected kernel is outside artifact schema', passed: Object.keys(artifact).sort().join(',') === 'artifactVersion,capabilities,name,schemaVersion,source,taskId' },
  ];
  return { artifactDigest: digest, validatorVersion: 1, passed: checks.every(check => check.passed),
    checkedAt: new Date().toISOString(), checks };
}
