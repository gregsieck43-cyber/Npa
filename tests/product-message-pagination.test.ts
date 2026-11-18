import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import type { SessionDetail } from '../src/frontend/api/types.js';

for (const mode of ['chat', 'cowork'] as const) test(`${mode} HTTP message cursors retain every row after client character trimming`, async t => {
  const base = path.resolve(process.env.TEMP!); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'message-page-'));
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: dir });
  t.after(() => backend.close());
  const harness = backend.services.harness!, kernel = backend.services.kernel;
  const create = () => mode === 'chat' ? harness.store.createSession({ title: 'Paging', workspace: dir, capabilities: { web: false, tools: false, mcp: false, skills: false, projectInstructions: false } }).id
    : kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: 'Paging', initialStatus: 'paused', permissionMode: 'read-only' } }).taskId!;
  const id = create(), other = create(), ids: string[] = mode === 'cowork' ? kernel.messagePage(id).messages.map(message => message.id) : [];
  const db = mode === 'cowork' ? new DatabaseSync(kernel.dbPath) : undefined;
  try {
    for (let n = 0; n < 260; n++) {
      const content = `message-${n}-` + 'x'.repeat(80000);
      if (mode === 'chat') ids.push(harness.store.addMessage(id, { role: 'user', content }).id);
      else { const message = { id: randomUUID(), role: 'user', content, createdAt: new Date(n * 1000).toISOString() }; ids.push(message.id); db!.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(message.id, id, 'main', JSON.stringify(message), message.createdAt); }
    }
  } finally { db?.close(); }
  const read = async (sessionId: string, before?: string) => fetch(`http://127.0.0.1:${backend.port}/v1/product/sessions/${sessionId}${before ? '?before=' + encodeURIComponent(before) : ''}`, { headers: { Authorization: `Bearer ${backend.token}` }, signal: AbortSignal.timeout(10000) });
  const latest = await read(id); assert.equal(latest.status, 200);
  let page = await latest.json() as SessionDetail; assert.ok(page.messages.length > 0 && page.messages.length <= 100); assert.ok(page.beforeCursor, 'server must expose the existing preceding-page cursor');
  const older = await read(id, page.beforeCursor); assert.equal(older.status, 200); assert.equal((await older.json() as SessionDetail).messages.at(-1)?.id, ids.at(-page.messages.length - 1));
  const seen = new Set<string>(); let pages = 0;
  for (;;) {
    // The real UI character budget retains only this continuous suffix of a server page.
    const visible = page.messages.slice(-20); visible.forEach(row => { assert.equal(seen.has(row.id), false, 'history anchors must never repeat a consumed row'); seen.add(row.id); });
    if (!visible.length) break;
    assert.ok(++pages <= ids.length, 'every nonempty page must advance at least one message');
    const response = await read(id, 'message:' + visible[0]!.id); assert.equal(response.status, 200);
    page = await response.json() as SessionDetail;
  }
  assert.deepEqual([...seen].sort(), [...ids].sort());
  assert.equal((await read(other, 'message:' + ids[0])).status, 400, 'foreign anchor must not resolve');
  assert.equal((await read(id, 'message:missing')).status, 400);
  assert.equal((await read(id, '0')).status, 400);
});
