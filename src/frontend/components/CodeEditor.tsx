import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

export function languageOf(path: string): { label: string; extension: () => Extension } {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return { label: 'TypeScript', extension: () => javascript({ typescript: true, jsx: ext === 'tsx' }) };
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return { label: 'JavaScript', extension: () => javascript({ jsx: ext === 'jsx' }) };
  if (ext === 'json') return { label: 'JSON', extension: () => json() };
  if (['md', 'markdown'].includes(ext)) return { label: 'Markdown', extension: () => markdown() };
  if (['css', 'scss'].includes(ext)) return { label: 'CSS', extension: () => css() };
  if (['html', 'htm'].includes(ext)) return { label: 'HTML', extension: () => html() };
  return { label: '纯文本', extension: () => [] };
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--fs-13)', backgroundColor: 'var(--surface)', color: 'var(--code-text)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
  '.cm-content': { padding: '10px 0' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--text-3)', border: 'none', paddingRight: '6px' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in oklab, var(--accent) 22%, transparent) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklab, var(--warn) 25%, transparent)' },
  '.cm-tooltip, .cm-panels': { background: 'var(--glass-strong)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-foldPlaceholder': { background: 'var(--accent-soft)', border: 'none', color: 'var(--accent)' },
});

const colors = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword], color: 'var(--syn-key)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--syn-str)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syn-num)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--syn-com)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syn-fn)' },
  { tag: [tags.typeName, tags.className], color: 'var(--accent-3)' },
  { tag: [tags.propertyName], color: 'var(--text)' },
  { tag: [tags.heading], color: 'var(--accent)', fontWeight: '700' },
  { tag: [tags.punctuation, tags.bracket], color: 'var(--text-3)' },
]);

export interface CodeEditorProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  onCursor?: (line: number, column: number, selection: string) => void;
  /** 变化时把光标移到该行并居中显示（search/problems 跳转）。 */
  reveal?: { line: number; column?: number; nonce: number };
}

export function CodeEditor({ path, value, onChange, onSave, onCursor, reveal }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const handlers = useRef({ onChange, onSave, onCursor });
  handlers.current = { onChange, onSave, onCursor };

  useEffect(() => {
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup, languageOf(path).extension(), theme, syntaxHighlighting(colors),
          Prec.highest(keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { handlers.current.onSave?.(); return true; } }])),
          EditorView.updateListener.of(update => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const range = update.state.selection.main, line = update.state.doc.lineAt(range.head);
              handlers.current.onCursor?.(line.number, range.head - line.from + 1, update.state.sliceDoc(range.from, range.to));
            }
          }),
        ],
      }),
    });
    return () => view.current?.destroy();
    // 每个标签页（path）一个编辑器实例；外部 value 变化在下方同步
  }, [path]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !reveal) return;
    const line = editor.state.doc.line(Math.min(Math.max(1, reveal.line), editor.state.doc.lines));
    const pos = Math.min(line.to, line.from + Math.max(0, (reveal.column ?? 1) - 1));
    editor.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    editor.focus();
  }, [reveal?.nonce]);

  return <div ref={host} className="code-editor" />;
}
