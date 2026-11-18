/** Test-only transport: synchronous persistence fixtures share a loop with their HTTP server.
 * A long poll-phase stall can expire the server's idle socket before Fetch observes its close.
 * Use a fresh loopback connection unless the test explicitly exercises connection reuse.
 * Production launchers do not import this file. No request is retried here.
 */
export function withTestLoopbackConnections(fetchImplementation) {
  return async function testLoopbackFetch(input, init) {
    let url;
    try { url = new URL(input instanceof Request ? input.url : String(input)); }
    catch { return fetchImplementation(input, init); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return fetchImplementation(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has('connection')) return fetchImplementation(input, init);
    headers.set('connection', 'close');
    return fetchImplementation(input, { ...init, headers });
  };
}

globalThis.fetch = withTestLoopbackConnections(globalThis.fetch);
