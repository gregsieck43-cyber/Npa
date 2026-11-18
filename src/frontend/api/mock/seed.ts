/**
 * 演示网关的种子数据。只在 mock 网关中使用，界面会常驻“演示数据”标记；
 * 真实产品（bridge 网关）不得引用本文件。
 */
import type {
  ActivityDay, ChatMessage, FileDiff, FileNode, InstructionFileView, McpServerView, ModelProfile, PluginView, ProjectView,
  SessionDetail, Settings, SkillView, TaskDetail, ToolCallView, ToolDefinitionView,
} from '../types';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const seedModels: ModelProfile[] = [
  {
    id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', provider: 'Commandcode', model: 'deepseek/deepseek-v4.1-flash', mode: 'live', contextWindow: 128_000, maxOutputTokens: 8_192, supportsReasoning: true, credentialPresent: true, remainingLiveRequests: 6,
    autoConfig: true, inputTypes: ['text'], capabilities: ['structuredOutput', 'systemMessageInChat'], reasoningLevels: ['low', 'medium', 'high'], reasoningMapping: { reasoning_effort: '{{level}}' },
  },
  {
    id: 'glm-flash', name: 'GLM 5.3 Flash', provider: 'Commandcode', model: 'z-ai/glm-5.3-flash', mode: 'live', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsReasoning: true, credentialPresent: true, remainingLiveRequests: 6,
    autoConfig: true, inputTypes: ['text', 'image', 'video', 'pdf'], capabilities: [], reasoningLevels: ['low', 'high', 'max'], reasoningMapping: { thinking: { type: 'enabled', effort: '{{level}}' } },
  },
  {
    id: 'mock-local', name: 'Mock 本地模型', provider: 'NPN Harness', model: 'mock/scripted', mode: 'mock', contextWindow: 64_000, maxOutputTokens: 4_096, supportsReasoning: true, credentialPresent: true,
    autoConfig: false, inputTypes: ['text', 'image'], capabilities: ['structuredOutput'], reasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'], reasoningMapping: { reasoning: { effort: '{{level}}' } },
  },
  { id: 'reviewer', name: '审查器 · Flash', provider: 'Commandcode', model: 'deepseek/deepseek-v4.1-flash', mode: 'live', contextWindow: 128_000, maxOutputTokens: 2_048, credentialPresent: true, remainingLiveRequests: 6, autoConfig: true, inputTypes: ['text'], capabilities: ['structuredOutput'], reasoningLevels: [] },
];

export const seedSettings: Settings = {
  appearance: { theme: 'light', accent: 'ember', density: 'comfortable', motion: 'full', fontScale: 1, ambient: true },
  defaults: { mode: 'chat', permission: 'auto-review', modelId: 'deepseek-flash', sendKey: 'enter' },
  autoReview: { reviewerModelId: 'reviewer', escalateAt: 'high', explain: true },
  rules: [
    { id: 'r1', pattern: 'npm test*', capability: 'exec', decision: 'allow' },
    { id: 'r2', pattern: 'git push*', capability: 'exec', decision: 'ask' },
    { id: 'r3', pattern: '**/*.key', capability: 'read', decision: 'deny' },
  ],
  privacy: { recordContent: true, redactSecrets: true },
  network: { webSearch: true, fetch: true, proxy: '' },
};

export const seedProjects: ProjectView[] = [
  { id: 'p-agent', name: 'NPN-Gamma Agent', path: 'D:\\Example\\workbench', branch: 'main', lastOpenedAt: minutesAgo(8), sessions: 14, changedFiles: 6, languages: [{ name: 'TypeScript', share: 0.78 }, { name: 'CSS', share: 0.14 }, { name: 'Other', share: 0.08 }] },
  { id: 'p-airi', name: '示例插件', path: 'D:\\Example\\sample-plugin', branch: 'main', lastOpenedAt: minutesAgo(60 * 26), sessions: 5, changedFiles: 0, languages: [{ name: 'Vue', share: 0.55 }, { name: 'TypeScript', share: 0.4 }, { name: 'Other', share: 0.05 }] },
  { id: 'p-docs', name: '示例文档站', path: 'D:\\Example\\demo\\reports', lastOpenedAt: minutesAgo(60 * 24 * 6), sessions: 3, languages: [{ name: 'Markdown', share: 0.92 }, { name: 'JSON', share: 0.08 }] },
];

export const seedFiles: FileNode[] = [
  { path: 'src', name: 'src', kind: 'dir', children: [
    { path: 'src/kernel', name: 'kernel', kind: 'dir', children: [
      { path: 'src/kernel/index.ts', name: 'index.ts', kind: 'file', change: 'M' },
      { path: 'src/kernel/outbox.ts', name: 'outbox.ts', kind: 'file', change: 'A' },
      { path: 'src/kernel/types.ts', name: 'types.ts', kind: 'file' },
    ] },
    { path: 'src/memory', name: 'memory', kind: 'dir', children: [
      { path: 'src/memory/archive.ts', name: 'archive.ts', kind: 'file', change: 'M' },
      { path: 'src/memory/tools.ts', name: 'tools.ts', kind: 'file' },
    ] },
    { path: 'src/harness', name: 'harness', kind: 'dir', children: [
      { path: 'src/harness/chat.ts', name: 'chat.ts', kind: 'file' },
      { path: 'src/harness/service.ts', name: 'service.ts', kind: 'file' },
    ] },
    { path: 'src/contracts.ts', name: 'contracts.ts', kind: 'file' },
  ] },
  { path: 'tests', name: 'tests', kind: 'dir', children: [
    { path: 'tests/memory-paging.test.ts', name: 'memory-paging.test.ts', kind: 'file', change: 'A' },
    { path: 'tests/kernel.test.ts', name: 'kernel.test.ts', kind: 'file' },
  ] },
  { path: 'package.json', name: 'package.json', kind: 'file' },
  { path: 'README.md', name: 'README.md', kind: 'file' },
];

export const seedFileText: Record<string, string> = {
  'src/memory/archive.ts': `import { createHash } from 'node:crypto';\n\nexport interface ArchivePage {\n  sourceId: string;\n  sha256: string;\n  items: ArchiveItem[];\n  nextOffset?: number;\n}\n\n/** 分页以快照游标为准，避免 BM25 全库变化导致页面抖动。 */\nexport function page(snapshot: Snapshot, offset: number, limit = 20): ArchivePage {\n  const items = snapshot.rows.slice(offset, offset + limit);\n  return {\n    sourceId: snapshot.id,\n    sha256: createHash('sha256').update(snapshot.digest).digest('hex'),\n    items,\n    nextOffset: offset + limit < snapshot.rows.length ? offset + limit : undefined,\n  };\n}\n`,
};

export const seedInstructions: InstructionFileView[] = [
  { id: 'i-global', scope: 'global', path: '%USERPROFILE%\\.npn\\AGENTS.md', status: 'loaded', bytes: 2_184, order: 1 },
  { id: 'i-agent', scope: 'project', projectId: 'p-agent', path: 'D:\\Example\\workbench\\AGENTS.md', status: 'loaded', bytes: 3_960, order: 2 },
  { id: 'i-agent-fe', scope: 'project', projectId: 'p-agent', path: 'D:\\Example\\workbench\\src\\frontend\\AGENTS.md', status: 'loaded', bytes: 2_712, order: 3 },
  { id: 'i-airi', scope: 'project', projectId: 'p-airi', path: 'D:\\Example\\sample-plugin\\AGENTS.md', status: 'missing', order: 2 },
];

export const seedMcp: McpServerView[] = [
  { id: 'm-fs', name: 'filesystem', transport: 'stdio', status: 'connected', tools: 11, target: 'npx @modelcontextprotocol/server-filesystem D:\\Example', enabled: true },
  { id: 'm-browser', name: 'browser', transport: 'http', status: 'connected', tools: 8, target: 'http://127.0.0.1:8931/mcp', enabled: true },
  { id: 'm-godot', name: 'godot-ai', transport: 'stdio', status: 'error', tools: 0, error: '进程退出：exit 1（找不到 Godot 可执行文件）', target: 'godot-mcp --headless', enabled: true },
];

export const seedPlugins: PluginView[] = [
  { id: 'pl-rea', name: 'REA 逆向工具层', version: '0.7.0', status: 'active', capabilities: ['read', 'exec'], description: '本地样本静态分析、字符串与节区检查，仅限已授权样本。' },
  { id: 'pl-web', name: '联网检索', version: '0.4.2', status: 'active', capabilities: ['network'], description: 'Mwmbl / 自定义搜索与网页抓取，结果带来源与时间戳。' },
  { id: 'pl-voice', name: 'AIRI 语音壳', version: '0.1.0', status: 'pending_approval', capabilities: ['network', 'exec'], description: '角色化语音交互插件，需要审批能力清单后才能启用。' },
];

export const seedSkills: SkillView[] = [
  { id: 's-tdd', name: 'test-driven-development', description: '实现前先写失败测试，再最小修复。', source: '~/.claude/skills', enabled: true },
  { id: 's-debug', name: 'systematic-debugging', description: '复现 → 缩小 → 假设 → 验证的诊断流程。', source: '~/.claude/skills', enabled: true },
  { id: 's-review', name: 'code-review', description: '基于固定版本同时核对需求符合性与正确性。', source: '项目 .agents', enabled: false },
];

export const seedToolDefinitions: ToolDefinitionView[] = [
  { name: 'read_file', source: 'builtin', capability: 'read', description: '读取工作区内文件的指定行范围。', schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'search', source: 'builtin', capability: 'read', description: '在工作区内按正则检索文本。', schema: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] } },
  { name: 'apply_patch', source: 'builtin', capability: 'write', description: '以统一 diff 修改工作区文件，需要权限。', schema: { type: 'object', properties: { path: { type: 'string' }, patch: { type: 'string' } }, required: ['path', 'patch'] } },
  { name: 'run_shell', source: 'builtin', capability: 'exec', description: '在工作区内执行 PowerShell 命令，需要权限。', schema: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['command'] } },
  { name: 'read_history', source: 'builtin', capability: 'read', description: '按来源 ID 与偏移回查原始记录（可回溯上下文）。', schema: { type: 'object', properties: { sourceId: { type: 'string' }, offset: { type: 'integer' } }, required: ['sourceId'] } },
  { name: 'web_search', source: 'plugin', capability: 'network', description: '联网检索并返回带来源的结果。', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'browser.snapshot', source: 'mcp', capability: 'mcp', description: 'MCP browser：获取页面可访问性快照。', schema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'spawn_worker', source: 'subagent', capability: 'exec', description: '派生受限子代理执行独立子任务。', schema: { type: 'object', properties: { goal: { type: 'string' }, capabilities: { type: 'array', items: { type: 'string' } } }, required: ['goal'] } },
];

const outboxDiff: FileDiff = {
  path: 'src/kernel/outbox.ts', status: 'added', additions: 18, deletions: 0, applied: true, toolCallId: 'tc-c3',
  hunks: [{ header: '@@ -0,0 +1,18 @@', lines: [
    'export interface OutboxEntry {', '  effectKey: string;', '  intentId: string;', '  state: \'pending\' | \'sent\' | \'acknowledged\' | \'unknown\';', '  attempts: number;', '}', '',
    '/** 先落盘意图再发送，崩溃后由 reconcile 判定未知效果，绝不盲目重发。 */', 'export function enqueue(store: Store, entry: OutboxEntry): void {', '  store.transaction(() => {', '    store.insert(\'outbox\', entry);', '    store.bumpRevision(entry.intentId);', '  });', '}', '',
    'export function reconcile(store: Store): OutboxEntry[] {', '  return store.select(\'outbox\', { state: \'sent\' }).map(markUnknown);', '}',
  ].map((text, i) => ({ kind: 'add' as const, newNo: i + 1, text })) }],
};

const kernelDiff: FileDiff = {
  path: 'src/kernel/index.ts', status: 'modified', additions: 4, deletions: 2, applied: false, toolCallId: 'tc-c4',
  hunks: [{ header: '@@ -412,9 +412,11 @@ export class Kernel {', lines: [
    { kind: 'ctx', oldNo: 412, newNo: 412, text: '  grant(intent: Intent, digest: string) {' },
    { kind: 'ctx', oldNo: 413, newNo: 413, text: '    this.assertFresh(intent, digest);' },
    { kind: 'del', oldNo: 414, text: '    this.dispatch(intent);' },
    { kind: 'del', oldNo: 415, text: '    this.store.update(\'intents\', intent.id, { state: \'sent\' });' },
    { kind: 'add', newNo: 414, text: '    enqueue(this.store, {' },
    { kind: 'add', newNo: 415, text: '      effectKey: intent.effectKey, intentId: intent.id,' },
    { kind: 'add', newNo: 416, text: '      state: \'pending\', attempts: 0,' },
    { kind: 'add', newNo: 417, text: '    });' },
    { kind: 'ctx', oldNo: 416, newNo: 418, text: '    this.emit(\'intent.granted\', { id: intent.id });' },
    { kind: 'ctx', oldNo: 417, newNo: 419, text: '  }' },
  ] }],
};

const pagingDiff: FileDiff = {
  path: 'src/memory/archive.ts', status: 'modified', additions: 3, deletions: 3, applied: true, toolCallId: 'tc-d2',
  hunks: [{ header: '@@ -88,8 +88,8 @@ export function page(', lines: [
    { kind: 'ctx', oldNo: 88, newNo: 88, text: 'export function page(snapshot: Snapshot, offset: number, limit = 20): ArchivePage {' },
    { kind: 'del', oldNo: 89, text: '  const ranked = bm25(snapshot.query, liveIndex());' },
    { kind: 'del', oldNo: 90, text: '  const items = ranked.slice(offset, offset + limit);' },
    { kind: 'add', newNo: 89, text: '  // 分页固定在快照行序上，全库新增文档不会让第 2 页漂移' },
    { kind: 'add', newNo: 90, text: '  const items = snapshot.rows.slice(offset, offset + limit);' },
    { kind: 'ctx', oldNo: 91, newNo: 91, text: '  return {' },
    { kind: 'del', oldNo: 92, text: '    sourceId: snapshot.id, sha256: hashProjection(items),' },
    { kind: 'add', newNo: 92, text: '    sourceId: snapshot.id, sha256: hashOriginal(snapshot.digest),' },
    { kind: 'ctx', oldNo: 93, newNo: 93, text: '    items,' },
  ] }],
};

export const seedDiffs: Record<string, FileDiff[]> = { 's-cowork': [outboxDiff, kernelDiff], 's-code': [pagingDiff] };

const call = (partial: Partial<ToolCallView> & Pick<ToolCallView, 'id' | 'name' | 'title' | 'capability'>): ToolCallView => ({
  source: 'builtin', risk: 'low', args: {}, status: 'succeeded', durationMs: 120, ...partial,
});

const text = (t: string) => ({ kind: 'text' as const, text: t });

function msg(id: string, role: ChatMessage['role'], minutes: number, parts: ChatMessage['parts'], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, createdAt: minutesAgo(minutes), status: 'done', parts, ...extra };
}

const rustAnswer = "示例函数返回两个数字的和。";

const coworkTask: TaskDetail = {
  id: 't-outbox', title: '审批流迁移到 effect outbox', status: 'waiting_approval', phase: '实施 · 第 3/5 步',
  goal: {
    objective: '验证示例项目中的计算函数。',
    constraints: ['不改变 Command/Intent 公开结构', '所有写入在单事务内完成', '不放宽现有测试时限'],
    acceptance: ['新增 outbox 单测覆盖 pending→sent→unknown', '整套回归 0 FAIL', '重启后未知效果进入 reconciling 而非重发'],
    mode: 'collaborative',
  },
  plan: [
    { id: 'p1', title: '阅读 Kernel.grant 与 dispatch 调用链', status: 'done' },
    { id: 'p2', title: '新增 outbox 模块与事务写入', status: 'done' },
    { id: 'p3', title: '改写 grant 走 outbox 并运行回归', status: 'active', detail: '等待批准：npm test' },
    { id: 'p4', title: '注入崩溃验证 reconcile 行为', status: 'todo' },
    { id: 'p5', title: '独立审查并汇总证据', status: 'todo' },
  ],
  budget: { modelCalls: 17, maxModelCalls: 60, toolCalls: 23, maxToolCalls: 120, tokens: 184_220 },
  checkpoints: [
    { id: 'ck1', label: '计划确认', createdAt: minutesAgo(52), messageCount: 4, digest: '9f2c1a7e' },
    { id: 'ck2', label: 'outbox 模块落盘', createdAt: minutesAgo(21), messageCount: 11, digest: '4be09d33' },
  ],
  subagents: [
    { id: 'sa1', role: 'worker', title: '检索全部 dispatch 调用点', status: 'completed', model: 'Flash', progress: 1 },
    { id: 'sa2', role: 'reviewer', title: '审查 outbox 事务边界', status: 'running', model: '审查器', progress: 0.45 },
  ],
  verification: { status: 'pending', items: [
    { label: 'outbox 单测', status: 'pass' }, { label: '整套回归', status: 'pending' }, { label: '崩溃对账', status: 'pending' },
  ] },
  startedAt: minutesAgo(58), updatedAt: minutesAgo(1), waitingReason: '验证示例项目中的计算函数。',
};

const codeTask: TaskDetail = {
  ...coworkTask, id: 't-paging', title: '修复上下文分页 BM25 抖动', status: 'completed', phase: '已完成', waitingReason: undefined,
  goal: { objective: '验证示例项目中的计算函数。', constraints: ['不新增记忆内核'], acceptance: ['分页回归通过', '原档 SHA 稳定'], mode: 'autonomous' },
  plan: [
    { id: 'q1', title: '复现第 2 页漂移', status: 'done' }, { id: 'q2', title: '改为快照行序分页', status: 'done' }, { id: 'q3', title: '运行分页回归', status: 'done' },
  ],
  budget: { modelCalls: 9, maxModelCalls: 40, toolCalls: 12, maxToolCalls: 80, tokens: 61_400 },
  checkpoints: [{ id: 'ck3', label: '修复完成', createdAt: minutesAgo(130), messageCount: 8, digest: 'c81f22b0' }],
  subagents: [],
  verification: { status: 'pass', items: [{ label: '分页回归 14/14', status: 'pass' }, { label: 'SHA 稳定性', status: 'pass' }] },
  startedAt: minutesAgo(170), updatedAt: minutesAgo(130),
};

export function seedSessions(): SessionDetail[] {
  return [
    {
      id: 's-cowork', mode: 'cowork', title: '审批流迁移到 effect outbox', createdAt: minutesAgo(58), updatedAt: minutesAgo(1), status: 'waiting_approval',
      permission: 'auto-review', modelId: 'deepseek-flash', projectId: 'p-agent', pinned: true, preview: '验证示例项目中的计算函数。', hasMoreBefore: false, task: coworkTask,
      messages: [
        msg('c-u1', 'user', 58, [text('演示消息。')]),
        msg('c-a1', 'assistant', 56, [
          { kind: 'reasoning', text: '需要先确认 grant → dispatch 的所有调用点，以及 intents 表的状态迁移。outbox 必须和 revision 自增在同一事务里，否则崩溃窗口会产生已发送但未记录的副作用。', durationMs: 4200 },
          { kind: 'tool', call: call({ id: 'tc-c1', name: 'search', title: '检索 dispatch( 调用点', capability: 'read', args: { pattern: 'dispatch\\(', glob: 'src/**/*.ts' }, result: { kind: 'files', files: [{ path: 'src/kernel/index.ts', detail: '3 处' }, { path: 'src/harness/chat-tools.ts', detail: '1 处' }] }, receivedByRequestId: 'rq-2' }) },
          { kind: 'tool', call: call({ id: 'tc-c2', name: 'read_file', title: '读取 src/kernel/index.ts 400–440', capability: 'read', args: { path: 'src/kernel/index.ts', offset: 400, limit: 40 }, result: { kind: 'text', text: 'grant(intent: Intent, digest: string) {\n  this.assertFresh(intent, digest);\n  this.dispatch(intent);\n  ...' }, receivedByRequestId: 'rq-2' }) },
          text('演示消息。'),
        ], { requestId: 'rq-1', model: 'deepseek/deepseek-v4.1-flash', usage: { input: 9_820, output: 612, cached: 7_200 }, durationMs: 8_400 }),
        msg('c-u2', 'user', 50, [text('演示消息。')]),
        msg('c-a2', 'assistant', 22, [
          { kind: 'tool', call: call({ id: 'tc-c3', name: 'apply_patch', title: '新增 src/kernel/outbox.ts', capability: 'write', risk: 'medium', args: { path: 'src/kernel/outbox.ts', patch: '+18 行' }, result: { kind: 'diff', diff: outboxDiff }, review: { reviewer: '审查器 · Flash', verdict: 'pass', risk: 'medium', reason: '新增文件位于工作区内，事务包裹插入与 revision 自增，未触碰凭据或外部系统。', checks: [{ label: '路径在工作区内', ok: true }, { label: '无删除操作', ok: true }, { label: '与目标契约一致', ok: true }], durationMs: 1300 }, receivedByRequestId: 'rq-4' }) },
          { kind: 'tool', call: call({ id: 'tc-c4', name: 'apply_patch', title: '改写 Kernel.grant 走 outbox', capability: 'write', risk: 'medium', args: { path: 'src/kernel/index.ts', patch: '+4 −2' }, status: 'succeeded', result: { kind: 'diff', diff: kernelDiff }, review: { reviewer: '审查器 · Flash', verdict: 'pass', risk: 'medium', reason: '修改范围限于 grant 方法，保持公开签名不变。', checks: [{ label: '公开结构未变', ok: true }, { label: '事务内写入', ok: true }], durationMs: 980 }, receivedByRequestId: 'rq-4' }) },
          text('演示消息。'),
          { kind: 'tool', call: call({ id: 'tc-c5', name: 'run_shell', title: '运行 npm test', capability: 'exec', risk: 'high', args: { command: 'npm test', timeoutMs: 600000 }, status: 'awaiting_approval', approvalId: 'ap-1', durationMs: undefined, review: { reviewer: '审查器 · Flash', verdict: 'escalate', risk: 'high', reason: '整套回归会启动 Electron 与多个子进程，耗时约 6 分钟，超出低风险自动放行范围，转交人工确认。', checks: [{ label: '命令在白名单', ok: true }, { label: '无网络写入', ok: true }, { label: '资源占用可控', ok: false }], durationMs: 1700 } }) },
        ], { requestId: 'rq-4', model: 'deepseek/deepseek-v4.1-flash', usage: { input: 21_400, output: 1_380, cached: 18_100 }, durationMs: 12_900 }),
      ],
    },
    {
      id: 's-code', mode: 'code', title: '修复上下文分页 BM25 抖动', createdAt: minutesAgo(170), updatedAt: minutesAgo(130), status: 'completed',
      permission: 'full-access', modelId: 'deepseek-flash', projectId: 'p-agent', preview: '验证示例项目中的计算函数。', hasMoreBefore: false, task: codeTask,
      messages: [
        msg('d-u1', 'user', 170, [text('演示消息。')], { attachments: [{ id: 'at1', name: 'archive.ts', kind: 'file', path: 'src/memory/archive.ts', bytes: 14493 }] }),
        msg('d-a1', 'assistant', 150, [
          { kind: 'reasoning', text: '漂移原因是分页每次都对实时索引重新做 BM25 排序。应在创建快照时固定行序，分页只切片。SHA 应取原档 digest 而不是当前页投影。', durationMs: 2600 },
          { kind: 'tool', call: call({ id: 'tc-d1', name: 'read_file', title: '读取 src/memory/archive.ts', capability: 'read', args: { path: 'src/memory/archive.ts' }, result: { kind: 'text', text: '…' }, receivedByRequestId: 'rq-d2' }) },
          { kind: 'tool', call: call({ id: 'tc-d2', name: 'apply_patch', title: '分页改为快照行序', capability: 'write', risk: 'medium', args: { path: 'src/memory/archive.ts' }, result: { kind: 'diff', diff: pagingDiff }, receivedByRequestId: 'rq-d2' }) },
          { kind: 'tool', call: call({ id: 'tc-d3', name: 'run_shell', title: 'node --test memory-paging', capability: 'exec', risk: 'medium', args: { command: 'node --test build/tests/memory-paging.test.js' }, durationMs: 4_820, result: { kind: 'terminal', command: 'node --test build/tests/memory-paging.test.js', exitCode: 0, output: '▶ archive paging\n  ✔ page 2 stable after inserts (31ms)\n  ✔ sha256 binds original digest (4ms)\n  ✔ nextOffset ends at snapshot size (2ms)\n✔ archive paging (52ms)\nℹ tests 14\nℹ pass 14\nℹ fail 0' }, receivedByRequestId: 'rq-d3' }) },
          text('演示消息。'),
        ], { requestId: 'rq-d3', model: 'deepseek/deepseek-v4.1-flash', usage: { input: 14_200, output: 980, cached: 9_900 }, durationMs: 19_300 }),
      ],
    },
    {
      id: 's-rust', mode: 'chat', title: '解释 Rust 生命周期与借用检查', createdAt: minutesAgo(240), updatedAt: minutesAgo(236), status: 'idle',
      permission: 'read-only', modelId: 'deepseek-flash', preview: '验证示例项目中的计算函数。', hasMoreBefore: false,
      messages: [
        msg('r-u1', 'user', 240, [text('演示消息。')]),
        msg('r-a1', 'assistant', 238, [{ kind: 'reasoning', text: '用户想要直观解释 + 规则列表，配一个经典 longest 示例最合适。', durationMs: 1800 }, text(rustAnswer)], { requestId: 'rq-r1', model: 'deepseek/deepseek-v4.1-flash', usage: { input: 1_240, output: 410 }, durationMs: 5_200 }),
      ],
    },
    {
      id: 's-weekly', mode: 'chat', title: '周报润色', createdAt: minutesAgo(60 * 20), updatedAt: minutesAgo(60 * 20), status: 'idle', permission: 'ask', modelId: 'deepseek-flash', preview: '验证示例项目中的计算函数。', hasMoreBefore: false,
      messages: [msg('w-u1', 'user', 60 * 20, [text('演示消息。')]), msg('w-a1', 'assistant', 60 * 20, [text('演示消息。')], { usage: { input: 320, output: 64 } })],
    },
    {
      id: 's-memory', mode: 'cowork', title: '整理 20 天记忆压缩方案', createdAt: minutesAgo(60 * 30), updatedAt: minutesAgo(60 * 28), status: 'completed', permission: 'ask', modelId: 'deepseek-flash', projectId: 'p-agent', preview: '验证示例项目中的计算函数。', hasMoreBefore: false,
      task: { ...codeTask, id: 't-mem', title: '整理 20 天记忆压缩方案', goal: { ...codeTask.goal, objective: '验证示例项目中的计算函数。' } },
      messages: [msg('m-u1', 'user', 60 * 30, [text('演示消息。')]), msg('m-a1', 'assistant', 60 * 28, [text('演示消息。')])],
    },
    { id: 's-old1', mode: 'chat', title: 'PowerShell 批量重命名脚本', createdAt: minutesAgo(60 * 24 * 3), updatedAt: minutesAgo(60 * 24 * 3), status: 'idle', permission: 'ask', modelId: 'deepseek-flash', hasMoreBefore: false, messages: [] },
    { id: 's-old2', mode: 'code', title: 'Godot 角色移动手感调参', createdAt: minutesAgo(60 * 24 * 5), updatedAt: minutesAgo(60 * 24 * 5), status: 'idle', permission: 'auto-review', modelId: 'deepseek-flash', projectId: 'p-airi', hasMoreBefore: false, messages: [] },
    { id: 's-old3', mode: 'cowork', title: '研究报告链接校验与归档', createdAt: minutesAgo(60 * 24 * 9), updatedAt: minutesAgo(60 * 24 * 9), status: 'failed', permission: 'read-only', modelId: 'deepseek-flash', projectId: 'p-docs', hasMoreBefore: false, messages: [] },
    { id: 's-old4', mode: 'chat', title: 'SQLite WAL 与 fsync 的取舍', createdAt: minutesAgo(60 * 24 * 14), updatedAt: minutesAgo(60 * 24 * 14), status: 'idle', permission: 'read-only', modelId: 'deepseek-flash', hasMoreBefore: false, messages: [] },
  ];
}

/** 确定性伪随机，保证演示热力图每次一致。 */
function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

export function seedActivity(days: number): ActivityDay[] {
  const random = seeded(20261019), result: ActivityDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000), weekend = [0, 6].includes(date.getDay());
    const burst = random() < 0.12 ? 3 : 1, idle = random() < (weekend ? 0.45 : 0.12);
    const events = idle ? 0 : Math.round((random() * 60 + 8) * burst * (1 - i / (days * 2.2)));
    result.push({ date: date.toISOString().slice(0, 10), events, modelCalls: Math.round(events * 0.35), toolEffects: Math.round(events * 0.22), tasksCreated: events ? Math.round(random() * 3) : 0, tasksCompleted: events ? Math.round(random() * 2) : 0 });
  }
  return result;
}
