import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBody, declaredCharset, sniffCharset } from '../src/network/body-decoder.js';
import { extractPage, parseRobots, robotsAllows } from '../src/network/page-content.js';
import { WebError } from '../src/network/url-policy.js';

const encoder = new TextEncoder();
const utf8 = (value: string) => encoder.encode(value);
const bytes = (...parts: (string | number[])[]) => {
  const chunks = parts.map(part => typeof part === 'string' ? utf8(part) : Uint8Array.from(part));
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return joined;
};
// Byte fixtures confirmed against the bundled Node decoder (full ICU).
const GBK_BEIJING = [0xb1, 0xb1, 0xbe, 0xa9];
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4];
const GB18030_GUGONG = [0xb9, 0xca, 0xb9, 0xac];
const BIG5_ZHONGWEN = [0xa4, 0xa4, 0xa4, 0xe5];
const pageUrl = new URL('https://example.org/article');
const errorCode = (expected: string) => (error: unknown) => error instanceof WebError && error.code === expected;

test('decodeBody decodes UTF-8 and strips a BOM even when the header disagrees', () => {
  assert.deepEqual(decodeBody(utf8('Hello 世界'), 'text/html; charset=utf-8'), { text: 'Hello 世界', charset: 'utf-8' });
  const withBom = decodeBody(bytes([0xef, 0xbb, 0xbf], 'Hello 世界'), 'text/html; charset=windows-1252');
  assert.deepEqual(withBom, { text: 'Hello 世界', charset: 'utf-8' });
  assert.doesNotMatch(withBom.text, /\uFEFF/);
});

test('decodeBody honors GBK, GB2312, GB18030 and Big5 labels', () => {
  assert.deepEqual(decodeBody(Uint8Array.from(GBK_BEIJING), 'text/html; charset=gbk'), { text: '北京', charset: 'gbk' });
  assert.deepEqual(decodeBody(Uint8Array.from(GBK_BEIJING), 'text/html; charset=gb2312'), { text: '北京', charset: 'gbk' });
  assert.deepEqual(decodeBody(Uint8Array.from(GB18030_GUGONG), 'text/html; charset=gb18030'), { text: '故宫', charset: 'gb18030' });
  assert.deepEqual(decodeBody(Uint8Array.from(BIG5_ZHONGWEN), 'text/html; charset=big5'), { text: '中文', charset: 'big5' });
  assert.equal(decodeBody(Uint8Array.from(GBK_BEIJING), 'text/html; charset=big5-hkscs').charset, 'big5');
});

test('decodeBody reads the <meta> charset when the header is silent', () => {
  const declared = bytes('<html><head><meta charset="gbk"></head><body>', GBK_BEIJING, '</body></html>');
  const decoded = decodeBody(declared, 'text/html');
  assert.equal(decoded.charset, 'gbk');
  assert.match(decoded.text, /北京/);
  const httpEquiv = bytes('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"></head><body>', GBK_ZHONGWEN, '</body></html>');
  const second = decodeBody(httpEquiv, 'text/html');
  assert.equal(second.charset, 'gbk');
  assert.match(second.text, /中文/);
});

test('the Content-Type charset wins over a contradictory <meta> declaration', () => {
  const page = bytes('<meta charset="gbk">', '中文');
  assert.deepEqual(decodeBody(page, 'text/html; charset=utf-8'), { text: '<meta charset="gbk">中文', charset: 'utf-8' });
});

test('a BOM wins over both the header and the <meta> declaration', () => {
  const page = bytes([0xef, 0xbb, 0xbf], '<meta charset="gbk">', '中文');
  assert.deepEqual(decodeBody(page, 'text/html; charset=gbk'), { text: '<meta charset="gbk">中文', charset: 'utf-8' });
});

test('unknown, empty and unsupported labels fall back to honestly reported UTF-8', () => {
  for (const header of ['text/html; charset=x-unknown-charset', 'text/html; charset=', 'text/html', '']) {
    assert.deepEqual(decodeBody(utf8('plain text'), header), { text: 'plain text', charset: 'utf-8' }, header);
  }
});

test('latin1 and ASCII labels map to the decoder that actually runs', () => {
  assert.deepEqual(decodeBody(Uint8Array.from([0xe9, 0x80]), 'text/html; charset=iso-8859-1'), { text: 'é€', charset: 'windows-1252' });
  assert.deepEqual(decodeBody(utf8('ascii'), 'text/html; charset=us-ascii'), { text: 'ascii', charset: 'utf-8' });
});

test('UTF-16LE and UTF-16BE BOMs select the byte order and are stripped', () => {
  assert.deepEqual(decodeBody(bytes([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]), 'text/html'), { text: 'AB', charset: 'utf-16le' });
  assert.deepEqual(decodeBody(bytes([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42]), 'text/html'), { text: 'AB', charset: 'utf-16be' });
});

test('the decode boundary rejects bodies beyond maxBytes as BODY_LIMIT', () => {
  assert.throws(() => decodeBody(new Uint8Array(9), 'text/html', 8), errorCode('BODY_LIMIT'));
  assert.equal(decodeBody(new Uint8Array(8), 'text/html', 8).text.length, 8);
  assert.equal(decodeBody(new Uint8Array(1_048_576), 'text/html').text.length, 1_048_576);
  assert.throws(() => decodeBody(new Uint8Array(1_048_577), 'text/html'), errorCode('BODY_LIMIT'));
});

test('invalid byte sequences become replacement characters instead of throwing', () => {
  const brokenUtf8 = decodeBody(Uint8Array.from([0xc3, 0x28, 0xe4, 0xbd]), 'text/html; charset=utf-8');
  assert.equal(brokenUtf8.charset, 'utf-8');
  assert.match(brokenUtf8.text, /\uFFFD/);
  const brokenGbk = decodeBody(Uint8Array.from([0x81, 0x20, 0xb1]), 'text/html; charset=gbk');
  assert.equal(brokenGbk.charset, 'gbk');
  assert.ok(brokenGbk.text.length > 0);
  for (const sample of [bytes('Hello 世界'), Uint8Array.from(GBK_BEIJING), Uint8Array.from(BIG5_ZHONGWEN), Uint8Array.from([0xc3, 0x28, 0xe4, 0xbd]), bytes([0xff, 0xfe, 0x41, 0x00])]) {
    assert.ok(decodeBody(sample, 'text/html').text.length <= sample.length);
  }
});

test('declaredCharset reads only the charset parameter and sniffCharset reads BOM or <meta>', () => {
  assert.equal(declaredCharset('text/html; CHARSET="GBK"'), 'gbk');
  assert.equal(declaredCharset('text/html; boundary=part; charset=iso-8859-1'), 'iso-8859-1');
  assert.equal(declaredCharset('text/html'), undefined);
  assert.equal(sniffCharset(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41])), 'utf-8');
  assert.equal(sniffCharset(Uint8Array.from([0xff, 0xfe, 0x41, 0x00])), 'utf-16le');
  assert.equal(sniffCharset(bytes('<html><head><meta charset="big5">')), 'big5');
  assert.equal(sniffCharset(utf8('<p>no declaration</p>')), undefined);
  assert.equal(sniffCharset(bytes(' '.repeat(2100), '<meta charset="gbk">')), undefined);
});

test('extractPage keeps article text, decodes entities and drops script, style and site chrome', () => {
  const page = extractPage('<html><head><title>Research &amp; notes</title><style>.ad{display:none}</style></head><body><header>Site banner</header><nav><a href="/menus">Menu</a></nav><main><h1>Article heading</h1><p>Useful body &mdash; source &lt;tag&gt;.</p><script>steal()</script><aside>Ads</aside><form>Subscribe</form><div hidden>Hidden text</div><p aria-hidden="true">Duplicate</p><a href="/reference">Reference</a><a href="https://outside.example.org/">Outside</a></main><footer>Footer</footer></body></html>', pageUrl);
  assert.equal(page.title, 'Research & notes');
  assert.match(page.text, /Article heading/);
  assert.match(page.text, /Useful body — source <tag>\./);
  assert.doesNotMatch(page.text, /Site banner|Menu|Ads|Subscribe|Hidden text|Duplicate|Footer|steal/);
  assert.deepEqual(page.links, ['https://example.org/reference']);
});

test('links stay same-origin, public, deduplicated and capped at one hundred', () => {
  const anchors = Array.from({ length: 120 }, (_, index) => '<a href="/page-' + index + '">Link ' + index + '</a>').join('');
  const page = extractPage('<main>' + anchors + '<a href="/page-0#duplicate">Again</a><a href="https://elsewhere.example.org/x">Elsewhere</a><a href="http://127.0.0.1/">Private</a></main>', pageUrl);
  assert.equal(page.links.length, 100);
  assert.equal(new Set(page.links).size, 100);
  assert.ok(page.links.every(link => link.startsWith('https://example.org/page-')));
});

test('title falls back to the hostname and text is capped at 40000 characters', () => {
  assert.equal(extractPage('<main><p>Body only</p></main>', pageUrl).title, 'example.org');
  assert.equal(extractPage('<main><p>' + 'word '.repeat(9000) + '</p></main>', pageUrl).text.length, 40000);
});

test('empty and whitespace-only documents fail as PAGE_EMPTY', () => {
  for (const html of ['', '   \n\t  ', '<html><body><div></div></body></html>', '<html> </html>']) {
    assert.throws(() => extractPage(html, pageUrl), errorCode('PAGE_EMPTY'), JSON.stringify(html));
  }
});

test('script-only shells fail as PAGE_RENDERING_REQUIRED without any bypass attempt', () => {
  const shells = [
    '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
    '<html><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>',
    '<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"page":"/"}}</script><div id="__next"></div></body></html>',
    '<html><body><noscript>Enable JavaScript to view this page.</noscript></body></html>',
  ];
  for (const html of shells) {
    assert.throws(() => extractPage(html, pageUrl),
      error => error instanceof WebError && error.code === 'PAGE_RENDERING_REQUIRED' &&
        /client-side rendering/.test(error.message) && /no text content is available/.test(error.message) && /no bypass is attempted/.test(error.message),
      html);
  }
});

test('login, subscription and challenge markup stay ACCESS_BLOCKED', () => {
  for (const html of ['<input type="password">', '<p>Subscribe to continue</p>', '<p>Verify you are human</p>', '<form id="challenge-form" action="/anomaly.js"></form>', '<div class="anomaly-modal"></div>']) {
    assert.throws(() => extractPage(html, pageUrl), errorCode('ACCESS_BLOCKED'), html);
  }
});

test('short genuine pages and pages with real text plus scripts still extract', () => {
  assert.equal(extractPage('<title>Public</title><p>Allowed</p>', pageUrl).text, 'Allowed');
  const page = extractPage('<html><head><title>Research &amp; notes</title></head><body><script>steal()</script><h1>Evidence</h1><p>A &lt; B.</p><a href="/next#one">Next</a></body></html>', pageUrl);
  assert.match(page.text, /Evidence/);
  assert.match(page.text, /A < B\./);
  assert.doesNotMatch(page.text, /steal/);
  assert.deepEqual(page.links, ['https://example.org/next']);
});

test('robots keeps longest-match precedence and $ anchoring', () => {
  const policy = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/public$\nDisallow: /*.pdf$\n');
  const allowed = (path: string) => robotsAllows(policy, new URL('https://example.org' + path));
  assert.equal(allowed('/private/secret'), false);
  assert.equal(allowed('/private/public'), true);
  assert.equal(allowed('/private/public/child'), false);
  assert.equal(allowed('/docs/file.pdf'), false);
  assert.equal(allowed('/docs/file.pdf?download=1'), true);
  assert.equal(allowed('/elsewhere'), true);
  const tie = parseRobots('User-agent: *\nDisallow: /same\nAllow: /same');
  assert.equal(robotsAllows(tie, new URL('https://example.org/same')), true);
});

test('robots parses crawl-delay in milliseconds for the selected agent group', () => {
  assert.equal(parseRobots('User-agent: *\nCrawl-delay: 1.5').crawlDelayMs, 1500);
  assert.equal(parseRobots('User-agent: *\nCrawl-delay: 0').crawlDelayMs, 0);
  assert.equal(parseRobots('User-agent: *\nCrawl-delay: nope').crawlDelayMs, 0);
  assert.equal(parseRobots('User-agent: npn-gammabot\nCrawl-delay: 2\n\nUser-agent: *\nCrawl-delay: 5').crawlDelayMs, 2000);
});

test('a GBK page decodes and extracts Chinese text end to end', () => {
  const body = bytes('<html><head><meta charset="gbk"><title>', GBK_BEIJING, '</title></head><body><main><h1>', GBK_BEIJING, '</h1><p>', GBK_ZHONGWEN, '</p></main></body></html>');
  const decoded = decodeBody(body, 'text/html');
  assert.equal(decoded.charset, 'gbk');
  const page = extractPage(decoded.text, new URL('https://example.org/gbk-page'));
  assert.equal(page.title, '北京');
  assert.match(page.text, /北京/);
  assert.match(page.text, /中文/);
  assert.deepEqual(page.links, []);
});

test('charset labels inherited from Object.prototype fall back to UTF-8', () => {
  const body = utf8('正常正文');
  for (const label of ['constructor', 'toString', '__proto__']) {
    assert.deepEqual(decodeBody(body, 'text/html; charset=' + label), { text: '正常正文', charset: 'utf-8' });
  }
});
