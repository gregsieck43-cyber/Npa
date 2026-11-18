import { useMemo, useState, type ReactNode } from 'react';
import type { ModelCapability, ModelInputType, ModelProfile, ModelProfileInput } from '../../api';
import { saveModel } from '../../app/actions';
import { Icon } from '../../components/Icon';
import { JsonEditor } from '../../components/JsonEditor';
import { Button, Modal, Switch } from '../../components/ui';
import { applyReasoningMapping, defaultLevel, inferModelLimits, reasoningLabel } from '../../lib/models';

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
  const [advanced, setAdvanced] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(current => ({ ...current, [key]: value }));
  const inferred = inferModelLimits(form.model);
  const effectiveMax = form.autoConfig ? inferred?.maxOutputTokens : positiveInt(form.maxOutputTokens);
  const effectiveContext = positiveInt(form.contextWindow) ?? (form.autoConfig ? inferred?.contextWindow : undefined);

  const mapping = useMemo(() => {
    if (!form.mapping.trim()) return { value: undefined as unknown };
    try { return { value: JSON.parse(form.mapping) as unknown }; } catch (error) { return { error: (error as Error).message }; }
  }, [form.mapping]);

  const errors: Partial<Record<'model' | 'contextWindow' | 'maxOutputTokens' | 'levels' | 'mapping', string>> = {};
  if (!form.model.trim()) errors.model = '请填写服务商使用的模型 ID';
  if (form.contextWindow && !positiveInt(form.contextWindow)) errors.contextWindow = '必须是正整数';
  if (!effectiveContext) errors.contextWindow ??= '无法推断，请手动填写上下文窗口';
  if (!form.autoConfig && form.maxOutputTokens && !positiveInt(form.maxOutputTokens)) errors.maxOutputTokens = '必须是正整数';
  if (effectiveMax && effectiveContext && effectiveMax > effectiveContext) errors.maxOutputTokens = '最大输出不能超过上下文窗口';
  const levels = form.reasoningLevels.map(l => l.trim());
  if (levels.some(l => !l)) errors.levels = '推理等级不能为空';
  else if (new Set(levels).size !== levels.length) errors.levels = '推理等级不能重复';
  if ('error' in mapping) errors.mapping = `JSON 无效：${mapping.error}`;
  const valid = Object.keys(errors).length === 0;
  const preview = levels.length && 'value' in mapping && mapping.value !== undefined ? applyReasoningMapping(mapping.value, defaultLevel(levels)!) : undefined;

  const submit = async () => {
    setSubmitted(true);
    if (!valid) return;
    setSaving(true);
    const input: ModelProfileInput = {
      id: profile?.id, name: form.name.trim() || form.model.trim(), provider: form.provider.trim() || '自定义', model: form.model.trim(), mode: profile?.mode ?? 'live',
      autoConfig: form.autoConfig, contextWindow: effectiveContext, maxOutputTokens: effectiveMax,
      inputTypes: form.inputTypes, capabilities: form.capabilities, reasoningLevels: levels, supportsReasoning: levels.length > 0,
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
        <button type="button" className="link-btn form-reset" onClick={() => { setForm(toForm(profile)); setSubmitted(false); }}>重置表单</button>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={saving || (submitted && !valid)} onClick={() => void submit()}>{saving ? '保存中…' : '保存'}</Button>
      </>}>
      <div className="model-form">
        <div className="model-form__row">
          <span className="form-field__label">智能配置<Help text="根据模型 ID 自动推断上下文窗口与最大输出，可随时关闭后手动填写" /></span>
          <Switch checked={form.autoConfig} onChange={value => set('autoConfig', value)} label="智能配置" />
          {form.autoConfig && <span className={`model-form__infer${inferred ? '' : ' is-miss'}`}>{inferred ? `已识别：${Math.round(inferred.contextWindow / 1000)}k 上下文 · ${Math.round(inferred.maxOutputTokens / 1000)}k 输出` : '未识别该模型，请手动填写'}</span>}
        </div>
        <div className="model-form__grid">
          <Field label="显示名称"><input className="input" value={form.name} placeholder={form.model || '例如 GLM 5.3 Flash'} onChange={e => set('name', e.target.value)} /></Field>
          <Field label="服务商"><input className="input" value={form.provider} placeholder="例如 Commandcode" onChange={e => set('provider', e.target.value)} /></Field>
        </div>
        <Field label="模型 ID" help="原样写入请求 Body 的 model 字段" error={show('model')}>
          <input className="input mono" value={form.model} placeholder="z-ai/glm-5.3-flash" onChange={e => set('model', e.target.value)} />
        </Field>
        <Field label="上下文窗口" help="模型一次请求可容纳的最大 token 数，决定上下文占用比例与压缩时机" error={show('contextWindow')}>
          <input className="input num" inputMode="numeric" value={form.contextWindow} placeholder={inferred && form.autoConfig ? String(inferred.contextWindow) : '例如 128000'} onChange={e => set('contextWindow', e.target.value.replace(/[^\d]/g, ''))} />
        </Field>
        <Field label="最大输出 Token" help={form.autoConfig ? '智能配置开启时由模型 ID 推断；关闭后可手动填写' : '单次回复的输出上限'} error={show('maxOutputTokens')}>
          <input className="input num" inputMode="numeric" disabled={form.autoConfig} value={form.autoConfig ? '' : form.maxOutputTokens} placeholder={form.autoConfig ? String(inferred?.maxOutputTokens ?? '无法推断') : '例如 8192'} onChange={e => set('maxOutputTokens', e.target.value.replace(/[^\d]/g, ''))} />
        </Field>

        <button type="button" className={`model-form__toggle${advanced ? ' is-open' : ''}`} onClick={() => setAdvanced(!advanced)}><Icon name="chevronDown" size={14} />高级配置</button>
        {advanced && (
          <div className="model-form__advanced">
            <div className="form-field">
              <span className="form-field__label">输入类型<Help text="模型能接收的附件类型；文本始终开启" /></span>
              <div className="check-row">{inputTypes.map(item => <CheckChip key={item.id} label={item.label} locked={item.id === 'text'} checked={form.inputTypes.includes(item.id)} onChange={on => set('inputTypes', on ? [...form.inputTypes, item.id] : form.inputTypes.filter(t => t !== item.id))} />)}</div>
            </div>
            <div className="form-field">
              <span className="form-field__label">模型能力<Help text="服务商原生支持的能力；未勾选时由 Harness 兼容处理" /></span>
              <div className="check-row">{capabilityOptions.map(item => <CheckChip key={item.id} label={item.label} checked={form.capabilities.includes(item.id)} onChange={on => set('capabilities', on ? [...form.capabilities, item.id] : form.capabilities.filter(c => c !== item.id))} />)}</div>
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
        <div className="set-note"><Icon name="lock" size={12} />API Key 只保存在后台凭据区，此处不显示也不会导出。</div>
      </div>
    </Modal>
  );
}
