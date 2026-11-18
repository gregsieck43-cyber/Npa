import { useEffect, useMemo, useRef } from 'react';
import { loadSession, releaseSession, setDraft } from '../../app/actions';
import { getState, useApp } from '../../app/store';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/ui';
import { Composer } from '../session/Composer';
import { Message } from '../session/Message';
import { MessageHistory } from '../session/MessageHistory';
import { TargetContext } from '../session/target';

/** IDE 右侧 Agent：只列出当前项目的 Code 会话，发送不离开 IDE。 */
export function IdeAgent({ projectId, sessionId, setSessionId, selection, onClose }: { projectId: string; sessionId?: string; setSessionId: (id?: string) => void; selection?: { path: string; text: string; line: number }; onClose: () => void }) {
  const sessions = useApp(s => s.sessions);
  const detail = useApp(s => (sessionId ? s.details[sessionId] : undefined));
  const scroller = useRef<HTMLDivElement>(null);
  const list = useMemo(() => Object.values(sessions).filter(s => s.mode === 'code' && s.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [sessions, projectId]);

  useEffect(() => {
    if (sessionId) void loadSession(sessionId);
    return () => releaseSession(sessionId);
  }, [sessionId]);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [detail?.messages]);

  const quoteSelection = () => {
    if (!selection?.text) return;
    const key = sessionId ?? 'new:code:embedded', current = getState().drafts[key] ?? '';
    const lang = selection.path.split('.').pop();
    setDraft(key, `${current ? `${current}\n\n` : ''}\`${selection.path}\` 第 ${selection.line} 行：\n\`\`\`${lang}\n${selection.text}\n\`\`\`\n`);
  };

  return (
    <aside className="ide-agent">
      <div className="ide-agent__head">
        <Icon name="bot" size={15} className="ide-agent__icon" />
        <select className="ide-agent__select" value={sessionId ?? ''} onChange={e => setSessionId(e.target.value || undefined)} aria-label="选择代码任务">
          <option value="">新代码任务</option>
          {list.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
        <IconButton icon="plus" label="新代码任务" size={14} onClick={() => setSessionId(undefined)} />
        <IconButton icon="x" label="关闭 Agent 面板" size={14} onClick={onClose} />
      </div>
      <div ref={scroller} className="ide-agent__thread">
        {sessionId && <MessageHistory sessionId={sessionId} />}
        {!sessionId && <div className="ide-agent__empty"><Icon name="bot" size={22} /><p>描述要修改的内容，Agent 会在当前项目中读写代码并运行验证。</p><p className="muted">在编辑器中选中代码后，可点击下方“引用选区”。</p></div>}
        {detail?.messages.map((message, i) => <Message key={message.id} message={message} sessionId={detail.id} isLast={i === detail.messages.length - 1} />)}
      </div>
      <div className="ide-agent__dock">
        {selection?.text && (
          <button type="button" className="ide-agent__quote" onClick={quoteSelection}>
            <Icon name="code" size={13} /><span className="truncate">引用选区 · {selection.path.split('/').pop()}:{selection.line}（{selection.text.split('\n').length} 行）</span>
          </button>
        )}
        <TargetContext.Provider value={{ sessionId, mode: 'code' }}>
          <Composer variant="compact" projectId={projectId} onSent={id => setSessionId(id)} placeholder="让 Agent 修改代码、解释或修复…" />
        </TargetContext.Provider>
      </div>
    </aside>
  );
}
