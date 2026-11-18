import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DiffLine, FileDiff } from '../api/types';
import { notify } from '../app/actions';
import { highlight } from '../lib/highlight';
import { parseMarkdown, type Block, type Inline } from '../lib/markdown';
import { Icon } from './Icon';
import { Collapse, IconButton, Segmented } from './ui';

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.t) {
      case 'text': return <Fragment key={i}>{node.v}</Fragment>;
      case 'strong': return <strong key={i}>{renderInline(node.c)}</strong>;
      case 'em': return <em key={i}>{renderInline(node.c)}</em>;
      case 'code': return <code key={i} className="inline-code">{node.v}</code>;
      case 'link': return <a key={i} href={node.href} target="_blank" rel="noreferrer">{renderInline(node.c)}</a>;
    }
  });
}

function renderBlock(block: Block, i: number, streaming: boolean): ReactNode {
  switch (block.t) {
    case 'heading': { const Tag = `h${Math.min(6, block.level + 2)}` as 'h3'; return <Tag key={i}>{renderInline(block.c)}</Tag>; }
    case 'paragraph': return <p key={i}>{renderInline(block.c)}</p>;
    case 'list': return block.ordered ? <ol key={i}>{block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ol> : <ul key={i}>{block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ul>;
    case 'quote': return <blockquote key={i}>{block.c.map((child, j) => renderBlock(child, j, false))}</blockquote>;
    case 'code': return <CodeBlock key={i} code={block.v} lang={block.lang} streaming={streaming && block.open} />;
    case 'table': return (
      <div key={i} className="md-table"><table>
        <thead><tr>{block.head.map((cell, j) => <th key={j}>{renderInline(cell)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, j) => <td key={j}>{renderInline(cell)}</td>)}</tr>)}</tbody>
      </table></div>
    );
    case 'hr': return <hr key={i} />;
  }
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className={`md${streaming ? ' is-streaming' : ''}`}>{blocks.map((block, i) => renderBlock(block, i, streaming))}</div>;
});

export function Code({ code, lang }: { code: string; lang: string }) {
  const tokens = useMemo(() => highlight(code, lang), [code, lang]);
  return <>{tokens.map((token, i) => token.k === 'plain' ? <Fragment key={i}>{token.v}</Fragment> : <span key={i} className={`syn-${token.k}`}>{token.v}</span>)}</>;
}

export async function copyText(text: string, label = '已复制') {
  try { await navigator.clipboard.writeText(text); notify('success', label); return true; }
  catch { notify('error', '复制失败', '无法写入剪贴板，请重试。'); return false; }
}

export function CopyButton({ text, label = '复制', successLabel = '已复制', size = 14, className, disabled }: {
  text: string | (() => string | Promise<string>); label?: string; successLabel?: string; size?: number; className?: string; disabled?: boolean;
}) {
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const epoch = useRef(0), busy = useRef(false);
  useEffect(() => { epoch.current++; busy.current = false; setStatus('idle'); return () => { epoch.current++; }; }, [text]);
  useEffect(() => {
    if (status !== 'success' && status !== 'error') return;
    const timer = setTimeout(() => setStatus('idle'), 1800);
    return () => clearTimeout(timer);
  }, [status]);
  const copy = async () => {
    if (busy.current) return;
    busy.current = true; const current = ++epoch.current; setStatus('pending');
    try {
      const value = typeof text === 'function' ? await text() : text;
      await navigator.clipboard.writeText(value);
      if (epoch.current === current) setStatus('success');
    } catch { if (epoch.current === current) setStatus('error'); }
    finally { if (epoch.current === current) busy.current = false; }
  };
  const feedback = status === 'success' ? successLabel : status === 'error' ? '复制失败，请重试' : status === 'pending' ? '正在复制' : label;
  return <span className={`copy-control${className ? ` ${className}` : ''}`} data-copy-state={status}>
    <IconButton icon={status === 'success' ? 'check' : status === 'error' ? 'circleX' : 'copy'} label={feedback} size={size} disabled={disabled || status === 'pending'} onClick={() => void copy()} />
    <span className="copy-control__feedback" role="status">{status === 'success' || status === 'error' ? feedback : ''}</span>
  </span>;
}

export function CodeBlock({ code, lang = 'text', title, streaming, maxHeight, numbered, wrap }: { code: string; lang?: string; title?: string; streaming?: boolean; maxHeight?: number; numbered?: boolean; wrap?: boolean }) {
  const lines = numbered ? code.split('\n') : undefined;
  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span className="code-block__lang">{title ?? lang}</span>
        {streaming && <span className="code-block__live"><span className="status-dot status-dot--accent status-dot--pulse" />生成中</span>}
        <CopyButton text={code} label="复制代码" successLabel="代码已复制" />
      </div>
      <pre style={{ maxHeight }} className={`${numbered ? 'is-numbered' : ''}${wrap ? ' is-wrapped' : ''}`}>
        {lines ? lines.map((line, i) => <div key={i} className="code-line"><span className="code-line__no">{i + 1}</span><code><Code code={line} lang={lang} /></code></div>) : <code><Code code={code} lang={lang} /></code>}
      </pre>
    </div>
  );
}

export function JsonBlock({ value, title, maxHeight = 320 }: { value: unknown; title?: string; maxHeight?: number }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? 'undefined', [value]);
  return <CodeBlock code={text} lang="json" title={title ?? 'json'} maxHeight={maxHeight} />;
}

function pairRows(lines: DiffLine[]) {
  const rows: { left?: DiffLine; right?: DiffLine }[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === 'ctx') { rows.push({ left: lines[i], right: lines[i] }); i++; continue; }
    const dels: DiffLine[] = [], adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) rows.push({ left: dels[j], right: adds[j] });
  }
  return rows;
}

const langOf = (path: string) => path.split('.').pop() ?? 'text';

export function DiffLines({ lines, lang, mode }: { lines: DiffLine[]; lang: string; mode: 'unified' | 'split' }) {
  if (mode === 'split') {
    return (
      <div className="diff diff--split">
        {pairRows(lines).map((row, i) => (
          <div key={i} className="diff__row">
            <div className={`diff__cell diff__cell--${row.left?.kind ?? 'empty'}`}><span className="diff__no">{row.left?.oldNo ?? ''}</span><code>{row.left ? <Code code={row.left.text} lang={lang} /> : null}</code></div>
            <div className={`diff__cell diff__cell--${row.right?.kind ?? 'empty'}`}><span className="diff__no">{row.right?.newNo ?? ''}</span><code>{row.right ? <Code code={row.right.text} lang={lang} /> : null}</code></div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="diff">
      {lines.map((line, i) => (
        <div key={i} className={`diff__line diff__line--${line.kind}`}>
          <span className="diff__no">{line.oldNo ?? ''}</span><span className="diff__no">{line.newNo ?? ''}</span>
          <span className="diff__sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span>
          <code><Code code={line.text} lang={lang} /></code>
        </div>
      ))}
    </div>
  );
}

export function FileDiffView({ diff, defaultMode = 'unified', collapsible = true }: { diff: FileDiff; defaultMode?: 'unified' | 'split'; collapsible?: boolean }) {
  const [mode, setMode] = useState<'unified' | 'split'>(defaultMode);
  const [open, setOpen] = useState(true);
  return (
    <div className="file-diff">
      <div className="file-diff__head">
        {collapsible && <IconButton icon={open ? 'chevronDown' : 'chevronRight'} label={open ? '折叠' : '展开'} size={14} onClick={() => setOpen(!open)} />}
        <Icon name="file" size={14} />
        <span className="file-diff__path mono truncate">{diff.path}</span>
        <span className={`file-diff__status file-diff__status--${diff.status}`}>{({ modified: '修改', added: '新增', deleted: '删除', renamed: '重命名' })[diff.status]}</span>
        <span className="diff-stat"><span className="diff-stat__add">+{diff.additions}</span><span className="diff-stat__del">−{diff.deletions}</span></span>
        <span className="grow" />
        <span className={`file-diff__applied${diff.applied ? ' is-applied' : ''}`}>{diff.applied ? '已应用' : '待应用'}</span>
        <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'unified', label: '统一', icon: 'rows' }, { value: 'split', label: '并排', icon: 'columns' }]} />
      </div>
      <Collapse open={open}>{diff.hunks.map((hunk, i) => (
        <div key={i} className="file-diff__hunk">
          <div className="file-diff__hunk-head mono">{hunk.header}</div>
          <DiffLines lines={hunk.lines} lang={langOf(diff.path)} mode={mode} />
        </div>
      ))}</Collapse>
    </div>
  );
}
