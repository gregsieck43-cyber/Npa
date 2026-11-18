import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ReactNode } from 'react';
import { AppFrame, type AppFrameProps } from './AppFrame.js';
import { SidebarRoot, type SidebarRootProps } from './SidebarRoot.js';
import { InputBar, type InputBarProps } from './InputBar.js';
import { EmptyHero } from './EmptyHero.js';
import { StatsPills, type StatsPillsProps } from './StatsPills.js';
import message from './MessageItem.module.css';
import messageActions from './MessageIconActions.module.css';
import conversation from './ConversationRoot.module.css';
import './base.css';
import './design-platform.css';
import './scrollbar.css';
import './focus.css';
import './gradient-shadow-text.css';
import './integration.css';
import '../workspace.css';
function mount<T>(target: HTMLElement, view: (props: T) => ReactNode) {
  const root = createRoot(target);
  return { update(props: T) { flushSync(() => root.render(view(props))); }, destroy() { root.unmount(); } };
}
export const mountFrame = (target: HTMLElement) => mount<AppFrameProps>(target, props => <AppFrame {...props}/>);
export const mountSidebar = (target: HTMLElement) => mount<SidebarRootProps>(target, props => <SidebarRoot {...props}/>);
export const mountInput = (target: HTMLElement) => mount<InputBarProps>(target, props => <InputBar {...props}/>);
export const mountHero = (target: HTMLElement) => mount<Parameters<typeof EmptyHero>[0]>(target, props => <EmptyHero {...props}/>);
export const mountStats = (target: HTMLElement) => mount<StatsPillsProps>(target, props => <StatsPills {...props}/>);
export { inputClasses, resizeComposer } from './InputBar.js';
export const messageClasses = message;
export const messageActionClasses = messageActions;
export const conversationClasses = conversation;

