import { useEffect, useRef, useState } from 'react';
import { gateway, type Diagnostic, type TerminalResult } from '../../api';
import { guard } from '../../app/actions';
import { Icon } from '../../components/Icon';
import { EmptyState, IconButton, Spinner } from '../../components/ui';
import { clockTime, duration } from '../../lib/format';

export type BottomTab = 'terminal' | 'problems' | 'output';
export interface OutputLine { at: string; text: string; tone?: 'ok' | 'warn' | 'danger' }

/** 人工终端：不经过 Agent 与模型，命令在项目根目录执行。 */
export function Terminal({ projectId, cwd }: { projectId: string; cwd: string }) {
  const [entries, setEntries] = useState<(TerminalResult & { id: number })[]>([]);
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [running, setRunning] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [entries, running]);
  const run = async () => {
    const value = command.trim();
    if (!value) return;
    setCommand(''); setCursor(-1); setHistory(h => [value, ...h.filter(x => x !== value)].slice(0, 50));
    if (['clear', 'cls'].includes(value)) { setEntries([]); return; }
    setRunning(true);
    const result = await guard('终端命令失败', () => gateway.workspace.terminal(projectId, value));
    setRunning(false);
    if (result) setEntries(list => [...list, { ...result, id: Date.now() }]);
  };
  return (
    <div className="ide-term" onClick={() => scroller.current?.querySelector('input')?.focus()}>
      <div ref={scroller} className="ide-term__scroll">
        <div className="ide-term__hint">人工终端 · 不经过 Agent 与模型 · 工作目录 {cwd}</div>
        {entries.map(entry => (
          <div key={entry.id} className="ide-term__entry">
            <div className="ide-term__cmd"><span className="ide-term__ps">PS {entry.cwd}&gt;</span> {entry.command}</div>
            {entry.output && <pre className={entry.exitCode ? 'is-error' : undefined}>{entry.output}</pre>}
            <div className="ide-term__meta">exit {entry.exitCode} · {duration(entry.durationMs)}</div>
          </div>
        ))}
        <div className="ide-term__line">
          <span className="ide-term__ps">PS {cwd}&gt;</span>
          <input value={command} disabled={running} spellCheck={false} aria-label="终端命令" onChange={e => setCommand(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void run();
              if (e.key === 'ArrowUp' && history.length) { e.preventDefault(); const next = Math.min(history.length - 1, cursor + 1); setCursor(next); setCommand(history[next]); }
              if (e.key === 'ArrowDown') { e.preventDefault(); const next = cursor - 1; setCursor(Math.max(-1, next)); setCommand(next >= 0 ? history[next] : ''); }
            }} />
          {running && <Spinner size={12} />}
        </div>
      </div>
    </div>
  );
}

const severityIcon = { error: 'circleX', warning: 'alert', info: 'info' } as const;

export function IdeBottom({ projectId, cwd, tab, setTab, diagnostics, output, onClose, onOpen, onRefreshProblems }: {
  projectId: string; cwd: string; tab: BottomTab; setTab: (tab: BottomTab) => void; diagnostics?: Diagnostic[]; output: OutputLine[];
  onClose: () => void; onOpen: (path: string, line: number, column: number) => void; onRefreshProblems: () => void;
}) {
  const counts = { error: diagnostics?.filter(d => d.severity === 'error').length ?? 0, warning: diagnostics?.filter(d => d.severity === 'warning').length ?? 0 };
  return (
    <div className="ide-bottom">
      <div className="ide-bottom__tabs">
        {(['problems', 'output', 'terminal'] as BottomTab[]).map(item => (
          <button key={item} type="button" className={`ide-bottom__tab${tab === item ? ' is-active' : ''}`} onClick={() => setTab(item)}>
            {({ problems: '问题', output: '输出', terminal: '终端' })[item]}
            {item === 'problems' && (counts.error + counts.warning > 0) && <span className="ide-bottom__count num">{counts.error + counts.warning}</span>}
          </button>
        ))}
        <span className="grow" />
        {tab === 'problems' && <IconButton icon="refresh" label="重新检查" size={13} onClick={onRefreshProblems} />}
        <IconButton icon="x" label="关闭面板  Ctrl+J" size={13} onClick={onClose} />
      </div>
      <div className="ide-bottom__body">
        {tab === 'terminal' && <Terminal projectId={projectId} cwd={cwd} />}
        {tab === 'problems' && (!diagnostics?.length ? <EmptyState icon="circleCheck" title="没有问题" detail="诊断来自后台语言服务；接入前由演示网关提供样例。" /> : (
          <div className="ide-problems">
            {diagnostics.map((d, i) => (
              <button key={i} type="button" className={`ide-problems__row is-${d.severity}`} onClick={() => onOpen(d.path, d.line, d.column)}>
                <Icon name={severityIcon[d.severity]} size={13} />
                <span className="grow truncate">{d.message}</span>
                <span className="muted mono">{d.source}</span>
                <span className="muted mono truncate">{d.path}:{d.line}:{d.column}</span>
              </button>
            ))}
          </div>
        ))}
        {tab === 'output' && (
          <div className="ide-output">
            {output.length === 0 ? <div className="muted">保存、提交与 Agent 写入会记录在这里。</div> : output.map((line, i) => <div key={i} className={line.tone ? `is-${line.tone}` : undefined}><span className="muted num">[{clockTime(line.at)}]</span> {line.text}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}
