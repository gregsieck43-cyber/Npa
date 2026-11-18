import { useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, ReviewVerdict, ToolCallView, ToolResult } from '../../api';
import { capabilityLabels, riskLabels } from '../../api/policy';
import { decideApproval, openInspector, openPanel } from '../../app/actions';
import { useApp } from '../../app/store';
import { Icon } from '../../components/Icon';
import { CodeBlock, DiffLines, FileDiffView, JsonBlock } from '../../components/rich';
import { Badge, Button, Collapse, Spinner } from '../../components/ui';
import { duration } from '../../lib/format';
import { failureStage, toolStatus } from '../../lib/status';
import { useRetainedContent } from '../../lib/motion';
import { ToolDetail } from '../inspector/ToolDetail';

function resultSummary(result: ToolResult | undefined) {
  if (!result) return undefined;
  switch (result.kind) {
    case 'terminal': return `exit ${result.exitCode}`;
    case 'diff': return `+${result.diff.additions} −${result.diff.deletions}`;
    case 'files': return `${result.files.length} 个文件`;
    case 'json': return 'JSON';
    case 'text': return `${result.text.split('\n').length} 行`;
  }
}

function ResultView({ result }: { result: ToolResult }) {
  switch (result.kind) {
    case 'terminal': return (
      <div className="terminal">
        <div className="terminal__cmd"><span className="terminal__prompt">❯</span><span className="mono">{result.command}</span><span className={`terminal__exit${result.exitCode === 0 ? ' is-ok' : ''}`}>exit {result.exitCode}</span></div>
        {result.output && <pre className="terminal__out">{result.output}</pre>}
      </div>
    );
    case 'diff': return <FileDiffView diff={result.diff} />;
    case 'files': return <div className="file-hits">{result.files.map(file => <div key={file.path} className="file-hits__row"><Icon name="file" size={13} /><span className="mono truncate">{file.path}</span>{file.detail && <span className="muted">{file.detail}</span>}</div>)}</div>;
    case 'json': return <JsonBlock value={result.value} title="结果" />;
    case 'text': return <CodeBlock code={result.text} lang="text" title="结果" maxHeight={260} />;
  }
}

export function ReviewPanel({ review }: { review: ReviewVerdict }) {
  const label = { pass: '审查通过', escalate: '转交人工', block: '已阻止' }[review.verdict];
  return (
    <div className={`review review--${review.verdict}`}>
      <div className="review__head">
        <Icon name={review.verdict === 'pass' ? 'shieldCheck' : review.verdict === 'block' ? 'lock' : 'shieldAlert'} size={15} />
        <strong>{label}</strong>
        <span className="muted">{review.reviewer} · {duration(review.durationMs)}</span>
        <span className="grow" />
        <Badge tone={review.risk === 'low' ? 'ok' : review.risk === 'medium' ? 'info' : 'warn'}>{riskLabels[review.risk]}</Badge>
      </div>
      <p className="review__reason">{review.reason}</p>
      <div className="review__checks">{review.checks.map(check => <span key={check.label} className={check.ok ? 'is-ok' : 'is-bad'}><Icon name={check.ok ? 'check' : 'x'} size={12} />{check.label}</span>)}</div>
    </div>
  );
}

export function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const [busy, setBusy] = useState<string>();
  const pending = useRef(false);
  const decide = async (key: string, approved: boolean, scope: 'once' | 'session') => {
    if (pending.current) return;
    pending.current = true;
    setBusy(key);
    try { await decideApproval(approval.id, { approved, scope: approval.conflict ? 'once' : scope, expectedIntentDigest: approval.digest, ...(approval.conflict ? { expectedConflictFingerprint: approval.conflict.fingerprint } : {}) }); }
    finally { pending.current = false; setBusy(undefined); }
  };
  return (
    <div className="approval" role="group" aria-label="需要批准" aria-busy={!!busy}>
      <div className="approval__border" />
      <div className="approval__inner">
        <div className="approval__head">
          <span className="approval__icon"><Icon name="shieldAlert" size={18} /></span>
          <div className="grow">
            <div className="approval__title">需要你的批准 · {approval.title}</div>
            <div className="approval__reason">{approval.reason}</div>
          </div>
          <Badge tone={approval.risk === 'high' || approval.risk === 'critical' ? 'warn' : 'info'} icon="alert">{riskLabels[approval.risk]} · {capabilityLabels[approval.capability]}</Badge>
        </div>
        {approval.previewKind === 'diff'
          ? <div className="approval__preview"><DiffLines lang="ts" mode="unified" lines={approval.preview.split('\n').map(line => ({ kind: line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx', text: line.slice(1) }))} /></div>
          : <CodeBlock code={approval.preview} lang={approval.previewKind === 'command' ? 'powershell' : approval.previewKind === 'json' ? 'json' : 'text'} title={approval.previewKind === 'command' ? '将要执行' : '参数'} />}
        {approval.conflict && <div className="approval__conflict" role="note">
          <strong>同一文件存在协作冲突，需要人工批准本次操作</strong>
          {approval.conflict.participants.map((peer, index) => <div key={`${peer.taskId}:${peer.path}:${index}`}><span className="mono">{peer.taskId}</span> · {peer.mode === 'editing' ? '正在编辑' : '近期修改'} · <span className="mono">{peer.path}</span></div>)}
          <Button size="sm" variant="ghost" onClick={() => openPanel('coordination')}>打开协作消息</Button>
          <span className="muted">批准只适用于当前展示的冲突状态；状态变化后需要重新确认。</span>
        </div>}
        <div className="approval__foot">
          <span className="approval__digest mono" title="审批绑定的意图摘要，过期审批会被后端拒绝">{approval.digest}</span>
          <span className="grow" />
          <Button variant="ghost" icon="x" disabled={!!busy} onClick={() => void decide('deny', false, 'once')}>{busy === 'deny' ? '提交中…' : '拒绝'}</Button>
          {!approval.conflict && <Button variant="secondary" icon="shieldCheck" disabled={!!busy} onClick={() => void decide('session', true, 'session')}>{busy === 'session' ? '批准中…' : '本会话始终允许'}</Button>}
          <Button variant="glow" icon="check" disabled={!!busy} onClick={() => void decide('once', true, 'once')}>{busy === 'once' ? '批准中…' : '批准一次'}</Button>
        </div>
      </div>
    </div>
  );
}

function ApprovalPresence({ approval }: { approval?: ApprovalRequest }) {
  const retained = useRetainedContent(!!approval, approval);
  return <Collapse open={!!approval}>{retained && <div className="tool__approval"><ApprovalCard key={retained.id} approval={retained} /></div>}</Collapse>;
}

export function ToolCard({ call, depth = 0 }: { call: ToolCallView; depth?: number }) {
  const approval = useApp(s => (call.approvalId ? s.approvals[call.approvalId] : undefined));
  const focus = useApp(s => s.inspectorFocus?.toolCallId);
  const element = useRef<HTMLDivElement>(null);
  const attention = ['awaiting_approval', 'blocked', 'denied', 'failed', 'unknown'].includes(call.status);
  const [open, setOpen] = useState(attention);
  const [snapshot, setSnapshot] = useState(false);
  useEffect(() => {
    if (!focus) return;
    const contains = (item: ToolCallView): boolean => item.id === focus || (item.children ?? []).some(contains);
    if (contains(call)) setOpen(true);
    // Only the message viewport may move; scrollIntoView also scrolls the app shell.
    if (call.id === focus) {
      const row = element.current, viewport = row?.closest<HTMLElement>('.thread');
      if (row && viewport) {
        const target = row.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
        if (target.top < bounds.top) viewport.scrollTop += target.top - bounds.top;
        else if (target.bottom > bounds.bottom) viewport.scrollTop += Math.min(target.top - bounds.top, target.bottom - bounds.bottom);
      }
    }
  }, [call, focus]);
  const status = toolStatus[call.status];
  const live = ['running', 'reviewing', 'pending'].includes(call.status);
  const summary = resultSummary(call.result);
  const lostResult = call.status === 'succeeded' && !call.receivedByRequestId;
  return (
    <div ref={element} className={`tool tool--${status.tone}${open ? ' is-open' : ''}${live ? ' is-live' : ''}`} style={{ marginLeft: depth * 18 }}>
      <button type="button" className="tool__head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool__status">{live ? <Spinner size={14} /> : <Icon name={status.icon} size={15} />}</span>
        <span className="tool__name mono">{call.name}</span>
        <span className="tool__title truncate">{call.title}</span>
        {call.source !== 'builtin' && <Badge tone="info">{({ mcp: 'MCP', plugin: '插件', subagent: '子代理' } as const)[call.source]}</Badge>}
        {call.risk !== 'low' && <Badge tone={call.risk === 'medium' ? 'neutral' : 'warn'}>{riskLabels[call.risk]}</Badge>}
        {call.review && <Badge tone={call.review.verdict === 'pass' ? 'ok' : call.review.verdict === 'block' ? 'danger' : 'warn'} icon="shield">{({ pass: '审查通过', escalate: '审查转人工', block: '审查阻止' })[call.review.verdict]}</Badge>}
        <span className="grow" />
        <span className={`tool__state tool__state--${status.tone}`}>{live ? <span className="shimmer-text">{status.label}</span> : status.label}</span>
        {summary && <span className="tool__summary mono">{summary}</span>}
        {call.durationMs !== undefined && <span className="tool__time num">{duration(call.durationMs)}</span>}
        <Icon name="chevronRight" size={14} className="tool__chevron" />
      </button>
      <ApprovalPresence approval={call.status === 'awaiting_approval' ? approval : undefined} />
      <Collapse open={open}>
        <div className="tool__body">
          {call.error && (
            <div className={`tool__error tool__error--${call.error.stage}`}>
              <Icon name={call.error.stage === 'permission' ? 'lock' : 'alert'} size={14} />
              <div><strong>{failureStage[call.error.stage]}</strong><p>{call.error.message}</p></div>
            </div>
          )}
          {call.review && <ReviewPanel review={call.review} />}
          <div className="tool__section">
            <div className="tool__label">模型生成的参数 <span className="muted mono">{call.id}</span>{call.sessionId && <span className="muted"> · 摘要，完整内容见调用快照</span>}</div>
            <JsonBlock value={call.args} title="arguments" maxHeight={200} />
          </div>
          {call.result && <div className="tool__section"><div className="tool__label">返回结果</div><ResultView result={call.result} /></div>}
          {call.sessionId && <div className="tool__section"><Button size="sm" onClick={() => setSnapshot(value => !value)}>{snapshot ? '收起调用快照' : '查看本次调用快照'}</Button>{snapshot && <ToolDetail key={call.id} sessionId={call.sessionId} callId={call.id} />}</div>}
          <div className="kv-grid">
            {call.toolCallId && <><span>tool_call_id</span><span className="mono">{call.toolCallId}</span></>}
            {call.requestId && <><span>request_id</span><span className="mono">{call.requestId}</span></>}
            {call.parentRequestId && <><span>parent_request_id</span><button type="button" className="link-btn mono" onClick={() => openInspector('request', { requestId: call.parentRequestId })}>{call.parentRequestId}</button></>}
            {call.taskId && <><span>task_id</span><span className="mono">{call.taskId}</span></>}
            {call.runId && <><span>run_id</span><span className="mono">{call.runId}</span></>}
          </div>
          <div className="tool__meta">
            <span><Icon name="shield" size={12} />{capabilityLabels[call.capability]}</span>
            {call.retries ? <span><Icon name="refresh" size={12} />重试 {call.retries} 次</span> : null}
            {call.receivedByRequestId && <button type="button" className="link-btn" onClick={() => openInspector('request', { requestId: call.receivedByRequestId })}><Icon name="arrowRight" size={12} />结果已进入请求 {call.receivedByRequestId}</button>}
            {lostResult && <span className="tool__lost"><Icon name="alert" size={12} />{failureStage.context}</span>}
            <span className="grow" />
            <button type="button" className="link-btn" onClick={() => openInspector('tools', { toolCallId: call.id })}><Icon name="eye" size={12} />在 Tool Inspector 中查看</button>
          </div>
          {call.children?.map(child => <ToolCard key={child.id} call={child} depth={depth + 1} />)}
        </div>
      </Collapse>
    </div>
  );
}
