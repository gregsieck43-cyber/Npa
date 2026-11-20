import { unzipSync, strFromU8 } from 'fflate';

const office = /\.(docx|xlsx|pptx)$/i;
export function isOfficeFile(name: string, bytes: Uint8Array): boolean {
  return office.test(name) && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
}
function decode(text: string) {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, key: string) => {
    const entities: Record<string,string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (Object.hasOwn(entities, key)) return entities[key];
    const code = key.startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
const runs = (body: string) => Array.from(body.matchAll(/<(?:[\w.-]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g), m => decode(m[1])).join('');
export function officeText(name: string, bytes: Uint8Array): string {
  const wanted = /\.docx$/i.test(name) ? /^word\/document\.xml$/ : /\.pptx$/i.test(name) ? /^ppt\/slides\/slide\d+\.xml$/ : /^xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml$/;
  let total = 0, count = 0;
  const parts = unzipSync(bytes, { filter: file => {
    if (!wanted.test(file.name)) return false;
    total += file.originalSize;
    if (++count > 200 || total > 4_000_000) throw new Error('Office 材料过大，请选取部分内容。');
    return true;
  } });
  const shared = parts['xl/sharedStrings.xml'];
  const strings = shared ? Array.from(strFromU8(shared).matchAll(/<si[\s>]([\s\S]*?)<\/si>/g), m => runs(m[1])) : [];
  const text: string[] = [];
  for (const key of Object.keys(parts).sort((a,b) => a.localeCompare(b, 'en', { numeric: true }))) {
    if (key.endsWith('sharedStrings.xml')) continue;
    const doc = strFromU8(parts[key]);
    if (key.startsWith('xl/')) {
      for (const row of doc.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
        text.push(Array.from(row[1].matchAll(/<c\b([^>]*?)>([\s\S]*?)<\/c>/g), m => {
          const value = /<v>([\s\S]*?)<\/v>/.exec(m[2])?.[1];
          return /\bt="s"/.test(m[1]) ? strings[Number(value)] ?? '' : value === undefined ? runs(m[2]) : decode(value);
        }).join('\t'));
      }
    } else for (const paragraph of doc.split(/<\/(?:w|a):p>/)) { const line = runs(paragraph); if (line) text.push(line); }
  }
  const result = text.join('\n').trim();
  if (!result || result.length > 100000) throw new Error('Office 材料为空或超过 100000 字符。');
  return result;
}
