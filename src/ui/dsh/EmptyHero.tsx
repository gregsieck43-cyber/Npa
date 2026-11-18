/* DeepSeek Harness EmptyHero/HeroShell (MIT), modified for the NPN identity
 * and genuine local activity. Composer remains a separate, stable seat. */
import { DomSeat } from './DomSeat.js';
import css from './HeroShell.module.css';
export function EmptyHero({ composer, activity, workspace, title = '今天想完成什么？' }: { composer: HTMLElement; activity: HTMLElement; workspace: HTMLElement; title?: string }) {
  return <div className={`${css.root} npn-dsh-hero`}><div className={css.stack}>
    <div className={`${css.headline} npn-hero-title`}><div className={css.titleGroup}><span>{title}</span></div><p className="npn-hero-caption">先聊清想法，再决定下一步。任务、工具与请求记录随时可查。</p></div>
    <div className={css.body}><DomSeat node={workspace} className={css.workspaceRow}/><DomSeat node={composer}/></div>
    <DomSeat node={activity} className="npn-home-activity"/>
  </div></div>;
}
