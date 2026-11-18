import type { AppMode, Capability, PermissionMode, RiskLevel } from './types';

/** 前端展示与演示网关使用的权限判定；真实执行判定在后端内核，结果必须与此表一致。 */
export type PolicyOutcome = 'allow' | 'ask' | 'review' | 'deny';

const riskRank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function decide(mode: PermissionMode, capability: Capability, risk: RiskLevel): PolicyOutcome {
  if (capability === 'read') return 'allow';
  // 关键操作：询问/完全访问下必须人工确认；自动审查交给审查器（可直接阻止）
  if (risk === 'critical' && (mode === 'ask' || mode === 'full-access')) return 'ask';
  switch (mode) {
    case 'read-only': return 'deny';
    case 'ask': return 'ask';
    case 'auto-review': return riskRank[risk] === 0 ? 'allow' : 'review';
    case 'full-access': return 'allow';
  }
}

/** Chat 放行读取、检索和后端只读适配器分类的低风险 MCP；通用 MCP 与写入/命令仍拒绝。 */
export function decideForMode(appMode: AppMode, mode: PermissionMode, capability: Capability, risk: RiskLevel): PolicyOutcome {
  if (appMode === 'chat') return capability === 'read' || capability === 'network' || capability === 'mcp' && risk === 'low' ? 'allow' : 'deny';
  return decide(mode, capability, risk);
}

export function reviewEscalates(risk: RiskLevel, escalateAt: RiskLevel): boolean {
  return riskRank[risk] >= riskRank[escalateAt];
}

export interface PermissionModeInfo {
  id: PermissionMode;
  label: string;
  short: string;
  /** 选择器中的一行简述。 */
  hint: string;
  description: string;
  tone: 'calm' | 'info' | 'accent' | 'danger';
}

export const permissionModes: PermissionModeInfo[] = [
  { id: 'read-only', label: '只读', short: '只读', tone: 'calm', hint: '只能读取与检索', description: 'Agent 只能读取与检索，任何写入、命令和外部副作用都会被直接拒绝。' },
  { id: 'ask', label: '每步询问', short: '询问', tone: 'info', hint: '有副作用的操作逐个批准', description: '读取自动放行；写文件、执行命令、联网写和 MCP 调用逐个等待你批准。' },
  { id: 'auto-review', label: '自动审查', short: '自动审查', tone: 'accent', hint: '低风险直接执行，其余先审查', description: '低风险操作直接执行，其余先由独立审查器评估，发现风险再转交你决定。' },
  { id: 'full-access', label: '完全访问', short: '完全访问', tone: 'danger', hint: '工作区内无需审批', description: '工作区内全部操作无需审批。凭据区与工作区外路径仍被内核拒绝。' },
];

export const capabilityLabels: Record<Capability, string> = {
  read: '读取文件', write: '写入文件', exec: '执行命令', network: '联网', mcp: 'MCP 工具',
};

export const riskLabels: Record<RiskLevel, string> = { low: '低风险', medium: '中风险', high: '高风险', critical: '关键' };

export const modeInfo = (mode: PermissionMode) => permissionModes.find(item => item.id === mode)!;
