import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { BackendClient } from '../src/extensions/client.js';

test('the MCP HTTP response budget counts streamed UTF-8 bytes and refuses an oversized response before parsing', async t => {
  const value = { status: 'ready', text: '中文🚀'.repeat(4000) }, body = Buffer.from(JSON.stringify(value));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    for (let offset = 0; offset < body.length; offset += 127) response.write(body.subarray(offset, offset + 127));
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const connection = { dataDir: process.cwd(), baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: 'fixture-only' };
  assert.deepEqual(await new BackendClient({ ...connection, maxResponseBytes: body.length }).health(), value);
  await assert.rejects(new BackendClient({ ...connection, maxResponseBytes: body.length - 1 }).health(), /transport byte limit.*paged history/);
  assert.deepEqual(await new BackendClient(connection).health(), value, 'existing explicit CLI export remains compatible');
});
