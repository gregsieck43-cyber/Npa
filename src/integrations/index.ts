import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Task } from '../contracts.js';
import type { Kernel } from '../kernel/index.js';
import { digestValue, isForbiddenRelative } from '../tools/policy.js';
import { IntegrationStore, identifier, text } from './store.js';
import { IntegrationTools } from './tools.js';
import type { CollaborationPlan, EvidenceInput, IntegrationEvidence, IntegrationFact, IntegrationResource, IntegrationSnapshot, PlanInput, PlanNodeInput, ProcessSearchInput, ProcessSearchResult, SharedTodo } from './types.js';
export * from './types.js';
export { COLLABORATION_TOOL_DEFINITIONS } from './definitions.js';
export { IntegrationTools, INTEGRATION_TOOL_DEFINITIONS } from './tools.js';

interface StoredPlan extends PlanInput { taskId: string; revision: number; createdAt: string; goalVersion?: number; supersededChildren?: string[]; }
export interface IntegrationServiceOptions { dataDir: string; projectRoot: string; dependencyRoot?: string; kernel: Kernel; }
const authority = 'Kernel owns task state, scheduling, approvals and verification; integration facts are untrusted annotations.' as const;
const nodeOwner = (plan: StoredPlan, nodeId: string) => `plan-${digestValue(plan.revision === 1 ? [plan.taskId, plan.id, nodeId] : [plan.taskId, plan.id, plan.revision, nodeId]).slice(0, 32)}`;

/** Independent metadata for a planner/executor workflow; no loop, queue or duplicate task states. */
export class IntegrationService {
  private readonly store: IntegrationStore;
  readonly tools: IntegrationTools;
  constructor(private readonly options: IntegrationServiceOptions) {
    this.store = new IntegrationStore(options.dataDir);
    this.tools = new IntegrationTools({ ...options, store: this.store });
  }
  close(): void { this.store.close(); }
  private task(taskId: string): Task {
    const task = this.options.kernel.getTask(taskId);
    if (!task) throw new Error('Integration task not found.');
    return task;
  }
  private *tree(taskId: string): Generator<Task> {
    yield this.task(taskId);
    const stack = [{ taskId, after: 0 }];
    while (stack.length) {
      const branch = stack.at(-1)!;
      const page = this.options.kernel.childTaskPage(branch.taskId, branch.after, 1);
      const child = page.items[0];
      if (!child) { stack.pop(); continue; }
      if (page.nextCursor === null) stack.pop(); else branch.after = page.nextCursor;
      yield child;
      stack.push({ taskId: child.id, after: 0 });
    }
  }
  private sourceTask(taskId: string, sourceTaskId: string): Task {
    this.task(taskId);
    const source = this.task(sourceTaskId);
    let current: Task | undefined = source;
    while (current) {
      if (current.id === taskId) return source;
      current = current.parentId ? this.options.kernel.getTask(current.parentId) : undefined;
    }
    throw new Error('Source task is outside this collaboration scope.');
  }
  createPlan(taskId: string, input: PlanInput): CollaborationPlan {
    const task = this.task(taskId);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) throw new Error('A terminal task cannot change its plan.');
    const validated = validatePlan(input);
    let plan = this.store.get<StoredPlan>('plan', taskId, 'current');
    const changed = plan && (digestValue({ id: plan.id, title: plan.title, nodes: plan.nodes }) !== digestValue(validated) || plan.goalVersion !== task.goalVersion);
    if (changed && task.executionPhase !== 'planning' && task.executionPhase !== 'awaiting_plan_confirmation') throw new Error('An executing plan is immutable; enter planning before revising it.');
    if (!plan || changed) {
      const previous = plan;
      const supersededChildren = previous ? [...new Set([...(previous.supersededChildren ?? []), ...previous.nodes.flatMap(node => {
        const child = this.options.kernel.childByOwner(taskId, nodeOwner(previous, node.id)); return child ? [child.id] : [];
      })])] : [];
      plan = { ...validated, taskId, revision: (previous?.revision ?? 0) + 1, createdAt: new Date().toISOString(), goalVersion: task.goalVersion, supersededChildren };
      // Durable input precedes Kernel commands. Stable command IDs recover partial application.
      this.store.put('plan-version', taskId, String(plan.revision), plan);
      this.store.put('plan', taskId, 'current', plan);
    }
    if (task.executionPhase === 'planning' || task.executionPhase === 'awaiting_plan_confirmation') {
      const reference = { id: plan.id, revision: plan.revision, digest: digestValue({ id: plan.id, title: plan.title, nodes: plan.nodes }), goalVersion: task.goalVersion };
      if (task.executionPhase !== 'awaiting_plan_confirmation' || digestValue(task.plan) !== digestValue(reference))
        this.options.kernel.command({ commandId: `save-plan-${digestValue([taskId, reference, task.generation])}`, type: 'save_plan', taskId,
          expectedRevision: task.revision, origin: 'model', parameters: { plan: reference } });
      return this.plan(taskId)!;
    }
    if (task.plan && (task.plan.revision !== plan.revision || task.plan.digest !== digestValue({ id: plan.id, title: plan.title, nodes: plan.nodes }) || task.plan.goalVersion !== task.goalVersion))
      throw new Error('Saved plan content does not match the approved Kernel reference.');
    for (const childTaskId of plan.supersededChildren ?? []) {
      const child = this.options.kernel.getTask(childTaskId);
      if (!child) continue;
      if (!['completed', 'failed', 'cancelled'].includes(child.status)) this.options.kernel.command({ commandId: `plan-cancel-${taskId}-${plan.revision}-${childTaskId}`, type: 'cancel_child', taskId, parameters: { childTaskId, reason: 'Superseded by the approved plan revision' } });
      const current = this.options.kernel.getTask(childTaskId)!;
      if (['failed', 'cancelled'].includes(current.status)) this.options.kernel.command({ commandId: `plan-dismiss-${taskId}-${plan.revision}-${childTaskId}`, type: 'dismiss_child', taskId, parameters: { childTaskId, reason: 'Superseded by the approved plan revision' } });
      else if (current.status === 'completed') this.options.kernel.command({ commandId: `plan-settle-${taskId}-${plan.revision}-${childTaskId}`, type: 'accept_child_result', taskId, parameters: { childTaskId } });
    }
    const mapped = new Map<string, string>();
    for (const node of plan.nodes) {
      const owner = nodeOwner(plan, node.id);
      const prior = this.options.kernel.childByOwner(taskId, owner) as (Task & { pauseState?: { parentTaskId?: string } }) | undefined;
      if (prior) {
        if (prior.status === 'paused' && prior.pauseState?.parentTaskId === taskId && task.status !== 'paused')
          this.options.kernel.command({ commandId: `plan-resume-${taskId}-${plan.revision}-${task.generation}-${prior.id}`, type: 'resume', taskId: prior.id, parameters: {} });
        mapped.set(node.id, prior.id); continue;
      }
      this.options.kernel.command({ commandId: `integration-${digestValue(plan.revision === 1 ? [taskId, plan.id, node.id] : [taskId, plan.id, plan.revision, node.id])}`, type: 'delegate', taskId,
        parameters: { title: node.title, objective: node.objective, owner, paths: node.paths, dependsOn: node.dependencies.map(id => mapped.get(id)!) } });
      const child = this.options.kernel.childByOwner(taskId, owner);
      if (!child) throw new Error('Kernel delegation was not observable; retry the same plan without changing its ID.');
      mapped.set(node.id, child.id);
    }
    return this.plan(taskId)!;
  }
  activateApprovedPlan(taskId: string): void {
    const task = this.task(taskId), plan = this.store.get<StoredPlan>('plan', taskId, 'current');
    if (task.executionPhase === 'executing' && !['paused', 'completed', 'failed', 'cancelled'].includes(task.status) && task.plan && plan) this.createPlan(taskId, { id: plan.id, title: plan.title, nodes: plan.nodes });
  }
  planHeader(taskId: string) {
    const task = this.task(taskId), plan = this.store.planHeader(taskId);
    return plan ? { ...plan, needsReview: plan.goalVersion === undefined || plan.goalVersion !== task.goalVersion,
      authority: 'Plan identity only. Current goal, child state and Kernel verification control further work.' } : undefined;
  }
  plan(taskId: string): CollaborationPlan | undefined {
    this.task(taskId);
    const plan = this.store.get<StoredPlan>('plan', taskId, 'current');
    if (!plan) return undefined;
    return { ...plan, nodes: plan.nodes.map(node => {
      const child = this.options.kernel.childByOwner(taskId, nodeOwner(plan, node.id));
      const ready = !!child && this.options.kernel.taskRunnable(child.id);
      return { ...node, ...(child ? { childTaskId: child.id } : {}), status: child?.status ?? 'not_delegated', ready,
        ...(!ready ? { blockedReason: !child ? 'Plan not fully delegated; retry the same plan.' : child.status === 'queued' && node.dependencies.length ? 'Kernel dependency or schedule gate is not ready.' : `Kernel task state: ${child.status}` } : {}) };
    }) };
  }
  snapshot(taskId: string): IntegrationSnapshot {
    return { taskId, plan: this.plan(taskId), todos: this.store.list('todo', taskId), resources: this.store.list('resource', taskId), facts: this.store.list('fact', taskId), evidence: this.store.list('evidence', taskId), authority };
  }
  addResource(taskId: string, input: { path: string; label: string }): IntegrationResource {
    this.task(taskId);
    const resourcePath = safeRelative(input.path);
    const value: IntegrationResource = { id: digestValue(resourcePath).slice(0, 32), taskId, path: resourcePath, label: text(input.label, 'Resource label', 300), createdAt: new Date().toISOString() };
    const existing = this.store.get<IntegrationResource>('resource', taskId, value.id);
    if (existing) return existing;
    this.store.put('resource', taskId, value.id, value); return value;
  }
  captureEvidence(taskId: string, input: EvidenceInput): IntegrationEvidence {
    this.sourceTask(taskId, input.sourceTaskId);
    let source: unknown;
    if (input.kind === 'message') {
      const message = this.options.kernel.getMessage(input.sourceId);
      if (message?.taskId === input.sourceTaskId) source = message;
    } else if (input.kind === 'event') {
      const seq = Number(input.sourceId);
      if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Event evidence needs its exact sequence.');
      source = this.options.kernel.events(input.sourceTaskId, seq - 1, 1).find(event => event.seq === seq);
    } else if (input.kind === 'receipt') {
      const intent = this.options.kernel.getIntent(input.sourceId);
      if (intent?.taskId === input.sourceTaskId && intent.state === 'applied' && intent.receipt) source = { intentId: intent.id, digest: intent.digest, receipt: intent.receipt };
    } else throw new Error('Unknown evidence kind.');
    if (!source) throw new Error('Original evidence was not found in the requested task scope.');
    const content = JSON.stringify(source), sha256 = digestValue(source);
    const id = digestValue([input.sourceTaskId, input.kind, input.sourceId, sha256]).slice(0, 32);
    const existing = this.store.get<IntegrationEvidence>('evidence', taskId, id);
    if (existing) return existing;
    const value: IntegrationEvidence = { ...input, id, taskId, sha256, content, createdAt: new Date().toISOString(), trust: 'untrusted' };
    this.store.put('evidence', taskId, id, value); return value;
  }
  private evidenceIds(taskId: string, ids: string[], required: boolean): string[] {
    if (!Array.isArray(ids) || ids.length > 32 || required && !ids.length || ids.some(id => !this.store.get('evidence', taskId, id))) throw new Error('Evidence must reference 1–32 captured originals in this task scope.');
    return [...new Set(ids)];
  }
  addFact(taskId: string, input: Omit<IntegrationFact, 'id' | 'taskId' | 'createdAt'>): IntegrationFact {
    this.task(taskId);
    if (!this.store.get('resource', taskId, input.resourceId)) throw new Error('Fact resource is not registered in this task scope.');
    if (!['observation', 'hypothesis'].includes(input.kind)) throw new Error('Fact kind must be observation or hypothesis.');
    const value: IntegrationFact = { ...input, id: randomUUID(), taskId, statement: text(input.statement, 'Fact statement', 6000), evidenceIds: this.evidenceIds(taskId, input.evidenceIds, true), createdAt: new Date().toISOString() };
    this.store.put('fact', taskId, value.id, value); return value;
  }
  saveTodo(taskId: string, input: Omit<SharedTodo, 'taskId' | 'revision' | 'updatedAt'> & { expectedRevision: number }): SharedTodo {
    this.task(taskId);
    const id = identifier(input.id);
    return this.store.transaction(() => {
      const previous = this.store.get<SharedTodo>('todo', taskId, id);
      if (input.expectedRevision !== (previous?.revision ?? 0)) throw new Error('Todo revision conflict; refresh before editing.');
      if (!['open', 'done'].includes(input.status)) throw new Error('Todo status must be open or done.');
      const value: SharedTodo = { id, taskId, title: text(input.title, 'Todo title', 1000), owner: text(input.owner, 'Todo owner', 120), status: input.status,
        evidenceIds: this.evidenceIds(taskId, input.evidenceIds, input.status === 'done'), revision: input.expectedRevision + 1, updatedAt: new Date().toISOString() };
      this.store.put('todo', taskId, id, value); return value;
    });
  }
  searchProcesses(taskId: string, input: ProcessSearchInput): ProcessSearchResult {
    const query = text(input.query, 'Process query', 400), offset = input.offset ?? 0, limit = input.limit ?? 20;
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Process pagination requires offset 0–10000 and limit 1–20.');
    const results = [];
    let skipped = 0;
    for (const task of this.tree(taskId)) {
      if (task.id === input.excludeTaskId) continue;
      let localOffset = 0;
      do {
        const page = this.options.kernel.memory(task.id).search({ query, limit: 20, offset: localOffset });
        for (const hit of page.results) {
          if (skipped++ < offset) continue;
          results.push({ taskId: task.id, owner: task.owner, sourceId: hit.id, role: hit.role, excerpt: hit.excerpt, createdAt: hit.createdAt });
          if (results.length > limit) return { results: results.slice(0, limit), nextOffset: offset + limit, rawHistoryRetained: true };
        }
        if (page.nextOffset === null) break;
        localOffset = page.nextOffset;
      } while (true);
    }
    return { results, nextOffset: null, rawHistoryRetained: true };
  }
  readProcess(taskId: string, sourceTaskId: string, messageId: string, offset = 0, length = 6000) {
    this.sourceTask(taskId, sourceTaskId);
    return this.options.kernel.memory(sourceTaskId).read({ id: messageId, offset, length });
  }
}

function safeRelative(value: unknown): string {
  const filename = text(value, 'Workspace path', 1000).replaceAll('\\', '/');
  if (path.isAbsolute(filename) || /^[a-z]:/i.test(filename) || filename.split('/').some(part => part === '..') || filename === '.' || isForbiddenRelative(filename)) throw new Error('Path must name a concrete non-protected workspace-relative resource.');
  const normalized = path.posix.normalize(filename);
  if (normalized === '.' || normalized === './') throw new Error('Path must not claim the workspace root.');
  return normalized;
}
function validatePlan(input: PlanInput): PlanInput {
  if (!input || !Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > 64) throw new Error('Plan requires 1–64 nodes.');
  const nodes: PlanNodeInput[] = input.nodes.map(node => {
    if (!Array.isArray(node.dependencies) || !Array.isArray(node.paths) || !node.paths.length || node.paths.length > 32) throw new Error('Each node needs dependencies and 1–32 concrete paths.');
    return { id: identifier(node.id), title: text(node.title, 'Node title', 200), objective: text(node.objective, 'Node objective', 6000), dependencies: [...new Set(node.dependencies.map(identifier))], paths: [...new Set(node.paths.map(safeRelative))] };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error('Duplicate plan node ID.');
  const claimed: string[] = [];
  for (const node of nodes) for (const resource of node.paths) {
    const normalized = resource.toLowerCase();
    if (claimed.some(prior => prior === normalized || prior.startsWith(normalized + '/') || normalized.startsWith(prior + '/'))) throw new Error('Plan node paths overlap; assign separate resources.');
    claimed.push(normalized);
  }
  const ordered: PlanNodeInput[] = [], seen = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    if (visiting.has(id)) throw new Error('Plan dependency cycle.');
    const node = byId.get(id);
    if (!node) throw new Error('Plan dependency does not exist.');
    visiting.add(id); node.dependencies.forEach(visit); visiting.delete(id); seen.add(id); ordered.push(node);
  };
  nodes.forEach(node => visit(node.id));
  return { id: identifier(input.id), title: text(input.title, 'Plan title', 200), nodes: ordered };
}
