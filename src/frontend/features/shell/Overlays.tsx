import { useEffect, useMemo, useState } from 'react';
import { dismissToast, openSession } from '../../app/actions';
import { useApp, type Toast } from '../../app/store';
import { Icon } from '../../components/Icon';
import { useCountdown, usePresence } from '../../lib/motion';

const toastIcon = { info: 'info', success: 'circleCheck', warn: 'alert', error: 'circleX' } as const;

export function Toasts() {
  const toasts = useApp(s => s.toasts);
  const [retained, setRetained] = useState(toasts);
  const visible = [...retained.filter(item => !toasts.some(toast => toast.id === item.id)), ...toasts];
  useEffect(() => { setRetained(previous => [...previous.filter(item => !toasts.some(toast => toast.id === item.id)), ...toasts]); }, [toasts]);
  return (
    <div className="toasts" aria-live="polite">
      {visible.map(toast => <ToastItem key={toast.id} toast={toast} open={toasts.some(item => item.id === toast.id)} onExited={() => setRetained(previous => previous.filter(item => item.id !== toast.id))} />)}
    </div>
  );
}

function ToastItem({ toast, open, onExited }: { toast: Toast; open: boolean; onExited: () => void }) {
  const presence = usePresence(open);
  const [hover, setHover] = useState(false), [focus, setFocus] = useState(false);
  const fraction = useCountdown(toast.tone === 'error' ? 8000 : 4200, hover || focus || !open, () => dismissToast(toast.id));
  useEffect(() => { if (!presence.mounted) onExited(); }, [presence.mounted, onExited]);
  if (!presence.mounted) return null;
  return <div className={`toast toast--${toast.tone}`} data-presence={presence.phase} style={presence.style} aria-hidden={!open || undefined} {...(!open ? { inert: '' } : {})}
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocusCapture={() => setFocus(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocus(false); }} role={toast.tone === 'error' ? 'alert' : 'status'}>
          <Icon name={toastIcon[toast.tone]} size={16} />
          <div className="grow"><div className="toast__title">{toast.title}</div>{toast.detail && <div className="toast__detail">{toast.detail}</div>}</div>
          <button type="button" className="toast__close" aria-label="关闭" onClick={() => dismissToast(toast.id)}><Icon name="x" size={13} /></button>
          <span className="toast__timer" style={{ animation: 'none', transform: `scaleX(${fraction})` }} />
        </div>;
}

/** 其他会话中的待审批请求：顶栏脉冲徽标，避免长任务在后台静默卡住。 */
export function ApprovalChip() {
  const approvals = useApp(s => s.approvals), sessions = useApp(s => s.sessions);
  const currentId = useApp(s => (s.view.kind === 'session' ? s.view.id : undefined));
  const elsewhere = useMemo(() => Object.values(approvals).filter(a => a.sessionId !== currentId), [approvals, currentId]);
  if (!elsewhere.length) return null;
  const first = elsewhere[0];
  return (
    <button type="button" className="approval-chip" onClick={() => void openSession(first.sessionId)} title={`${sessions[first.sessionId]?.title ?? '会话'} · ${first.title}`}>
      <span className="approval-chip__pulse"><Icon name="shieldAlert" size={13} /></span>
      <span className="approval-chip__text"><strong>{elsewhere.length} 个待批准</strong><span className="truncate">{first.title}</span></span>
      <Icon name="arrowRight" size={13} />
    </button>
  );
}
