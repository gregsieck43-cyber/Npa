import { useEffect, useState, type FormEvent } from "react";
import { postContextAction } from "../lib/api";
import type { ContextRange, VistaBlock, VistaState } from "../lib/types";
import { formatTokens, percent } from "../lib/utils";
import { Icon } from "./Icon";

interface VistaInspectorProps {
  vista: VistaState;
  onPinToggle?: (blockId: string, pinned: boolean) => void;
  onArchive?: (blockId: string) => void | Promise<void>;
  onRecover?: (blockId: string) => void | Promise<void>;
  onRestoreRange?: (blockId: string, range: ContextRange) => void | Promise<void>;
  onApproval?: (approvalId: string, decision: "allow" | "deny") => void;
}
const blockLabels: Record<VistaBlock["type"], string> = {
  goal: "目标",
  acceptance: "验收",
  constraint: "约束",
  context: "上下文",
  tool: "工具",
  result: "结果",
  memory: "记忆",
};

export function VistaInspector({ vista, onPinToggle, onArchive, onRecover, onRestoreRange, onApproval }: VistaInspectorProps) {
  const [blocks, setBlocks] = useState(vista.blocks);
  const [actionError, setActionError] = useState<string>();
  useEffect(() => setBlocks(vista.blocks), [vista.blocks]);

  const runContextAction = async (action: "archive" | "recover" | "restore", blockId: string, range?: ContextRange) => {
    if (action === "archive" && onArchive) {
      await onArchive(blockId);
      return;
    }
    if (action === "recover" && onRecover) {
      await onRecover(blockId);
      return;
    }
    if (action === "restore" && onRestoreRange) {
      await onRestoreRange(blockId, range || {});
      return;
    }
    if (!vista.runId) return;
    try {
      await postContextAction(vista.runId, action, { blockIds: [blockId], ...(range ? { range } : {}) });
      setBlocks((current) => current.map((block) => block.id === blockId
        ? { ...block, archived: action === "archive" ? true : action === "recover" ? false : block.archived, status: action === "archive" ? "stale" : action === "recover" ? "active" : block.status }
        : block));
      setActionError(undefined);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "上下文操作失败");
    }
  };

  const pressure = Math.round(vista.tokenPressure || percent(vista.tokenUsed, vista.tokenLimit));
  const budget = percent(vista.budgetUsed, vista.budgetLimit);
  return (
    <aside aria-label="VISTA 检查器" className="inspector-panel">
      <header className="inspector-heading"><div><p className="eyebrow">Context workspace</p><h2>VISTA 检查器</h2></div><button aria-label="检查器选项" className="icon-button" type="button"><Icon name="more" /></button></header>
      <p className="inspector-intro">只显示可恢复、可验证的上下文块。</p>

      <section className="inspector-section pressure-section"><div className="inspector-section-title"><span>Token 压力</span><strong>{pressure}%</strong></div><div aria-label={`Token 压力 ${pressure}%`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={pressure} className="meter" role="progressbar"><span style={{ width: `${Math.min(100, pressure)}%` }} /></div><div className="meter-caption"><span>{formatTokens(vista.tokenUsed)} 已使用</span><span>上限 {formatTokens(vista.tokenLimit)}</span></div></section>

      <section className="inspector-section"><div className="inspector-section-title"><span>预算</span><span className="subtle">{vista.budgetCurrency || "USD"}</span></div><div className="budget-row"><strong>${Number(vista.budgetUsed || 0).toFixed(2)}</strong><span>/ ${Number(vista.budgetLimit || 25).toFixed(0)}</span></div><div aria-label={`预算使用 ${Math.round(budget)}%`} className="meter meter-budget" role="progressbar"><span style={{ width: `${budget}%` }} /></div></section>

      <section className="inspector-section"><div className="inspector-section-title"><span>权限</span><Icon name="lock" size={15} /></div><div className="permission-badge"><span className="status-dot" />{vista.permission || "本地审阅"}</div></section>

      <section className="inspector-section vista-blocks"><div className="inspector-section-title"><span>上下文块</span><span className="subtle">{blocks.length}</span></div>{actionError ? <p className="feature-error" role="alert">{actionError}</p> : null}<div className="block-list">{blocks.map((block) => <VistaBlockRow block={block} key={block.id} onPinToggle={onPinToggle} onArchive={(blockId) => void runContextAction("archive", blockId)} onRecover={(blockId) => void runContextAction("recover", blockId)} onRestoreRange={(blockId, range) => void runContextAction("restore", blockId, range)} />)}</div></section>

      <section className="inspector-section approvals-section"><div className="inspector-section-title"><span>待审批</span><span className={`approval-count ${vista.approvals.length ? "has-items" : ""}`}>{vista.approvals.length}</span></div>{vista.approvals.length ? vista.approvals.map((approval) => <div className="approval-row" key={approval.id}><span className={`risk-dot risk-${approval.risk}`} /><div><strong>{approval.title}</strong><small>{approval.risk === "high" ? "高风险动作" : approval.risk === "medium" ? "需要确认" : "低风险动作"}</small></div><div className="approval-actions"><button className="ghost-button compact" disabled={!onApproval} onClick={() => onApproval?.(approval.id, "deny")} type="button">拒绝</button><button className="primary-button compact" disabled={!onApproval} onClick={() => onApproval?.(approval.id, "allow")} type="button">批准</button></div></div>) : <p className="inspector-empty"><Icon name="checkCircle" size={15} />当前没有待审批项</p>}</section>
    </aside>
  );
}

function VistaBlockRow({ block, onPinToggle, onArchive, onRecover, onRestoreRange }: { block: VistaBlock; onPinToggle?: (blockId: string, pinned: boolean) => void; onArchive?: (blockId: string) => void; onRecover?: (blockId: string) => void; onRestoreRange?: (blockId: string, range: ContextRange) => void }) {
  const [rangeStart, setRangeStart] = useState("0");
  const [rangeEnd, setRangeEnd] = useState("");
  const archived = block.archived || block.status === "stale";
  const restoreRange = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const start = Number(rangeStart);
    const end = rangeEnd.trim() ? Number(rangeEnd) : undefined;
    if (!Number.isSafeInteger(start) || start < 0 || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) return;
    onRestoreRange?.(block.id, end === undefined ? { start } : { start, end });
  };
  return <article className={`vista-block ${block.pinned ? "is-pinned" : ""}`}><div className="block-main"><div className="block-title"><span className="block-type">{blockLabels[block.type]}</span><strong>{block.title}</strong>{block.status === "verified" ? <Icon name="checkCircle" size={14} /> : null}</div>{block.summary ? <p>{block.summary}</p> : null}<div className="block-meta">{block.tokens ? <span>{formatTokens(block.tokens)} tokens</span> : null}{block.source ? <span>{block.source}</span> : null}{block.permanentPinned ? <span>永久固定</span> : null}</div></div><div className="block-actions">{block.permanentPinned ? null : <button aria-label={block.pinned ? `取消固定 ${block.title}` : `固定 ${block.title}`} className={`pin-button ${block.pinned ? "is-pinned" : ""}`} onClick={() => onPinToggle?.(block.id, !block.pinned)} type="button"><span>•</span></button>}{block.permanentPinned ? null : archived ? <button aria-label={`恢复 ${block.title}`} className="ghost-button compact" onClick={() => onRecover?.(block.id)} type="button">恢复</button> : <button aria-label={`归档 ${block.title}`} className="ghost-button compact" onClick={() => onArchive?.(block.id)} type="button">归档</button>}{block.payloadRef ? <form aria-label={`范围恢复 ${block.title}`} onSubmit={restoreRange}><input aria-label={`范围起点 ${block.title}`} min="0" onChange={(event) => setRangeStart(event.target.value)} type="number" value={rangeStart} /><input aria-label={`范围终点 ${block.title}`} min="0" onChange={(event) => setRangeEnd(event.target.value)} placeholder="末尾" type="number" value={rangeEnd} /><button className="ghost-button compact" type="submit">范围恢复</button></form> : null}</div></article>;
}
