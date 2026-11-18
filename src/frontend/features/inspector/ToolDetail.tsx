import { useEffect, useState } from 'react';
import { gateway, type ToolDetailPage, type ToolDetailSection } from '../../api';
import { CodeBlock } from '../../components/rich';
import { Button, ErrorBanner, Skeleton } from '../../components/ui';

/** The entire payload stays in persistence; the UI holds one bounded, redacted page. */
export function ToolDetail({ sessionId, callId }: { sessionId: string; callId: string }) {
  const [section, setSection] = useState<ToolDetailSection>('schema');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ToolDetailPage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(undefined); setPage(undefined);
    gateway.inspector.toolDetail(sessionId, callId, section, offset).then(
      value => { if (alive) { setPage(value); setLoading(false); } },
      failure => { if (alive) { setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false); } },
    );
    return () => { alive = false; };
  }, [sessionId, callId, section, offset, revision]);
  return <div className="tool__section">
    <label className="field"><span>本次调用快照（已脱敏）</span><select aria-label="调用快照字段" value={section} onChange={event => { setSection(event.target.value as ToolDetailSection); setOffset(0); }}>
      <option value="schema">本次 Schema</option><option value="description">本次 Description</option><option value="mcpDefinition">历史 MCP 工具定义</option><option value="arguments">完整参数</option><option value="result">原始结果</option>
    </select></label>
    {section === 'mcpDefinition' && <p className="muted">仅显示本次调用保存的服务工具定义。digest 绑定当时批准的服务配置与原始工具定义；页面 SHA-256 仅校验脱敏后的文本。</p>}
    {loading && <Skeleton lines={3} />}
    {error && <ErrorBanner message={error} onRetry={() => setRevision(value => value + 1)} />}
    {page && <>
      {!page.available ? <p className="muted">{page.reason}</p> : <CodeBlock code={page.text} lang={section === 'description' ? 'text' : 'json'} title={`${section} · ${page.offset + 1}–${page.offset + page.text.length} / ${page.totalChars} 字符`} maxHeight={300} />}
      <div className="row"><Button size="sm" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 6000))}>上一段</Button><Button size="sm" disabled={page.nextOffset === undefined || loading} onClick={() => setOffset(page.nextOffset!)}>下一段</Button><Button size="sm" onClick={() => { setOffset(0); setRevision(value => value + 1); }}>刷新快照</Button></div>
      <div className="muted mono">SHA-256 {page.sha256}</div>
    </>}
  </div>;
}
