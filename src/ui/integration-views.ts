import type { IntegrationSnapshot, IntegrationStatus, PlanInput, ProcessSearchResult } from '../integrations/types.js';
import { append, badge, button, element, empty, field, input, testId, textarea } from './dom.js';
import { displayStatus, errorText, pretty } from './view-model.js';
import type { HarnessUiHost } from './harness-ui.js';

/** Views of the shared integration service, not a scheduler or a verification engine. */
export function mountIntegrationSettings(target: HTMLElement, host: HarnessUiHost): void {
  const content = testId(element('div', 'integration-settings'), 'integration-settings'); target.append(content);
  const load = async () => {
    content.replaceChildren(empty('正在读取集成状态…')); content.setAttribute('aria-busy', 'true');
    try {
      const status = await host.request<IntegrationStatus>('GET', '/v1/integrations/status');
      if (!content.isConnected) return;
      content.replaceChildren(append(element('div', 'integration-status'), badge(status.rea.available ? '静态引擎可用' : '静态引擎不可用', status.rea.available ? 'live' : 'warning'), element('span', 'tiny muted', `${status.rea.engine} ${status.rea.version}`)));
      const enabled = input('', '', 'rea-enabled'); enabled.type = 'checkbox'; enabled.checked = status.rea.enabled;
      content.append(element('p', 'muted', 'REA 用于读取明确选定的本地文件。配置启用不代表已经执行分析，也不改变任务工具审批。'), append(element('label', 'toggle-label'), enabled, '启用 REA 静态分析工具'));
      if (status.rea.reason) content.append(element('p', 'integration-note', status.rea.reason));
      content.append(element('p', 'integration-note', `原生能力不可用：${status.rea.native.reason}`), append(element('div', 'form-actions'), button('刷新状态', () => host.run(load), 'small', 'rea-refresh'), button('保存集成设置', () => host.run(async () => { await host.request('POST', '/v1/integrations/rea', { enabled: enabled.checked }); host.toast('REA 设置已保存；未执行分析。'); await load(); }), 'primary small', 'rea-save')));
      content.append(element('h3', '', '协作数据的边界'), element('p', 'muted', '执行、授权、调度与验收仍来自同一 Kernel。协作计划、共享待办、资源与事实证据是可追溯注记，不会自动变成已验收结果。'));
    } catch (error) { if (content.isConnected) content.replaceChildren(append(element('div', 'notice error'), element('span', '', `集成状态读取失败：${errorText(error)}`), button('重试', () => host.run(load), 'small'))); }
    finally { content.setAttribute('aria-busy', 'false'); }
  };
  host.run(load);
}

export function mountTaskIntegrations(target: HTMLElement, taskId: string, host: HarnessUiHost, selectTask: (id: string) => void, view: 'collaboration' | 'evidence'): void {
  const root = testId(element('section', 'integration-section'), view === 'collaboration' ? 'task-integrations' : 'task-evidence');
  root.append(element('h3', '', view === 'collaboration' ? '协作计划与共享上下文' : '可追溯事实与证据'));
  const content = element('div'); root.append(content); target.append(root);
  const base = `/v1/tasks/${encodeURIComponent(taskId)}/integrations`;
  const load = async () => {
    content.replaceChildren(empty('正在读取已保存记录…')); content.setAttribute('aria-busy', 'true');
    try {
      const data = await host.request<IntegrationSnapshot>('GET', base); if (!root.isConnected) return;
      content.replaceChildren();
      if (view === 'collaboration') paintPlan(data);
      else paintEvidence(data);
    } catch (error) { if (root.isConnected) content.replaceChildren(append(element('div', 'notice error'), element('span', '', `协作数据未取得：${errorText(error)}`), button('重试', () => host.run(load), 'small'))); }
    finally { content.setAttribute('aria-busy', 'false'); }
  };
  const disclose = (label: string, child: HTMLElement) => { const node = element('details', 'integration-evidence'); node.append(element('summary', '', label), child); return node; };
  function paintPlan(data: IntegrationSnapshot) {
    const plan = testId(element('div'), 'integration-plan');
    plan.append(append(element('div', 'row spread'), element('h3', '', data.plan?.title ?? '协作计划'), button('登记计划', editPlan, 'small', 'integration-edit-plan')));
    if (!data.plan) plan.append(empty('尚未登记依赖计划。已有子任务仍可在上方查看；没有记录的进度不会被推断。'));
    for (const node of data.plan?.nodes ?? []) {
      const row = element('article', 'integration-node'); row.append(append(element('div', 'row wrap'), element('strong', '', node.title), badge(node.status === 'not_delegated' ? '尚未分派' : displayStatus(node.status))), element('p', '', node.objective), element('p', 'tiny muted', `依赖：${node.dependencies.join('、') || '无'}；文件所有权：${node.paths.join('、') || '未声明'}`));
      if (node.blockedReason) row.append(element('p', 'integration-note', node.blockedReason));
      if (node.childTaskId) row.append(button('查看实际子任务', () => selectTask(node.childTaskId!), 'small ghost'));
      plan.append(row);
    }
    const todos = testId(element('div', 'integration-section'), 'integration-todos'); todos.append(element('h3', '', '共享待办'));
    if (!data.todos.length) todos.append(empty('还没有共享待办。状态只显示已保存记录。'));
    for (const todo of data.todos) {
      const row = element('div', 'integration-node'); row.append(append(element('div', 'row spread'), element('strong', '', todo.title), badge(todo.status === 'done' ? '已记录完成' : '待办')), element('p', 'tiny muted', `所有者 ${todo.owner} · 修订 ${todo.revision} · ${todo.evidenceIds.length} 条证据`)); todos.append(row);
    }
    content.append(plan, todos, resources(data), button('刷新协作记录', () => host.run(load), 'small', 'integration-refresh'));
    const process = element('div', 'integration-section'); process.append(element('h3', '', '检索其他工作过程'));
    const query = input('', '查找已保留的过程记录', 'integration-process-search'), results = element('div'), form = element('form', 'integration-tools');
    query.setAttribute('aria-label', '检索工作过程'); form.append(query, button('检索原始记录', () => form.requestSubmit(), 'small', 'integration-process-submit'));
    let request = 0;
    form.addEventListener('submit', event => { event.preventDefault(); const token = ++request; host.run(async () => {
      results.replaceChildren(empty('正在检索原始记录…'));
      try {
        const result = await host.request<ProcessSearchResult>('GET', `${base}/processes?q=${encodeURIComponent(query.value)}&limit=20`); if (token !== request || !root.isConnected) return;
        results.replaceChildren(); if (!result.results.length) results.append(empty('没有匹配的已保存过程。'));
        for (const hit of result.results) results.append(disclose(`${hit.owner} / ${hit.role} / ${hit.createdAt}`, append(element('div'), element('p', '', hit.excerpt), button('查看来源原文', () => host.run(async () => { const source = await host.request('GET', `${base}/process?sourceTaskId=${encodeURIComponent(hit.taskId)}&messageId=${encodeURIComponent(hit.sourceId)}`); const dialog = host.showModal('过程原文', `来源任务 ${hit.taskId} · 消息 ${hit.sourceId}`); dialog.body.append(element('pre', 'inspector-json', pretty(source))); }), 'small'))));
        if (result.nextOffset !== null) results.append(element('p', 'tiny muted', '当前显示前 20 条匹配。请细化关键词以定位来源。'));
      } catch (error) { if (token === request && root.isConnected) results.replaceChildren(element('p', 'inspector-error', errorText(error))); }
    }); });
    process.append(form, results); content.append(process);
  }
  function resources(data: IntegrationSnapshot): HTMLElement {
    const list = testId(element('div', 'integration-section'), 'integration-resources'); list.append(element('h3', '', '共享资源'));
    if (!data.resources.length) list.append(empty('没有已登记资源。登记不会自动读取文件或扩大权限。'));
    for (const resource of data.resources) list.append(append(element('div', 'integration-node'), element('strong', '', resource.label), element('code', 'source-path', resource.path)));
    return list;
  }
  function paintEvidence(data: IntegrationSnapshot) {
    content.append(element('p', 'integration-note', '以下事实、假设与证据来自未受信任注记，不替代上方独立验收。引用标识与摘要保留用于回查。'));
    const facts = testId(element('div', 'integration-section'), 'integration-facts');
    if (!data.facts.length) facts.append(empty('尚无登记的事实或假设。'));
    for (const fact of data.facts) facts.append(append(element('article', 'integration-fact'), badge(fact.kind === 'hypothesis' ? '假设 · 待验证' : '观察记录'), element('p', '', fact.statement), element('p', 'tiny muted', `资源 ${fact.resourceId} · 证据 ${fact.evidenceIds.join('、') || '未关联'}`)));
    const evidence = testId(element('div', 'integration-section'), 'integration-evidence'); evidence.append(element('h3', '', '来源证据'));
    if (!data.evidence.length) evidence.append(empty('尚无捕获的原始证据；不会展示示例或虚构验证结果。'));
    for (const item of data.evidence) evidence.append(disclose(`${item.kind} / ${item.sourceId}`, append(element('div'), element('code', 'source-path', `任务 ${item.sourceTaskId}\nSHA-256 ${item.sha256}`), element('pre', '', item.content))));
    content.append(facts, evidence, resources(data), button('刷新事实与证据', () => host.run(load), 'small'));
  }
  function editPlan() {
    const dialog = host.showModal('登记协作计划', '每个节点声明 id、title、objective、dependencies 与独占 paths。保存计划不会假造子任务状态；调度与审批仍由后台执行。');
    const json = textarea('{\n  "id": "",\n  "title": "",\n  "nodes": []\n}', 'PlanInput JSON', 'integration-plan-input'); json.spellcheck = false;
    const submit = button('保存计划', () => host.run(async () => { const plan = JSON.parse(json.value) as PlanInput; await host.request('POST', `${base}/plan`, plan); dialog.close(); await load(); host.toast('协作计划已保存。'); }), 'primary', 'save-integration-plan');
    dialog.body.append(field('明确的节点与依赖', json), append(element('div', 'form-actions'), button('取消', dialog.close, 'ghost'), submit));
  }
  host.run(load);
}
