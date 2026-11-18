import { WebError } from './url-policy.js';

export interface DecodedBody { text: string; charset: string }

/** Hard ceiling at the decode boundary; the transport enforces the same limit while reading. */
const DEFAULT_MAX_BYTES = 1_048_576;
/** <meta> declarations are only trusted from the document head. */
const META_SCAN_BYTES = 2048;

interface ByteOrderMark { charset: 'utf-8' | 'utf-16le' | 'utf-16be'; length: number }

// Aliases exist so the reported charset is always the decoder label that was actually used.
const CHARSET_ALIASES: Record<string, string> = {
  'utf-8': 'utf-8', utf8: 'utf-8', 'unicode-1-1-utf-8': 'utf-8',
  gbk: 'gbk', 'x-gbk': 'gbk', gb2312: 'gbk', 'gb-2312': 'gbk', 'gb_2312': 'gbk', chinese: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5', 'big5-hkscs': 'big5', csbig5: 'big5',
  'iso-8859-1': 'windows-1252', 'iso8859-1': 'windows-1252', 'iso_8859-1': 'windows-1252',
  latin1: 'windows-1252', 'latin-1': 'windows-1252', cp1252: 'windows-1252', 'windows-1252': 'windows-1252',
  'us-ascii': 'utf-8', ascii: 'utf-8', 'ansi_x3.4-1968': 'utf-8',
};

/**
 * Decodes a response body at the single boundary where bytes become page text.
 * Precedence: BOM > Content-Type charset parameter > <meta> declaration > UTF-8.
 */
export function decodeBody(bytes: Uint8Array, contentType: string, maxBytes = DEFAULT_MAX_BYTES): DecodedBody {
  if (bytes.length > maxBytes) throw new WebError('BODY_LIMIT', `Response body of ${bytes.length} bytes exceeds the ${maxBytes}-byte decode limit.`);
  const bom = sniffBom(bytes);
  const charset = bom?.charset ?? normalizeCharset(declaredCharset(contentType)) ?? normalizeCharset(metaCharset(bytes)) ?? 'utf-8';
  // A declared BOM never belongs to the text itself.
  const payload = bom ? bytes.subarray(bom.length) : bytes;
  // Non-fatal keeps a server that lies about its charset readable through replacement characters.
  return { text: new TextDecoder(charset, { fatal: false }).decode(payload), charset };
}

/** Returns the Content-Type charset parameter, lowercased, or undefined when absent. */
export function declaredCharset(contentType: string): string | undefined {
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(contentType);
  return label(match?.[1] ?? match?.[2] ?? match?.[3]);
}

/** Returns the charset declared by a BOM or an in-document <meta> tag, or undefined. */
export function sniffCharset(bytes: Uint8Array): string | undefined {
  return sniffBom(bytes)?.charset ?? normalizeCharset(metaCharset(bytes));
}

function sniffBom(bytes: Uint8Array): ByteOrderMark | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { charset: 'utf-8', length: 3 };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { charset: 'utf-16le', length: 2 };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { charset: 'utf-16be', length: 2 };
  return undefined;
}

function metaCharset(bytes: Uint8Array): string | undefined {
  // Markup is ASCII. Mapping each byte to the same code unit keeps non-UTF-8 bodies scannable
  // without assuming anything about the charset we are trying to discover.
  const limit = Math.min(bytes.length, META_SCAN_BYTES);
  let head = '';
  for (let index = 0; index < limit; index++) head += String.fromCharCode(bytes[index]);
  const match = /<meta\b[^>]*\bcharset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>;]+))/i.exec(head);
  return label(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function label(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeCharset(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Only own entries are aliases. Inherited object properties such as constructor or __proto__
  // must fall through to the runtime check instead of being used as decoder labels.
  const alias = Object.hasOwn(CHARSET_ALIASES, value) ? CHARSET_ALIASES[value] : undefined;
  if (alias) return alias;
  // A label outside the alias table is honored only when the runtime decoder accepts it.
  // Labels the runtime rejects fall through to UTF-8, which is then reported honestly.
  try { new TextDecoder(value); return value; } catch { return undefined; }
}
