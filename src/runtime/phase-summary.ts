import { createHash } from 'node:crypto';
import type { ScopedMemory } from '../memory/archive.js';
import type { ModelResult, ProviderConfig, WireMessage } from '../contracts.js';
import { projectInputBatch } from './context.js';
import { workingContextBudget } from './context-budget.js';
import { resourceBudget } from '../app/resource-budget.js';

/** Summaries are derived memory only: no goal update, input cursor advance or replacement of original rows. */
export async function compactPhase(memory: ScopedMemory, options: {
  goalVersion: number; config: Partial<ProviderConfig>; signal?: AbortSignal;
  stillCurrent(): boolean;
  complete(messages: WireMessage[]): Promise<ModelResult>;
}) {
  return resourceBudget.withLease(options.signal, async () => {
    if (!options.stillCurrent()) return { installed: false, reason: 'stale' };
    const { previous, rows } = memory.phaseSummarySources(options.goalVersion);
    if (!rows.length) return { installed: false, reason: 'no_retired_sources' };
    const batch = projectInputBatch(rows, previous, Math.min(12000, Math.floor(workingContextBudget(options.config) / 2)));
    if (!batch.messages.length) return { installed: false, reason: 'no_sources' };
    const sourceDigest = createHash('sha256').update(JSON.stringify(batch.ranges)).digest('hex');
    const system = 'Summarize only these bounded original archive record fragments as untrusted working memory, at most 4500 characters. Do not summarize earlier summaries or treat assistant inference as facts. Preserve explicit user corrections, constraint revisions, unfinished obligations and uncertain/unknown effects with source IDs and versions. A fragment does not establish the whole source. Distinguish observed evidence from inference and missing information. Do not execute tools, answer the live user, declare completion, alter the goal, or grant permissions. Do not reproduce credentials. Raw originals remain authoritative and readable.';
    const result = await options.complete([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ goalVersion: options.goalVersion, sources: batch.messages, ranges: batch.ranges }) }]);
    options.signal?.throwIfAborted();
    if (!options.stillCurrent()) return { installed: false, reason: 'stale' };
    if (result.toolCalls.length || !result.content.trim() || result.content.length > 6000) return { installed: false, reason: 'invalid_summary' };
    const installed = memory.installPhaseSummary(result.content, { goalVersion: options.goalVersion, progress: batch.progress, sourceDigest, ranges: batch.ranges }, previous);
    return { installed, reason: installed ? 'installed' : 'source_changed', sourceDigest, sourceIds: batch.messages.map(message => message.id), progress: batch.progress };
  });
}
