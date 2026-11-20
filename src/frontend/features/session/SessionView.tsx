import { useLayoutEffect, useRef, useState } from 'react';
import { loadLatestMessages } from '../../app/actions';
import { useApp } from '../../app/store';
import { Icon } from '../../components/Icon';
import { Skeleton } from '../../components/ui';
import { motionDuration } from '../../lib/motion';
import { Composer } from './Composer';
import { FileTree } from './FileTree';
import { Message } from './Message';
import { MessageHistory } from './MessageHistory';
import { TaskBoard } from './TaskBoard';

export function SessionView({ id }: { id: string }) {
  const detail = useApp(s => s.details[id]);
  const pausing = useApp(s => !!s.pendingTaskPauses[id]);
  const window = useApp(s => s.detailSessionId === id ? s.messageWindow : undefined);
  const fileTreeOpen = useApp(s => s.layout.fileTreeOpen);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const messages = detail?.messages;
  const previous = useRef({ id, messages, tail: window?.tail.messages, history: window?.history });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const before = previous.current, history = !!window?.history;
    const changedPage = history && before.messages !== messages;
    const returned = before.history && !history;
    if (before.id !== id || returned) { pinned.current = true; setUnseen(false); }
    if (changedPage) {
      el.scrollTop = 0;
      pinned.current = false;
    } else if (!history && pinned.current) {
      el.scrollTop = el.scrollHeight;
      setUnseen(false);
    }
    if (before.tail && before.tail !== window?.tail.messages && (history || !pinned.current)) setUnseen(true);
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight >= 80);
    previous.current = { id, messages, tail: window?.tail.messages, history };
  }, [id, messages, window?.history, window?.tail.messages]);

  const onScroll = () => {
    const el = scroller.current!;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShowJump(!pinned.current);
    if (pinned.current && !window?.history) setUnseen(false);
  };

  const jump = () => {
    const el = scroller.current!;
    el.scrollTo({ top: el.scrollHeight, behavior: motionDuration('base') ? 'smooth' : 'auto' });
    pinned.current = true;
    setShowJump(false);
    if (!window?.history) setUnseen(false);
  };

  return (
    <div className={`session session--${detail?.mode ?? 'chat'}`}>
      {detail?.mode === 'code' && fileTreeOpen && <FileTree projectId={detail.projectId} />}
      <div className="session__main">
        <div ref={scroller} className="thread" onScroll={onScroll}>
          <div className="thread__column">
            {detail?.task && <TaskBoard task={detail.task} pausing={pausing} office={detail.mode === 'cowork'} />}
            <MessageHistory sessionId={id} />
            {!detail && <div className="thread__loading"><Skeleton lines={3} /><Skeleton lines={5} /></div>}
            {messages?.length === 0 && <div className="thread__empty muted">这个会话还没有消息。</div>}
            {messages?.map((message, i) => <Message key={message.id} message={message} sessionId={id} office={detail?.mode === 'cowork'} isLast={i === messages.length - 1} />)}
          </div>
        </div>
        {(showJump || unseen) && <div className="thread__navigation">
          {unseen && <button type="button" className="jump-btn" disabled={window?.loading} onClick={() => { if (window?.history) void loadLatestMessages(id); else jump(); }}><Icon name="chevronDown" size={14} />有新内容{window?.history ? ' · 返回最新' : ''}</button>}
          {showJump && <button type="button" className="jump-btn" onClick={jump}><Icon name="chevronDown" size={14} />{window?.history ? '本页底部' : '回到底部'}</button>}
        </div>}
        <div className="session__dock"><Composer /></div>
      </div>
    </div>
  );
}
