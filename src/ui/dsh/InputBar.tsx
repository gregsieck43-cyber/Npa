/* DeepSeek Harness InputBar (MIT). NPN replaces Cordis/Lexical bindings with
 * its session-bound draft controller; card/scroll/tools/trailing/dock stay shared. */
import { useLayoutEffect } from 'react';
import { DomSeat } from './DomSeat.js';
import css from './InputBar.module.css';
export interface InputBarProps { editor: HTMLTextAreaElement; attachments: HTMLElement; controls: HTMLElement; status: HTMLElement; hero?: boolean }
export function InputBar({ editor, attachments, controls, status, hero = false }: InputBarProps) {
  editor.className = `${css.input} npn-dsh-input`;
  controls.className = `${css.row} npn-dsh-controls`;
  useLayoutEffect(() => {
    const resize = () => resizeComposer(editor);
    const frame = requestAnimationFrame(resize);
    editor.addEventListener('input', resize);
    return () => { cancelAnimationFrame(frame); editor.removeEventListener('input', resize); };
  }, [editor]);
  return <div className={`${css.root} ${hero ? css.hero : ''} npn-dsh-composer`}>
    <div className={css.card} data-composer-card>
      <DomSeat node={attachments}/>
      <div className={css.scroll}><DomSeat node={editor} className={css.grow}/></div>
      <DomSeat node={controls}/>
    </div>
    <DomSeat node={status} className={css.dock}/>
  </div>;
}
export const inputClasses = css;
export function resizeComposer(editor: HTMLTextAreaElement): void {
  editor.style.height = 'auto';
  editor.style.height = `${Math.min(280, Math.max(72, editor.scrollHeight))}px`;
}
