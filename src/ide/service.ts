import path from 'node:path';
import type { Services } from '../app/services.js';
import type { AgentMetrics } from '../harness/metrics.js';
import type { Message } from '../contracts.js';
import type { ChatMessage, ToolRecord } from '../harness/types.js';
import type { IdeAgentSelection, IdeAgentView } from './types.js';

/** One bounded presentation query over existing authority; no second Chat or Work engine. */
export async function ideAgentView(services: Services, folder: string, selected: IdeAgentSelection): Promise<IdeAgentView> {
  const workspace = await services.ideWorkspace(folder), harness = services.harness;
  if (!harness) throw new Error('The shared Harness is not ready.');
  const sameWorkspace = (value?: string) => Boolean(value && path.resolve(value).toLowerCase() === workspace.path.toLowerCase());
  const tasks = services.kernel.workspaceTaskPage(workspace.path).items;
  const chats = harness.store.workspaceSessions(workspace.path);
  const task = selected.taskId ? services.kernel.getTask(selected.taskId) : undefined;
  const chat = selected.chatId ? harness.store.getSession(selected.chatId) : undefined;
  if (selected.taskId && (!task || !sameWorkspace(task.workspace) || services.kernel.isManagedExternally(task.id))
    || selected.chatId && (!chat || !sameWorkspace(chat.workspace)) || selected.taskId && selected.chatId) throw new Error('The selected task/conversation is not in this IDE workspace.');
  harness.workTrace.sync();
  const scope = task ? { taskId: task.id } : chat ? { sessionId: chat.id } : undefined;
  let messages: (Message | ChatMessage)[] = [], totalMessages = 0;
  if (task) { const page = services.kernel.messagePage(task.id, Number.MAX_SAFE_INTEGER, 80); messages = page.messages; totalMessages = page.totalMessages; }
  if (chat) { const page = harness.chat.sessionView(chat.id, undefined, 80); messages = page.messages; totalMessages = page.totalMessages; }
  const latest = scope ? harness.store.listRequests({ ...scope, order: 'desc', limit: 1 }).requests[0] : undefined;
  const request = latest ? harness.store.getRequest(latest.id) : undefined;
  const url = (route: string) => {
    const query = new URLSearchParams();
    if (task) query.set('taskId', task.id);
    else if (chat) query.set('sessionId', chat.id);
    return new URL(`/v1/harness/${route}?${query}`, 'http://127.0.0.1');
  };
  const tools = scope ? (await harness.route('GET', url('tools'), {}) as { calls: ToolRecord[] }).calls.slice(0, 40) : [];
  const metrics = scope ? await harness.route('GET', url('metrics'), {}) as AgentMetrics : undefined;
  return harness.sanitize({ workspace, providerMode: request ? harness.profiles.get(request.profileId).provider.mode : services.configuration.provider.mode, tasks,
    chats: chats.map(({ id, title, workspace, profileId, updatedAt }) => ({ id, title, workspace, profileId, updatedAt })),
    profiles: harness.profiles.list().map(profile => ({ id: profile.id, name: profile.name, model: profile.provider.model, mode: profile.provider.mode })),
    task, chat, totalMessages, messages: messages.map(message => ({ ...message, content: message.content.slice(0, 24000), ...(message.content.length > 24000 ? { previewTruncated: true } : {}) })),
    request: request ? { id: request.id, kind: request.kind, status: request.status, draft: request.draft.slice(-32000), usage: request.usage, durationMs: request.durationMs, error: request.error, model: request.model, contextWindowTokens: request.contextWindowTokens } : undefined,
    tools, metrics });
}
