import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listenLoopback } from '../src/app/loopback.js';
test('local HTTP stays fetch-accessible even when OS ephemeral ports include blocked ports', async t => {
  await assert.rejects(fetch('http://127.0.0.1:6667'), error => error instanceof Error && (error.cause as Error)?.message === 'bad port');
  const server = createServer((_request, response) => response.end('ready'));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const port = await listenLoopback(server);
  assert.ok(port >= 49152 && port <= 65535); assert.equal((server.address() as any).address, '127.0.0.1');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ready');
  assert.equal(server.listenerCount('error'), 0);
});
