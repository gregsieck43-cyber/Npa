import type { AppMode, FailureStage, SessionStatus, TaskStatus, ToolStatus } from '../api/types';
import type { IconName } from '../components/Icon';

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'idle' | 'accent';

export const modeMeta: Record<AppMode, { label: string; icon: IconName; noun: string; tagline: string }> = {
  chat: { label: 'Chat', icon: 'chat', noun: '对话', tagline: '快速提问、讨论与写作' },
  cowork: { label: 'Cowork', icon: 'layers', noun: '办公会话', tagline: '整理资料、撰写文档与制作汇报' },
  code: { label: 'Code', icon: 'code', noun: '代码任务', tagline: '在项目里读写代码、运行验证' },
};

export const sessionStatus: Record<SessionStatus, { label: string; tone: Tone; live: boolean }> = {
  idle: { label: '空闲', tone: 'idle', live: false },
  streaming: { label: '生成中', tone: 'accent', live: true },
  running: { label: '运行中', tone: 'accent', live: true },
  waiting_approval: { label: '待审批', tone: 'warn', live: true },
  waiting_input: { label: '等待输入', tone: 'warn', live: false },
  paused: { label: '已暂停', tone: 'info', live: false },
  failed: { label: '失败', tone: 'danger', live: false },
  completed: { label: '已完成', tone: 'ok', live: false },
};

export const taskStatus: Record<TaskStatus, { label: string; tone: Tone }> = {
  queued: { label: '排队中', tone: 'idle' },
  running: { label: '运行中', tone: 'accent' },
  waiting_approval: { label: '等待审批', tone: 'warn' },
  waiting_input: { label: '等待输入', tone: 'warn' },
  waiting_children: { label: '等待子任务', tone: 'info' },
  paused: { label: '已暂停', tone: 'info' },
  reconciling: { label: '对账中', tone: 'warn' },
  completed: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已终止', tone: 'idle' },
};

export const toolStatus: Record<ToolStatus, { label: string; tone: Tone; icon: IconName }> = {
  pending: { label: '准备中', tone: 'idle', icon: 'clock' },
  awaiting_approval: { label: '等待批准', tone: 'warn', icon: 'shieldAlert' },
  reviewing: { label: '审查中', tone: 'accent', icon: 'shield' },
  running: { label: '执行中', tone: 'accent', icon: 'activity' },
  succeeded: { label: '成功', tone: 'ok', icon: 'circleCheck' },
  failed: { label: '失败', tone: 'danger', icon: 'circleX' },
  denied: { label: '已拒绝', tone: 'danger', icon: 'circleX' },
  blocked: { label: '已拦截', tone: 'danger', icon: 'lock' },
  cancelled: { label: '已取消', tone: 'idle', icon: 'stop' },
  unknown: { label: '结果未知', tone: 'warn', icon: 'alert' },
};

/** 不同失败阶段分开命名，不能统一称“工具失败”。 */
export const failureStage: Record<FailureStage, string> = {
  unknown_tool: '模型请求了未注册的工具',
  permission: '权限检查未通过',
  validation: '参数 / Schema 校验失败',
  execution: '工具执行失败',
  reconciliation: '外部效果未知，等待对账',
  context: '成功但结果未进入后续请求',
};
