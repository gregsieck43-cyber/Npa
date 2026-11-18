import type { ToolCall, ToolDefinition } from '../contracts.js';
import type { ScopedMemory, SearchInput, ReadInput, NoteInput, NotesInput } from './archive.js';

export type ScopedMemoryPort = Pick<ScopedMemory, 'manifest' | 'search' | 'read' | 'remember' | 'notes' | 'context'>;

export const MEMORY_TOOLS: ToolDefinition[] = [
  { type: 'function', function: { name: 'search_history', description: 'Search the complete preserved conversation, tool arguments/results and attachments. Returns matching snippets and source IDs, including messages outside the working context. Phrase matches are literal; any mode searches whitespace-separated alternatives. Results are newest-first by archive sequence (not BM25 relevance), so a snapshot pages consistently while other conversations append.', parameters: { type: 'object', properties: { query: { type: 'string' }, mode: { type: 'string', enum: ['phrase', 'any'] }, limit: { type: 'integer', minimum: 1, maximum: 20 }, offset: { type: 'integer', minimum: 0 }, snapshot: { type: 'integer', minimum: 0 } }, required: ['query'], additionalProperties: false } } },
  { type: 'function', function: { name: 'read_history', description: 'Read an exact archived source by ID, including text beyond a preview. Continue with nextOffset until null. SHA-256 identifies the complete original record. Offsets use UTF-16 characters.', parameters: { type: 'object', properties: { id: { type: 'string' }, field: { type: 'string', enum: ['content', 'record', 'toolCalls', 'attachments'] }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 12000 } }, required: ['id'], additionalProperties: false } } },
  { type: 'function', function: { name: 'recall_memory', description: 'Browse or search source-backed topic notes. Latest revisions are default; inspect old revisions explicitly. Invalid sources and resolved notes must not be treated as current evidence.', parameters: { type: 'object', properties: { query: { type: 'string' }, key: { type: 'string' }, revisions: { type: 'boolean' }, includeResolved: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'remember', description: 'Save or revise a concise constraint, decision, fact, plan or open issue with original source IDs. Use expectedRevision=0 for a new topic, or the current revision when updating/resolving. Retain previous revisions. Notes cannot change the saved goal, permissions, or execution state. Record key decisions before they leave the working window.', parameters: { type: 'object', properties: { key: { type: 'string' }, kind: { type: 'string', enum: ['constraint', 'decision', 'fact', 'plan', 'open_issue'] }, text: { type: 'string' }, sourceIds: { type: 'array', items: { type: 'string' } }, expectedRevision: { type: 'integer', minimum: 0 }, status: { type: 'string', enum: ['active', 'resolved'] } }, required: ['key', 'kind', 'text', 'sourceIds', 'expectedRevision'], additionalProperties: false } } },
];
export const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map(tool => tool.function.name));
for (const tool of MEMORY_TOOLS.filter(tool => ['search_history', 'read_history'].includes(tool.function.name))) {
  const properties = tool.function.parameters.properties as Record<string, unknown>;
  properties.source = { type: 'string', enum: ['current', 'origin_chat'], description: 'Defaults to current conversation. A branched or promoted Work task can read its immutable origin archive (source Task prefix or promoted Chat snapshot).' };
}
export function memoryTool(memory: ScopedMemoryPort, call: Pick<ToolCall, 'name' | 'arguments'>, operationId: string, origin?: ScopedMemoryPort): string | undefined {
  if (call.arguments.source === 'origin_chat') {
    if (!origin || !['search_history', 'read_history'].includes(call.name)) throw new Error('This task has no readable origin Chat archive for this operation.');
    memory = origin;
  } else if (call.arguments.source !== undefined && call.arguments.source !== 'current') throw new Error('Unknown memory source.');
  switch (call.name) {
    case 'search_history': return JSON.stringify(memory.search(call.arguments as unknown as SearchInput));
    case 'read_history': return JSON.stringify(memory.read(call.arguments as unknown as ReadInput));
    case 'recall_memory': return JSON.stringify(memory.notes(call.arguments as NotesInput));
    case 'remember': return JSON.stringify(memory.remember(call.arguments as unknown as NoteInput, operationId));
    default: return undefined;
  }
}
