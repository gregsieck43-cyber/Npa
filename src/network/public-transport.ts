import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { type PublicAddress, WebError } from './url-policy.js';

export const WEB_USER_AGENT = 'NPN-GammaBot/0.3 (local user-requested research)';

export interface PublicRequestInit {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

/** DNS is pinned to the checked address; redirects and body limits belong to WebClient. */
export function publicGet(url: URL, address: PublicAddress, signal: AbortSignal): Promise<Response> {
  return publicRequest(url, address, { method: 'GET', headers: { Accept: 'text/html,application/json,text/plain;q=0.9' } }, signal);
}

/**
 * Production transport for every page GET and every fixed search request (including the Exa
 * JSON-RPC POST). The socket targets the address that was already validated, so a second DNS
 * answer cannot redirect the connection to a private destination.
 */
export function publicRequest(url: URL, address: PublicAddress, init: PublicRequestInit, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'User-Agent': WEB_USER_AGENT, 'Accept-Encoding': 'identity', ...init.headers };
    const body = init.body;
    if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body));
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: init.method, signal, family: address.family,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers,
    }, response => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const status = response.statusCode ?? 502;
      if (status < 200 || status > 599) { response.destroy(); reject(new WebError('HTTP_PROTOCOL', 'Unsupported HTTP response.')); return; }
      const responseBody = [204, 205, 304].includes(status) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      resolve(new Response(responseBody, { status, headers: responseHeaders }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}
