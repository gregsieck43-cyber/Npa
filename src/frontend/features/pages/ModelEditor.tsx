import { useMemo, useRef, useState, type ReactNode } from 'react';
import { wireBody, wireSettings } from '../../../runtime/provider-wire';
import { gateway, type ModelCapability, ModelInputType, ModelProfile, ModelProfileInput } from '../../api';
import { guard, saveModel } from '../../app/actions';
import { Icon } from '../../components/Icon';
import { JsonEditor } from '../../components/JsonEditor';
import { Button, Modal, Switch } from '../../components/ui';
import { applyReasoningMapping, catalogModel, defaultLevel, inferModelLimits, reasoningLabel } from '../../lib/models';

const inputTypes: { id: ModelInputType; label: string }[] = [{ id: 'text', label: '文本' }, { id: 'image', label: '图片' }, { id: 'video', label: '视频' }, { id: 'pdf', label: 'PDF' }];
const capabilityOptions: { id: ModelCapability; label: string }[] = [{ id: 'structuredOutput', label: '结构化输出' }, { id: 'nativeWebSearch', label: '原生联网搜索' }, { id: 'systemMessageInChat', label: '对话中系统消息' }];

interface Form {
  name: string; provider: string; model: string; autoConfig: boolean;
  contextWindow: string; maxOutputTokens: string;
  inputTypes: ModelInputType[]; capabilities: ModelCapability[]; reasoningLevels: string[]; mapping: string;
}

function toForm(profile?: ModelProfile): Form {
  return {
    name: profile?.name ?? '', provider: profile?.provider ?? '', model: profile?.model ?? '', autoConfig: profile?.autoConfig ?? true,
    contextWindow: profile?.contextWindow ? String(profile.contextWindow) : '', maxOutputTokens: profile?.maxOutputTokens ? String(profile.maxOutputTokens) : '',
    inputTypes: profile?.inputTypes ?? ['text'], capabilities: profile?.capabilities ?? [], reasoningLevels: profile?.reasoningLevels ?? [],
    mapping: profile?.reasoningMapping === undefined ? '{\n  "reasoning_effort": "{{level}}"\n}' : JSON.stringify(profile.reasoningMapping, null, 2),
  };
}

function Help({ text }: { text: string }) {
  return <span className="help-dot" data-tip={text} data-tip-side="top" tabIndex={0}><Icon name="info" size={13} /></span>;
}

export function Field({ label, help, children, error }: { label: string; help?: string; children: ReactNode; error?: string }) {
  return (
    <label className="form-field">
      <span className="form-field__label">{label}{help && <Help text={help} />}</span>
      {children}
      {error && <span className="form-field__error"><Icon name="alert" size={12} />{error}</span>}
    </label>
  );
}

function CheckChip({ checked, label, locked, onChange }: { checked: boolean; label: string; locked?: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" className={`check-chip${checked ? ' is-on' : ''}${locked ? ' is-locked' : ''}`} aria-pressed={checked} disabled={locked} onClick={() => onChange(!checked)}>
      <span className="check-chip__box">{checked && <Icon name="check" size={12} strokeWidth={2.6} />}</span>
      {label}
      {locked && <Icon name="lock" size={12} className="muted" />}
    </button>
  );
}

const positiveInt = (value: string) => (/^\d+$/.test(value) && Number(value) > 0 ? Number(value) : undefined);

export function ModelEditor({ profile, open, onClose }: { profile?: ModelProfile; open: boolean; onClose: () => void }) {
  const [form, setForm] = useState<Form>(() => toForm(profile));
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [allowance, setAllowance] = useState('');
  const [format, setFormat] = useState<import('../../api/types').WireSettings['format']>(profile?.wire?.format ?? 'chat');
  const [protocol, setProtocol] = useState(profile?.wire?.protocol ?? 'chat');
  const [endpointPath, setEndpointPath] = useState(profile?.wire?.path ?? 'chat/completions');
  const { format: _format, protocol: _protocol, path: _path, ...customFields } = profile?.wire ?? {};
  const [custom, setCustom] = useState(JSON.stringify(customFields, null, 2));
  const [available, setAvailable] = useState<import('../../api/types').DiscoveredModel[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const live = profile?.mode !== 'mock';
  const wire = (): import('../../api/types').WireSettings => format === 'custom'
    ? { ...JSON.parse(custom), format, protocol, path: endpointPath } : { format };
  const directoryKey = useRef('');
  directoryKey.current = JSON.stringify([baseUrl, format, protocol, custom, endpointPath, apiKey]);
  const refresh = async () => {
    const requested = directoryKey.current;
    setRefreshing(true);
    try {
      const rows = await guard('刷新模型失败', () => gateway.settings.discoverModels({ id: profile?.id, baseUrl, wire: wire(), apiKey }));
      if (rows && requested === directoryKey.current) setAvailable(rows);
    } finally { setRefreshing(false); }
  };
  let wirePreview = '', wireError = '';
  if (format === 'custom') {
    try {
      const settings = wireSettings(wire());
      wirePreview = JSON.stringify(wireBody({ model: form.model || 'example', messages: [{ role: 'user', content: '示例' }], stream: true, max_tokens: 256 }, settings), null, 2);
    } catch (error) { wireError = (error as Error).message; }
  }
  const [advanced, setAdvanced] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const savedManual = profile?.manualFields ?? (profile ? ['contextWindow','maxOutputTokens','inputTypes','capabilities','reasoningLevels','mapping'] : []);
  const [manual, setManual] = useState<string[]>(savedManual);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    if (['contextWindow','maxOutputTokens','inputTypes','capabilities','reasoningLevels','mapping'].includes(key)) {
      setManual(fields => [...fields.filter(f => f !== key), ...(value === '' ? [] : [key])]);
    }
    setForm(current => ({ ...current, [key]: value }));
  };
  const found = available.find(m => m.id === form.model);
  const knownRow = catalogModel(form.model, baseUrl, format === 'custom' ? protocol : format);
  const known = inferModelLimits(form.model, baseUrl, format === 'custom' ? protocol : format);
  const inferred = found || known ? { contextWindow: found?.contextWindow ?? known?.contextWindow, maxOutputTokens: found?.maxOutputTokens ?? known?.maxOutputTokens } : undefined;
  const effectiveMax = form.autoConfig && !manual.includes('maxOutputTokens') && inferred?.maxOutputTokens ? Math.min(inferred.maxOutputTokens, 131072) : positiveInt(form.maxOutputTokens);
  const effectiveContext = form.autoConfig && !manual.includes('contextWindow') && inferred?.contextWindow ? inferred.contextWindow : positiveInt(form.contextWindow);

  const inputs = form.autoConfig && !manual.includes('inputTypes') ? found?.inputTypes ?? knownRow?.[5] ?? form.inputTypes : form.inputTypes;
  const capabilities = form.autoConfig && !manual.includes('capabilities') && knownRow ? (knownRow[6] ? ['structuredOutput' as const] : []) : form.capabilities;
  const mapping = useMemo(() => {
    if (!form.mapping.trim()) return { value: undefined as unknown };
    try { return { value: JSON.parse(form.mapping) as unknown }; } catch (error) { return { error: (error as Error).message }; }
  }, [form.mapping]);

  const errors: Partial<Record<'model' | 'contextWindow' | 'maxOutputTokens' | 'levels' | 'mapping', string>> = {};
  if (!form.model.trim()) errors.model = '请填写服务商使用的模型 ID';
  if (form.contextWindow && !positiveInt(form.contextWindow)) errors.contextWindow = '必须是正整数';
  if (form.contextWindow && !effectiveContext) errors.contextWindow ??= '无法推断，请手动填写上下文窗口';
  if (!form.autoConfig && form.maxOutputTokens && !positiveInt(form.maxOutputTokens)) errors.maxOutputTokens = '必须是正整数';
  if (effectiveMax && effectiveContext && effectiveMax > effectiveContext) errors.maxOutputTokens = '最大输出不能超过上下文窗口';
  const levels = form.reasoningLevels.map(l => l.trim());
  if (levels.some(l => !l)) errors.levels = '推理等级不能为空';
  else if (new Set(levels).size !== levels.length) errors.levels = '推理等级不能重复';
  if ('error' in mapping) errors.mapping = `JSON 无效：${mapping.error}`;
  const valid = Object.keys(errors).length === 0 && !wireError;
  const preview = levels.length && 'value' in mapping && mapping.value !== undefined ? applyReasoningMapping(mapping.value, defaultLevel(levels)!) : undefined;

  const submit = async () => {
    setSubmitted(true);
    if (!valid) return;
    setSaving(true);
    let connection = {};
    if (live) {
      const settings = await guard('连接配置无效', async () => {
        const url = new URL(baseUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('请输入 HTTPS Base URL');
        return { baseUrl: url.href, wire: wire(), ...(apiKey ? { apiKey } : {}), ...(allowance ? { allowance: Number(allowance) } : {}) };
      });
      if (!settings) { setSaving(false); return; }
      connection = settings;
    }
    const input: ModelProfileInput = {
      ...connection, id: profile?.id, name: form.name.trim() || form.model.trim(), provider: form.provider.trim() || '自定义', model: form.model.trim(), mode: profile?.mode ?? 'live',
      autoConfig: form.autoConfig, contextWindow: effectiveContext, maxOutputTokens: effectiveMax,
      manualFields: manual, inputTypes: inputs, capabilities, reasoningLevels: levels, supportsReasoning: levels.length > 0 || (form.autoConfig && knownRow?.[7]),
      reasoningMapping: 'value' in mapping ? mapping.value : undefined,
    };
    const saved = await saveModel(input);
    setSaving(false);
    if (saved) onClose();
  };
  const show = (key: keyof typeof errors) => (submitted ? errors[key] : undefined);

  return (
    <Modal open={open} onClose={onClose} title={profile ? '编辑模型配置' : '添加模型'} width={560}
      footer={<>
        <button type="button" className="link-btn form-reset" onClick={() => { setForm(toForm(profile)); setManual(savedManual); setSubmitted(false);
          setBaseUrl(profile?.baseUrl ?? ''); setFormat(profile?.wire?.format ?? 'chat'); setProtocol(profile?.wire?.protocol ?? 'chat');
          setEndpointPath(profile?.wire?.path ?? 'chat/completions'); setCustom(JSON.stringify(customFields, null, 2));
          setApiKey(''); setAllowance(''); setAvailable([]); }}>重置表单</button>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={saving || (submitted && !valid)} onClick={() => void submit()}>{saving ? '保存中…' : '保存'}</Button>
      </>}>
      <div className="model-form">
        <div className="model-form__row">
          <span className="form-field__label">智能配置<Help text="结合模型 ID、Base URL、API 格式和供应商目录推荐参数。手动修改的字段保持原值。" /></span>
          <Switch checked={form.autoConfig} onChange={value => set('autoConfig', value)} label="智能配置" />
          {form.autoConfig && <span className={`model-form__infer${inferred ? '' : ' is-miss'}`}>{inferred ? `已识别 · 上下文 ${inferred.contextWindow?.toLocaleString() ?? '待填写'} · 最大输出 ${inferred.maxOutputTokens?.toLocaleString() ?? '待填写'}` : '未识别该模型，请手动填写'}</span>}
        </div>
        <div className="model-form__grid">
          <Field label="显示名称"><input className="input" value={form.name} placeholder={form.model || '例如 GLM 5.3 Flash'} onChange={e => set('name', e.target.value)} /></Field>
          <Field label="服务商"><input className="input" value={form.provider} placeholder="例如 Commandcode" onChange={e => set('provider', e.target.value)} /></Field>
        </div>
        {live && <>
          <Field label="Base URL"><input className="input mono" value={baseUrl} placeholder="https://api.example.com/v1" onChange={e => { setBaseUrl(e.target.value); setAvailable([]); }} /></Field>
          <Field label="API 格式"><select aria-label="API 格式" className="select" value={format} onChange={e => { setFormat(e.target.value as typeof format); setAvailable([]); }}>
            <option value="messages">Anthropic Messages (/v1/messages)</option><option value="chat">Chat Completions (/chat/completions)</option><option value="responses">Responses (/responses)</option><option value="custom">自定义</option>
          </select></Field>
          {format === 'custom' && <>
            <Field label="基础协议"><select className="select" value={protocol} onChange={e => { setProtocol(e.target.value as typeof protocol); setAvailable([]); }}><option value="chat">Chat Completions</option><option value="messages">Messages</option><option value="responses">Responses</option></select></Field>
            <Field label="端点路径"><input className="input" value={endpointPath} onChange={e => { setEndpointPath(e.target.value); setAvailable([]); }} /></Field>
            <Field label="协议映射（可选）" help='示例 {"authHeader":"X-API-Key","requestFields":{"model":"engine"},"responseFields":{"content":"reply.text","finish_reason":"finish"},"streamFields":{"content":"delta","finish_reason":"finish","done":"done"}}'><textarea className="input mono" value={custom} onChange={e => { setCustom(e.target.value); setAvailable([]); }} /></Field>
            {wireError ? <span role="alert">{wireError}</span> : <details><summary>请求样例</summary><pre>{wirePreview}</pre></details>}
          </>}
          <Field label="API Key（仅当前后台会话）"><input autoComplete="off" type="password" className="input" value={apiKey} placeholder={profile?.credentialPresent ? '已配置' : '输入密钥'} onChange={e => { setApiKey(e.target.value); setAvailable([]); }} /></Field>
          <Field label="授权请求数（24 小时，可留空）"><input type="number" min="1" max="1000000" className="input" value={allowance} onChange={e => setAllowance(e.target.value)} /></Field>
          <Button disabled={refreshing || !baseUrl} onClick={() => void refresh()}>{refreshing ? '正在读取…' : '刷新模型列表'}</Button>
          {knownRow && <small>参考目录 · {knownRow[0]} · 输入 {knownRow[5].join("、")}{knownRow[6] ? " · 结构化输出" : ""}{knownRow[7] ? " · 推理" : ""}</small>}
          {available.length > 0 && <Field label="可用模型"><select aria-label="可用模型" className="select" value={found?.id ?? ''} onChange={e => {
            const m = available.find(row => row.id === e.target.value);
            if (m) set('model', m.id);
          }}><option value="">选择模型</option>{available.map(m => <option key={m.id}>{m.id}</option>)}</select></Field>}
        </>}
        <Field label="模型 ID" help="原样写入请求 Body 的 model 字段" error={show('model')}>
          <input className="input mono" value={form.model} placeholder="z-ai/glm-5.3-flash" onChange={e => set('model', e.target.value)} />
        </Field>
        <Field label="上下文窗口" help="模型一次请求可容纳的最大 token 数，决定上下文占用比例与压缩时机" error={show('contextWindow')}>
          <input className="input num" inputMode="numeric" value={form.autoConfig && !manual.includes('contextWindow') ? effectiveContext ?? '' : form.contextWindow} placeholder={inferred?.contextWindow && form.autoConfig ? String(inferred.contextWindow) : '例如 128000'} onChange={e => set('contextWindow', e.target.value.replace(/[^\d]/g, ''))} />
        </Field>
        <Field label="最大输出 Token" help={form.autoConfig ? '服务商元数据优先；可手动覆盖' : '单次回复的输出上限'} error={show('maxOutputTokens')}>
          <input className="input num" inputMode="numeric" value={form.autoConfig && !manual.includes('maxOutputTokens') ? effectiveMax ?? '' : form.maxOutputTokens} placeholder={form.autoConfig ? String(inferred?.maxOutputTokens ?? '无法推断') : '例如 8192'} onChange={e => set('maxOutputTokens', e.target.value.replace(/[^\d]/g, ''))} />
        </Field>

        <button type="button" className={`model-form__toggle${advanced ? ' is-open' : ''}`} onClick={() => setAdvanced(!advanced)}><Icon name="chevronDown" size={14} />高级配置</button>
        {advanced && (
          <div className="model-form__advanced">
            <div className="form-field">
              <span className="form-field__label">输入类型<Help text="模型能接收的附件类型；文本始终开启" /></span>
              <div className="check-row">{inputTypes.map(item => <CheckChip key={item.id} label={item.label} locked={item.id === 'text'} checked={inputs.includes(item.id)} onChange={on => set('inputTypes', on ? [...inputs, item.id] : inputs.filter(t => t !== item.id))} />)}</div>
            </div>
            <div className="form-field">
              <span className="form-field__label">模型能力<Help text="服务商原生支持的能力；未勾选时由 Harness 兼容处理" /></span>
              <div className="check-row">{capabilityOptions.map(item => <CheckChip key={item.id} label={item.label} checked={capabilities.includes(item.id)} onChange={on => set('capabilities', on ? [...capabilities, item.id] : capabilities.filter(c => c !== item.id))} />)}</div>
            </div>
            <div className="form-field">
              <span className="form-field__label">推理等级（从低到高）<Help text="对话框右侧推理档滑轨的档位；留空表示不支持调节" /></span>
              <div className="level-row">
                {form.reasoningLevels.map((level, i) => (
                  <span key={i} className="level-input">
                    <input className="input mono" value={level} placeholder="level" onChange={e => set('reasoningLevels', form.reasoningLevels.map((l, j) => (j === i ? e.target.value : l)))} />
                    <button type="button" aria-label="删除该等级" onClick={() => set('reasoningLevels', form.reasoningLevels.filter((_, j) => j !== i))}><Icon name="x" size={11} /></button>
                  </span>
                ))}
                <button type="button" className="level-add" aria-label="添加等级" onClick={() => set('reasoningLevels', [...form.reasoningLevels, ''])}><Icon name="plus" size={15} /></button>
              </div>
              {show('levels') && <span className="form-field__error"><Icon name="alert" size={12} />{errors.levels}</span>}
            </div>
            <div className="form-field">
              <span className="form-field__label">推理参数映射<Help text="合并进请求 Body 的 JSON，{{level}} 会被替换为所选推理等级" /></span>
              <div className="model-form__json"><JsonEditor value={form.mapping} onChange={value => set('mapping', value)} /></div>
              {errors.mapping ? <span className="form-field__error"><Icon name="alert" size={12} />{errors.mapping}</span>
                : preview !== undefined && <span className="model-form__preview mono">默认档「{reasoningLabel(defaultLevel(levels)!)}」→ {JSON.stringify(preview)}</span>}
            </div>
          </div>
        )}
        <div className="set-note"><Icon name="lock" size={12} />会话密钥在后台退出时清除。已保存的密钥始终以隐藏状态处理。</div>
      </div>
    </Modal>
  );
}
