import { WebError, abortable, parsePublicUrl } from './url-policy.js';

export interface ProviderRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}
export type ProviderTransport = (request: ProviderRequest, signal: AbortSignal) => Promise<Response>;

/** One public hit. Structurally identical to SearchResult; kept local so this module never imports the adapters. */
export interface FreeSearchResult { title: string; url: string; snippet: string; source: string }
export interface FreeSearchOutcome { results: FreeSearchResult[]; endpoint: string }

export interface FreeProvider {
  readonly id: 'exa' | 'bing-rss';
  readonly label: string;
  readonly endpoints: readonly string[];
  search(query: string, transport: ProviderTransport, signal: AbortSignal): Promise<FreeSearchOutcome>;
}

export const EXA_ENDPOINT = 'https://mcp.exa.ai/mcp';
export const BING_RSS_ENDPOINT = 'https://www.bing.com/search';

const BODY_LIMIT = 1024 * 1024;
const RESULT_LIMIT = 10;
const TITLE_LIMIT = 300;
const SNIPPET_LIMIT = 1000;

// Anonymous MCP wire verified by the 2026-10-29 probe: one initialize, one initialized
// notification, one fixed search tool. The transport is injected, so no provider here reaches
// the network, chooses a fallback or retries on its own.
const EXA_PROTOCOL_VERSION = '2025-03-26';
/**
 * MCP Version Negotiation: the server may choose another version it supports, but this client only
 * continues on versions whose wire behaviour it implements and has fixtures for. A newer or
 * invented date string is a protocol failure, not something to echo on later requests.
 */
const EXA_SUPPORTED_PROTOCOLS: readonly string[] = ['2025-03-26', '2025-06-18'];
const EXA_INITIALIZE_ID = 1;
const EXA_SEARCH_ID = 2;
const EXA_TOOL = 'web_search_exa';
const EXA_RESULT_COUNT = 10;
const EXA_LABEL = 'Exa free anonymous web search';
const BING_LABEL = 'Bing public RSS search';
const EXA_BLOCK_SEPARATOR = /^[ \t]*-{3,}[ \t]*$/m;
const EXA_HIGHLIGHTS = /^[ \t]*Highlights?:[ \t]*/im;
const EXA_METADATA = /^[ \t]*(?:Title|URL|Published|Author|Date):[^\n]*$/gim;
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const XML_ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi;
const XML_CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
const XML_DTD = /<!DOCTYPE|<!ENTITY/i;
const XML_PROLOG = /^<\?xml[\s\S]*?\?>/;
const XML_COMMENTS = /^(?:<!--[\s\S]*?-->)+/;
const XML_CHARSET = /charset\s*=\s*"?([^;"'\s]+)/i;
const TRACKING_PARAM = /^(?:utm_.+|fbclid|gclid|msclkid)$/i;

interface ExaSession { protocol: string; sessionId?: string }

export const exaFreeProvider: FreeProvider = { id: 'exa', label: EXA_LABEL, endpoints: [EXA_ENDPOINT], search: exaSearch };
export const bingRssProvider: FreeProvider = { id: 'bing-rss', label: BING_LABEL, endpoints: [BING_RSS_ENDPOINT], search: bingRssSearch };
export const FREE_PROVIDERS: readonly FreeProvider[] = [exaFreeProvider, bingRssProvider];

/** Exa anonymous MCP: initialize (id 1), notifications/initialized, then the one fixed search call (id 2). */
async function exaSearch(query: string, transport: ProviderTransport, signal: AbortSignal): Promise<FreeSearchOutcome> {
  signal.throwIfAborted();
  const session: ExaSession = { protocol: EXA_PROTOCOL_VERSION };
  const hello = record(await exaCall(session, transport, signal, EXA_INITIALIZE_ID, 'initialize', {
    protocolVersion: EXA_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'npn-gamma-network', version: '0.7.0' },
  }));
  const negotiated = hello?.protocolVersion;
  if (typeof negotiated !== 'string' || !EXA_SUPPORTED_PROTOCOLS.includes(negotiated)) {
    throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' negotiated unsupported MCP protocol version ' + String(negotiated) + '.');
  }
  // Every later request states the version the server accepted.
  session.protocol = negotiated;
  await exaNotify(session, transport, signal);
  const answer = await exaCall(session, transport, signal, EXA_SEARCH_ID, 'tools/call', {
    name: EXA_TOOL,
    arguments: { query, numResults: EXA_RESULT_COUNT },
  });
  return { results: exaResults(answer), endpoint: EXA_ENDPOINT };
}

async function exaCall(session: ExaSession, transport: ProviderTransport, signal: AbortSignal, id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
  const response = await transport(exaRequest(session, { jsonrpc: '2.0', method, id, params }), signal);
  captureSession(session, response);
  await assertStatus(response, EXA_LABEL);
  return exaMessage(response, id, signal);
}

async function exaNotify(session: ExaSession, transport: ProviderTransport, signal: AbortSignal): Promise<void> {
  const response = await transport(exaRequest(session, { jsonrpc: '2.0', method: 'notifications/initialized' }), signal);
  captureSession(session, response);
  await assertStatus(response, EXA_LABEL);
  const acknowledged = response.status === 200 || response.status === 202 || response.status === 204;
  // The acknowledgement never carries a JSON-RPC message.
  await cancelBody(response);
  if (!acknowledged) throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' acknowledged an MCP notification with HTTP ' + response.status + '.');
}

function exaRequest(session: ExaSession, payload: Record<string, unknown>): ProviderRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': session.protocol,
  };
  if (session.sessionId) headers['Mcp-Session-Id'] = session.sessionId;
  return { url: EXA_ENDPOINT, method: 'POST', headers, body: JSON.stringify(payload) };
}

/** The server may issue a session id with any response; it is echoed on every later request. */
function captureSession(session: ExaSession, response: Response): void {
  const issued = response.headers.get('mcp-session-id');
  if (issued) session.sessionId = issued;
}

async function exaMessage(response: Response, id: number, signal: AbortSignal): Promise<unknown> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    return resultOf(jsonMessage(new TextDecoder().decode(await readBody(response, signal))), id);
  }
  return exaStreamMessage(response, id, signal);
}

/** Reads the first JSON-RPC message addressed to this request out of an incremental SSE body. */
async function exaStreamMessage(response: Response, id: number, signal: AbortSignal): Promise<unknown> {
  const body = response.body;
  if (!body) throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' returned an event stream without a body.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let size = 0;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > BODY_LIMIT) throwBodyLimit();
      // CRLF can be split across chunks, so the whole pending tail is normalized again.
      pending = (pending + decoder.decode(chunk.value, { stream: true })).replaceAll('\r\n', '\n');
      if (pending.length > BODY_LIMIT) throwBodyLimit();
      // A frame ends at a blank line; a trailing frame is never dispatched at end of stream.
      for (let boundary = pending.indexOf('\n\n'); boundary >= 0; boundary = pending.indexOf('\n\n')) {
        const payload = frameData(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        if (!payload) continue;
        const message = jsonMessage(payload);
        if (addressedTo(message, id)) return resultOf(message, id);
      }
    }
    throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' closed the stream without a response for request ' + id + '.');
  } finally {
    await releaseReader(reader);
  }
}

/** MCP streamable HTTP payload: only data lines carry the message, so comments and other fields are ignored. */
function frameData(frame: string): string {
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.join('\n');
}

function jsonMessage(text: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' returned invalid JSON.'); }
  const message = record(parsed);
  if (!message) throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' returned a JSON message that is not an object.');
  if (message.jsonrpc !== '2.0') throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' returned a message that is not JSON-RPC 2.0.');
  return message;
}

/** Strict number equality: a string id, a missing id or another call's id never addresses our request. */
function addressedTo(message: Record<string, unknown>, id: number): boolean {
  return message.id === id;
}

function resultOf(message: Record<string, unknown>, id: number): unknown {
  if (!addressedTo(message, id)) throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' answered request ' + String(message.id) + ' instead of ' + id + '.');
  const failure = record(message.error);
  if (failure) {
    const code = typeof failure.code === 'number' ? failure.code : 'unknown';
    const detail = typeof failure.message === 'string' ? failure.message.slice(0, 160) : 'no message';
    throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' returned JSON-RPC error ' + code + ': ' + detail);
  }
  return message.result;
}

function exaResults(result: unknown): FreeSearchResult[] {
  const payload = record(result);
  if (!payload) throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' returned a tool result that is not an object.');
  if (payload.isError === true) throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' reported a tool error.');
  const text = textEntries(payload.content).join('\n');
  // An empty content array is a legitimate empty search; malformed entries throw in textEntries.
  if (!text.trim()) return [];
  const results = parseExaText(text);
  // Text that parses into nothing is a protocol surprise, not an empty result set.
  if (!results.length) throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' returned text without any Title/URL result block.');
  return results;
}

function textEntries(content: unknown): string[] {
  // The reviewed tool always answers with an array of text blocks. A missing array or an entry of
  // another shape is a protocol failure; silently skipping it would turn corruption into "no hits".
  if (!Array.isArray(content)) throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' returned a tool result without a content array.');
  const texts: string[] = [];
  for (const item of content) {
    const entry = record(item);
    if (!entry || entry.type !== 'text' || typeof entry.text !== 'string') {
      throw new WebError('SEARCH_PROTOCOL', EXA_LABEL + ' returned a content entry that is not a text block.');
    }
    texts.push(entry.text);
  }
  return texts;
}

/** Exa result text: blocks separated by a hyphen rule, each with Title/URL lines and a Highlights section. */
function parseExaText(text: string): FreeSearchResult[] {
  const results: FreeSearchResult[] = [];
  const seen = new Set<string>();
  for (const block of text.split(EXA_BLOCK_SEPARATOR)) {
    if (results.length === RESULT_LIMIT) break;
    const title = flatten(field(block, 'Title')).slice(0, TITLE_LIMIT);
    const target = field(block, 'URL');
    if (!title || !target) continue;
    let url: URL;
    try { url = withoutTracking(parsePublicUrl(target)); } catch { continue; } // Private and credential links are dropped, not reported.
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    results.push({ title, url: url.href, snippet: exaSnippet(block), source: 'exa' });
  }
  return results;
}

function field(block: string, name: string): string {
  const match = new RegExp('^[ \\t]*' + name + ':[ \\t]*(.*)$', 'im').exec(block);
  return match ? match[1].trim() : '';
}

function exaSnippet(block: string): string {
  const highlights = EXA_HIGHLIGHTS.exec(block);
  // Everything after the Highlights line is the snippet; without one the metadata lines are prose.
  const prose = highlights ? block.slice(highlights.index + highlights[0].length) : block.replace(EXA_METADATA, ' ');
  return flatten(prose).slice(0, SNIPPET_LIMIT);
}

/** Bing public RSS: one fixed GET; the feed is decoded and read without any DTD or entity processing. */
async function bingRssSearch(query: string, transport: ProviderTransport, signal: AbortSignal): Promise<FreeSearchOutcome> {
  signal.throwIfAborted();
  const requestUrl = BING_RSS_ENDPOINT + '?format=rss&q=' + encodeURIComponent(query);
  const response = await transport({
    url: requestUrl,
    method: 'GET',
    headers: { Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8' },
  }, signal);
  await assertStatus(response, BING_LABEL);
  const document = rssDocument(decodeBody(await readBody(response, signal), response.headers.get('content-type') ?? ''));
  return { results: parseBingItems(document), endpoint: requestUrl };
}

/**
 * A feed that declares a DTD or an entity is refused before anything is expanded: this reader
 * decodes the five XML named entities and numeric references only, and never resolves anything
 * external.
 */
function rssDocument(text: string): string {
  if (XML_DTD.test(text)) {
    throw new WebError('SEARCH_PROTOCOL', BING_LABEL + ' returned a document that declares a DTD or entity; it is rejected without entity resolution.');
  }
  const document = text.replace(/^\uFEFF/, '').trimStart().replace(XML_PROLOG, '').replace(XML_COMMENTS, '').trimStart();
  if (!/^<rss\b/i.test(document)) throw new WebError('SEARCH_PROTOCOL', BING_LABEL + ' did not return an RSS document.');
  return document;
}

function parseBingItems(document: string): FreeSearchResult[] {
  const results: FreeSearchResult[] = [];
  const seen = new Set<string>();
  for (const match of document.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    if (results.length === RESULT_LIMIT) break;
    const item = match[1];
    const title = flatten(feedElement(item, 'title')).slice(0, TITLE_LIMIT);
    if (!title) continue;
    let url: URL;
    try { url = withoutTracking(parsePublicUrl(feedElement(item, 'link').trim())); } catch { continue; } // Private, non-HTTP and malformed links are dropped.
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    results.push({ title, url: url.href, snippet: flatten(feedElement(item, 'description')).slice(0, SNIPPET_LIMIT), source: 'bing' });
  }
  return results;
}

/** Same tracking-parameter semantics as the wire search providers: drop campaign ids, keep real parameters. */
function withoutTracking(url: URL): URL {
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  return url;
}

/** CDATA marks literal text rather than markup; both forms are decoded once and then tags are stripped. */
function feedElement(item: string, name: string): string {
  const match = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '\\s*>', 'i').exec(item);
  return match ? decodeXmlEntities(match[1].replace(XML_CDATA, '$1')) : '';
}

function decodeXmlEntities(value: string): string {
  return value.replace(XML_ENTITY, (original: string, entity: string) => {
    if (!entity.startsWith('#')) return XML_ENTITIES[entity.toLowerCase()] ?? original;
    const hex = entity[1] === 'x' || entity[1] === 'X';
    const code = hex ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original;
  });
}

/** Snippet and title text: markup removed, whitespace collapsed to one line. */
function flatten(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Charset labels are honoured when known; decoding never fails on malformed bytes. */
function decodeBody(bytes: Uint8Array, contentType: string): string {
  const label = XML_CHARSET.exec(contentType)?.[1];
  return (label ? decoderFor(label) : new TextDecoder()).decode(bytes);
}

function decoderFor(label: string): TextDecoder {
  try { return new TextDecoder(label, { fatal: false }); } catch { return new TextDecoder(); } // Unknown label: read it as UTF-8.
}

/** A failed response is never read; releasing it keeps the pinned socket from lingering. */
async function assertStatus(response: Response, label: string): Promise<void> {
  const redirect = response.redirected || (response.status >= 300 && response.status < 400);
  if (!redirect && response.ok) return;
  await cancelBody(response);
  if (redirect) throw new WebError('HTTP_FAILED', label + ' answered with a redirect (HTTP ' + response.status + '); redirects are not followed.');
  if (response.status === 429) {
    throw new WebError('RATE_LIMITED', label + ' is an anonymous, credential-free free tier and rate limited this request (HTTP 429). No credential, paid upgrade, changed identity or verification bypass is attempted.');
  }
  throw new WebError('HTTP_FAILED', label + ' returned HTTP ' + response.status + '.');
}

/** Releasing an unread body is best effort; a stream that already failed rejects cancel. */
async function cancelBody(response: Response): Promise<void> {
  if (response.body) await response.body.cancel().catch(() => undefined);
}

/** Reads at most BODY_LIMIT bytes; every read is abortable so cancellation rejects promptly. */
async function readBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > BODY_LIMIT) throwBodyLimit();
      chunks.push(chunk.value);
    }
  } finally {
    await releaseReader(reader);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * Cancelling is best effort: a stream that already errored or was aborted rejects cancel, and
 * that cleanup failure must not replace the reason the request actually stopped.
 */
async function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  await reader.cancel().catch(() => undefined);
  reader.releaseLock();
}

function throwBodyLimit(): never {
  throw new WebError('BODY_LIMIT', 'Search response exceeded the ' + BODY_LIMIT + ' byte limit.');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
