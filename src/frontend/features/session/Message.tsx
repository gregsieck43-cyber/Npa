import { memo, useId, useState } from 'react';
import type { ChatMessage, MessagePart, ToolCallView } from '../../api';
import { branch, editMessage, openInspector, regenerate } from '../../app/actions';
import { useApp } from '../../app/store';
import { Icon } from '../../components/Icon';
import { CopyButton, Markdown } from '../../components/rich';
import { Button, Collapse, IconButton } from '../../components/ui';
import { clockTime, compactNumber, duration } from '../../lib/format';
import { ToolCard } from './ToolCard';

function Reasoning({ part, live }: { part: Extract<MessagePart, { kind: 'reasoning' }>; live: boolean }) {
  // undefined 表示用户还没手动选择，此时跟随 live：流式展开、终态收起。
  // 一旦用户点过，true/false 就是明确选择，后续流式分片或结束都不能覆盖它。
  const [manualOpen, setManualOpen] = useState<boolean>();
  const bodyId = useId();
  const open = manualOpen ?? live;
  return (
    <div className={`reasoning${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="reasoning__head"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setManualOpen(!open)}
      >
        <Icon name="brain" size={14} />
        {live
          ? <span className="shimmer-text">正在思考…</span>
          : <span>{part.durationMs === undefined ? '思考过程' : `已思考 ${duration(part.durationMs)}`}</span>}
        <Icon name="chevronRight" size={13} className="reasoning__chevron" />
      </button>
      <Collapse open={open} id={bodyId}><div className="reasoning__body">{part.text}</div></Collapse>
    </div>
  );
}

/** 连续的工具调用合并为一条带连接线的工具链。 */
function groupParts(parts: MessagePart[]) {
  const groups: ({ kind: 'part'; part: MessagePart; index: number } | { kind: 'tools'; calls: ToolCallView[]; index: number })[] = [];
  parts.forEach((part, index) => {
    const last = groups[groups.length - 1];
    if (part.kind === 'tool' && last?.kind === 'tools') last.calls.push(part.call);
    else if (part.kind === 'tool') groups.push({ kind: 'tools', calls: [part.call], index });
    else groups.push({ kind: 'part', part, index });
  });
  return groups;
}

function plainText(message: ChatMessage) {
  return message.parts.map(part => (part.kind === 'text' ? part.text : '')).join('\n\n').trim();
}

/** 用户消息：可编辑后重新发送（丢弃其后的回复并重新生成）；会话运行中不可编辑。 */
function UserMessage({ message, sessionId }: { message: ChatMessage; sessionId: string }) {
  const busy = useApp(s => ['streaming', 'running', 'waiting_approval'].includes(s.sessions[sessionId]?.status ?? ''));
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const original = plainText(message);
  const resend = async () => {
    const text = draft?.trim();
    if (!text || saving) return;
    setSaving(true);
    const ok = await editMessage(sessionId, message.id, text);
    setSaving(false);
    if (ok) setDraft(undefined);
  };
  return (
    <div className={`msg msg--user${draft !== undefined ? ' is-editing' : ''}`}>
      {draft !== undefined ? (
        <div className="msg__edit">
          <textarea autoFocus value={draft} rows={Math.min(10, Math.max(2, draft.split('\n').length))} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setDraft(undefined); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void resend(); } }} />
          <div className="msg__edit-bar">
            <span className="muted grow">重新发送会丢弃这条消息之后的回复 · Ctrl+Enter</span>
            <Button size="sm" variant="ghost" onClick={() => setDraft(undefined)}>取消</Button>
            <Button size="sm" variant="primary" icon="arrowUp" disabled={!draft.trim() || draft.trim() === original || saving} onClick={() => void resend()}>重新发送</Button>
          </div>
        </div>
      ) : (
        <div className="msg__bubble">
          {message.attachments?.length ? <div className="msg__attachments">{message.attachments.map(a => <span key={a.id} className="attachment-chip"><Icon name={a.kind === 'image' ? 'image' : 'file'} size={12} />{a.name}</span>)}</div> : null}
          {message.parts.map((part, i) => part.kind === 'text' ? <div key={i} className="msg__text">{part.text}</div> : null)}
        </div>
      )}
      {draft === undefined && (
        <div className="msg__actions msg__actions--user">
          <span className="msg__time">{clockTime(message.createdAt)}</span>
          <CopyButton text={original} size={14} />
          <IconButton icon="pencil" label={busy ? '运行中不可编辑' : '编辑并重新发送'} size={14} disabled={busy} onClick={() => setDraft(original)} />
          <IconButton icon="branch" label="从这里分叉" size={14} onClick={() => void branch(sessionId, message.id)} />
        </div>
      )}
    </div>
  );
}

export const Message = memo(function Message({ message, sessionId, isLast }: { message: ChatMessage; sessionId: string; isLast: boolean }) {
  if (message.role === 'user') return <UserMessage message={message} sessionId={sessionId} />;

  const streaming = message.status === 'streaming';
  const groups = groupParts(message.parts);
  const lastTextIndex = message.parts.map(p => p.kind).lastIndexOf('text');
  return (
    <div className={`msg msg--assistant${streaming ? ' is-streaming' : ''}`}>
     <div className="msg__content">
        <div className="msg__meta">
          <span className="msg__dot" data-live={streaming} /><strong>NPN Gamma</strong>
          {message.model && <span className="mono">{message.model}</span>}
          <span>{clockTime(message.createdAt)}</span>
        </div>
        {message.parts.length === 0 && streaming && <div className="typing"><span /><span /><span /></div>}
        {groups.map(group => {
          if (group.kind === 'tools') return <div key={group.index} className="tool-chain">{group.calls.map(call => <ToolCard key={call.id} call={call} />)}</div>;
          const { part, index } = group;
          if (part.kind === 'reasoning') return <Reasoning key={index} part={part} live={streaming && index === message.parts.length - 1} />;
          if (part.kind === 'notice') return <div key={index} className={`notice notice--${part.tone}`}><Icon name={part.tone === 'error' ? 'circleX' : part.tone === 'warn' ? 'alert' : part.tone === 'success' ? 'circleCheck' : 'info'} size={14} />{part.text}</div>;
          if (part.kind === 'text') return <Markdown key={index} text={part.text} streaming={streaming && index === lastTextIndex && index === message.parts.length - 1} />;
          return null;
        })}
        {message.status === 'error' && message.error && (
          <div className="notice notice--error"><Icon name="circleX" size={14} /><span className="grow">{message.error.message}<span className="muted mono"> · {message.error.code}</span></span><Button size="sm" variant="ghost" icon="refresh" onClick={() => void regenerate(sessionId, message.id)}>重试</Button></div>
        )}
        {!streaming && (
          <div className={`msg__actions${isLast ? ' is-pinned' : ''}`}>
            <CopyButton text={plainText(message)} size={14} />
            <IconButton icon="refresh" label="重新生成" size={14} onClick={() => void regenerate(sessionId, message.id)} />
            <IconButton icon="branch" label="从这里分叉" size={14} onClick={() => void branch(sessionId, message.id)} />
            {message.requestId && <IconButton icon="eye" label="检查实际请求" size={14} onClick={() => openInspector('request', { requestId: message.requestId })} />}
            {message.usage && (
              <span className="usage-chip num" title="输入 / 输出 tokens（缓存命中）">
                <Icon name="arrowUp" size={11} />{compactNumber(message.usage.input)}
                <Icon name="arrowUp" size={11} className="flip" />{compactNumber(message.usage.output)}
                {message.usage.cached ? <span className="usage-chip__cache">缓存 {compactNumber(message.usage.cached)}</span> : null}
                {message.durationMs ? <span>· {duration(message.durationMs)}</span> : null}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
