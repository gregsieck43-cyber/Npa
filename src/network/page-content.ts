import { parsePublicUrl, WebError } from './url-policy.js';

export interface ExtractedPage { title: string; text: string; links: string[] }

// Text that only a script can produce is a real failure for a text extractor, not thin content.
// The bound keeps the rule conservative: a short but genuine page ("Allowed", "A < B.") still
// has letters or digits and is extracted; only wordless markup is treated as an embedded shell.
const JS_SHELL_TEXT_LIMIT = 20;
const CLIENT_RENDERING_MARKUP = /<script\b|<noscript\b|\bid\s*=\s*["']?(?:app|root|__NEXT_DATA__)["'\s>]/i;

export function extractPage(html: string, url: URL): ExtractedPage {
  if (/<input\b[^>]*type\s*=\s*["']?password\b/i.test(html) ||
      /(?:subscribe|sign in|log in|register) to (?:continue|read|view)|verify (?:that )?you are human|captcha challenge|id\s*=\s*["']challenge-form["']|class\s*=\s*["'][^"']*anomaly-modal/i.test(html)) {
    throw new WebError('ACCESS_BLOCKED', 'Page requires login, subscription or an anti-bot challenge; no bypass is attempted.');
  }
  if (!html.trim()) throw new WebError('PAGE_EMPTY', 'Page body was empty or whitespace only; there is no text content to extract.');
  const rendersClientSide = CLIENT_RENDERING_MARKUP.test(html);
  const title = cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? url.hostname).slice(0, 300);
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  // Prefer semantic content. Older pages without main/article retain their body, minus site chrome.
  const main = cleaned.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1]
    ?? cleaned.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i)?.[1];
  const content = (main ?? cleaned.replace(/<header\b[^>]*>[\s\S]*?<\/header\s*>/gi, ''))
    .replace(/<(nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<([a-z][\w:-]*)\b[^>]*\s(?:hidden(?=[\s=>])|aria-hidden\s*=\s*["']?true\b)[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const body = content
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr)>|<br\s*\/?>/gi, '\n');
  const text = cleanText(body).slice(0, 40000);
  // Pages that need scripts to render carry no readable words. A page with words keeps its text
  // even when it is short or also loads scripts, so ordinary short documents are unaffected.
  if (!/[\p{L}\p{N}]/u.test(text) && text.length < JS_SHELL_TEXT_LIMIT) {
    if (rendersClientSide) throw new WebError('PAGE_RENDERING_REQUIRED', 'Page needs client-side rendering; no text content is available and no bypass is attempted.');
    if (!text) throw new WebError('PAGE_EMPTY', 'Page contains no visible text.');
  }
  const links = new Set<string>();
  for (const match of content.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    try {
      const target = parsePublicUrl(new URL(decodeEntities(match[1] ?? match[2] ?? match[3]), url).href);
      if (target.origin === url.origin) links.add(target.href);
    } catch { /* Unsupported links are not crawl targets. */ }
    if (links.size >= 100) break;
  }
  return { title, text, links: [...links] };
}
export function cleanText(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/[\t\r ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/ +([.,!?;:])/g, '$1').trim();
}
function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©' };
  return value.replace(/&(#x[a-f\d]+|#\d+|amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip|lsquo|rsquo|ldquo|rdquo|copy);/gi, (original, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? original;
    const code = entity.toLowerCase().startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original;
  });
}

interface RobotsRule { allow: boolean; path: string }
export interface RobotsPolicy { rules: RobotsRule[]; crawlDelayMs: number }
export function parseRobots(text: string): RobotsPolicy {
  const groups: { agents: string[]; rules: RobotsRule[]; delay: number }[] = [];
  let group = { agents: [] as string[], rules: [] as RobotsRule[], delay: 0 };
  let startedRules = false;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.split('#')[0].trim();
    const separator = clean.indexOf(':');
    if (separator < 0) continue;
    const key = clean.slice(0, separator).trim().toLowerCase();
    const value = clean.slice(separator + 1).trim();
    if (key === 'user-agent') {
      if (!value) continue;
      if (startedRules) { groups.push(group); group = { agents: [], rules: [], delay: 0 }; startedRules = false; }
      group.agents.push(value.toLowerCase());
    } else if (group.agents.length && (key === 'allow' || key === 'disallow')) {
      startedRules = true;
      if (value.length > 8192) throw new WebError('ROBOTS_UNSUPPORTED', 'Site robots rule exceeds the supported URL size; crawl stopped.');
      if (value) group.rules.push({ allow: key === 'allow', path: value });
    } else if (group.agents.length && key === 'crawl-delay') {
      startedRules = true;
      const delay = Number(value);
      if (Number.isFinite(delay) && delay > 0) group.delay = delay * 1000;
    }
  }
  groups.push(group);
  const specific = groups.filter(item => item.agents.includes('npn-gammabot'));
  const selected = specific.length ? specific : groups.filter(item => item.agents.includes('*'));
  return { rules: selected.flatMap(item => item.rules), crawlDelayMs: Math.max(0, ...selected.map(item => item.delay)) };
}
export function robotsAllows(policy: RobotsPolicy, url: URL): boolean {
  const path = normalizeRobotsOctets(`${url.pathname}${url.search}`);
  let winner: RobotsRule | undefined;
  let longest = -1;
  for (const rule of policy.rules) {
    const anchored = rule.path.endsWith('$');
    const content = normalizeRobotsOctets(anchored ? rule.path.slice(0, -1) : rule.path);
    const pattern = content.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    if (new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path)) {
      const length = content.replace(/\*/g, '').length;
      if (length > longest || (length === longest && rule.allow)) { winner = rule; longest = length; }
    }
  }
  return winner?.allow ?? true;
}
function normalizeRobotsOctets(value: string): string {
  return value.replace(/%([a-f\d]{2})/gi, (encoded, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return /[a-z\d\-._~]/i.test(character) ? character : encoded.toUpperCase();
  }).replace(/[^\x00-\x7f]/gu, character => encodeURIComponent(character));
}
