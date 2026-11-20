import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { gateway, type Attachment } from '../../api';
import { cancel, goHome, guard, openInspector, promote, send, setDraft } from '../../app/actions';
import { getState, useApp } from '../../app/store';
import { Ring } from '../../components/charts';
import { Icon, type IconName } from '../../components/Icon';
import { IconButton, Menu, Popover, Spinner } from '../../components/ui';
import { bytes, compactNumber, percent } from '../../lib/format';
import { modeMeta } from '../../lib/status';
import { ModelPicker, PermissionPicker, ReasoningPicker } from './Pickers';
import { useTarget } from './target';
import { ComposerProject } from './ComposerProject';
import { SessionOptions } from './SessionOptions';

interface SlashCommand { id: string; label: string; detail: string; icon: IconName; run: () => void }

const placeholders = {
  chat: '问点什么，或输入 / 查看命令…',
  cowork: '添加材料，或说说需要整理、撰写什么…',
  code: '描述要在项目里做的修改，或粘贴报错…',
};

/** onSent：嵌入场景（IDE Agent 面板）在新会话创建后回传其 id。 */
export function Composer({ variant = 'dock', projectId, onSent, placeholder }: { variant?: 'hero' | 'dock' | 'compact'; projectId?: string; onSent?: (sessionId: string) => void; placeholder?: string }) {
  const target = useTarget(), sessionId = target.sessionId;
  const session = useApp(s => (sessionId ? s.sessions[sessionId] : undefined));
  const hasTask = useApp(s => sessionId ? !!s.details[sessionId]?.task : false);
  const effectiveMode = session?.mode ?? target.mode;
  const draftKey = sessionId ?? `new:${effectiveMode}${target.embedded ? ':embedded' : ''}`;
  const text = useApp(s => s.drafts[draftKey] ?? '');
  const metrics = useApp(s => (sessionId ? s.metrics[sessionId] : undefined));
  const sendKey = useApp(s => s.settings?.defaults.sendKey ?? 'enter');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [planFirst, setPlanFirst] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef<object>();
  const revision = useRef(0);
  const scope = useRef(draftKey);
  scope.current = draftKey;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { submission.current = undefined; setSubmitting(false); }, [draftKey]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [attachMenu, setAttachMenu] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const attachAnchor = useRef<HTMLButtonElement>(null);
  const busy = session ? ['streaming', 'running', 'waiting_approval'].includes(session.status) : false;

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  useEffect(() => { area.current?.focus(); }, [sessionId, effectiveMode]);
  useEffect(() => { setPlanFirst(false); setAttachments([]); }, [draftKey]);

  const commands = useMemo<SlashCommand[]>(() => {
    const list: SlashCommand[] = [
      { id: 'plan', label: '/plan', detail: '先产出计划，确认后再执行', icon: 'listChecks', run: () => setPlanFirst(true) },
      { id: 'inspect', label: '/inspect', detail: '打开 Inspector 查看实际请求', icon: 'eye', run: () => openInspector('request') },
      { id: 'trace', label: '/trace', detail: '查看执行轨迹', icon: 'activity', run: () => openInspector('trace') },
      { id: 'new', label: '/new', detail: `新建${modeMeta[effectiveMode].noun}`, icon: 'plus', run: () => goHome(effectiveMode) },
    ];
    if (session?.mode === 'chat') list.push({ id: 'promote', label: '/promote', detail: '把当前对话升级为 Cowork 办公会话', icon: 'layers', run: () => void promote(session.id, text.replace(/^\/\w*\s*/, '') || session.title, ['目标完成且有可验证证据']) });
    return list.filter(cmd => !(effectiveMode === 'cowork' && ['inspect','trace'].includes(cmd.id)) && (cmd.id !== 'plan' || (effectiveMode !== 'chat' && !sessionId)));
  }, [effectiveMode, session, sessionId, text]);

  const slashQuery = /^\/(\w*)$/.exec(text)?.[1];
  const slashMatches = slashQuery !== undefined ? commands.filter(c => c.id.startsWith(slashQuery)) : [];

  const submit = async () => {
    const value = text.trim();
    if (!value || submission.current) return;
    const token = {}, sentRevision = revision.current, sentAttachments = attachments;
    submission.current = token;
    setSubmitting(true);
    setDraft(draftKey, '');
    try {
      const created = await send(value, sentAttachments, { sessionId, mode: effectiveMode, embedded: target.embedded, projectId, planFirst: effectiveMode !== 'chat' && planFirst });
      const current = mounted.current && scope.current === draftKey && submission.current === token;
      if (created && current) {
        setAttachments(items => items.filter(item => !sentAttachments.includes(item)));
        onSent?.(created);
      } else if (!created && current && revision.current === sentRevision && !getState().drafts[draftKey]) setDraft(draftKey, value);
    } finally {
      if (submission.current === token) { submission.current = undefined; if (mounted.current) setSubmitting(false); }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatches.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSlashIndex(i => (i + (event.key === 'ArrowDown' ? 1 : -1) + slashMatches.length) % slashMatches.length); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); slashMatches[slashIndex % slashMatches.length].run(); setDraft(draftKey, ''); return; }
      if (event.key === 'Escape') { setDraft(draftKey, ''); return; }
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    const wantsSend = sendKey === 'enter' ? !event.shiftKey : event.ctrlKey || event.metaKey;
    if (wantsSend) { event.preventDefault(); void submit(); }
  };

  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const scopeAtDrop = scope.current;
    const selected = [...event.dataTransfer.files];
    const files = await guard('添加附件失败', () => gateway.desktop.droppedFiles(selected));
    if (files && scopeAtDrop === scope.current) setAttachments(current => [...current, ...files.filter(file => !current.some(item => item.id === file.id))]);
  };

  const pickFiles = async () => {
    const scopeAtPick = scope.current;
    const picked = await guard('选择文件失败', () => gateway.desktop.pickFiles());
    if (picked?.length && scope.current === scopeAtPick) setAttachments(current => [...current, ...picked.filter(p => !current.some(item => item.id === p.id))]);
  };

  const contextShare = metrics?.contextUsed && metrics.contextWindow ? metrics.contextUsed / metrics.contextWindow : undefined;

  return (
    <div className={`composer composer--${variant}${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <div className="composer__glow" />
      {!target.embedded && <ComposerProject sessionId={sessionId} />}
      {slashMatches.length > 0 && (
        <div className="slash-menu">
          {slashMatches.map((command, i) => (
            <button key={command.id} type="button" className={`slash-menu__item${i === slashIndex % slashMatches.length ? ' is-active' : ''}`} onMouseEnter={() => setSlashIndex(i)} onClick={() => { command.run(); setDraft(draftKey, ''); }}>
              <Icon name={command.icon} size={15} /><span className="mono">{command.label}</span><span className="muted">{command.detail}</span>
            </button>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer__attachments">
          {attachments.map(item => (
            <span key={item.id} className="attachment-chip">
              <Icon name={item.kind === 'image' ? 'image' : item.kind === 'folder' ? 'folder' : 'file'} size={13} />
              <span className="truncate">{item.name}</span>
              {item.bytes !== undefined && <span className="muted">{bytes(item.bytes)}</span>}
              <button type="button" aria-label="移除附件" onClick={() => setAttachments(current => current.filter(a => a.id !== item.id))}><Icon name="x" size={12} /></button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={area}
        className="composer__input"
        value={text}
        rows={1}
        placeholder={placeholder ?? placeholders[effectiveMode]}
        onChange={event => { revision.current++; setDraft(draftKey, event.target.value); setSlashIndex(0); }}
        onKeyDown={onKeyDown}
      />
      <div className="composer__bar">
        <button ref={attachAnchor} type="button" className="composer__tool" aria-label="添加附件" data-tip="添加附件" data-tip-side="top" onClick={() => setAttachMenu(true)}><Icon name="plus" size={16} /></button>
        <Popover anchor={attachAnchor} open={attachMenu} onClose={() => setAttachMenu(false)} placement="top" width={210}>
          <Menu onClose={() => setAttachMenu(false)} items={[
            { id: 'file', label: '添加附件', icon: 'paperclip', onSelect: () => void pickFiles() },
            ...(effectiveMode !== 'chat' && (!session || hasTask) ? [{ id: 'plan', label: '计划模式', hint: planFirst ? '已开启' : '关闭', icon: 'listChecks' as IconName, onSelect: () => setPlanFirst(!planFirst) }] : []),
            { id: 'image', label: '添加图片', icon: 'image', onSelect: () => void pickFiles() },
            ...(sessionId ? [{ id: 'session-options', label: '会话高级设置与导出', icon: 'sliders' as IconName, onSelect: () => setOptionsOpen(true) }] : []),
            ...(effectiveMode === 'code' ? [{ id: 'sel', label: '引用编辑器选区', icon: 'code' as IconName, hint: 'IDE', onSelect: () => void gateway.desktop.openIde() }] : []),
          ]} />
        </Popover>
        {(effectiveMode === 'code' || (effectiveMode === 'cowork' && (planFirst || hasTask))) && <PermissionPicker />}
        <span className="grow" />
        <ModelPicker />
        <ReasoningPicker />
        {contextShare !== undefined && (
          <span className="composer__ctx" data-tip={`上下文 ${compactNumber(metrics!.contextUsed!)} / ${compactNumber(metrics!.contextWindow!)} tokens`} data-tip-side="top" onClick={() => openInspector('context')}>
            <Ring value={contextShare} size={22} stroke={3} tone={contextShare > 0.85 ? 'danger' : contextShare > 0.6 ? 'warn' : 'accent'} />
            <span className="num">{percent(contextShare)}</span>
          </span>
        )}
        {submitting ? (
          <button type="button" className="icon-btn send-btn" aria-label="正在发送" aria-busy="true" disabled><Spinner size={16} /></button>
        ) : busy && sessionId ? (
          <IconButton icon="stop" label="停止  Esc" className="send-btn is-stop" tipSide="top" onClick={() => void cancel(sessionId)} />
        ) : (
          <IconButton icon="arrowUp" label={sendKey === 'enter' ? '发送  Enter' : '发送  Ctrl+Enter'} className={`send-btn${text.trim() ? ' is-ready' : ''}`} tipSide="top" disabled={!text.trim() || submitting} onClick={() => void submit()} />
        )}
      </div>
      {dragging && <div className="composer__drop"><Icon name="upload" size={20} />松开以附加文件</div>}
      {optionsOpen && sessionId && <SessionOptions key={sessionId} sessionId={sessionId} onClose={() => setOptionsOpen(false)} />}
    </div>
  );
}
