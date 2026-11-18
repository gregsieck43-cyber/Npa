/** 轻量语法着色：按语言族给出 token 列表，覆盖常见关键字/字符串/数字/注释/函数名。 */
export type TokenKind = 'key' | 'str' | 'num' | 'com' | 'fn' | 'plain';
export interface Token { k: TokenKind; v: string }

const keywords = new Set(('const let var function return if else for while do switch case break continue new class extends implements interface type enum import from export default async await try catch finally throw typeof instanceof in of yield this super null undefined true false void public private protected readonly static as fn let mut impl struct trait pub use mod match where self Self def lambda pass None True False elif and or not is with').split(' '));

const build = (singleQuote: string) => new RegExp(String.raw`(\/\/[^\n]*|#(?![\da-f]{3,8}\b)[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|${singleQuote}|` + '`(?:[^`\\\\]|\\\\.)*`' + String.raw`)|(\b\d[\d_.]*(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)`, 'g');
const generic = build(String.raw`'(?:[^'\\\n]|\\.)*'`);
/** Rust 中 ' 也用于生命周期（'a），只把单字符字面量当字符串。 */
const rust = build(String.raw`'(?:[^'\\\n]|\\.)'`);

export function highlight(code: string, lang: string): Token[] {
  if (['text', 'txt', 'plain', 'log', ''].includes(lang)) return [{ k: 'plain', v: code }];
  const hashComments = ['py', 'python', 'sh', 'bash', 'ps1', 'powershell', 'yaml', 'yml', 'toml'].includes(lang);
  const tokens: Token[] = [];
  let last = 0;
  for (const match of code.matchAll(lang === 'rust' || lang === 'rs' ? rust : generic)) {
    if (match[1]?.startsWith('#') && !hashComments) {
      continue;
    }
    if (match.index > last) tokens.push({ k: 'plain', v: code.slice(last, match.index) });
    const [value] = match;
    const kind: TokenKind = match[1] ? 'com' : match[2] ? 'str' : match[3] ? 'num' : match[4] ? (keywords.has(value) ? 'key' : 'fn') : keywords.has(value) ? 'key' : 'plain';
    tokens.push({ k: kind, v: value });
    last = match.index + value.length;
  }
  if (last < code.length) tokens.push({ k: 'plain', v: code.slice(last) });
  return tokens;
}
