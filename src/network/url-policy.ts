import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface PublicAddress { address: string; family: number }
export type DnsResolver = (hostname: string) => Promise<PublicAddress[]>;
export class WebError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'WebError'; }
}

export function parsePublicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new WebError('INVALID_URL', 'Use an absolute HTTP or HTTPS URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) {
    throw new WebError('URL_BLOCKED', 'Only HTTP(S) URLs without embedded credentials are allowed.');
  }
  for (const key of url.searchParams.keys()) {
    if (/^(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|bearer|credential)$/i.test(key)) throw new WebError('URL_BLOCKED', 'Credential parameters are not supported by public page tools.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(hostname) || !hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(hostname)) {
    throw new WebError('URL_BLOCKED', 'IP literals, local names and private destinations are not allowed.');
  }
  url.hash = '';
  return url;
}

export async function resolvePublicUrl(url: URL, resolver: DnsResolver, signal: AbortSignal): Promise<PublicAddress> {
  const addresses = await abortable(resolver(url.hostname), signal);
  if (!addresses.length || addresses.some(item => item.family !== isIP(item.address) || !isPublicAddress(item.address))) {
    throw new WebError('DNS_BLOCKED', 'Destination DNS includes an address outside the public Internet.');
  }
  return addresses[0];
}
export const systemResolver: DnsResolver = hostname => lookup(hostname, { all: true, verbatim: true });

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const first = Number.parseInt(normalized.split(':')[0], 16);
    const second = Number.parseInt(normalized.split(':')[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && first !== 0x2002;
  }
  return false;
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
