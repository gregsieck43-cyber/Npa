import { randomUUID } from 'node:crypto';
import type { Services } from './services.js';
import type { EvidenceInput, IntegrationFact, PlanInput, ReaConfiguration, SharedTodo } from '../integrations/types.js';

export async function integrationRoute(services: Services, method: string, url: URL, input: Record<string, unknown>): Promise<unknown> {
    const integrations = services.integrations;
    if (method === 'GET' && url.pathname === '/v1/integrations/status') return integrations.tools.status();
    if (method === 'POST' && url.pathname === '/v1/integrations/rea') {
        integrations.tools.configure(input as unknown as ReaConfiguration);
        return integrations.tools.status();
    }
    const match = /^\/v1\/tasks\/([^/]+)\/integrations(?:\/([a-z]+))?$/.exec(url.pathname);
    if (!match) throw new Error('Unknown integration route.');
    const task = services.task(decodeURIComponent(match[1]!));
    const action = match[2] ?? 'snapshot';
    if (method === 'GET') {
        if (action === 'snapshot') return integrations.snapshot(task.id);
        if (action === 'plan') return integrations.plan(task.id) ?? null;
        if (action === 'processes') return integrations.searchProcesses(task.id, {
            query: url.searchParams.get('q') ?? '', offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 20),
            ...(url.searchParams.has('excludeTaskId') ? { excludeTaskId: url.searchParams.get('excludeTaskId')! } : {}),
        });
        if (action === 'process') return integrations.readProcess(task.id, url.searchParams.get('sourceTaskId') ?? '', url.searchParams.get('messageId') ?? '', Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('length') ?? 6000));
        if (action === 'results') {
            const effectKey = url.searchParams.get('effectKey') ?? '';
            const intent = services.kernel.intentForEffect(effectKey);
            if (!intent || intent.taskId !== task.id || intent.name !== 'rea_analyze_local') throw new Error('Analysis result is outside the selected task.');
            return integrations.tools.readResult(effectKey, Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('length') ?? 6000));
        }
    }
    if (method === 'POST') {
        if (action === 'plan') return integrations.createPlan(task.id, input as unknown as PlanInput);
        if (action === 'resources') return integrations.addResource(task.id, input as unknown as { path: string; label: string });
        if (action === 'evidence') return integrations.captureEvidence(task.id, input as unknown as EvidenceInput);
        if (action === 'facts') return integrations.addFact(task.id, input as unknown as Omit<IntegrationFact, 'id' | 'taskId' | 'createdAt'>);
        if (action === 'todos') return integrations.saveTodo(task.id, input as unknown as Omit<SharedTodo, 'taskId' | 'revision' | 'updatedAt'> & { expectedRevision: number });
        if (action === 'analyze') {
            const requestId = typeof input.requestId === 'string' ? input.requestId : randomUUID();
            return services.command({ commandId: requestId, type: 'propose_tool', taskId: task.id,
                parameters: { name: 'rea_analyze_local', arguments: { paths: input.paths } } });
        }
    }
    throw new Error('Unknown integration action or method.');
}
