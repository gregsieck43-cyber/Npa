import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GatewayError } from '../api/contract';
import { MockGateway } from '../api/mock/gateway';
import type { ApprovalRequest, ChatMessage, GatewayEvent, PermissionMode, SendInput, ToolCallView } from '../api/types';

function harness() {
  const gateway = new MockGateway(), events: GatewayEvent[] = [];
  gateway.subscribe(event => events.push(event));
  const waitFor = <T>(pick: () => T | undefined, timeout = 30_000) => new Promise<T>((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = pick();
      if (value !== undefined) return resolve(value);
      if (Date.now() - started > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 25);
    };
    tick();
  });
  const lastMessage = (sessionId: string, messageId: string) => events.filter((e): e is Extract<GatewayEvent, { type: 'message.upsert' }> => e.type === 'message.upsert' && e.sessionId === sessionId && e.message.id === messageId).at(-1)?.message;
  const finished = (sessionId: string, messageId: string) => waitFor(() => { const m = lastMessage(sessionId, messageId); return m && m.status !== 'streaming' ? m : undefined; });
  const approvals = () => events.filter((e): e is Extract<GatewayEvent, { type: 'approval.requested' }> => e.type === 'approval.requested').map(e => e.approval);
  const nextApproval = (count: number) => waitFor<ApprovalRequest>(() => approvals()[count - 1]);
  const send = (mode: SendInput['mode'], permission: PermissionMode, text: string) => gateway.chat.send({ mode, permission, text, attachments: [], modelId: 'mock-local' });
  return { gateway, events, finished, nextApproval, approvals, send, waitFor, lastMessage };
}

const tools = (message: ChatMessage): ToolCallView[] => message.parts.flatMap(p => (p.kind === 'tool' ? [p.call] : []));

describe('演示网关的权限语义与契约一致', { concurrency: true }, () => {
  test('只读：写入和命令被拦截为 permission 阶段，读取照常执行', async () => {
    const h = harness();
    const { sessionId, messageId } = await h.send('code', 'read-only', '修复登录问题');
    const message = await h.finished(sessionId, messageId);
    const calls = tools(message);
    assert.ok(calls.filter(c => c.capability === 'read').every(c => c.status === 'succeeded'));
    const blocked = calls.filter(c => c.capability !== 'read');
    assert.ok(blocked.length >= 2);
    assert.ok(blocked.every(c => c.status === 'blocked' && c.error?.stage === 'permission' && !c.result));
    assert.equal(h.approvals().length, 0, '只读模式不弹审批');
  });

  test('每步询问：批准后执行、拒绝后标记 denied 且无结果', async () => {
    const h = harness();
    const { sessionId, messageId } = await h.send('code', 'ask', '修复登录问题');
    const first = await h.nextApproval(1);
    assert.equal(first.capability, 'write');
    await h.gateway.approvals.decide(first.id, { approved: true, scope: 'once' });
    const second = await h.nextApproval(2);
    assert.equal(second.capability, 'exec');
    await h.gateway.approvals.decide(second.id, { approved: false, scope: 'once' });
    const calls = tools(await h.finished(sessionId, messageId));
    assert.equal(calls.find(c => c.id === first.toolCallId)?.status, 'succeeded');
    const denied = calls.find(c => c.id === second.toolCallId)!;
    assert.equal(denied.status, 'denied');
    assert.equal(denied.result, undefined);
    await assert.rejects(h.gateway.approvals.decide(second.id, { approved: true, scope: 'once' }), (e: unknown) => e instanceof GatewayError && e.code === 'stale');
  });

  test('自动审查：低于阈值的操作审查通过后自动执行，不打扰用户', async () => {
    const h = harness();
    const { sessionId, messageId } = await h.send('code', 'auto-review', '修复登录问题');
    const calls = tools(await h.finished(sessionId, messageId));
    const reviewed = calls.filter(c => c.capability !== 'read');
    assert.ok(reviewed.every(c => c.review?.verdict === 'pass' && c.status === 'succeeded'));
    assert.equal(h.approvals().length, 0);
  });

  test('自动审查：达到阈值的高风险命令转交人工，审批携带审查结论', async () => {
    const h = harness();
    await h.send('cowork', 'auto-review', '跑整套回归');
    const approval = await h.nextApproval(1);
    assert.equal(approval.risk, 'high');
    assert.equal(approval.review?.verdict, 'escalate');
  });

  test('关键操作：完全访问下仍需确认，自动审查下直接阻止', async () => {
    const full = harness();
    await full.send('code', 'full-access', '清理构建目录');
    const approval = await full.nextApproval(1);
    assert.equal(approval.risk, 'critical');

    const review = harness();
    const { sessionId, messageId } = await review.send('code', 'auto-review', '清理构建目录');
    const calls = tools(await review.finished(sessionId, messageId));
    const critical = calls.find(c => c.risk === 'critical')!;
    assert.equal(critical.status, 'blocked');
    assert.equal(critical.review?.verdict, 'block');
  });

  test('停止：运行被取消，待审批被撤回，未执行的工具不产生结果', async () => {
    const h = harness();
    const { sessionId, messageId } = await h.send('code', 'ask', '修复登录问题');
    const approval = await h.nextApproval(1);
    await h.gateway.chat.cancel(sessionId);
    const message = await h.finished(sessionId, messageId);
    assert.equal(message.status, 'cancelled');
    assert.ok(h.events.some(e => e.type === 'approval.resolved' && e.approvalId === approval.id && !e.approved));
    assert.equal(tools(message).find(c => c.id === approval.toolCallId)?.result, undefined);
    assert.deepEqual(await h.gateway.approvals.pending(sessionId), []);
  });

  test('Chat 模式：即使会话标记为只读，联网检索也照常执行且不弹审批', async () => {
    const h = harness();
    const { sessionId, messageId } = await h.send('chat', 'read-only', '搜索一下最新的 Electron 安全实践');
    const calls = tools(await h.finished(sessionId, messageId));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 'succeeded');
    assert.equal(h.approvals().length, 0);
    const inventory = await h.gateway.inspector.tools(sessionId);
    assert.ok(!inventory.allowed.includes('apply_patch') && !inventory.allowed.includes('run_shell'), 'Chat 不暴露有副作用的工具');
  });

  test('推理强度：所选等级按模型映射写入请求 Body，切换后生效', async () => {
    const h = harness();
    const { sessionId, messageId } = await h.gateway.chat.send({ mode: 'chat', permission: 'ask', text: '你好', attachments: [], modelId: 'glm-flash', reasoningEffort: 'max' });
    await h.finished(sessionId, messageId);
    const [request] = await h.gateway.inspector.requests(sessionId);
    assert.deepEqual((request.body as { thinking: unknown }).thinking, { type: 'enabled', effort: 'max' });
    const updated = await h.gateway.sessions.update(sessionId, { reasoningEffort: 'low' });
    assert.equal(updated.reasoningEffort, 'low');
  });

  test('模型配置：校验失败如实报错，保存后列表更新且保留凭据状态', async () => {
    const h = harness();
    await assert.rejects(h.gateway.settings.saveModel({ name: 'x', provider: 'p', model: ' ', mode: 'live' }), (e: unknown) => e instanceof GatewayError && e.code === 'validation');
    await assert.rejects(h.gateway.settings.saveModel({ name: 'x', provider: 'p', model: 'a/b', mode: 'live', contextWindow: 1000, maxOutputTokens: 2000 }), (e: unknown) => e instanceof GatewayError && e.code === 'validation');
    const saved = await h.gateway.settings.saveModel({ id: 'glm-flash', name: 'GLM 5.3', provider: 'Commandcode', model: 'z-ai/glm-5.3-flash', mode: 'live', contextWindow: 500_000, reasoningLevels: ['low', 'max'] });
    assert.equal(saved.credentialPresent, true);
    assert.equal(saved.supportsReasoning, true);
    assert.equal((await h.gateway.settings.models()).find(m => m.id === 'glm-flash')?.contextWindow, 500_000);
    await assert.rejects(h.gateway.settings.removeModel('deepseek-flash'), (e: unknown) => e instanceof GatewayError && e.code === 'invalid_state', '默认模型不能删除');
  });

  test('IDE 工作区：保存产生变更、提交后清空，越界路径与非法正则如实报错', async () => {
    const { gateway } = harness(), project = 'p-agent';
    await assert.rejects(gateway.workspace.writeFile(project, '../outside.txt', 'x'), (e: unknown) => e instanceof GatewayError && e.code === 'permission');
    await assert.rejects(gateway.workspace.search(project, { text: '(', regex: true }), (e: unknown) => e instanceof GatewayError && e.code === 'validation');
    const before = await gateway.workspace.sourceControl(project);
    assert.ok(before.changes.some(c => c.path === 'src/kernel/outbox.ts' && c.status === 'A'));
    const original = await gateway.workspace.readFile(project, 'README.md');
    const saved = await gateway.workspace.writeFile(project, 'README.md', `${original}新增一行\n`);
    assert.equal(saved.path, 'README.md');
    const after = await gateway.workspace.sourceControl(project);
    const readme = after.changes.find(c => c.path === 'README.md')!;
    assert.equal(readme.status, 'M');
    assert.equal(readme.additions, 1);
    const diff = await gateway.workspace.fileDiff(project, 'README.md');
    assert.ok(diff.hunks[0].lines.some(l => l.kind === 'add' && l.text === '新增一行'));
    const hits = await gateway.workspace.search(project, { text: 'enqueue' });
    assert.ok(hits.some(h => h.path === 'src/kernel/outbox.ts' && h.line > 0 && h.preview.includes('enqueue')));
    await assert.rejects(gateway.workspace.commit(project, ' ', ['README.md']), (e: unknown) => e instanceof GatewayError && e.code === 'validation');
    await gateway.workspace.commit(project, 'docs: readme', after.changes.map(c => c.path));
    assert.equal((await gateway.workspace.sourceControl(project)).changes.length, 0);
    const term = await gateway.workspace.terminal(project, 'git status');
    assert.equal(term.exitCode, 0);
    assert.match(term.output, /working tree clean/);
    assert.equal((await gateway.workspace.terminal(project, 'rm -rf /')).exitCode, 1, '未模拟的命令如实失败');
    assert.ok((await gateway.workspace.diagnostics(project)).some(d => d.severity === 'error'));
  });

  test('侧边面板：网页抓取校验协议，侧边聊天不写入主对话', async () => {
    const { gateway, events } = harness();
    await assert.rejects(gateway.web.fetch('javascript:alert(1)'), (e: unknown) => e instanceof GatewayError && e.code === 'validation');
    await assert.rejects(gateway.web.fetch('not a url'), (e: unknown) => e instanceof GatewayError && e.code === 'validation');
    const page = await gateway.web.fetch('https://example.com/docs');
    assert.equal(page.status, 200);
    assert.ok(page.fetchedAt && page.text.length > 0);
    assert.ok((await gateway.web.search('electron')).length > 0);
    const before = (await gateway.sessions.get('s-cowork')).messages.length;
    const answer = await gateway.chat.sideAsk({ sessionId: 's-cowork', question: '现在卡在哪一步？', attachments: [], modelId: 'mock-local', history: [] });
    assert.equal(answer.question, '现在卡在哪一步？');
    assert.equal((await gateway.sessions.get('s-cowork')).messages.length, before, '侧边聊天不改变主对话');
    assert.ok(!events.some(e => e.type === 'message.upsert' && e.sessionId === 's-cowork'));
    const initial = await gateway.chat.sideAsk({ question: '独立侧聊第一句', attachments: [], modelId: 'mock-local' });
    const temp = await gateway.chat.sideAsk({ sideSessionId: initial.sideSessionId, question: '再问一句', attachments: [], modelId: 'mock-local' });
    assert.match(temp.answer, /第 2 轮/, '多轮历史由后台持久会话提供');
    assert.match(temp.answer, /没有读取任何会话上下文/, '没有会话时是临时聊天');
    await assert.rejects(gateway.chat.sideAsk({ question: ' ', attachments: [], modelId: 'mock-local', history: [] }), (e: unknown) => e instanceof GatewayError && e.code === 'validation');
  });

  test('编辑并重新发送：截断其后的消息并按新内容重新生成；只能编辑用户消息', async () => {
    const h = harness();
    const { sessionId, messageId } = await h.send('chat', 'ask', '第一问');
    await h.finished(sessionId, messageId);
    const second = await h.gateway.chat.send({ sessionId, mode: 'chat', permission: 'ask', text: '第二问', attachments: [], modelId: 'mock-local' });
    await h.finished(sessionId, second.messageId);
    const before = (await h.gateway.sessions.get(sessionId)).messages;
    const firstUser = before.find(m => m.role === 'user')!;
    await assert.rejects(h.gateway.chat.edit(sessionId, before[1].id, '改'), (e: unknown) => e instanceof GatewayError && e.code === 'not_found', '助手消息不可编辑');
    await h.gateway.chat.edit(sessionId, firstUser.id, '改过的第一问');
    const edited = (await h.gateway.sessions.get(sessionId)).messages;
    assert.equal(edited[0].id, firstUser.id);
    assert.equal(edited[0].parts[0].kind === 'text' && edited[0].parts[0].text, '改过的第一问');
    assert.ok(!edited.some(m => m.parts.some(p => p.kind === 'text' && p.text === '第二问')), '其后的消息被丢弃');
    await assert.rejects(h.gateway.chat.edit(sessionId, firstUser.id, '运行中再改'), (e: unknown) => e instanceof GatewayError && e.code === 'busy');
  });

  test('项目取消登记只解除关联；MCP 配置校验地址并可增删', async () => {
    const { gateway } = harness();
    const linked = (await gateway.sessions.list({})).items.filter(s => s.projectId === 'p-agent');
    assert.ok(linked.length > 0);
    await gateway.workspace.removeProject('p-agent');
    assert.ok(!(await gateway.workspace.projects()).some(p => p.id === 'p-agent'));
    assert.ok((await gateway.sessions.list({})).items.every(s => s.projectId !== 'p-agent'), '会话保留但不再关联');
    await assert.rejects(gateway.settings.saveMcp({ name: 'web', transport: 'http', target: 'ftp://x', enabled: true }), (e: unknown) => e instanceof GatewayError && e.code === 'validation');
    await assert.rejects(gateway.settings.saveMcp({ name: 'filesystem', transport: 'stdio', target: 'x', enabled: true }), (e: unknown) => e instanceof GatewayError && e.code === 'validation', '名称不可重复');
    const saved = await gateway.settings.saveMcp({ name: 'web', transport: 'http', target: 'http://127.0.0.1:9000/mcp', enabled: true });
    assert.equal(saved.status, 'connected');
    await gateway.settings.removeMcp(saved.id);
    assert.ok(!(await gateway.settings.mcp()).some(s => s.id === saved.id));
    assert.equal((await gateway.settings.reconnectMcp('m-godot')).status, 'error', '仍失败的服务器如实返回错误');
  });

  test('请求重放：Body 校验失败如实报错，合法 Body 生成关联父请求的新记录', async () => {
    const h = harness();
    await assert.rejects(h.gateway.inspector.replay('rq-r1', { model: 'x' }, 'send'), (e: unknown) => e instanceof GatewayError && e.code === 'validation');
    const record = await h.gateway.inspector.replay('rq-r1', { model: 'x', messages: [] }, 'branch');
    assert.equal(record.parentId, 'rq-r1');
    assert.equal(record.status, 'draft');
    assert.ok(record.redactions.includes('headers.authorization'));
  });
});
