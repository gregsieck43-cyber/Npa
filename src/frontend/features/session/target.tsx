import { createContext, useContext } from 'react';
import type { AppMode } from '../../api';
import { useApp } from '../../app/store';

/** 输入框与选择器作用的会话。sessionId 缺省表示“新会话草稿”。 */
export interface ComposerTarget { sessionId?: string; mode: AppMode; embedded: boolean }

/** IDE Agent 面板等嵌入场景显式提供目标；否则从当前路由推导。 */
export const TargetContext = createContext<Omit<ComposerTarget, 'embedded'> | null>(null);

export function useTarget(): ComposerTarget {
  const explicit = useContext(TargetContext);
  const routed = useApp(s => (s.view.kind === 'session' ? s.view.id : undefined));
  const routedMode = useApp(s => (routed ? s.sessions[routed]?.mode : undefined) ?? s.mode);
  return explicit ? { ...explicit, embedded: true } : { sessionId: routed, mode: routedMode, embedded: false };
}
