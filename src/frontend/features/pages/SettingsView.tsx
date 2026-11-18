import { useEffect, useState, type ReactNode } from 'react';
import { gateway, type AccentName, type InstructionFileView, type McpServerInput, type McpServerView, type ModelProfile, type PermissionRule, type PluginView, type Settings, type SkillView, type ThemePreference } from '../../api';
import { capabilityLabels, permissionModes, riskLabels } from '../../api/policy';
import { clearSessionHistory, guard, notify, openIdeView, openSettings, removeModel, updateSettings } from '../../app/actions';
import { bytes, compactNumber } from '../../lib/format';
import { reasoningLabel } from '../../lib/models';
import { Field, ModelEditor } from './ModelEditor';
import { setState, useApp, type SettingsSection } from '../../app/store';
import { Icon, type IconName } from '../../components/Icon';
import { Badge, Button, IconButton, Kbd, Modal, Segmented, Skeleton, StatusDot, Switch } from '../../components/ui';
import type { McpReadCatalog } from '../../api/types';

const sections: { id: SettingsSection; label: string; icon: IconName }[] = [
  { id: 'appearance', label: '外观', icon: 'palette' },
  { id: 'models', label: '模型', icon: 'cpu' },
  { id: 'permissions', label: '权限与审查', icon: 'shieldCheck' },
  { id: 'tools', label: '工具与 MCP', icon: 'plug' },
  { id: 'extensions', label: '插件与 Skills', icon: 'sparkles' },
  { id: 'instructions', label: '指令文件', icon: 'file' },
  { id: 'network', label: '联网', icon: 'globe' },
  { id: 'privacy', label: '隐私与数据', icon: 'database' },
  { id: 'shortcuts', label: '快捷键', icon: 'keyboard' },
  { id: 'about', label: '关于', icon: 'info' },
];

const accents: { id: AccentName; label: string }[] = [{ id: 'ember', label: '陶土（默认）' }, { id: 'indigo', label: '靛灰' }, { id: 'jade', label: '苔绿' }, { id: 'violet', label: '雾紫' }, { id: 'ocean', label: '海蓝' }];

function Row({ title, detail, children }: { title: string; detail?: ReactNode; children: ReactNode }) {
  return <div className="set-row"><div className="grow"><div className="set-row__title">{title}</div>{detail && <div className="set-row__detail">{detail}</div>}</div><div className="set-row__control">{children}</div></div>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="set-group"><h3>{title}</h3><div className="set-group__body">{children}</div></section>;
}

function Appearance({ settings }: { settings: Settings }) {
  const a = settings.appearance;
  const themes: { id: ThemePreference; label: string; icon: IconName }[] = [{ id: 'light', label: '暖白', icon: 'sun' }, { id: 'dark', label: '深墨', icon: 'moon' }, { id: 'system', label: '跟随系统', icon: 'monitor' }];
  return (
    <>
      <Group title="主题">
        <div className="theme-cards">
          {themes.map(theme => (
            <button key={theme.id} type="button" className={`theme-card theme-card--${theme.id}${a.theme === theme.id ? ' is-active' : ''}`} onClick={event => void updateSettings({ appearance: { theme: theme.id } }, { x: event.clientX, y: event.clientY })}>
              <span className="theme-card__preview"><span className="tp-side" /><span className="tp-main"><span /><span /><span className="tp-accent" /></span></span>
              <span className="theme-card__label"><Icon name={theme.icon} size={14} />{theme.label}{a.theme === theme.id && <Icon name="check" size={14} />}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group title="强调色">
        <div className="swatches">{accents.map(accent => <button key={accent.id} type="button" className={`swatch swatch--${accent.id}${a.accent === accent.id ? ' is-active' : ''}`} onClick={() => void updateSettings({ appearance: { accent: accent.id } })}><span />{accent.label}</button>)}</div>
      </Group>
      <Group title="界面">
        <Row title="信息密度" detail="紧凑模式减少留白，适合 Inspector 重度使用"><Segmented size="sm" value={a.density} onChange={value => void updateSettings({ appearance: { density: value } })} options={[{ value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' }]} /></Row>
        <Row title="动效" detail="减弱后保留状态变化，去掉位移与循环动画"><Segmented size="sm" value={a.motion} onChange={value => void updateSettings({ appearance: { motion: value } })} options={[{ value: 'full', label: '完整' }, { value: 'reduced', label: '减弱' }]} /></Row>
        <Row title="环境光" detail="背景缓慢流动的柔光与颗粒质感"><Switch checked={a.ambient} onChange={value => void updateSettings({ appearance: { ambient: value } })} /></Row>
        <Row title="字号" detail={`${Math.round(a.fontScale * 100)}%`}><input className="range" type="range" min={0.9} max={1.2} step={0.05} value={a.fontScale} onChange={event => void updateSettings({ appearance: { fontScale: Number(event.target.value) } })} /></Row>
      </Group>
    </>
  );
}

function Models({ settings }: { settings: Settings }) {
  const models = useApp(s => s.models);
  const [testing, setTesting] = useState<string>();
  const [editing, setEditing] = useState<{ profile?: ModelProfile; key: number }>();
  const test = async (id: string) => {
    setTesting(id);
    const result = await guard('连接测试失败', () => gateway.settings.testModel(id));
    setTesting(undefined);
    if (result) notify(result.ok ? 'success' : 'error', result.ok ? '连接正常' : '连接失败', result.message);
  };
  return (
    <Group title="模型配置">
      {models.map(model => (
        <div key={model.id} className="model-row">
          <span className={`model-option__badge model-option__badge--${model.mode}`}>{model.mode === 'live' ? 'LIVE' : 'MOCK'}</span>
          <div className="grow">
            <div className="set-row__title">{model.name}{settings.defaults.modelId === model.id && <Badge tone="accent">默认</Badge>}{settings.autoReview.reviewerModelId === model.id && <Badge tone="info">审查器</Badge>}{model.autoConfig && <Badge>智能配置</Badge>}</div>
            <div className="set-row__detail mono">{model.provider} · {model.model}</div>
            <div className="model-row__specs">
              <span>上下文 {model.contextWindow ? compactNumber(model.contextWindow) : '未配置'}</span>
              <span>输出 {model.maxOutputTokens ? compactNumber(model.maxOutputTokens) : '未配置'}</span>
              <span>{model.reasoningLevels?.length ? `推理 ${model.reasoningLevels.map(reasoningLabel).join(' / ')}` : '不支持推理档'}</span>
              {model.inputTypes && model.inputTypes.length > 1 && <span>多模态 {model.inputTypes.length}</span>}
            </div>
          </div>
          <span className="model-row__cred">{model.credentialPresent ? <><StatusDot tone="ok" />凭据已配置</> : <><StatusDot tone="danger" />缺少凭据</>}</span>
          {model.remainingLiveRequests !== undefined && <span className="muted num">剩余 {model.remainingLiveRequests} 次</span>}
          <Button size="sm" variant="ghost" onClick={() => void updateSettings({ defaults: { modelId: model.id } })} disabled={settings.defaults.modelId === model.id}>设为默认</Button>
          <Button size="sm" variant="secondary" icon="activity" disabled={testing === model.id} onClick={() => void test(model.id)}>{testing === model.id ? '测试中…' : '测试连接'}</Button>
          <Button size="sm" variant="secondary" icon="pencil" onClick={() => setEditing({ profile: model, key: Date.now() })}>编辑</Button>
          <button type="button" className="icon-btn" aria-label="删除模型配置" data-tip="删除" disabled={settings.defaults.modelId === model.id} onClick={() => void removeModel(model.id)}><Icon name="trash" size={14} /></button>
        </div>
      ))}
      <div className="model-row"><Button size="sm" variant="ghost" icon="plus" onClick={() => setEditing({ key: Date.now() })}>添加模型</Button></div>
      <div className="set-note"><Icon name="lock" size={12} />API Key 只保存在后台凭据区，前端永远不会显示或导出。</div>
      {editing && <ModelEditor key={editing.key} profile={editing.profile} open onClose={() => setEditing(undefined)} />}
    </Group>
  );
}

function Permissions({ settings }: { settings: Settings }) {
  const models = useApp(s => s.models);
  const [rules, setRules] = useState<PermissionRule[]>(settings.rules);
  const saveRules = (next: PermissionRule[]) => { setRules(next); void updateSettings({ rules: next }); };
  return (
    <>
      <Group title="新会话默认权限模式">
        <div className="perm-cards">
          {permissionModes.map(mode => (
            <button key={mode.id} type="button" className={`perm-card perm-option--${mode.tone}${settings.defaults.permission === mode.id ? ' is-active' : ''}`} onClick={() => void updateSettings({ defaults: { permission: mode.id } })}>
              <span className="perm-option__icon"><Icon name={({ 'read-only': 'lock', ask: 'shield', 'auto-review': 'shieldCheck', 'full-access': 'zap' } as const)[mode.id]} size={18} /></span>
              <strong>{mode.label}</strong>
              <span className="muted">{mode.description}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group title="自动审查">
        <Row title="审查模型" detail="独立于执行模型，只读取待执行操作与目标契约"><select className="select" value={settings.autoReview.reviewerModelId} onChange={event => void updateSettings({ autoReview: { reviewerModelId: event.target.value } })}>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Row>
        <Row title="升级到人工的风险阈值" detail="达到该风险等级的操作即使审查通过也转交你确认"><Segmented size="sm" value={settings.autoReview.escalateAt} onChange={value => void updateSettings({ autoReview: { escalateAt: value } })} options={(['medium', 'high', 'critical'] as const).map(r => ({ value: r, label: riskLabels[r] }))} /></Row>
        <Row title="显示审查理由" detail="在工具卡片中展示审查器的检查项与结论"><Switch checked={settings.autoReview.explain} onChange={value => void updateSettings({ autoReview: { explain: value } })} /></Row>
      </Group>
      <Group title="命令与路径规则">
        <div className="rules">
          <div className="rules__head"><span>匹配</span><span>能力</span><span>决定</span><span /></div>
          {rules.map(rule => (
            <div key={rule.id} className="rules__row">
              <input className="input mono" value={rule.pattern} onChange={event => setRules(rules.map(r => r.id === rule.id ? { ...r, pattern: event.target.value } : r))} onBlur={() => saveRules(rules)} />
              <select className="select" value={rule.capability} onChange={event => saveRules(rules.map(r => r.id === rule.id ? { ...r, capability: event.target.value as PermissionRule['capability'] } : r))}>{Object.entries(capabilityLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <Segmented size="sm" value={rule.decision} onChange={value => saveRules(rules.map(r => r.id === rule.id ? { ...r, decision: value } : r))} options={[{ value: 'allow', label: '允许' }, { value: 'ask', label: '询问' }, { value: 'deny', label: '拒绝' }]} />
              <button type="button" className="icon-btn" aria-label="删除规则" onClick={() => saveRules(rules.filter(r => r.id !== rule.id))}><Icon name="trash" size={14} /></button>
            </div>
          ))}
          <Button size="sm" variant="ghost" icon="plus" onClick={() => saveRules([...rules, { id: `r-${Date.now()}`, pattern: '', capability: 'exec', decision: 'ask' }])}>添加规则</Button>
        </div>
        <div className="set-note"><Icon name="info" size={12} />规则优先于权限模式；“拒绝”在任何模式下都生效。</div>
      </Group>
    </>
  );
}

function useList<T>(load: () => Promise<T[]>, title: string) {
  const [items, setItems] = useState<T[]>();
  useEffect(() => { void guard(title, load).then(result => setItems(result ?? [])); }, []);
  return [items, setItems] as const;
}

function McpEditor({ server, onClose, onSaved }: { server?: McpServerView; onClose: () => void; onSaved: (saved: McpServerView) => void }) {
  const [form, setForm] = useState<McpServerInput>({ id: server?.id, name: server?.name ?? '', transport: server?.transport ?? 'stdio', target: server?.target ?? '', enabled: server?.enabled ?? true });
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState<McpServerView>();
  const set = <K extends keyof McpServerInput>(key: K, value: McpServerInput[K]) => { setReview(undefined); setForm(current => ({ ...current, [key]: value })); };
  const submit = async (approve = false) => {
    setSaving(true);
    const saved = await guard('保存 MCP 服务器失败', () => gateway.settings.saveMcp({ ...form, ...(approve && review?.digest ? { approvedDigest: review.digest } : {}) }));
    setSaving(false);
    if (saved) { onSaved(saved); setForm(current => ({ ...current, id: saved.id })); setReview(saved); if (saved.status === 'connected' || !saved.enabled) onClose(); }
  };
  return (
    <Modal open onClose={onClose} title={server ? `编辑 ${server.name}` : '添加 MCP 服务器'} width={520}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" disabled={saving || !form.name.trim() || !form.target.trim()} onClick={() => void submit(!!review?.digest)}>{saving ? '处理中…' : review?.digest ? '批准该配置并连接' : '保存配置'}</Button></>}>
      <div className="model-form">
        <Field label="名称" help="连接后可查看服务提供的实际工具目录"><input className="input mono" autoFocus value={form.name} placeholder="例如 filesystem" onChange={e => set('name', e.target.value)} /></Field>
        <Field label="传输方式"><Segmented size="sm" value={form.transport} onChange={value => set('transport', value)} options={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'HTTP' }, { value: 'sse', label: 'SSE' }]} /></Field>
        <Field label={form.transport === 'stdio' ? '启动命令' : '服务地址'} help={form.transport === 'stdio' ? '使用项目内可执行文件和脚本的完整路径；凭据不要写在命令里。进程以可执行文件所在目录启动。' : '当前版本只支持 stdio；HTTP/SSE 会返回不支持。'}>
          <input className="input mono" value={form.target} placeholder={form.transport === 'stdio' ? '"D:\\项目\\node.exe" "D:\\项目\\server.mjs"' : 'http://127.0.0.1:8931/mcp'} onChange={e => set('target', e.target.value)} />
        </Field>
        <div className="model-form__row"><span className="form-field__label">启用</span><Switch checked={form.enabled} onChange={value => set('enabled', value)} label="启用" /></div>
        {review && <div className="set-note" role="status">{review.error}<p>批准后将运行此本地服务，并信任其工具声明。Chat 仅可使用目录声明为只读且未标记破坏性的工具；其他调用仍使用 Cowork 权限。</p><code>{review.digest}</code></div>}
      </div>
    </Modal>
  );
}

function McpCatalog({ server, onClose }: { server: McpServerView; onClose: () => void }) {
  const [catalog, setCatalog] = useState<McpReadCatalog>();
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string>();
  useEffect(() => { let active = true; setCatalog(undefined); setError(undefined); gateway.settings.mcpCatalog(server.id, page * 40).then(value => { if (active) setCatalog(value); }, failure => { if (active) setError((failure as Error).message); }); return () => { active = false; }; }, [server.id, page]);
  return <Modal open onClose={onClose} title={`${server.name} · 工具目录`} width={620} footer={<Button onClick={onClose}>关闭</Button>}>
    <div className="model-form"><div className="set-note">Chat 只提供此已批准服务声明的只读工具；服务声明不是操作系统沙箱。</div>{error && <div role="alert">{error}</div>}{!catalog && !error && <Skeleton lines={3} />}
      {catalog?.tools.map(tool => <details key={tool.name}><summary>{tool.name} · {tool.chatAllowed ? 'Chat 可读取' : '仅 Cowork'}</summary><p>{tool.description}</p><pre className="mono">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}
      <div className="raw__actions"><Button disabled={!page} onClick={() => setPage(value => value - 1)}>上一页</Button><span>{page + 1} / {catalog ? Math.max(1, Math.ceil(catalog.total / 40)) : '…'}</span><Button disabled={!catalog || (page + 1) * 40 >= catalog.total} onClick={() => setPage(value => value + 1)}>下一页</Button></div>
    </div></Modal>;
}

function Tools() {
  const [servers, setServers] = useList<McpServerView>(() => gateway.settings.mcp(), '读取 MCP 失败');
  const [editing, setEditing] = useState<McpServerView | 'new'>();
  const [catalog, setCatalog] = useState<McpServerView>();
  const [busy, setBusy] = useState<string>();
  const upsert = (saved: McpServerView) => setServers(current => (current?.some(s => s.id === saved.id) ? current.map(s => (s.id === saved.id ? saved : s)) : [...(current ?? []), saved]));
  const reconnect = async (server: McpServerView) => {
    setBusy(server.id);
    const result = await guard('重新连接失败', () => gateway.settings.reconnectMcp(server.id));
    setBusy(undefined);
    if (result) { upsert(result); notify(result.status === 'connected' ? 'success' : 'error', result.status === 'connected' ? `${result.name} 已连接` : `${result.name} 仍无法连接`, result.error); }
  };
  const remove = async (server: McpServerView) => {
    const ok = await guard('删除 MCP 服务器失败', async () => { await gateway.settings.removeMcp(server.id); return true; });
    if (ok) setServers(current => current?.filter(s => s.id !== server.id));
  };
  return (
    <Group title="MCP 服务器">
      {!servers ? <Skeleton lines={3} /> : servers.map(server => (
        <div key={server.id} className="model-row">
          <StatusDot tone={server.status === 'connected' ? 'ok' : server.status === 'error' ? 'danger' : 'idle'} />
          <div className="grow">
            <div className="set-row__title">{server.name}<Badge>{server.transport}</Badge></div>
            {server.target && <div className="set-row__detail mono truncate" title={server.target}>{server.target}</div>}
            <div className={`set-row__detail${server.error ? ' danger' : ''}`}>{server.error ?? `${server.tools} 个工具`}</div>
          </div>
          <Badge tone={server.status === 'connected' ? 'ok' : server.status === 'error' ? 'danger' : 'neutral'}>{({ connected: '已连接', disconnected: '未连接', error: '错误' })[server.status]}</Badge>
          <Button size="sm" variant="ghost" disabled={server.status !== 'connected'} onClick={() => setCatalog(server)}>查看工具</Button>
          <IconButton icon="refresh" label="重新连接" size={14} disabled={busy === server.id} className={busy === server.id ? 'is-spinning' : undefined} onClick={() => void reconnect(server)} />
          <IconButton icon="pencil" label="编辑" size={14} onClick={() => setEditing(server)} />
          <IconButton icon="trash" label="删除" size={14} tipSide="bottom-end" onClick={() => void remove(server)} />
        </div>
      ))}
      <Button size="sm" variant="ghost" icon="plus" onClick={() => setEditing('new')}>添加服务器</Button>
      <div className="set-note"><Icon name="shield" size={12} />仅连接已批准的本地服务。Chat 的 MCP 开关只启用目录声明的只读工具；其他调用受 Cowork 权限约束。</div>
      {editing && <McpEditor server={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={upsert} />}
      {catalog && <McpCatalog server={catalog} onClose={() => setCatalog(undefined)} />}
    </Group>
  );
}

const scopeLabel = { global: '全局', project: '项目' } as const;

function Instructions() {
  const [files] = useList<InstructionFileView>(() => gateway.settings.instructions(), '读取指令文件失败');
  const projects = useApp(s => s.projects);
  const groups = [
    { key: 'global', title: '全局', items: files?.filter(f => f.scope === 'global') ?? [] },
    ...projects.map(p => ({ key: p.id, title: p.name, items: files?.filter(f => f.projectId === p.id) ?? [] })).filter(g => g.items.length),
  ];
  return (
    <>
      <Group title="加载规则">
        <div className="set-note set-note--block">
          <Icon name="info" size={12} />
          <span>下面是后台发现的全局与项目指令文件（如 <span className="mono">AGENTS.md</span>），按序号从小到大注入，后注入的内容追加在后。文件名与查找路径以后台实际支持的规则为准；每次请求实际注入了什么，可在 检查器 → Prompt 中逐项查看。</span>
        </div>
      </Group>
      {!files ? <Skeleton lines={4} /> : groups.map(group => (
        <Group key={group.key} title={group.title}>
          {group.items.length === 0 && <div className="muted">没有发现指令文件</div>}
          {group.items.sort((a, b) => a.order - b.order).map(file => (
            <div key={file.id} className="model-row">
              <span className="instr-order num">{file.order}</span>
              <div className="grow">
                <div className="set-row__title mono truncate" title={file.path}>{file.path}</div>
                <div className={`set-row__detail${file.status === 'error' ? ' danger' : ''}`}>{scopeLabel[file.scope]} · {file.status === 'loaded' ? `已加载 ${bytes(file.bytes ?? 0)}` : file.status === 'missing' ? '文件不存在，未注入' : file.error ?? '读取失败'}</div>
              </div>
              <Badge tone={file.status === 'loaded' ? 'ok' : file.status === 'error' ? 'danger' : 'neutral'}>{({ loaded: '已加载', missing: '未找到', error: '错误' })[file.status]}</Badge>
              {file.projectId && <IconButton icon="terminal" label="在 IDE 中打开" size={14} tipSide="bottom-end" onClick={() => openIdeView(file.projectId)} />}
            </div>
          ))}
        </Group>
      ))}
    </>
  );
}

function Extensions() {
  const [plugins] = useList<PluginView>(() => gateway.settings.plugins(), '读取插件失败');
  const [skills, setSkills] = useList<SkillView>(() => gateway.settings.skills(), '读取 Skills 失败');
  const toggle = async (skill: SkillView, enabled: boolean) => {
    const updated = await guard('切换 Skill 失败', () => gateway.settings.toggleSkill(skill.id, enabled));
    if (updated) setSkills(current => current?.map(s => (s.id === updated.id ? updated : s)));
  };
  return (
    <>
      <Group title="插件">
        {!plugins ? <Skeleton lines={3} /> : plugins.map(plugin => (
          <div key={plugin.id} className="model-row">
            <span className="plugin-icon"><Icon name="plug" size={16} /></span>
            <div className="grow"><div className="set-row__title">{plugin.name}<span className="muted mono"> v{plugin.version}</span></div><div className="set-row__detail">{plugin.description}</div><div className="row">{plugin.capabilities.map(c => <Badge key={c}>{capabilityLabels[c]}</Badge>)}</div></div>
            <Badge tone={plugin.status === 'active' ? 'ok' : plugin.status === 'pending_approval' ? 'warn' : 'neutral'}>{({ active: '已启用', pending_approval: '待审批能力', disabled: '已停用' })[plugin.status]}</Badge>
          </div>
        ))}
      </Group>
      <Group title="Skills">
        {!skills ? <Skeleton lines={3} /> : skills.map(skill => (
          <Row key={skill.id} title={skill.name} detail={<>{skill.description}<span className="mono muted"> · {skill.source}</span></>}><Switch checked={skill.enabled} onChange={value => void toggle(skill, value)} /></Row>
        ))}
      </Group>
    </>
  );
}

function Network({ settings }: { settings: Settings }) {
  return (
    <Group title="联网能力">
      <Row title="联网检索" detail="允许模型调用 web_search，结果附带来源与时间戳"><Switch checked={settings.network.webSearch} onChange={value => void updateSettings({ network: { webSearch: value } })} /></Row>
      <Row title="网页抓取" detail="允许读取指定 URL 的正文"><Switch checked={settings.network.fetch} onChange={value => void updateSettings({ network: { fetch: value } })} /></Row>
      <Row title="代理" detail="留空表示直连"><input className="input mono" placeholder="http://127.0.0.1:7890" defaultValue={settings.network.proxy} onBlur={event => void updateSettings({ network: { proxy: event.target.value } })} /></Row>
    </Group>
  );
}

function Privacy({ settings }: { settings: Settings }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Group title="记录">
        <Row title="记录请求正文" detail="关闭后 Inspector 仅保留请求元数据与哈希，不保存详细 Body；用于任务恢复的 Kernel 消息、工具效果记录与检查点仍保存在本地数据目录。"><Switch checked={settings.privacy.recordContent} onChange={value => void updateSettings({ privacy: { recordContent: value } })} /></Row>
        <Row title="自动脱敏" detail="在记录与导出中移除 Authorization、API Key 等凭据"><Switch checked={settings.privacy.redactSecrets} onChange={value => void updateSettings({ privacy: { redactSecrets: value } })} /></Row>
      </Group>
      <Group title="数据">
        <Row title="打开数据目录" detail="会话、轨迹与长期记忆的持久化位置"><Button size="sm" variant="secondary" icon="folderOpen" onClick={() => void guard('打开数据目录失败', () => gateway.desktop.openDataFolder())}>打开</Button></Row>
        <Row title="清除历史" detail="删除所有未置顶的会话记录，不可撤销"><Button size="sm" variant="danger" icon="trash" onClick={() => setConfirm(true)}>清除…</Button></Row>
      </Group>
      <Modal open={confirm} onClose={() => setConfirm(false)} title="清除全部未置顶的历史？" tone="danger" width={420}
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>取消</Button><Button variant="danger" icon="trash" onClick={() => { setConfirm(false); void clearSessionHistory(); }}>确认清除</Button></>}>
        <p>置顶的会话会保留。长期记忆与审计记录由后台按保留策略单独管理。</p>
      </Modal>
    </>
  );
}

const shortcuts: [string, string][] = [
  ['Ctrl+K', '命令面板 / 全局搜索'], ['Ctrl+N', '新建当前模式会话'], ['Ctrl+1', '切换到 Chat'], ['Ctrl+2', '切换到 Cowork'], ['Ctrl+3', '切换到 Code'],
  ['Ctrl+B', '收起 / 展开侧栏'], ['Ctrl+I', '收起 / 打开侧边面板'], ['Ctrl+Alt+S', '侧边聊天'], ['Ctrl+P', '侧边面板 · 文件'], ['Ctrl+`', '侧边面板 · 终端'], ['Ctrl+,', '打开设置'], ['Enter', '发送（可在设置中改为 Ctrl+Enter）'], ['Shift+Enter', '换行'], ['/', '在输入框开头唤出命令'], ['Esc', '停止生成 / 关闭浮层'],
];

function About() {
  const connection = useApp(s => s.connection);
  const [version, setVersion] = useState<string>();
  useEffect(() => { void guard('读取版本失败', () => gateway.desktop.version()).then(setVersion); }, []);
  return (
    <Group title="关于 NPN Gamma">
      <Row title="前端版本" detail="当前前端版本，后台接线完成前使用演示网关"><span className="mono">{version ?? '—'}</span></Row>
      <Row title="网关" detail={gateway.kind === 'mock' ? '演示网关：全部数据为前端内存中的演示数据' : '真实网关：通过 Electron preload 连接后台'}><Badge tone={gateway.kind === 'mock' ? 'warn' : 'ok'}>{gateway.kind}</Badge></Row>
      <Row title="后台" detail={connection?.message}><span className="mono">{connection?.backendVersion ?? '—'}</span></Row>
    </Group>
  );
}

export function SettingsView({ section }: { section: SettingsSection }) {
  const settings = useApp(s => s.settings);
  return (
    <div className="settings">
      <nav className="settings__nav">
        <div className="settings__title">设置</div>
        {sections.map(item => <button key={item.id} type="button" className={`nav-item${section === item.id ? ' is-active' : ''}`} onClick={() => openSettings(item.id)}><Icon name={item.icon} size={15} /><span>{item.label}</span></button>)}
      </nav>
      <div className="settings__body" key={section}>
        <h2 className="settings__heading rise-in">{sections.find(s => s.id === section)!.label}</h2>
        <div className="rise-in">
          {!settings ? <Skeleton lines={6} /> : (
            <>
              {section === 'appearance' && <Appearance settings={settings} />}
              {section === 'models' && <Models settings={settings} />}
              {section === 'permissions' && <Permissions settings={settings} />}
              {section === 'tools' && <Tools />}
              {section === 'extensions' && <Extensions />}
              {section === 'instructions' && <Instructions />}
              {section === 'network' && <Network settings={settings} />}
              {section === 'privacy' && <Privacy settings={settings} />}
              {section === 'shortcuts' && <Group title="键盘快捷键">{shortcuts.map(([keys, label]) => <Row key={keys} title={label}><Kbd keys={keys} /></Row>)}</Group>}
              {section === 'about' && <About />}
            </>
          )}
        </div>
      </div>
      <button type="button" className="settings__close icon-btn" aria-label="关闭设置" onClick={() => setState({ view: { kind: 'home' } })}><Icon name="x" size={16} /></button>
    </div>
  );
}
