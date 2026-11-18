import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { Capability, ModelProfile, PermissionMode } from '../../api';
import { capabilityLabels, decide, modeInfo, permissionModes, type PolicyOutcome } from '../../api/policy';
import { openSettings, setModel, setPermission, setReasoning } from '../../app/actions';
import { useApp } from '../../app/store';
import { Icon, type IconName } from '../../components/Icon';
import { IconButton, Modal, Popover } from '../../components/ui';
import { ParticleSlider } from '../../components/ParticleSlider';
import { useTarget } from './target';
import { defaultLevel, levelColor, levelGradient, reasoningLabel } from '../../lib/models';

const modeIcon: Record<PermissionMode, IconName> = { 'read-only': 'lock', ask: 'shield', 'auto-review': 'shieldCheck', 'full-access': 'zap' };
const capabilityIcon: Record<Capability, IconName> = { read: 'eye', write: 'pencil', exec: 'terminal', network: 'globe', mcp: 'plug' };
const outcomeMeta: Record<PolicyOutcome, { label: string; className: string }> = {
  allow: { label: '放行', className: 'is-allow' }, ask: { label: '询问', className: 'is-ask' }, review: { label: '审查', className: 'is-review' }, deny: { label: '拒绝', className: 'is-deny' },
};
const capabilities: Capability[] = ['read', 'write', 'exec', 'network', 'mcp'];

/** 目标会话（或新会话草稿）的权限模式。 */
export function useActivePermission(): PermissionMode {
  const { sessionId } = useTarget();
  return useApp(s => (sessionId ? s.sessions[sessionId]?.permission : undefined) ?? s.draftPermission ?? s.settings?.defaults.permission ?? 'ask');
}

export function useActiveModel(): string {
  const { sessionId } = useTarget();
  return useApp(s => (sessionId ? s.sessions[sessionId]?.modelId : undefined) ?? s.draftModelId ?? s.settings?.defaults.modelId ?? '');
}

function useActiveReasoning(): string | undefined {
  const { sessionId } = useTarget();
  return useApp(s => (sessionId ? s.sessions[sessionId]?.reasoningEffort : s.draftReasoning));
}

function HoldToConfirm({ onConfirm, label }: { onConfirm: () => void; label: string }) {
  const [progress, setProgress] = useState(0);
  const timer = useRef<number>();
  const start = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const began = performance.now();
    const tick = () => {
      const value = Math.min(1, (performance.now() - began) / 1100);
      setProgress(value);
      if (value >= 1) { onConfirm(); return; }
      timer.current = requestAnimationFrame(tick);
    };
    timer.current = requestAnimationFrame(tick);
  };
  const stop = () => { if (timer.current) cancelAnimationFrame(timer.current); setProgress(0); };
  return (
    <button type="button" className="hold-btn" onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} style={{ ['--hold' as string]: progress }}>
      <span className="hold-btn__fill" />
      <Icon name="zap" size={16} /><span>{progress > 0 ? '继续按住…' : label}</span>
    </button>
  );
}

/** 紧凑权限选择器：每项一行简述，能力矩阵只为悬停/选中的那一项显示。Chat 模式不渲染。 */
export function PermissionPicker() {
  const mode = useActivePermission(), { sessionId } = useTarget();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<PermissionMode>();
  const [confirm, setConfirm] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const info = modeInfo(mode), focus = hover ?? mode;
  const choose = (next: PermissionMode) => {
    setOpen(false);
    if (next === 'full-access' && mode !== 'full-access') setConfirm(true);
    else setPermission(next, sessionId);
  };
  return (
    <>
      <button ref={anchor} type="button" className={`perm-chip perm-chip--${info.tone}${open ? ' is-open' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu">
        <Icon name={modeIcon[mode]} size={14} />
        <span>{info.short}</span>
        <Icon name="chevronDown" size={12} className="perm-chip__caret" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => { setOpen(false); setHover(undefined); }} placement="top" width={300} className="perm-pop">
        <div className="perm-pop__head">权限模式</div>
        <div className="perm-pop__list" onMouseLeave={() => setHover(undefined)}>
          {permissionModes.map(item => (
            <button key={item.id} type="button" className={`perm-option perm-option--${item.tone}${item.id === mode ? ' is-active' : ''}`} onMouseEnter={() => setHover(item.id)} onFocus={() => setHover(item.id)} onClick={() => choose(item.id)} title={item.description}>
              <span className="perm-option__icon"><Icon name={modeIcon[item.id]} size={15} /></span>
              <span className="perm-option__text"><span className="perm-option__title">{item.label}</span><span className="perm-option__desc">{item.hint}</span></span>
              {item.id === mode && <Icon name="check" size={14} className="perm-option__check" />}
            </button>
          ))}
        </div>
        <div className="perm-matrix perm-matrix--strip" key={focus}>
          {capabilities.map(cap => {
            const outcome = decide(focus, cap, 'medium');
            return <span key={cap} className={`perm-matrix__cell ${outcomeMeta[outcome].className}`} title={`${capabilityLabels[cap]}：${outcomeMeta[outcome].label}`}><Icon name={capabilityIcon[cap]} size={11} />{outcomeMeta[outcome].label}</span>;
          })}
        </div>
      </Popover>
      <Modal open={confirm} onClose={() => setConfirm(false)} title="切换到完全访问？" tone="danger" width={460}
        footer={<><button type="button" className="btn btn--ghost btn--md" onClick={() => setConfirm(false)}>取消</button><HoldToConfirm label="按住以确认" onConfirm={() => { setConfirm(false); setPermission('full-access', sessionId); }} /></>}>
        <div className="danger-note">
          <div className="danger-note__icon"><Icon name="zap" size={22} /></div>
          <div>
            <p>Agent 将可以在工作区内<strong>直接写文件、执行命令、联网和调用 MCP 工具</strong>，不再逐个请求批准。</p>
            <ul>
              <li>凭据区、产品数据与工作区外路径仍会被内核拒绝</li>
              <li>关键操作（如递归删除）仍需你确认</li>
              <li>所有操作照常记录在 Trace 与 Tool Inspector 中</li>
            </ul>
          </div>
        </div>
      </Modal>
    </>
  );
}

/** 不传 onChange 时作用于目标会话；传入时为受控模式（如侧边聊天自己的模型）。 */
export function ModelPicker({ value, onChange }: { value?: string; onChange?: (modelId: string) => void } = {}) {
  const active = useActiveModel(), models = useApp(s => s.models), { sessionId } = useTarget();
  const modelId = onChange ? value ?? active : active;
  const choose = (id: string) => (onChange ? onChange(id) : setModel(id, sessionId));
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const current = models.find(m => m.id === modelId);
  return (
    <>
      <button ref={anchor} type="button" className="model-chip" onClick={() => setOpen(!open)}>
        <Icon name="cpu" size={14} /><span className="truncate">{current?.name ?? '选择模型'}</span><Icon name="chevronDown" size={12} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top" align="end" width={300}>
        <div className="menu">
          {models.filter(m => m.id !== 'reviewer').map(model => (
            <button key={model.id} type="button" className={`menu__item model-option${model.id === modelId ? ' is-active' : ''}`} onClick={() => { choose(model.id); setOpen(false); }}>
              <span className={`model-option__badge model-option__badge--${model.mode}`}>{model.mode === 'live' ? 'LIVE' : 'MOCK'}</span>
              <span className="grow"><span className="model-option__name">{model.name}</span><span className="model-option__meta">{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k 上下文` : '上下文未配置'}{model.reasoningLevels?.length ? ` · ${model.reasoningLevels.length} 档推理` : ''}{model.remainingLiveRequests !== undefined ? ` · 剩余 ${model.remainingLiveRequests} 次` : ''}</span></span>
              {model.id === modelId && <Icon name="check" size={14} />}
            </button>
          ))}
          <div className="menu__divider" />
          <button type="button" className="menu__item" onClick={() => { setOpen(false); openSettings('models'); }}><Icon name="sliders" size={15} /><span className="grow">管理模型配置…</span></button>
        </div>
      </Popover>
    </>
  );
}


/** 受控模式下 modelId / value / onChange 一起传入；value 为 undefined 表示模型默认档。 */
export function ReasoningPicker({ modelId: controlledModel, value, onChange }: { modelId?: string; value?: string; onChange?: (level?: string) => void } = {}) {
  const activeModel = useActiveModel(), { sessionId } = useTarget(), activeLevel = useActiveReasoning();
  const modelId = onChange ? controlledModel ?? activeModel : activeModel;
  const model = useApp(s => s.models.find(m => m.id === modelId)) as ModelProfile | undefined;
  const chosen = onChange ? value : activeLevel;
  const setLevel = (level?: string) => (onChange ? onChange(level) : setReasoning(level, sessionId));
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const levels = useMemo(() => model?.reasoningLevels ?? [], [model]);
  if (!levels.length) return null;
  const level = chosen && levels.includes(chosen) ? chosen : defaultLevel(levels)!;
  const index = levels.indexOf(level), last = levels.length - 1, fraction = last ? index / last : 1, isMax = last > 0 && index === last;
  const color = levelColor(fraction);
  return (
    <>
      <button ref={anchor} type="button" className={`reason-chip${isMax ? ' is-max' : ''}${open ? ' is-open' : ''}`} style={{ ['--level-color' as string]: color, ['--level-grad' as string]: levelGradient(Math.max(fraction, 0.25)) } as CSSProperties} onClick={() => setOpen(!open)} aria-haspopup="dialog" title="推理强度">
        <Icon name="brain" size={14} className="reason-chip__icon" />
        <span className="reason-chip__label">{reasoningLabel(level)}</span>
        <Icon name="chevronDown" size={12} className="perm-chip__caret" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top" align="end" width={320} className="reason-pop">
        <div className={`reason-pop__head${isMax ? ' is-max' : ''}`} style={{ ['--level-color' as string]: color } as CSSProperties}>
          <span className="reason-pop__name">推理强度</span>
          <strong key={level} className="reason-pop__level">{reasoningLabel(level)}</strong>
          <span className="grow" />
          <IconButton icon="refresh" label="恢复默认档" size={14} tipSide="left" onClick={() => setLevel(undefined)} />
        </div>
        <button type="button" className="reason-pop__model" onClick={() => { setOpen(false); openSettings('models'); }}>{model!.name} · {levels.length} 档<Icon name="chevronRight" size={12} /></button>
        <div className="reason-pop__ends"><span>更快</span><span>更聪明</span></div>
        <ParticleSlider count={levels.length} index={index} label={reasoningLabel(level)} onChange={i => setLevel(levels[i])} />
      </Popover>
    </>
  );
}
