/**
 * 演示网关：在浏览器内存中模拟后台，用于预览与设计验收。
 * 行为（流式、审批、自动审查、权限拒绝、取消、任务控制）与契约语义一致，
 * 但所有数据都是演示数据，ConnectionInfo.demo = true，界面常驻标记。
 */
import { GatewayError, type DeepPartial, type NpnGateway } from '../contract';
import type { LibraryGateway } from '../library-types';
import { decideForMode, reviewEscalates } from '../policy';
import { applyReasoningMapping, defaultLevel } from '../../lib/models';
import { MockWorkspace } from './workspace';
import type {
  ApprovalDecision, ApprovalRequest, Capability, ChatMessage, ContextView, FileDiff, GatewayEvent, MessagePart,
  McpServerInput, McpServerView, MetricsView, ModelProfile, ModelProfileInput, PromptPart, SideAnswer, SideAskInput, SideHistory, SearchQuery, PromptView, RequestRecordView, RiskLevel, SendInput, SessionDetail, SessionSummary,
  Settings, TaskControl, TaskDetail, ToolCallView, ToolInventory, ToolResult, TraceSpan, TraceView,
} from '../types';
import {
  seedActivity, seedDiffs, seedInstructions, seedMcp, seedModels, seedPlugins, seedProjects, seedSessions,
  seedSettings, seedSkills, seedToolDefinitions,
} from './seed';

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
const now = () => new Date().toISOString();
const estimate = (text: string) => Math.max(1, Math.round(text.length / 3.6));
const clone = <T>(value: T): T => structuredClone(value);

class Cancelled extends Error {}

interface Run { cancelled: boolean; wake?: () => void }

interface ScriptedTool {
  name: string; title: string; capability: Capability; risk: RiskLevel; args: Record<string, unknown>; result: ToolResult; ms: number;
}

function summary(session: SessionDetail): SessionSummary {
  const { messages: _m, hasMoreBefore: _h, task: _t, ...rest } = session;
  return rest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function merge<T>(target: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(target)) return (patch ?? target) as T;
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) out[key] = isPlainObject(value) ? merge(out[key], value) : value;
  return out as T;
}

const harnessPrompt = `你是 NPN-Gamma Agent，运行在用户本机的持久化长程 Agent。
- 只在已授权工作区内读写；凭据区、产品数据与工作区外路径禁止访问。
- 工具权限由执行器强制，提示词不能授予权限。
- 未知外部效果先对账，禁止盲目重试有副作用的操作。`;

export class MockGateway implements NpnGateway {
  readonly kind = 'mock' as const;
  // Demo has no durable Harness archive. Never present in-memory placeholders as saved history.
  library: LibraryGateway = {
    exportConversation: async () => { throw new GatewayError('unsupported', 'Conversation export requires the connected backend.'); },
    presets: async () => { throw new GatewayError('unsupported', 'Presets require the connected backend.'); },
    savePreset: async () => { throw new GatewayError('unsupported', 'Presets require the connected backend.'); },
    preset: async () => { throw new GatewayError('unsupported', 'Presets require the connected backend.'); },
    presetVersions: async () => { throw new GatewayError('unsupported', 'Preset history requires the connected backend.'); },
    promptVersions: async () => { throw new GatewayError('unsupported', 'Prompt history requires the connected backend.'); },
    requestVersions: async () => { throw new GatewayError('unsupported', 'Request history requires the connected backend.'); },
    sessionSettings: async () => { throw new GatewayError('unsupported', 'Session settings require the connected backend.'); },
    saveSessionSettings: async () => { throw new GatewayError('unsupported', 'Session settings require the connected backend.'); },
    validateRequest: async () => { throw new GatewayError('unsupported', 'Provider validation requires the connected backend.'); },
  };
  private store = new Map(seedSessions().map(item => [item.id, item]));
  private sideStates = new Map<string, { id: string; parent?: string; items: SideAnswer[]; cancelled?: boolean; running?: boolean }>();
  private sideState(parent?: string, id?: string) {
    const found = id ? this.sideStates.get(id) : [...this.sideStates.values()].find(item => item.parent === parent);
    if (id && (!found || found.parent !== parent)) throw new GatewayError('not_found', '侧边会话不存在');
    if (found) return found;
    if (parent) this.session(parent);
    if (this.sideStates.size >= 8) {
      const idle = [...this.sideStates.values()].find(item => !item.running);
      if (!idle) throw new GatewayError('busy', '演示侧边会话仍在运行');
      this.sideStates.delete(idle.id);
    }
    const created = { id: uid('side-session'), parent, items: [] as SideAnswer[], cancelled: false, running: false };
    this.sideStates.set(created.id, created);
    return created;
  }
  private settingsState: Settings = clone(seedSettings);
  private listeners = new Set<(event: GatewayEvent) => void>();
  private approvalsState = new Map<string, ApprovalRequest>();
  private approvalWaiters = new Map<string, (decision: ApprovalDecision) => void>();
  private runs = new Map<string, Run>();
  private requestLog = new Map<string, RequestRecordView[]>();
  private promptEdits = new Map<string, Map<string, { content: string; version: number }>>();
  private projectsState = clone(seedProjects);
  private skillsState = clone(seedSkills);
  private mcpState = clone(seedMcp);
  private modelsState = clone(seedModels);
  private ide = new MockWorkspace(projectId => this.projectsState.find(p => p.id === projectId)?.path ?? 'D:\\Example\\project');
  private diffState = new Map(Object.entries(clone(seedDiffs)));

  constructor() {
    const pending = this.store.get('s-cowork');
    const call = pending?.messages.flatMap(m => m.parts).find(p => p.kind === 'tool' && p.call.status === 'awaiting_approval');
    if (pending && call?.kind === 'tool') {
      this.approvalsState.set('ap-1', {
        id: 'ap-1', sessionId: pending.id, toolCallId: call.call.id, title: '运行整套回归 npm test', reason: '审查器认为资源占用超出自动放行范围',
        capability: 'exec', risk: 'high', preview: 'PS D:\\Example\\workbench> npm test', previewKind: 'command', digest: 'sha256:5e1d…a90c', createdAt: pending.updatedAt, review: call.call.review,
      });
      this.approvalWaiters.set('ap-1', decision => void this.finishSeedApproval(pending.id, call.call.id, decision));
    }
  }

  // ---------- 基础 ----------
  async connection() {
    await this.pause(120);
    return { status: 'online' as const, demo: true, backendVersion: 'demo-gateway', latencyMs: 4 };
  }

  subscribe(listener: (event: GatewayEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: GatewayEvent) {
    for (const listener of this.listeners) listener(clone(event));
  }

  private pause(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)); }

  private session(id: string) {
    const session = this.store.get(id);
    if (!session) throw new GatewayError('not_found', `会话不存在：${id}`);
    return session;
  }

  private touch(session: SessionDetail, patch: Partial<SessionSummary> = {}) {
    Object.assign(session, patch, { updatedAt: now() });
    this.emit({ type: 'session.upsert', session: summary(session) });
  }

  private pushMessage(session: SessionDetail, message: ChatMessage) {
    const index = session.messages.findIndex(item => item.id === message.id);
    if (index >= 0) session.messages[index] = message; else session.messages.push(message);
    this.emit({ type: 'message.upsert', sessionId: session.id, message });
  }

  // ---------- sessions ----------
  sessions = {
    list: async (query: { mode?: SessionSummary['mode']; text?: string; projectId?: string; cursor?: string; limit?: number }) => {
      await this.pause(80);
      const text = query.text?.trim().toLowerCase();
      const limit = query.limit ?? 200;
      const boundary: unknown = query.cursor === undefined ? undefined : JSON.parse(query.cursor);
      if (boundary !== undefined && (!Array.isArray(boundary) || boundary.length !== 2 || boundary.some(value => typeof value !== 'string'))) {
        throw new GatewayError('validation', '无效的会话分页游标。');
      }
      const items = [...this.store.values()]
        .filter(item => !query.mode || item.mode === query.mode)
        .filter(item => !query.projectId || item.projectId === query.projectId)
        .filter(item => !text || item.title.toLowerCase().includes(text) || item.preview?.toLowerCase().includes(text))
        .filter(item => !Array.isArray(boundary) || item.updatedAt.localeCompare(boundary[0]) < 0 ||
          (item.updatedAt === boundary[0] && item.id.localeCompare(boundary[1]) < 0))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
        .slice(0, limit + 1)
        .map(summary);
      const page = items.slice(0, limit), last = page.at(-1);
      return { items: page, ...(last && items.length > page.length ? { nextCursor: JSON.stringify([last.updatedAt, last.id]) } : {}) };
    },
    get: async (id: string) => { await this.pause(90); return clone(this.session(id)); },
    update: async (id: string, patch: Partial<Pick<SessionSummary, 'title' | 'pinned' | 'permission' | 'modelId' | 'reasoningEffort'>>) => {
      const session = this.session(id);
      this.touch(session, patch);
      if (patch.permission) this.emit({ type: 'inspector.invalidated', sessionId: id });
      return summary(session);
    },
    remove: async (id: string) => {
      this.session(id);
      this.store.delete(id);
      this.emit({ type: 'session.removed', sessionId: id });
    },
    branch: async (id: string, messageId: string) => {
      const source = this.session(id), index = source.messages.findIndex(item => item.id === messageId);
      if (index < 0) throw new GatewayError('not_found', '分叉点消息不存在');
      const branch: SessionDetail = { ...clone(source), id: uid('s'), title: `${source.title} · 分叉`, createdAt: now(), updatedAt: now(), status: 'idle', pinned: false, parentSessionId: id, messages: clone(source.messages.slice(0, index + 1)), task: undefined };
      this.store.set(branch.id, branch);
      this.emit({ type: 'session.upsert', session: summary(branch) });
      return summary(branch);
    },
    promote: async (id: string, goal: { objective: string; acceptance: string[] }) => {
      const source = this.session(id);
      const task: TaskDetail = {
        id: uid('t'), title: goal.objective.slice(0, 40), status: 'queued', phase: '排队中', goal: { objective: goal.objective, constraints: [], acceptance: goal.acceptance, mode: 'collaborative' },
        plan: [{ id: uid('p'), title: '确认目标与验收标准', status: 'active' }], budget: { modelCalls: 0, maxModelCalls: 60, toolCalls: 0, maxToolCalls: 120, tokens: 0 },
        checkpoints: [], subagents: [], verification: { status: 'pending', items: goal.acceptance.map(label => ({ label, status: 'pending' as const })) }, startedAt: now(), updatedAt: now(),
      };
      const work: SessionDetail = { ...clone(source), id: uid('s'), mode: 'cowork', title: task.title, createdAt: now(), updatedAt: now(), status: 'idle', parentSessionId: id, task, pinned: false };
      this.store.set(work.id, work);
      this.emit({ type: 'session.upsert', session: summary(work) });
      return summary(work);
    },
  };

  // ---------- chat ----------
  chat = {
    send: async (input: SendInput) => {
      if (!input.text.trim()) throw new GatewayError('validation', '消息不能为空');
      if (input.sessionId && this.runs.has(input.sessionId)) throw new GatewayError('busy', '当前会话仍在运行，请先停止或等待完成');
      const session = input.sessionId ? this.session(input.sessionId) : this.createSession(input);
      const user: ChatMessage = { id: uid('m'), role: 'user', createdAt: now(), status: 'done', parts: [{ kind: 'text', text: input.text }], attachments: input.attachments };
      this.pushMessage(session, user);
      this.touch(session, { status: 'streaming', preview: input.text.slice(0, 60), permission: input.permission, modelId: input.modelId, reasoningEffort: input.reasoningEffort });
      const messageId = uid('m');
      void this.run(session, input, messageId);
      return { sessionId: session.id, messageId };
    },
    cancel: async (sessionId: string) => {
      const run = this.runs.get(sessionId);
      if (!run) return;
      run.cancelled = true;
      run.wake?.();
      for (const approval of [...this.approvalsState.values()].filter(item => item.sessionId === sessionId)) this.resolveApproval(approval.id, { approved: false, scope: 'once', note: 'cancelled' });
    },
    regenerate: async (sessionId: string, messageId: string) => {
      const session = this.session(sessionId);
      const index = session.messages.findIndex(item => item.id === messageId);
      const user = [...session.messages.slice(0, index)].reverse().find(item => item.role === 'user');
      if (!user) throw new GatewayError('not_found', '找不到可重新生成的用户消息');
      session.messages = session.messages.filter(item => item.id !== messageId);
      this.emit({ type: 'session.upsert', session: summary(session) });
      const text = user.parts.find(part => part.kind === 'text');
      this.touch(session, { status: 'streaming' });
      void this.run(session, { sessionId, mode: session.mode, text: text?.kind === 'text' ? text.text : '', attachments: [], permission: session.permission, modelId: session.modelId }, uid('m'));
    },
    edit: async (sessionId: string, messageId: string, text: string) => {
      if (!text.trim()) throw new GatewayError('validation', '消息不能为空');
      if (this.runs.has(sessionId)) throw new GatewayError('busy', '当前会话仍在运行，请先停止或等待完成');
      const session = this.session(sessionId);
      const index = session.messages.findIndex(item => item.id === messageId);
      const original = session.messages[index];
      if (!original || original.role !== 'user') throw new GatewayError('not_found', '找不到要编辑的用户消息');
      const edited: ChatMessage = { ...original, parts: [{ kind: 'text', text }], createdAt: now() };
      session.messages = [...session.messages.slice(0, index), edited];
      this.emit({ type: 'session.upsert', session: summary(session) });
      this.emit({ type: 'message.upsert', sessionId, message: edited });
      this.touch(session, { status: 'streaming', preview: text.slice(0, 60) });
      void this.run(session, { sessionId, mode: session.mode, text, attachments: original.attachments ?? [], permission: session.permission, modelId: session.modelId, reasoningEffort: session.reasoningEffort }, uid('m'));
    },
    sideAsk: async (input: SideAskInput) => {
      if (!input.question.trim()) throw new GatewayError('validation', '问题不能为空');
      const session = input.sessionId ? this.session(input.sessionId) : undefined;
      const side = this.sideState(input.sessionId, input.sideSessionId);
      const existing = input.messageId ? side.items.find(item => item.id === input.messageId) : undefined;
      if (existing) {
        if (existing.question !== input.question) throw new GatewayError('conflict', '输入标识已用于其他问题');
        return clone(existing);
      }
      if (side.running) throw new GatewayError('busy', '当前侧边请求仍在运行');
      const model = this.modelsState.find(m => m.id === input.modelId);
      const turn = side.items.length + 1, files = input.attachments.length ? `，附带 ${input.attachments.length} 个附件` : '';
      const answer: SideAnswer = { id: input.messageId ?? uid('side'), sideSessionId: side.id, question: input.question, createdAt: now(), attachments: input.attachments, modelId: input.modelId, answer: '', status: 'running', operations: [] };
      side.items = [...side.items.slice(-79), answer]; side.running = true; side.cancelled = false;
      await this.pause(900);
      const context = session
        ? `关联「${session.title}」：当前会话共 ${session.messages.length} 条消息${session.task ? `，任务处于“${session.task.phase}”` : ''}。`
        : '没有读取任何会话上下文。';
      answer.status = side.cancelled ? 'cancelled' : 'completed'; side.running = false;
      answer.answer = side.cancelled ? '侧边请求已停止。' : `（演示 · ${model?.name ?? input.modelId}${input.reasoningEffort ? ` · ${input.reasoningEffort}` : ''} · 第 ${turn} 轮${files}）${context}\n\n关于“${input.question.slice(0, 40)}”：已保存至演示侧边历史。任务操作需连接真实后台，演示不会伪造操作回执。`;
      return clone(answer);
    },
    sideHistory: async (input: { sessionId?: string; sideSessionId?: string; before?: string }): Promise<SideHistory> => {
      const side = this.sideState(input.sessionId, input.sideSessionId);
      const end = input.before ? side.items.findIndex(item => item.id === input.before) : side.items.length;
      const start = Math.max(0, end - 40), items = side.items.slice(start, end);
      return { sideSessionId: side.id, items: clone(items), nextCursor: start ? items[0]?.id : undefined };
    },
    sideCancel: async (input: { sessionId?: string; sideSessionId: string }) => { this.sideState(input.sessionId, input.sideSessionId).cancelled = true; },
    sideClear: async (input: { sessionId?: string; sideSessionId: string }) => {
      const side = this.sideState(input.sessionId, input.sideSessionId); side.cancelled = true; this.sideStates.delete(side.id);
    },
  };

  web = {
    fetch: async (url: string) => {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new GatewayError('validation', `不是有效的网址：${url}`); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new GatewayError('validation', '只支持 http / https 网址');
      await this.pause(700);
      const host = parsed.hostname.replace(/^www\./, '');
      return {
        url: parsed.href, status: 200, fetchedAt: now(), title: `${host} · 阅读模式（演示）`,
        text: `## ${host}\n\n这是演示网关生成的阅读模式内容，用于展示侧边浏览器的界面。接入后台后，正文由 \`POST /v1/web/fetch\` 抓取并附带来源与抓取时间。\n\n- 地址：${parsed.href}\n- 路径：\`${parsed.pathname}\`\n\n> 页面中的脚本不会在 NPN-Gamma 中执行；链接在侧边面板内以阅读模式打开。`,
      };
    },
    search: async (query: string) => {
      if (!query.trim()) throw new GatewayError('validation', '搜索词不能为空');
      await this.pause(600);
      return [
        { title: `${query} - 官方文档`, url: `https://docs.example.com/search?q=${encodeURIComponent(query)}`, snippet: `与“${query}”相关的官方说明与示例（演示结果）。` },
        { title: `${query} 的最佳实践`, url: `https://blog.example.com/${encodeURIComponent(query)}`, snippet: '社区整理的实践要点与常见坑（演示结果）。' },
        { title: `讨论：${query}`, url: `https://forum.example.com/t/${encodeURIComponent(query)}`, snippet: '开发者论坛中的相关讨论（演示结果）。' },
      ];
    },
  };

  private createSession(input: SendInput): SessionDetail {
    const title = input.text.replace(/\s+/g, ' ').trim().slice(0, 28) || '新会话';
    const session: SessionDetail = { id: uid('s'), mode: input.mode, title, createdAt: now(), updatedAt: now(), status: 'idle', permission: input.permission, modelId: input.modelId, reasoningEffort: input.reasoningEffort, projectId: input.mode === 'chat' ? undefined : input.projectId ?? 'p-agent', hasMoreBefore: false, messages: [] };
    if (input.mode !== 'chat') session.task = this.newTask(input);
    this.store.set(session.id, session);
    this.emit({ type: 'session.upsert', session: summary(session) });
    return session;
  }

  private newTask(input: SendInput): TaskDetail {
    return {
      id: uid('t'), title: input.text.slice(0, 40), status: 'running', phase: input.planFirst ? '规划中' : '实施中',
      goal: { objective: input.text, constraints: ['只在当前工作区内修改', '不放宽现有测试'], acceptance: ['相关测试通过', '变更有可读 Diff'], mode: input.planFirst ? 'collaborative' : 'autonomous' },
      plan: [
        { id: uid('p'), title: '定位相关代码', status: 'active' },
        { id: uid('p'), title: '实施最小修改', status: 'todo' },
        { id: uid('p'), title: '运行验证', status: 'todo' },
        { id: uid('p'), title: '汇总证据', status: 'todo' },
      ],
      budget: { modelCalls: 0, maxModelCalls: 40, toolCalls: 0, maxToolCalls: 80, tokens: 0 },
      checkpoints: [], subagents: [], verification: { status: 'pending', items: [{ label: '相关测试', status: 'pending' }, { label: 'Diff 审阅', status: 'pending' }] },
      startedAt: now(), updatedAt: now(),
    };
  }

  private async run(session: SessionDetail, input: SendInput, messageId: string) {
    const run: Run = { cancelled: false };
    this.runs.set(session.id, run);
    const started = performance.now(), requestId = uid('rq');
    const message: ChatMessage = { id: messageId, role: 'assistant', createdAt: now(), status: 'streaming', parts: [], requestId, model: this.modelsState.find(m => m.id === input.modelId)?.model ?? input.modelId };
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      if (run.cancelled) return reject(new Cancelled());
      const timer = setTimeout(() => { run.wake = undefined; resolve(); }, ms);
      run.wake = () => { clearTimeout(timer); reject(new Cancelled()); };
    });
    const flush = () => this.pushMessage(session, clone(message));
    const stream = async (part: Extract<MessagePart, { kind: 'text' | 'reasoning' }>, text: string, speed = 1) => {
      message.parts.push(part);
      for (let i = 0; i < text.length;) {
        const step = 2 + Math.floor(Math.random() * 5);
        part.text = text.slice(0, i += step);
        flush();
        await wait(18 / speed);
      }
    };
    try {
      await wait(380);
      const reasoningStart = performance.now();
      const reasoning: Extract<MessagePart, { kind: 'reasoning' }> = { kind: 'reasoning', text: '' };
      await stream(reasoning, this.reasoningFor(input), 2.4);
      reasoning.durationMs = Math.round(performance.now() - reasoningStart);
      flush();
      const tools = this.toolsFor(input);
      for (const [index, spec] of tools.entries()) {
        await this.runTool(session, message, spec, run, wait, flush, requestId);
        if (session.task) this.advancePlan(session, index + 1, tools.length);
      }
      await stream({ kind: 'text', text: '' }, this.answerFor(input, message));
      message.status = 'done';
      message.durationMs = Math.round(performance.now() - started);
      const promptTokens = estimate(harnessPrompt) + session.messages.reduce((n, m) => n + estimate(JSON.stringify(m.parts)), 0);
      message.usage = { input: promptTokens, output: estimate(JSON.stringify(message.parts)), cached: Math.round(promptTokens * (0.3 + Math.random() * 0.5)) };
      flush();
      if (session.task) this.finishTask(session);
      this.touch(session, { status: session.task ? 'completed' : 'idle', preview: this.plain(message).slice(0, 60) });
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      message.status = 'cancelled';
      for (const part of message.parts) if (part.kind === 'tool' && ['running', 'awaiting_approval', 'reviewing', 'pending'].includes(part.call.status)) part.call.status = 'cancelled';
      message.parts.push({ kind: 'notice', tone: 'warn', text: '已由你停止。未执行的工具调用不会产生副作用。' });
      flush();
      if (session.task) { session.task.status = 'paused'; session.task.phase = '已停止'; this.emit({ type: 'task.updated', sessionId: session.id, task: clone(session.task) }); }
      this.touch(session, { status: 'idle' });
    } finally {
      this.runs.delete(session.id);
      this.recordRequest(session, message, input);
      this.emit({ type: 'metrics.updated', sessionId: session.id, metrics: this.computeMetrics(session) });
      this.emit({ type: 'inspector.invalidated', sessionId: session.id });
    }
  }

  private async runTool(session: SessionDetail, message: ChatMessage, spec: ScriptedTool, run: Run, wait: (ms: number) => Promise<void>, pushMessage: () => void, requestId: string) {
    // 工具状态变化时同时让 Inspector 重新拉取，运行中也能看到实时轨迹
    const flush = () => { pushMessage(); this.emit({ type: 'inspector.invalidated', sessionId: session.id }); };
    const call: ToolCallView = { id: uid('tc'), name: spec.name, title: spec.title, source: spec.name.includes('.') ? 'mcp' : spec.name === 'web_search' ? 'plugin' : 'builtin', capability: spec.capability, risk: spec.risk, args: spec.args, status: 'pending', requestId, startedAt: now() };
    message.parts.push({ kind: 'tool', call });
    flush();
    await wait(260);
    let outcome = decideForMode(session.mode, session.permission, spec.capability, spec.risk);
    if (outcome === 'deny') {
      call.status = 'blocked';
      call.error = { stage: 'permission', message: `只读模式拒绝「${spec.title}」，未产生任何副作用。切换权限模式后可重新发送。` };
      flush();
      return;
    }
    if (outcome === 'review') {
      call.status = 'reviewing';
      flush();
      await wait(1100);
      const blocked = spec.risk === 'critical';
      const escalate = !blocked && reviewEscalates(spec.risk, this.settingsState.autoReview.escalateAt);
      call.review = {
        reviewer: '审查器 · Flash', verdict: blocked ? 'block' : escalate ? 'escalate' : 'pass', risk: spec.risk, durationMs: 1100,
        reason: blocked ? '操作会删除工作区外不可恢复的数据，已阻止。' : escalate ? `${spec.title} 的风险等级达到升级阈值，转交你确认。` : '修改限于工作区内，与目标契约一致，无凭据或外部写入。',
        checks: [{ label: '路径在工作区内', ok: !blocked }, { label: '与目标契约一致', ok: true }, { label: '可回滚', ok: spec.capability !== 'exec' || !escalate }],
      };
      if (blocked) { call.status = 'blocked'; call.error = { stage: 'permission', message: '自动审查阻止了该操作。' }; flush(); return; }
      outcome = escalate ? 'ask' : 'allow';
      flush();
    }
    if (outcome === 'ask') {
      call.status = 'awaiting_approval';
      const approval: ApprovalRequest = {
        id: uid('ap'), sessionId: session.id, toolCallId: call.id, title: spec.title, reason: call.review ? call.review.reason : `${session.permission === 'ask' ? '每步询问模式' : '关键操作'}需要你的批准`,
        capability: spec.capability, risk: spec.risk, preview: spec.result.kind === 'diff' ? spec.result.diff.hunks.flatMap(h => h.lines.map(l => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`)).join('\n') : String(spec.args.command ?? JSON.stringify(spec.args, null, 2)),
        previewKind: spec.result.kind === 'diff' ? 'diff' : spec.args.command ? 'command' : 'json', digest: `sha256:${Math.random().toString(16).slice(2, 10)}…`, createdAt: now(), review: call.review,
      };
      call.approvalId = approval.id;
      this.approvalsState.set(approval.id, approval);
      this.touch(session, { status: 'waiting_approval' });
      if (session.task) { session.task.status = 'waiting_approval'; session.task.waitingReason = `等待批准：${spec.title}`; this.emit({ type: 'task.updated', sessionId: session.id, task: clone(session.task) }); }
      flush();
      this.emit({ type: 'approval.requested', approval: clone(approval) });
      const decision = await new Promise<ApprovalDecision>(resolve => { this.approvalWaiters.set(approval.id, resolve); });
      if (run.cancelled) throw new Cancelled();
      this.touch(session, { status: 'streaming' });
      if (session.task) { session.task.status = 'running'; session.task.waitingReason = undefined; this.emit({ type: 'task.updated', sessionId: session.id, task: clone(session.task) }); }
      if (!decision.approved) {
        call.status = 'denied';
        call.error = { stage: 'permission', message: '你拒绝了该操作，Agent 将调整方案。' };
        flush();
        return;
      }
    }
    call.status = 'running';
    flush();
    await wait(spec.ms);
    call.status = 'succeeded';
    call.durationMs = spec.ms;
    call.result = spec.result;
    call.receivedByRequestId = requestId;
    if (spec.result.kind === 'diff') this.diffState.set(session.id, [...(this.diffState.get(session.id) ?? []), { ...spec.result.diff, toolCallId: call.id }]);
    if (session.task) { session.task.budget.toolCalls++; session.task.budget.modelCalls++; }
    flush();
  }

  private advancePlan(session: SessionDetail, done: number, total: number) {
    const task = session.task!;
    const target = Math.min(task.plan.length - 1, Math.floor((done / total) * (task.plan.length - 1)));
    task.plan.forEach((step, i) => { if (step.status !== 'blocked') step.status = i < target ? 'done' : i === target ? 'active' : 'todo'; });
    task.phase = `实施 · 第 ${target + 1}/${task.plan.length} 步`;
    task.updatedAt = now();
    this.emit({ type: 'task.updated', sessionId: session.id, task: clone(task) });
  }

  private finishTask(session: SessionDetail) {
    const task = session.task!;
    task.plan.forEach(step => { step.status = 'done'; });
    task.status = 'completed'; task.phase = '已完成'; task.updatedAt = now();
    task.verification = { status: 'pass', items: task.verification.items.map(item => ({ ...item, status: 'pass' })) };
    task.checkpoints.push({ id: uid('ck'), label: '任务完成', createdAt: now(), messageCount: session.messages.length, digest: Math.random().toString(16).slice(2, 10) });
    this.emit({ type: 'task.updated', sessionId: session.id, task: clone(task) });
  }

  private reasoningFor(input: SendInput) {
    if (input.mode === 'chat') return `用户问的是「${input.text.slice(0, 40)}」。先给结论，再分点解释，最后给一个可直接使用的示例。`;
    return `目标：${input.text.slice(0, 60)}。先检索相关代码确认调用链，再做最小修改，最后运行测试验证。当前权限模式为「${input.permission}」，有副作用的步骤需遵守该模式。`;
  }

  private toolsFor(input: SendInput): ScriptedTool[] {
    const text = input.text;
    if (input.mode === 'chat') {
      if (/搜索|联网|最新|search|新闻/i.test(text)) return [{ name: 'web_search', title: `联网检索「${text.slice(0, 16)}」`, capability: 'network', risk: 'low', args: { query: text }, ms: 1400, result: { kind: 'json', value: { results: [{ title: '官方文档', url: 'https://example.com/docs', fetchedAt: now() }, { title: '社区讨论', url: 'https://example.com/forum', fetchedAt: now() }] } } }];
      return [];
    }
    const diff: FileDiff = { path: 'src/feature.ts', status: 'modified', additions: 3, deletions: 1, applied: true, hunks: [{ header: '@@ -21,6 +21,8 @@', lines: [
      { kind: 'ctx', oldNo: 21, newNo: 21, text: 'export function handle(input: Input) {' },
      { kind: 'del', oldNo: 22, text: '  return process(input);' },
      { kind: 'add', newNo: 22, text: '  const checked = validate(input);' },
      { kind: 'add', newNo: 23, text: '  if (!checked.ok) return checked;' },
      { kind: 'add', newNo: 24, text: '  return process(checked.value);' },
      { kind: 'ctx', oldNo: 23, newNo: 25, text: '}' },
    ] }] };
    const tools: ScriptedTool[] = [
      { name: 'search', title: '检索相关实现', capability: 'read', risk: 'low', args: { pattern: text.slice(0, 12) }, ms: 600, result: { kind: 'files', files: [{ path: 'src/feature.ts', detail: '2 处' }, { path: 'tests/feature.test.ts', detail: '1 处' }] } },
      { name: 'read_file', title: '读取 src/feature.ts', capability: 'read', risk: 'low', args: { path: 'src/feature.ts' }, ms: 400, result: { kind: 'text', text: 'export function handle(input: Input) {\n  return process(input);\n}' } },
      { name: 'apply_patch', title: '修改 src/feature.ts', capability: 'write', risk: 'medium', args: { path: 'src/feature.ts', patch: '+3 −1' }, ms: 700, result: { kind: 'diff', diff } },
      { name: 'run_shell', title: '运行相关测试', capability: 'exec', risk: input.mode === 'code' ? 'medium' : 'high', args: { command: 'node --test build/tests/feature.test.js' }, ms: 2200, result: { kind: 'terminal', command: 'node --test build/tests/feature.test.js', exitCode: 0, output: '▶ feature\n  ✔ rejects invalid input (3ms)\n  ✔ processes valid input (1ms)\n✔ feature (9ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0' } },
    ];
    if (/删除|清理|rm -rf|remove/i.test(text)) tools.push({ name: 'run_shell', title: '删除构建缓存目录', capability: 'exec', risk: 'critical', args: { command: 'Remove-Item -Recurse build' }, ms: 800, result: { kind: 'terminal', command: 'Remove-Item -Recurse build', exitCode: 0, output: '' } });
    return tools;
  }

  private answerFor(input: SendInput, message: ChatMessage) {
    const calls = message.parts.filter((p): p is Extract<MessagePart, { kind: 'tool' }> => p.kind === 'tool').map(p => p.call);
    if (input.mode === 'chat') {
      return `> 这是**演示网关**生成的回答，用于展示界面效果；接入后台后将由真实模型回复。\n\n关于「${input.text.slice(0, 40)}」，可以从三个层面理解：\n\n1. **核心结论**：先明确目标与约束，再选择最小可行方案。\n2. **关键权衡**：可靠性优先于速度，任何有副作用的操作都要可回溯。\n3. **落地方式**：用小步验证代替一次性大改。\n\n| 维度 | 建议 | 说明 |\n| --- | --- | --- |\n| 正确性 | 先写测试 | 失败复现 → 最小修复 |\n| 可观测 | 记录轨迹 | 请求、工具、回执可关联 |\n| 恢复 | 检查点 | 重启后从持久状态继续 |\n\n\`\`\`ts\nexport async function step(task: Task) {\n  const plan = await propose(task);\n  for (const action of plan) await execute(action); // 每步受权限门禁约束\n  return verify(task);\n}\n\`\`\``;
    }
    const blocked = calls.filter(c => ['blocked', 'denied'].includes(c.status));
    const ok = calls.filter(c => c.status === 'succeeded');
    return `${blocked.length ? `有 **${blocked.length}** 个步骤因权限未执行：${blocked.map(c => `\`${c.name}\``).join('、')}。` : '全部步骤已完成。'}\n\n- 成功执行 ${ok.length} 个工具调用\n- 修改文件：${ok.filter(c => c.result?.kind === 'diff').map(c => `\`${(c.result as { kind: 'diff'; diff: FileDiff }).diff.path}\``).join('、') || '无'}\n- 验证：${ok.some(c => c.result?.kind === 'terminal') ? '相关测试 2/2 通过' : '未运行'}\n\n变更可在右侧 **Inspector → Diff** 中逐行审阅。`;
  }

  private plain(message: ChatMessage) {
    return message.parts.map(p => (p.kind === 'text' ? p.text : '')).join(' ').replace(/[#>*`|]/g, '').trim();
  }

  private async finishSeedApproval(sessionId: string, callId: string, decision: ApprovalDecision) {
    const session = this.session(sessionId);
    const message = session.messages.find(m => m.parts.some(p => p.kind === 'tool' && p.call.id === callId))!;
    const part = message.parts.find((p): p is Extract<MessagePart, { kind: 'tool' }> => p.kind === 'tool' && p.call.id === callId)!;
    const task = session.task!;
    if (!decision.approved) {
      part.call.status = 'denied';
      part.call.error = { stage: 'permission', message: '你拒绝了该操作，Agent 将调整方案。' };
      task.status = 'waiting_input'; task.waitingReason = '回归被拒绝，等待新的指示';
      this.pushMessage(session, clone(message));
      this.emit({ type: 'task.updated', sessionId, task: clone(task) });
      this.touch(session, { status: 'idle' });
      return;
    }
    part.call.status = 'running';
    task.status = 'running'; task.waitingReason = undefined;
    this.pushMessage(session, clone(message));
    this.emit({ type: 'task.updated', sessionId, task: clone(task) });
    this.touch(session, { status: 'running' });
    await this.pause(2600);
    part.call.status = 'succeeded'; part.call.durationMs = 2600; part.call.receivedByRequestId = 'rq-5';
    part.call.result = { kind: 'terminal', command: 'npm test', exitCode: 0, output: '> npn-gamma-agent@0.7.0 test\n> node --test --test-concurrency=2 build/tests/*.test.js\n\nℹ tests 318\nℹ suites 41\nℹ pass 317\nℹ fail 0\nℹ skipped 1\nℹ duration_ms 362118' };
    task.plan[2].status = 'done'; task.plan[3].status = 'active'; task.phase = '实施 · 第 4/5 步';
    task.verification.items[1].status = 'pass';
    this.pushMessage(session, clone(message));
    this.emit({ type: 'task.updated', sessionId, task: clone(task) });
    this.touch(session, { status: 'running', preview: '整套回归 317 PASS / 0 FAIL' });
  }

  // ---------- approvals ----------
  approvals = {
    pending: async (sessionId?: string) => [...this.approvalsState.values()].filter(item => !sessionId || item.sessionId === sessionId).map(clone),
    decide: async (approvalId: string, decision: ApprovalDecision) => {
      if (!this.approvalsState.has(approvalId)) throw new GatewayError('stale', '审批已过期或已处理，请刷新');
      this.resolveApproval(approvalId, decision);
    },
  };

  private resolveApproval(approvalId: string, decision: ApprovalDecision) {
    const approval = this.approvalsState.get(approvalId);
    if (!approval) return;
    this.approvalsState.delete(approvalId);
    const waiter = this.approvalWaiters.get(approvalId);
    this.approvalWaiters.delete(approvalId);
    if (decision.approved && decision.scope === 'session') this.settingsState.rules.push({ id: uid('r'), pattern: approval.title, capability: approval.capability, decision: 'allow' });
    this.emit({ type: 'approval.resolved', approvalId, approved: decision.approved });
    waiter?.(decision);
  }

  // ---------- tasks ----------
  tasks = {
    get: async (sessionId: string) => clone(this.session(sessionId).task),
    control: async (taskId: string, action: TaskControl) => {
      const session = [...this.store.values()].find(item => item.task?.id === taskId);
      if (!session?.task) throw new GatewayError('not_found', '任务不存在');
      const task = session.task;
      const terminal = ['completed', 'cancelled'].includes(task.status);
      if (terminal && action !== 'checkpoint') throw new GatewayError('invalid_state', '任务已结束，无法执行该操作');
      if (action === 'pause') { await this.chat.cancel(session.id); task.status = 'paused'; task.phase = '已暂停'; this.touch(session, { status: 'paused' }); }
      if (action === 'resume' || action === 'retry') { task.status = 'running'; task.phase = '恢复执行'; task.waitingReason = undefined; this.touch(session, { status: 'running' }); }
      if (action === 'cancel') { await this.chat.cancel(session.id); task.status = 'cancelled'; task.phase = '已终止'; this.touch(session, { status: 'idle' }); }
      if (action === 'checkpoint') task.checkpoints.push({ id: uid('ck'), label: '手动检查点', createdAt: now(), messageCount: session.messages.length, digest: Math.random().toString(16).slice(2, 10) });
      task.updatedAt = now();
      this.emit({ type: 'task.updated', sessionId: session.id, task: clone(task) });
      return clone(task);
    },
  };

  // ---------- inspector ----------
  private promptParts(session: SessionDetail): PromptPart[] {
    const edits = this.promptEdits.get(session.id) ?? new Map();
    const part = (p: Omit<PromptPart, 'tokens' | 'tokensExact'>): PromptPart => {
      const edit = edits.get(p.id);
      const content = edit?.content ?? p.content;
      return { ...p, content, version: edit?.version ?? p.version, tokens: estimate(content), tokensExact: false };
    };
    const history = session.messages.map(m => this.plain(m)).join('\n');
    return [
      part({ id: 'harness', label: 'Harness 执行约束', role: 'system', scope: 'harness', source: 'src/runtime/prompts.ts', content: harnessPrompt, effective: true, merge: 'locked', editable: false, version: 7 }),
      part({ id: 'identity', label: 'Agent 身份与行为', role: 'system', scope: 'global', source: '设置 → 提示词 → 全局', content: '回答简洁、先结论后细节；不确定时明确说明；不声称未验证的结果。', effective: true, merge: 'override', editable: true, version: 3 }),
      part({ id: 'mode', label: `${session.mode === 'chat' ? 'Chat' : session.mode === 'cowork' ? 'Cowork' : 'Code'} 模式提示词`, role: 'developer', scope: 'harness', source: `src/runtime/prompts.ts#${session.mode}`, content: session.mode === 'chat' ? '这是对话模式：除非用户要求，不调用有副作用的工具。' : '这是长程任务模式：遵循目标契约，按计划推进，每步留下可验证证据。', effective: true, merge: 'append', editable: false }),
      part({ id: 'agents', label: '项目 AGENTS.md', role: 'developer', scope: 'project', source: 'D:\\Example\\workbench\\AGENTS.md', content: 'Use the simplest viable design. Validate once at real trust boundaries…', effective: session.mode !== 'chat', merge: 'append', editable: false }),
      part({ id: 'tools', label: '工具定义与 Schema', role: 'system', scope: 'harness', source: '工具注册表（按权限过滤）', content: JSON.stringify(seedToolDefinitions.filter(t => decideForMode(session.mode, session.permission, t.capability, 'low') !== 'deny').map(t => ({ name: t.name, description: t.description })), null, 2), effective: true, merge: 'locked', editable: false }),
      part({ id: 'memory', label: '长期记忆（检索命中）', role: 'system', scope: 'project', source: 'memory/archive · FTS5 命中 3 条', content: '- [mem-41 · sha 9f2c1a] 用户偏好：先给结论再细节\n- [mem-77 · sha 4be09d] 本项目测试命令：npm test（约 6 分钟）', effective: true, merge: 'append', editable: false }),
      part({ id: 'session', label: '会话自定义指令', role: 'developer', scope: 'session', source: '本会话设置', content: '', effective: false, merge: 'override', editable: true, overriddenBy: undefined }),
      part({ id: 'history', label: '历史消息', role: 'user', scope: 'session', source: `${session.messages.length} 条消息`, content: history || '（空）', effective: true, merge: 'append', editable: false }),
    ];
  }

  inspector = {
    toolDetail: async (): Promise<never> => { throw new GatewayError('unsupported', '演示数据没有持久调用快照，请连接真实后台。'); },
    prompt: async (sessionId: string): Promise<PromptView> => {
      await this.pause(120);
      const parts = this.promptParts(this.session(sessionId));
      return { parts, totalTokens: parts.filter(p => p.effective).reduce((n, p) => n + p.tokens, 0), pendingEdits: this.promptEdits.get(sessionId)?.size ?? 0 };
    },
    savePrompt: async (sessionId: string, partId: string, content: string) => {
      const edits = this.promptEdits.get(sessionId) ?? new Map();
      edits.set(partId, { content, version: (edits.get(partId)?.version ?? 1) + 1 });
      this.promptEdits.set(sessionId, edits);
      return this.inspector.prompt(sessionId);
    },
    requests: async (sessionId: string) => {
      await this.pause(100);
      const session = this.session(sessionId);
      const logged = this.requestLog.get(sessionId) ?? [];
      const synthesized = session.messages.filter(m => m.role === 'assistant' && m.requestId && !logged.some(r => r.id === m.requestId)).map(m => this.buildRequest(session, m));
      return [...synthesized, ...logged].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    replay: async (requestId: string, body: unknown, mode: 'send' | 'branch') => {
      const owner = [...this.store.values()].find(s => s.messages.some(m => m.requestId === requestId) || this.requestLog.get(s.id)?.some(r => r.id === requestId));
      if (!owner) throw new GatewayError('not_found', '请求不存在');
      if (!isPlainObject(body) || !Array.isArray(body.messages)) throw new GatewayError('validation', 'Body 必须包含 messages 数组');
      await this.pause(mode === 'send' ? 1600 : 200);
      const record: RequestRecordView = {
        id: uid('rq'), kind: 'studio', status: mode === 'send' ? 'completed' : 'draft', createdAt: now(), model: String(body.model ?? 'unknown'), endpoint: 'POST /provider/v1/chat/completions', body, redactions: ['headers.authorization'], parentId: requestId, branchLabel: mode === 'branch' ? '分叉草稿' : '有界测试',
        durationMs: mode === 'send' ? 1600 : undefined, firstTokenMs: mode === 'send' ? 420 : undefined,
        usage: mode === 'send' ? { input: estimate(JSON.stringify(body)), output: 96 } : undefined,
        response: mode === 'send' ? { content: '（演示）这是基于编辑后 Body 的一次有界测试响应。工具调用未被重放。', finishReason: 'stop' } : undefined,
      };
      this.requestLog.set(owner.id, [...(this.requestLog.get(owner.id) ?? []), record]);
      this.emit({ type: 'notify', tone: 'success', title: mode === 'send' ? '测试请求已完成' : '已保存为分叉', detail: '工具调用不会被自动重放' });
      return record;
    },
    tools: async (sessionId: string): Promise<ToolInventory> => {
      await this.pause(90);
      const session = this.session(sessionId);
      const allowed = seedToolDefinitions.filter(t => decideForMode(session.mode, session.permission, t.capability, 'low') !== 'deny').map(t => t.name);
      const exposed = session.mode === 'chat' ? allowed.filter(name => ['read_file', 'search', 'web_search', 'read_history'].includes(name)) : allowed;
      return { registered: clone(seedToolDefinitions), allowed, exposed, calls: session.messages.flatMap(m => m.parts.flatMap(p => (p.kind === 'tool' ? [clone(p.call)] : []))) };
    },
    trace: async (sessionId: string, query?: { text?: string; type?: string }): Promise<TraceView> => {
      await this.pause(110);
      const session = this.session(sessionId);
      const spans = this.buildTrace(session).filter(s => (!query?.type || s.type === query.type) && (!query?.text || s.label.toLowerCase().includes(query.text.toLowerCase())));
      return { startedAt: session.createdAt, spans, hasMore: false };
    },
    context: async (sessionId: string): Promise<ContextView> => {
      await this.pause(90);
      const session = this.session(sessionId), parts = this.promptParts(session);
      const tokens = (id: string) => parts.find(p => p.id === id)?.tokens ?? 0;
      const historyItems = session.messages.map(m => ({ label: `${m.role === 'user' ? '用户' : '助手'} · ${this.plain(m).slice(0, 18) || '工具调用'}`, tokens: estimate(JSON.stringify(m.parts)), sourceId: m.id, sha: m.id.slice(-6) }));
      const window = this.modelsState.find(m => m.id === session.modelId)?.contextWindow ?? 64_000;
      const segments: ContextView['segments'] = [
        { id: 'system', label: '系统与 Harness', kind: 'system', tokens: tokens('harness') + tokens('identity') + tokens('mode') + 1800 },
        { id: 'tools', label: '工具定义', kind: 'tools', tokens: tokens('tools') + 2400 },
        { id: 'memory', label: '长期记忆', kind: 'memory', tokens: tokens('memory') + 900, items: [{ label: 'mem-41 用户偏好', tokens: 120, sourceId: 'mem-41', sha: '9f2c1a' }, { label: 'mem-77 测试命令', tokens: 96, sourceId: 'mem-77', sha: '4be09d' }] },
        { id: 'files', label: '附带文件', kind: 'files', tokens: session.mode === 'chat' ? 0 : 6200, items: session.mode === 'chat' ? [] : [{ label: 'src/kernel/index.ts 400–440', tokens: 1800, sourceId: 'file:index.ts', sha: 'a1b2c3' }] },
        { id: 'history', label: '对话历史', kind: 'history', tokens: historyItems.reduce((n, i) => n + i.tokens, 0), items: historyItems },
        { id: 'reserve', label: '输出预留', kind: 'reserve', tokens: 4096 },
      ];
      return { windowTokens: window, usedTokens: segments.reduce((n, s) => n + s.tokens, 0), segments, omitted: session.messages.length >= 4 ? [{ sourceId: 'arch-2031', label: '早期工具输出（已归档，可分页回查）', tokens: 12_400, sha: 'e7d1f0' }, { sourceId: 'arch-2032', label: 'npm test 完整日志', tokens: 8_800, sha: '0c4aa9' }] : [] };
    },
    recall: async (_sessionId: string, sourceId: string, offset = 0) => {
      await this.pause(240);
      const lines = Array.from({ length: 60 }, (_, i) => `[${sourceId} #${i + 1}] 原始记录第 ${i + 1} 行（演示）：工具输出、命令日志或早期对话的未压缩原文。`);
      const page = lines.slice(offset, offset + 20);
      return { sourceId, sha: `sha256:${sourceId.replace(/\W/g, '').padEnd(8, '0').slice(0, 8)}…`, offset, text: page.join('\n'), nextOffset: offset + 20 < lines.length ? offset + 20 : undefined };
    },
    diffs: async (sessionId: string) => { await this.pause(80); return clone(this.diffState.get(sessionId) ?? []); },
  };

  private buildRequest(session: SessionDetail, message: ChatMessage): RequestRecordView {
    const index = session.messages.indexOf(message);
    const history = session.messages.slice(0, index).map(m => ({ role: m.role, content: this.plain(m) }));
    const tools = seedToolDefinitions.filter(t => decideForMode(session.mode, session.permission, t.capability, 'low') !== 'deny').map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
    const calls = message.parts.filter((p): p is Extract<MessagePart, { kind: 'tool' }> => p.kind === 'tool');
    return {
      id: message.requestId!, kind: session.mode === 'chat' ? 'chat' : 'work', status: message.status === 'done' ? 'completed' : message.status === 'cancelled' ? 'cancelled' : message.status === 'error' ? 'failed' : 'running',
      createdAt: message.createdAt, model: message.model ?? 'deepseek/deepseek-v4.1-flash', endpoint: 'POST https://api.commandcode.ai/provider/v1/chat/completions',
      body: this.requestBody(session, message, history, tools),
      redactions: ['headers.authorization', 'headers.x-api-key'], durationMs: message.durationMs, firstTokenMs: message.durationMs ? Math.round(message.durationMs * 0.08) : undefined, usage: message.usage,
      response: { content: this.plain(message), finishReason: calls.length ? 'tool_calls' : 'stop', toolCalls: calls.map(p => ({ name: p.call.name, arguments: JSON.stringify(p.call.args) })) },
    };
  }

  /** 适配后的请求 Body：所选推理等级按模型的 reasoningMapping 合并进去。 */
  private requestBody(session: SessionDetail, message: ChatMessage, history: unknown[], tools: unknown[]) {
    const profile = this.modelsState.find(m => m.id === session.modelId);
    const level = session.reasoningEffort ?? defaultLevel(profile?.reasoningLevels ?? []);
    const reasoning = level && profile?.reasoningMapping ? applyReasoningMapping(profile.reasoningMapping, level) as Record<string, unknown> : {};
    return { model: message.model ?? profile?.model, stream: true, temperature: 0.3, max_tokens: Math.min(512, profile?.maxOutputTokens ?? 512), ...reasoning, messages: [{ role: 'system', content: harnessPrompt }, ...history], tools, tool_choice: 'auto' };
  }

  private recordRequest(session: SessionDetail, message: ChatMessage, _input: SendInput) {
    this.requestLog.set(session.id, [...(this.requestLog.get(session.id) ?? []), this.buildRequest(session, message)]);
  }

  private buildTrace(session: SessionDetail): TraceSpan[] {
    const origin = Date.parse(session.createdAt), spans: TraceSpan[] = [];
    for (const message of session.messages.filter(m => m.role === 'assistant')) {
      const start = Math.max(0, Date.parse(message.createdAt) - origin), turnId = `turn-${message.id}`;
      const tools = message.parts.filter((p): p is Extract<MessagePart, { kind: 'tool' }> => p.kind === 'tool').map(p => p.call);
      const toolTime = tools.reduce((n, t) => n + (t.durationMs ?? 400) + (t.review?.durationMs ?? 0), 0);
      const total = Math.max(message.durationMs ?? 0, toolTime + 2400);
      const status: TraceSpan['status'] = message.status === 'streaming' ? 'running' : message.status === 'cancelled' ? 'cancelled' : message.status === 'error' ? 'error' : tools.some(t => t.status === 'awaiting_approval') ? 'waiting' : 'ok';
      spans.push({ id: turnId, type: 'turn', label: '用户回合', status, startMs: start, durationMs: total, requestId: message.requestId });
      spans.push({ id: `${turnId}-p`, parentId: turnId, type: 'prompt', label: '提示词组装', status: 'ok', startMs: start, durationMs: 40, attrs: { parts: 8 } });
      spans.push({ id: `${turnId}-c`, parentId: turnId, type: 'context', label: '上下文选择', status: 'ok', startMs: start + 40, durationMs: 90, attrs: { tokens: message.usage?.input ?? 0 } });
      spans.push({ id: `${turnId}-m`, parentId: turnId, type: 'model', label: `模型请求 ${message.model ?? ''}`, status: status === 'running' ? 'running' : 'ok', startMs: start + 130, durationMs: 1800, requestId: message.requestId, payloadRef: message.requestId, attrs: { in: message.usage?.input ?? 0, out: message.usage?.output ?? 0 } });
      let cursor = start + 1930;
      for (const tool of tools) {
        if (tool.review) {
          spans.push({ id: `${tool.id}-r`, parentId: turnId, type: 'review', label: `审查 ${tool.name} → ${tool.review.verdict}`, status: tool.review.verdict === 'block' ? 'error' : 'ok', startMs: cursor, durationMs: tool.review.durationMs });
          cursor += tool.review.durationMs;
        }
        const duration = tool.durationMs ?? 400;
        spans.push({ id: tool.id, parentId: turnId, type: 'tool', label: `${tool.name} · ${tool.title}`, status: tool.status === 'succeeded' ? 'ok' : tool.status === 'awaiting_approval' ? 'waiting' : ['running', 'reviewing'].includes(tool.status) ? 'running' : 'error', startMs: cursor, durationMs: duration, payloadRef: tool.id, attrs: { capability: tool.capability, risk: tool.risk } });
        cursor += duration;
      }
      if (tools.length) spans.push({ id: `${turnId}-m2`, parentId: turnId, type: 'model', label: '模型请求（携带工具结果）', status: status === 'running' ? 'running' : 'ok', startMs: cursor, durationMs: Math.max(600, total - (cursor - start)), requestId: message.requestId });
    }
    for (const checkpoint of session.task?.checkpoints ?? []) spans.push({ id: checkpoint.id, type: 'checkpoint', label: `检查点 · ${checkpoint.label}`, status: 'ok', startMs: Math.max(0, Date.parse(checkpoint.createdAt) - origin), durationMs: 0, attrs: { digest: checkpoint.digest } });
    return spans.sort((a, b) => a.startMs - b.startMs);
  }

  private computeMetrics(session: SessionDetail): MetricsView {
    const assistant = session.messages.filter(m => m.role === 'assistant');
    const usage = assistant.reduce((acc, m) => ({ input: acc.input + (m.usage?.input ?? 0), output: acc.output + (m.usage?.output ?? 0), cached: (acc.cached ?? 0) + (m.usage?.cached ?? 0) }), { input: 0, output: 0, cached: 0 });
    const calls = assistant.flatMap(m => m.parts.filter(p => p.kind === 'tool'));
    const last = assistant.at(-1);
    return {
      rounds: session.messages.filter(m => m.role === 'user').length, modelSteps: assistant.length + calls.length, tokens: usage, toolCalls: calls.length,
      activeTools: calls.filter(p => p.kind === 'tool' && ['running', 'awaiting_approval', 'reviewing'].includes(p.call.status)).length,
      cacheHitRate: usage.input ? (usage.cached ?? 0) / usage.input : undefined, lastLatencyMs: last?.durationMs, tokensPerSecond: last?.durationMs && last.usage ? last.usage.output / (last.durationMs / 1000) : undefined,
      contextUsed: last?.usage?.input, contextWindow: this.modelsState.find(m => m.id === session.modelId)?.contextWindow,
    };
  }

  metrics = {
    session: async (sessionId: string) => this.computeMetrics(this.session(sessionId)),
    activity: async (days: number) => { await this.pause(140); return seedActivity(days); },
  };

  // ---------- workspace ----------
  workspace = {
    projects: async () => { await this.pause(90); return clone(this.projectsState); },
    addProject: async () => {
      await this.pause(300);
      const project = { id: uid('p'), name: `新项目 ${this.projectsState.length + 1}`, path: `D:\\Example\\project-${this.projectsState.length + 1}`, lastOpenedAt: now(), sessions: 0, languages: [] };
      this.projectsState.unshift(project);
      this.emit({ type: 'notify', tone: 'success', title: '已登记项目', detail: project.path });
      return clone(project);
    },
    removeProject: async (projectId: string) => {
      if (!this.projectsState.some(p => p.id === projectId)) throw new GatewayError('not_found', '项目不存在');
      this.projectsState = this.projectsState.filter(p => p.id !== projectId);
      for (const session of this.store.values()) if (session.projectId === projectId) this.touch(session, { projectId: undefined });
    },
    files: async (projectId: string) => { await this.pause(100); return this.ide.tree(projectId); },
    readFile: async (projectId: string, path: string) => { await this.pause(80); return this.ide.read(projectId, path); },
    writeFile: async (projectId: string, path: string, content: string) => { await this.pause(120); return this.ide.write(projectId, path, content); },
    search: async (projectId: string, query: SearchQuery) => { await this.pause(160); return this.ide.search(projectId, query); },
    sourceControl: async (projectId: string) => { await this.pause(90); return this.ide.sourceControl(projectId); },
    fileDiff: async (projectId: string, path: string) => { await this.pause(90); return this.ide.diff(projectId, path); },
    commit: async (projectId: string, message: string, paths: string[]) => { await this.pause(400); const result = this.ide.commit(projectId, message, paths); this.emit({ type: 'notify', tone: 'success', title: `已提交 ${result.commit}`, detail: message }); return result; },
    terminal: async (projectId: string, command: string) => { await this.pause(260); return this.ide.terminal(projectId, command); },
    diagnostics: async (projectId: string) => { await this.pause(120); return this.ide.diagnostics(projectId); },
  };

  // ---------- settings ----------
  settings = {
    get: async () => clone(this.settingsState),
    update: async (patch: DeepPartial<Settings>) => { this.settingsState = merge(this.settingsState, patch); return clone(this.settingsState); },
    models: async () => clone(this.modelsState),
    saveModel: async (input: ModelProfileInput) => {
      await this.pause(240);
      if (!input.model.trim()) throw new GatewayError('validation', '模型 ID 不能为空');
      if (input.contextWindow !== undefined && (!Number.isInteger(input.contextWindow) || input.contextWindow <= 0)) throw new GatewayError('validation', '上下文窗口必须是正整数');
      if (input.maxOutputTokens !== undefined && input.contextWindow !== undefined && input.maxOutputTokens > input.contextWindow) throw new GatewayError('validation', '最大输出不能超过上下文窗口');
      const existing = input.id ? this.modelsState.find(m => m.id === input.id) : undefined;
      const saved: ModelProfile = { credentialPresent: existing?.credentialPresent ?? false, remainingLiveRequests: existing?.remainingLiveRequests, ...existing, ...input, id: input.id ?? uid('model'), supportsReasoning: Boolean(input.reasoningLevels?.length) };
      this.modelsState = existing ? this.modelsState.map(m => (m.id === saved.id ? saved : m)) : [...this.modelsState, saved];
      this.emit({ type: 'notify', tone: 'success', title: existing ? '模型配置已保存' : '已添加模型', detail: saved.model });
      return clone(saved);
    },
    removeModel: async (modelId: string) => {
      if (this.settingsState.defaults.modelId === modelId) throw new GatewayError('invalid_state', '不能删除默认模型，请先设置其他默认模型');
      this.modelsState = this.modelsState.filter(m => m.id !== modelId);
    },
    testModel: async (modelId: string) => {
      await this.pause(900);
      const model = this.modelsState.find(m => m.id === modelId);
      if (!model) throw new GatewayError('not_found', '模型配置不存在');
      return model.credentialPresent ? { ok: true, latencyMs: 412, message: `演示：${model.model} 连接正常（未发送真实请求）` } : { ok: false, message: '缺少凭据' };
    },
    mcp: async () => clone(this.mcpState),
    mcpCatalog: async (id: string) => ({ serverId: id, serverDigest: 'demo', offset: 0, total: 0, tools: [] }),
    saveMcp: async (input: McpServerInput) => {
      if (!input.name.trim()) throw new GatewayError('validation', '名称不能为空');
      if (!input.target.trim()) throw new GatewayError('validation', input.transport === 'stdio' ? '启动命令不能为空' : '服务地址不能为空');
      if (input.transport !== 'stdio' && !/^https?:\/\//i.test(input.target.trim())) throw new GatewayError('validation', '服务地址必须以 http:// 或 https:// 开头');
      if (this.mcpState.some(s => s.name === input.name.trim() && s.id !== input.id)) throw new GatewayError('validation', `已存在名为 ${input.name.trim()} 的服务器`);
      await this.pause(600);
      const saved: McpServerView = { id: input.id ?? uid('m'), name: input.name.trim(), transport: input.transport, target: input.target.trim(), enabled: input.enabled, status: input.enabled ? 'connected' : 'disconnected', tools: input.enabled ? 4 : 0 };
      this.mcpState = input.id ? this.mcpState.map(s => (s.id === input.id ? saved : s)) : [...this.mcpState, saved];
      return clone(saved);
    },
    removeMcp: async (id: string) => {
      if (!this.mcpState.some(s => s.id === id)) throw new GatewayError('not_found', 'MCP 服务器不存在');
      this.mcpState = this.mcpState.filter(s => s.id !== id);
    },
    reconnectMcp: async (id: string) => {
      const server = this.mcpState.find(s => s.id === id);
      if (!server) throw new GatewayError('not_found', 'MCP 服务器不存在');
      await this.pause(800);
      if (server.error) return clone(server);
      Object.assign(server, { status: 'connected', enabled: true });
      return clone(server);
    },
    instructions: async () => { await this.pause(80); return clone(seedInstructions); },
    plugins: async () => clone(seedPlugins),
    skills: async () => clone(this.skillsState),
    toggleSkill: async (id: string, enabled: boolean) => {
      const skill = this.skillsState.find(s => s.id === id);
      if (!skill) throw new GatewayError('not_found', 'Skill 不存在');
      skill.enabled = enabled;
      return clone(skill);
    },
    clearHistory: async () => {
      for (const [id, session] of this.store) if (!session.pinned) { this.store.delete(id); this.emit({ type: 'session.removed', sessionId: id }); }
    },
  };

  // ---------- desktop ----------
  desktop = {
    pickFiles: async () => {
      await this.pause(200);
      return [{ id: uid('at'), name: 'archive.ts', kind: 'file' as const, path: 'src/memory/archive.ts', bytes: 14_493 }];
    },
    openIde: async () => { this.emit({ type: 'notify', tone: 'info', title: '演示网关未连接 IDE', detail: '接入后台后将打开 NPN 品牌 IDE 宿主' }); },
    copyText: async (text: string) => { await navigator.clipboard.writeText(text); },
    openDataFolder: async () => { this.emit({ type: 'notify', tone: 'info', title: '演示网关没有数据目录' }); },
    version: async () => '1.0.0-frontend',
  };
}
