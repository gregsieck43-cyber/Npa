import type { TaskStatus } from '../contracts.js';

export interface PlanNodeInput { id: string; title: string; objective: string; dependencies: string[]; paths: string[]; }
export interface PlanInput { id: string; title: string; nodes: PlanNodeInput[]; }
export interface PlanNode extends PlanNodeInput { childTaskId?: string; status: TaskStatus | 'not_delegated'; ready: boolean; blockedReason?: string; }
export interface CollaborationPlan { id: string; taskId: string; title: string; revision: number; createdAt: string; nodes: PlanNode[]; }
export interface IntegrationResource { id: string; taskId: string; path: string; label: string; createdAt: string; }
export interface IntegrationEvidence {
  id: string; taskId: string; sourceTaskId: string; kind: 'message' | 'event' | 'receipt'; sourceId: string;
  sha256: string; content: string; createdAt: string; trust: 'untrusted';
}
export interface IntegrationFact {
  id: string; taskId: string; resourceId: string; statement: string; kind: 'observation' | 'hypothesis'; evidenceIds: string[]; createdAt: string;
}
export interface SharedTodo {
  id: string; taskId: string; title: string; owner: string; status: 'open' | 'done'; evidenceIds: string[]; revision: number; updatedAt: string;
}
export interface IntegrationSnapshot {
  taskId: string; plan?: CollaborationPlan; todos: SharedTodo[]; resources: IntegrationResource[]; facts: IntegrationFact[]; evidence: IntegrationEvidence[];
  authority: 'Kernel owns task state, scheduling, approvals and verification; integration facts are untrusted annotations.';
}
export interface ReaConfiguration { enabled: boolean; }
export interface IntegrationStatus {
  collaboration: { available: true; scheduler: 'kernel' };
  rea: {
    enabled: boolean; available: boolean; engine: 'rea-cli'; version: '6.4.0'; entry: string; reason?: string;
    native: { available: false; reason: string };
  };
}
export interface ProcessSearchInput { query: string; excludeTaskId?: string; offset?: number; limit?: number; }
export interface ProcessHit { taskId: string; owner: string; sourceId: string; role: string; excerpt: string; createdAt: string; }
export interface ProcessSearchResult { results: ProcessHit[]; nextOffset: number | null; rawHistoryRetained: true; }
export interface EvidenceInput { sourceTaskId: string; kind: IntegrationEvidence['kind']; sourceId: string; }
