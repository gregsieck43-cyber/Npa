import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { json } from '@codemirror/lang-json';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { element } from './dom.js';
export { parseRequestBody } from './harness-model.js';

export interface HarnessUiHost {
  request<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  run(action: () => Promise<void>): void;
  toast(message: string, error?: boolean): void;
  showModal(title: string, caption: string): { body: HTMLElement; close(): void };
}
export const harnessPath = (path: string) => `/v1/harness${path}`;
export const requestStatus: Record<string, string> = { draft: '未发送', running: '生成中', completed: '已完成', failed: '失败', cancelled: '已取消' };

export function jsonEditor(value: unknown, onChange: (text: string) => void, testId = 'raw-request-editor') {
  const container = element('div', 'json-editor');
  const theme = EditorView.theme({
    '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--editor-bg)', fontSize: '12px' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.8', overflow: 'auto' },
    '.cm-content': { padding: '12px 0' }, '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--faint)', border: 'none' },
    '.cm-activeLine,.cm-activeLineGutter': { backgroundColor: 'var(--hover)' }, '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground': { backgroundColor: 'var(--selection) !important' }, '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
  });
  const view = new EditorView({ parent: container, state: EditorState.create({ doc: typeof value === 'string' ? value : JSON.stringify(value, null, 2), extensions: [basicSetup, json(), EditorView.cspNonce.of('npn-gamma-editor'), theme, syntaxHighlighting(HighlightStyle.define([{ tag: tags.propertyName, color: 'var(--syntax-function)' }, { tag: tags.string, color: 'var(--syntax-string)' }, { tag: tags.number, color: 'var(--syntax-number)' }, { tag: tags.bool, color: 'var(--syntax-keyword)' }])), EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.doc.toString()); })] }) });
  view.contentDOM.dataset.testid = testId; view.contentDOM.setAttribute('aria-label', '原始 JSON 请求编辑器');
  return { container, view, text: () => view.state.doc.toString(), destroy: () => view.destroy() };
}

