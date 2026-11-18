import { json, jsonParseLinter } from '@codemirror/lang-json';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { linter, lintGutter } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--fs-12)', backgroundColor: 'var(--code-bg)', color: 'var(--code-text)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--text-3)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in oklab, var(--accent) 26%, transparent) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-tooltip': { background: 'var(--glass-strong)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)' },
  '.cm-foldPlaceholder': { background: 'var(--accent-soft)', border: 'none', color: 'var(--accent)' },
});

const colors = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--syn-fn)' },
  { tag: tags.string, color: 'var(--syn-str)' },
  { tag: tags.number, color: 'var(--syn-num)' },
  { tag: [tags.bool, tags.null], color: 'var(--syn-key)' },
  { tag: tags.punctuation, color: 'var(--text-3)' },
]);

/** CodeMirror JSON 编辑器：语法高亮、折叠、括号匹配与解析校验。 */
export function JsonEditor({ value, onChange, readOnly = false }: { value: string; onChange?: (value: string) => void; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup, json(), linter(jsonParseLinter()), lintGutter(), theme, syntaxHighlighting(colors), EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of(update => { if (update.docChanged) change.current?.(update.state.doc.toString()); }),
        ],
      }),
    });
    return () => view.current?.destroy();
    // 只在挂载时创建；外部 value 变化在下面的 effect 中同步
  }, [readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="json-editor" />;
}
