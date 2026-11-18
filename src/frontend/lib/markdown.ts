/** 极简 Markdown 解析：块级（标题/段落/列表/引用/代码/表格/分隔线）+ 行内（粗体/斜体/代码/链接）。不产生 HTML 字符串，交给 React 渲染，避免注入。 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'paragraph'; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'code'; lang: string; v: string; open: boolean }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push({ t: 'text', v: text.slice(last, match.index) });
    const token = match[0];
    if (match[1]) out.push({ t: 'code', v: token.slice(1, -1) });
    else if (match[2]) out.push({ t: 'strong', c: parseInline(token.slice(2, -2)) });
    else if (match[3]) out.push({ t: 'em', c: parseInline(token.slice(1, -1)) });
    else {
      const split = token.indexOf('](');
      const href = token.slice(split + 2, -1);
      out.push(/^(https?:|mailto:)/.test(href) ? { t: 'link', href, c: parseInline(token.slice(1, split)) } : { t: 'text', v: token });
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => parseInline(cell.trim()));

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n'), blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      const open = i >= lines.length;
      i++;
      blocks.push({ t: 'code', lang: fence[1] || 'text', v: body.join('\n'), open });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ t: 'heading', level: heading[1].length, c: parseInline(heading[2]) }); i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', c: parseMarkdown(body.join('\n')) });
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line), rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    const listMatch = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1]), items: Inline[][] = [];
      while (i < lines.length) {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!item || /\d/.test(item[1]) !== ordered) break;
        items.push(parseInline(item[2]));
        i++;
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>|\s*([-*+]|\d+[.)])\s|\|.*\|\s*$)/.test(lines[i])) body.push(lines[i++]);
    if (!body.length) body.push(lines[i++]);
    blocks.push({ t: 'paragraph', c: parseInline(body.join(' ')) });
  }
  return blocks;
}
