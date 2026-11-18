import type { Task } from '../contracts.js';
import { displayStatus } from './view-model.js';
import { messagePreview } from './workspace-model.js';

export function icon(name: string): SVGSVGElement {
  const paths: Record<string, string> = {
    chat: 'M4 4h16v12H8l-4 4V4Z', code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16',
    folder: 'M3 6h7l2 3h9v11H3V6Z', plus: 'M12 5v14M5 12h14', search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6',
    settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
    panel: 'M3 4h18v16H3V4Zm12 0v16', history: 'M4 4v5h5M4 9a9 9 0 1 1-1 8m9-10v6l4 2',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c-5 5-5 13 0 18 5-5 5-13 0-18ZM3 12h18',
    plug: 'M8 2v6m8-6v6M5 8h14v3a7 7 0 0 1-7 7v4m-7-11h14', shield: 'm12 3 9 4v6c0 5-9 9-9 9s-9-4-9-9V7l9-4Zm-4 9 3 3 5-6',
    x: 'm6 6 12 12M6 18 18 6', send: 'm3 3 19 9-19 9 4-9-4-9Zm4 9h15', menu: 'M4 6h16M4 12h16M4 18h16',
    edit: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z', check: 'm4 12 5 5L20 6', arrow: 'M4 12h16m-6-6 6 6-6 6',
    sparkle: 'm12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3 3-6Z', terminal: 'm5 6 6 6-6 6m9 0h6',
    moon: 'M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11Z', sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
    work: 'M4 5h16v16H4V5ZM9 5V3h6v2M8 11h8m-8 5h5',
    chevron: 'm9 5 7 7-7 7',
  };
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('fill', 'none'); node.setAttribute('stroke', 'currentColor'); node.setAttribute('stroke-width', '1.6'); node.setAttribute('stroke-linecap', 'round'); node.setAttribute('stroke-linejoin', 'round'); node.setAttribute('aria-hidden', 'true'); node.classList.add('icon');
  const path = document.createElementNS(node.namespaceURI, 'path'); path.setAttribute('d', paths[name] ?? paths.chat); node.append(path); return node;
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function append(parent: HTMLElement, ...children: (Node | string | undefined)[]): HTMLElement {
  for (const child of children) if (child !== undefined) parent.append(child);
  return parent;
}
export function testId(node: HTMLElement, id: string): HTMLElement { node.dataset.testid = id; return node; }
export function button(label: string, action: () => void | Promise<void>, className = '', id?: string): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', () => {
    const result = action();
    if (result instanceof Promise) { node.disabled = true; void result.finally(() => { node.disabled = false; }); }
  });
  if (id) node.dataset.testid = id;
  return node;
}
export function field(labelText: string, control: HTMLElement, className = ''): HTMLLabelElement {
  return append(element('label', className), labelText, control) as HTMLLabelElement;
}
export function input(value = '', placeholder = '', id?: string): HTMLInputElement {
  const node = element('input'); node.value = value; node.placeholder = placeholder;
  if (id) node.dataset.testid = id;
  return node;
}
export function textarea(value = '', placeholder = '', id?: string): HTMLTextAreaElement {
  const node = element('textarea'); node.value = value; node.placeholder = placeholder;
  if (id) node.dataset.testid = id;
  return node;
}
export function select(options: [string, string][], value: string, id?: string): HTMLSelectElement {
  const node = element('select');
  options.forEach(([key, title]) => { const option = element('option', '', title); option.value = key; node.append(option); });
  node.value = value; if (id) node.dataset.testid = id; return node;
}
export function badge(text: string, tone = ''): HTMLElement { return append(element('span', `badge ${tone}`), element('i', 'dot'), text); }
export function statusBadge(task: Task): HTMLElement {
  const tone = task.status === 'running' || task.status === 'completed' ? 'live' : task.status.startsWith('waiting') || task.status === 'reconciling' ? 'warning' : task.status === 'failed' ? 'failed' : '';
  return testId(badge(displayStatus(task.status), tone), 'task-status');
}
export function sectionTitle(title: string, action?: HTMLElement): HTMLElement { return append(element('div', 'section-title'), element('h3', '', title), action); }
export function empty(text: string): HTMLElement { return element('div', 'empty-small', text); }

/** Long bodies render only on demand; the complete stored source is never clipped. */
export function progressiveMessage(content: string, render: () => HTMLElement, expanded = false, changed?: (open: boolean) => void): HTMLElement {
  const view = messagePreview(content);
  if (!view.folded) return render();
  const root = element('div', 'progressive-message');
  const preview = element('div', 'message-preview', view.preview + '…');
  const detail = element('details', 'message-disclosure');
  detail.open = expanded;
  const summary = element('summary', '', expanded ? '收起长消息' : `展开完整消息（${content.length.toLocaleString()} 字符）`);
  let body: HTMLElement | undefined;
  const sync = () => {
    preview.hidden = detail.open;
    if (detail.open && !body) { body = render(); detail.append(body); }
    summary.textContent = detail.open ? '收起长消息' : `展开完整消息（${content.length.toLocaleString()} 字符）`;
  };
  detail.append(summary); sync();
  detail.addEventListener('toggle', () => { sync(); changed?.(detail.open); });
  root.append(preview, detail); return root;
}

interface TextActions { copyText(text: string): void; copySource(url: string): void; }

/** Render the conversation's supported Markdown blocks using text nodes only. */
export function richText(content: string, actions: TextActions): HTMLElement {
  const root = element('div', 'rich-text');
  const rows = content.replace(/\r\n?/g, '\n').split('\n');
  const inline = (target: HTMLElement, text: string): void => {
    const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
    let offset = 0;
    for (const match of text.matchAll(tokens)) {
      target.append(text.slice(offset, match.index)); const token = match[0];
      if (token.startsWith('`')) target.append(element('code', '', token.slice(1, -1)));
      else if (token.startsWith('**') || token.startsWith('__')) target.append(element('strong', '', token.slice(2, -2)));
      else {
        const split = token.indexOf(']('), label = token.slice(1, split), url = token.slice(split + 2, -1);
        const source = button(label, () => actions.copySource(url), 'message-link'); source.title = `复制来源地址：${url}`; source.setAttribute('aria-label', `${label}，复制来源地址`); target.append(source);
      }
      offset = match.index! + token.length;
    }
    target.append(text.slice(offset));
  };
  const listMatch = (text: string) => text.match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
  const tableCells = (text: string) => text.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  const tableRule = (text: string) => text.includes('|') && tableCells(text).every(cell => /^:?-{3,}:?$/.test(cell));
  const blockStart = (text: string) => /^\s{0,3}(#{1,6}\s|`{3,}|~{3,}|>\s?|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(text) || !!listMatch(text);
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (!row.trim()) { index++; continue; }
    const fence = row.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[1], language = fence[2].trim(), code: string[] = []; index++;
      const close = new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`);
      while (index < rows.length && !close.test(rows[index])) code.push(rows[index++]);
      if (index < rows.length) index++;
      const text = code.join('\n'), block = element('div', 'code-block');
      const copy = button('复制', () => actions.copyText(text), 'small ghost'); copy.setAttribute('aria-label', '复制代码块');
      block.append(append(element('div', 'code-block-header'), element('span', '', language || '代码'), copy), append(element('pre'), element('code', '', text))); root.append(block); continue;
    }
    const heading = row.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) { const title = element(heading[1].length <= 2 ? 'h3' : 'h4'); inline(title, heading[2]); root.append(title); index++; continue; }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(row)) { root.append(element('hr')); index++; continue; }
    if (index + 1 < rows.length && row.includes('|') && tableRule(rows[index + 1])) {
      const table = element('table'), header = element('thead'), tr = element('tr');
      for (const cell of tableCells(row)) { const th = element('th'); inline(th, cell); tr.append(th); }
      header.append(tr); table.append(header); index += 2; const body = element('tbody');
      while (index < rows.length && rows[index].includes('|') && rows[index].trim()) { const record = element('tr'); for (const cell of tableCells(rows[index++])) { const td = element('td'); inline(td, cell); record.append(td); } body.append(record); }
      table.append(body); root.append(append(element('div', 'rich-table'), table)); continue;
    }
    const first = listMatch(row);
    if (first) {
      const ordered = /^\d/.test(first[1]), list = element(ordered ? 'ol' : 'ul');
      if (ordered) (list as HTMLOListElement).start = Number.parseInt(first[1], 10);
      while (index < rows.length) { const item = listMatch(rows[index]); if (!item || /^\d/.test(item[1]) !== ordered) break; const li = element('li'); inline(li, item[2].replace(/^\[([ xX])\]\s*/, (_, done: string) => done === ' ' ? '☐ ' : '☑ ')); list.append(li); index++; }
      root.append(list); continue;
    }
    if (/^\s{0,3}>/.test(row)) { const quote = element('blockquote'), text: string[] = []; while (index < rows.length && /^\s{0,3}>/.test(rows[index])) text.push(rows[index++].replace(/^\s{0,3}>\s?/, '')); inline(quote, text.join('\n')); root.append(quote); continue; }
    const paragraph = [rows[index++]];
    while (index < rows.length && rows[index].trim() && !blockStart(rows[index]) && !(index + 1 < rows.length && tableRule(rows[index + 1]))) paragraph.push(rows[index++]);
    const p = element('p'); inline(p, paragraph.join('\n')); root.append(p);
  }
  return root;
}
