import { randomUUID } from 'node:crypto';
import type { Command, GoalContract, Snapshot, Task } from '../contracts.js';
import { BackendClient, type BackendAccess, type HistoryOptions } from './client.js';

export interface CliOptions { dataDir: string; client?: BackendAccess; stdout?: (text: string) => void | Promise<void>; stderr?: (text: string) => void; signal?: AbortSignal; }
export const CLI_HELP = `NPN-Gamma CLI (shared desktop backend)
  health | list
  submit <objective> [--title text] [--mode collaborative|autonomous]
    [--workspace path] [--constraint text] [--accept text] [--max-calls number]
  status|events|history|result <task-id>
    events/history: [--after-seq number | --cursor number] [--limit 1..1000] [--through number]
    history: [--kind messages|events] (default messages). Every response is one bounded page.
  export-history <task-id> [--kind messages|events|all] [--limit 1..1000]
    Streams NDJSON pages and a final completion record; default kind is all.
  cancel|retry|resume <task-id> [--expected-revision number]
All commands: [--data-dir path]; mutations: [--command-id stable-id]
Use NPN-MCP.cmd for newline-delimited MCP stdio (stdout is protocol only).
`;

interface ParsedArgs { command: string; positional: string[]; flags: Record<string, string[]>; }
function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: args[0] ?? 'help', positional: [], flags: {} };
  const allowed = new Set(['data-dir', 'title', 'mode', 'workspace', 'constraint', 'accept', 'max-calls', 'command-id', 'expected-revision', 'after-seq', 'cursor', 'limit', 'through', 'kind']);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) { parsed.positional.push(arg); continue; }
    const key = arg.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown option --${key}.`);
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`Option --${key} requires a value.`);
    if (parsed.flags[key] && !['constraint', 'accept'].includes(key)) throw new Error(`Option --${key} may appear once.`);
    (parsed.flags[key] ??= []).push(value);
  }
  return parsed;
}
function positiveInteger(value: string | undefined, fallback: number, name: string, minimum = 1): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > 1_000_000) throw new Error(`${name} must be an integer from ${minimum} to 1000000.`);
  return number;
}
export function taskFromSnapshot(snapshot: Snapshot, taskId: string): Task {
  const task = snapshot.selectedTask?.id === taskId ? snapshot.selectedTask : snapshot.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`Task ${taskId} was not found.`);
  return task;
}
function historyOptions(flags: ParsedArgs['flags']): HistoryOptions {
  const options: HistoryOptions = {};
  for (const [flag, key] of [['after-seq', 'afterSeq'], ['cursor', 'cursor'], ['limit', 'limit'], ['through', 'throughSeq']] as const) {
    if (flags[flag]) {
      const value = Number(flags[flag][0]);
      if (!Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0) || (key === 'limit' && value > 1000)) throw new Error(`${flag} is outside the supported integer range.`);
      options[key] = value;
    }
  }
  if (options.afterSeq !== undefined && options.cursor !== undefined) throw new Error('Specify --after-seq or --cursor, not both.');
  return options;
}

/** Returns a process exit code; output is JSON for automation, diagnostics go to stderr. */
export async function runCli(args: string[], options: CliOptions): Promise<number> {
  const out = options.stdout ?? (text => new Promise<void>((resolve, reject) => { process.stdout.write(text, error => error ? reject(error) : resolve()); }));
  const err = options.stderr ?? (text => { process.stderr.write(text); });
  try {
    const parsed = parseArgs(args);
    const { command, positional, flags } = parsed;
    if (['help', '--help', '-h'].includes(command)) { await out(CLI_HELP); return 0; }
    if (!['events', 'history', 'export-history'].includes(command) && ['after-seq', 'cursor', 'limit', 'through', 'kind'].some(flag => flags[flag])) throw new Error('History pagination options require events, history or export-history.');
    const client = options.client ?? new BackendClient({ dataDir: flags['data-dir']?.[0] ?? options.dataDir });
    let result: unknown;
    if (command === 'health') result = await client.health(options.signal);
    else if (command === 'list') result = { tasks: (await client.snapshot(undefined, options.signal)).tasks, historyWindow: true };
    else if (command === 'submit') {
      const objective = positional.join(' ').trim();
      if (!objective) throw new Error('submit requires an objective.');
      const mode = flags.mode?.[0] ?? 'collaborative';
      if (mode !== 'collaborative' && mode !== 'autonomous') throw new Error('mode must be collaborative or autonomous.');
      const goal: GoalContract = { objective, mode, constraints: flags.constraint ?? [], acceptance: flags.accept ?? [], maxModelCalls: positiveInteger(flags['max-calls']?.[0], 20, 'max-calls') };
      result = await client.command({ commandId: flags['command-id']?.[0] ?? randomUUID(), type: 'submit', parameters: { title: flags.title?.[0] ?? objective.slice(0, 80), goal, ...(flags.workspace?.[0] ? { workspace: flags.workspace[0] } : {}) } });
    } else if (['status', 'events', 'history', 'export-history', 'result', 'cancel', 'retry', 'resume'].includes(command)) {
      const taskId = positional[0];
      if (!taskId || positional.length !== 1) throw new Error(`${command} requires exactly one task ID.`);
      if (['cancel', 'retry', 'resume'].includes(command)) {
        const control: Command = { commandId: flags['command-id']?.[0] ?? randomUUID(), type: command, taskId, ...(flags['expected-revision']?.[0] === undefined ? {} : { expectedRevision: positiveInteger(flags['expected-revision'][0], 0, 'expected-revision', 0) }) };
        result = await client.command(control);
      } else if (['events', 'history', 'export-history'].includes(command)) {
        const kind = flags.kind?.[0] ?? (command === 'events' ? 'events' : command === 'export-history' ? 'all' : 'messages');
        if (!['messages', 'events', ...(command === 'export-history' ? ['all'] : [])].includes(kind) || command === 'events' && kind !== 'events') throw new Error('Select a supported history kind: messages or events; export-history also supports all.');
        const query = historyOptions(flags);
        const read = async (section: string, page: HistoryOptions) => {
          options.signal?.throwIfAborted();
          if (section === 'events') return client.events(taskId, page, options.signal);
          if (!client.messages) throw new Error('This backend client does not support paged message history.');
          return client.messages(taskId, page, options.signal);
        };
        if (command === 'export-history') {
          if (kind === 'all' && (query.cursor !== undefined || query.afterSeq !== undefined || query.throughSeq !== undefined)) throw new Error('A continuation cursor requires one explicit export kind.');
          const sections = kind === 'all' ? ['messages', 'events'] : [kind];
          const first = await Promise.all(sections.map(section => read(section, query)));
          let pages = 0, messages = 0, events = 0;
          const through: Record<string, number | undefined> = {};
          for (const [index, section] of sections.entries()) {
            let page = first[index]!;
            through[section] = page.page?.throughSeq;
            for (;;) {
              if (!page.page || !Number.isSafeInteger(page.page.throughSeq)) throw new Error('The backend did not provide a bounded history cursor and watermark.');
              options.signal?.throwIfAborted();
              await out(JSON.stringify({ type: 'page', taskId, kind: section, ...page, historyWindow: true }) + '\n');
              options.signal?.throwIfAborted();
              pages++; messages += 'messages' in page ? page.messages.length : 0; events += 'events' in page ? page.events.length : 0;
              if (page.page.nextCursor === null) break;
              if (page.page.nextCursor <= page.page.afterSeq) throw new Error('History cursor did not advance.');
              page = await read(section, { cursor: page.page.nextCursor, limit: query.limit, throughSeq: through[section] });
            }
          }
          await out(JSON.stringify({ type: 'complete', taskId, pages, messages, events, through }) + '\n');
          return 0;
        }
        result = { taskId, kind, ...await read(kind, query), historyWindow: true };
      } else {
        const snapshot = await client.snapshot(taskId, options.signal);
        const task = taskFromSnapshot(snapshot, taskId);
        if (command === 'status') result = task;
        else result = { taskId, status: task.status, result: task.result ?? null, error: task.error ?? null, waitingReason: task.waitingReason ?? null, intents: snapshot.intents, historyWindow: true };
      }
    } else throw new Error(`Unknown command ${command}. Run help for available commands.`);
    await out(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
