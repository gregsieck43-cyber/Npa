/** 演示项目的文件内容（仅 mock 网关使用）。original 为“上次提交”的内容，undefined 表示新增文件。 */
export interface DemoFile { content: string; original?: string }

const archiveNow = `import { createHash } from 'node:crypto';

export interface ArchivePage {
  sourceId: string;
  sha256: string;
  items: ArchiveItem[];
  nextOffset?: number;
}

/** 分页以快照游标为准，避免 BM25 全库变化导致页面抖动。 */
export function page(snapshot: Snapshot, offset: number, limit = 20): ArchivePage {
  // 分页固定在快照行序上，全库新增文档不会让第 2 页漂移
  const items = snapshot.rows.slice(offset, offset + limit);
  return {
    sourceId: snapshot.id, sha256: hashOriginal(snapshot.digest),
    items,
    nextOffset: offset + limit < snapshot.rows.length ? offset + limit : undefined,
  };
}

export function hashOriginal(digest: string): string {
  return createHash('sha256').update(digest).digest('hex');
}
`;

const archiveBefore = archiveNow
  .replace("  // 分页固定在快照行序上，全库新增文档不会让第 2 页漂移\n  const items = snapshot.rows.slice(offset, offset + limit);", '  const ranked = bm25(snapshot.query, liveIndex());\n  const items = ranked.slice(offset, offset + limit);')
  .replace('sha256: hashOriginal(snapshot.digest)', 'sha256: hashProjection(items)');

const kernelNow = `import { enqueue } from './outbox';
import type { Intent } from './types';

export class Kernel {
  constructor(private readonly store: Store) {}

  grant(intent: Intent, digest: string) {
    this.assertFresh(intent, digest);
    enqueue(this.store, {
      effectKey: intent.effectKey, intentId: intent.id,
      state: 'pending', attempts: 0,
    });
    this.emit('intent.granted', { id: intent.id });
  }

  private assertFresh(intent: Intent, digest: string) {
    if (intent.digest !== digest) throw new KernelError('stale', 'Approval is stale');
    // TODO: 同时校验 policyEpoch
  }
}
`;

const kernelBefore = kernelNow
  .replace("import { enqueue } from './outbox';\n", '')
  .replace("    enqueue(this.store, {\n      effectKey: intent.effectKey, intentId: intent.id,\n      state: 'pending', attempts: 0,\n    });", "    this.dispatch(intent);\n    this.store.update('intents', intent.id, { state: 'sent' });");

const outbox = `export interface OutboxEntry {
  effectKey: string;
  intentId: string;
  state: 'pending' | 'sent' | 'acknowledged' | 'unknown';
  attempts: number;
}

/** 先落盘意图再发送，崩溃后由 reconcile 判定未知效果，绝不盲目重发。 */
export function enqueue(store: Store, entry: OutboxEntry): void {
  store.transaction(() => {
    store.insert('outbox', entry);
    store.bumpRevision(entry.intentId);
  });
}

export function reconcile(store: Store): OutboxEntry[] {
  return store.select('outbox', { state: 'sent' }).map(markUnknown);
}
`;

const pagingTest = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { page } from '../src/memory/archive';

test('page 2 stable after inserts', () => {
  const snapshot = fixture(45);
  const before = page(snapshot, 20).items.map(i => i.id);
  insertDocuments(30);
  assert.deepEqual(page(snapshot, 20).items.map(i => i.id), before);
});
`;

const same = (content: string): DemoFile => ({ content, original: content });

export function demoFiles(): Record<string, DemoFile> {
  return {
    'src/kernel/index.ts': { content: kernelNow, original: kernelBefore },
    'src/kernel/outbox.ts': { content: outbox },
    'src/kernel/types.ts': same(`export interface Intent {\n  id: string;\n  effectKey: string;\n  digest: string;\n  policyEpoch: number;\n}\n`),
    'src/memory/archive.ts': { content: archiveNow, original: archiveBefore },
    'src/memory/tools.ts': same(`import { page } from './archive';\n\nexport const readHistory = {\n  name: 'read_history',\n  run: ({ sourceId, offset }: { sourceId: string; offset?: number }) => page(load(sourceId), offset ?? 0),\n};\n`),
    'src/harness/chat.ts': same(`export async function send(input: ChatInput) {\n  const request = await assemble(input);\n  return stream(request);\n}\n`),
    'src/harness/service.ts': same(`export class HarnessService {\n  route(method: string, url: URL) {\n    // 路由分发\n  }\n}\n`),
    'src/contracts.ts': same(`export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed';\n`),
    'tests/memory-paging.test.ts': { content: pagingTest },
    'tests/kernel.test.ts': same(`import { test } from 'node:test';\n\ntest('grant enqueues effect', () => {});\n`),
    'package.json': same(`{\n  "name": "npn-gamma-agent",\n  "version": "0.7.0",\n  "scripts": {\n    "test": "node --test build/tests/*.test.js"\n  }\n}\n`),
    'README.md': same(`# NPN-Gamma Agent\n\n持久化本地 Agent：桌面、CLI 与 MCP。\n`),
  };
}
