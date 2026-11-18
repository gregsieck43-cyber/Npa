/**
 * Streaming bridge 契约钉（前端，无生产改动）：BridgeGateway 必须如实搬运产品事件流中的
 * message.upsert —— status 'streaming' 的多个同 id 分片与最终 'done' 不能合并、改写或伪造。
 *
 * 只用 node:test + node:assert/strict + 可注入的确定性时钟 + 本地传输桩；不触网、不写盘。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeGateway } from '../api/bridge';
import type { BridgeTimers } from '../api/bridge';
import type { GatewayEvent } from '../api/types';

const PREFIX = '/v1/product';
const SESSION_ID = 'work-task-1';
const FULL_TEXT = 'Streamed Work answer text.';

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise<void>(resolve => { setImmediate(() => resolve()); });
  }
}

/** 与既有 bridge-product 测试相同的确定性时钟：不依赖真实 setTimeout。 */
class FakeTimers implements BridgeTimers {
  private now = 0;
  private nextId = 1;
  private readonly queue = new Map<number, { at: number; order: number; handler: () => void }>();

  setTimeout(handler: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.queue.set(id, { at: this.now + Math.max(0, delayMs), order: id, handler });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.queue.delete(handle as number);
  }

  size(): number {
    return this.queue.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + Math.max(0, ms);
    for (;;) {
      await flush();
      let next: { id: number; at: number; order: number; handler: () => void } | undefined;
      for (const [id, timer] of this.queue) {
        if (timer.at > target) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && timer.order < next.order)) {
          next = { id, at: timer.at, order: timer.order, handler: timer.handler };
        }
      }
      if (!next) break;
      this.queue.delete(next.id);
      this.now = next.at;
      next.handler();
    }
    this.now = target;
    await flush();
  }
}

const textOf = (event: Extract<GatewayEvent, { type: 'message.upsert' }>): string =>
  event.message.parts.map(part => part.kind === 'text' ? part.text : '').join('');

test('BridgeGateway transports streaming->done message.upsert events faithfully in cursor order', async () => {
  const userEvent: GatewayEvent = {
    type: 'message.upsert', sessionId: SESSION_ID,
    message: { id: 'user-1', role: 'user', createdAt: '2026-10-30T00:00:00.000Z', status: 'done', parts: [{ kind: 'text', text: 'Stream the Work answer' }] },
  };
  const partial = (text: string): GatewayEvent => ({
    type: 'message.upsert', sessionId: SESSION_ID,
    message: { id: 'assistant-S', role: 'assistant', createdAt: '2026-10-30T00:00:01.000Z', status: 'streaming', parts: [{ kind: 'text', text }], requestId: 'req-1' },
  });
  const doneEvent: GatewayEvent = {
    type: 'message.upsert', sessionId: SESSION_ID,
    message: { id: 'assistant-S', role: 'assistant', createdAt: '2026-10-30T00:00:02.000Z', status: 'done', parts: [{ kind: 'text', text: FULL_TEXT }], requestId: 'req-1' },
  };
  const expected: GatewayEvent[] = [userEvent, partial('Streamed'), partial('Streamed Work'), partial('Streamed Work answer'), doneEvent];

  const timers = new FakeTimers();
  const requests: { method: string; path: string; body: unknown }[] = [];
  let serves = 0;
  const npn = {
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      requests.push({ method, path, body });
      if (!path.startsWith(PREFIX + '/events')) throw new Error('unexpected bridge request: ' + path);
      serves += 1;
      return { events: expected.map((event, index) => ({ id: index + 1, event })), nextCursor: expected.length, earliest: 1, reset: false };
    },
    async desktop(): Promise<unknown> { return undefined; },
  };
  const gateway = new BridgeGateway(npn, { timers, pollIntervalMs: 1000 });
  const delivered: GatewayEvent[] = [];
  const off = gateway.subscribe(event => delivered.push(event));

  await flush();
  await timers.advance(0);
  await flush();
  assert.deepEqual(delivered, expected, 'every product event must reach the subscriber unchanged, in cursor order');
  assert.equal(requests.length, 1, 'the first poll must fetch one event page');
  assert.equal(requests[0]!.method, 'GET');
  const url = new URL(requests[0]!.path, 'http://127.0.0.1');
  assert.equal(url.pathname, PREFIX + '/events');
  assert.equal(url.searchParams.get('cursor'), '0');
  assert.equal(url.searchParams.get('limit'), '200');

  const assistant = delivered.filter((event): event is Extract<GatewayEvent, { type: 'message.upsert' }> =>
    event.type === 'message.upsert' && event.message.role === 'assistant');
  const streaming = assistant.filter(event => event.message.status === 'streaming');
  assert.equal(streaming.length, 3, 'all three partial bubbles must be delivered, never coalesced');
  assert.deepEqual(streaming.map(event => event.message.id), ['assistant-S', 'assistant-S', 'assistant-S'], 'one stable partial id must be preserved');
  assert.deepEqual(streaming.map(textOf), ['Streamed', 'Streamed Work', 'Streamed Work answer'], 'partial text must be forwarded exactly');
  const texts = assistant.map(textOf);
  for (let index = 1; index < texts.length; index += 1) assert.ok(texts[index]!.startsWith(texts[index - 1]!), 'partial text must grow monotonically');
  const last = assistant.at(-1)!;
  assert.equal(last.message.id, 'assistant-S');
  assert.equal(last.message.status, 'done');
  assert.equal(textOf(last), FULL_TEXT, 'the last delivered message for the id must be done with the full text');

  await timers.advance(1000);
  await flush();
  assert.ok(serves >= 2, 'the bridge must poll again for later events');
  assert.deepEqual(delivered, expected, 'a re-served old page must not duplicate or fabricate events');
  off();
  assert.equal(timers.size(), 0, 'unsubscribing the last listener must clear the poll timer');
});

test('BridgeGateway renews a held read immediately and ignores its late response after unsubscribe', async () => {
  const timers = new FakeTimers();
  const requests: string[] = [];
  const event: GatewayEvent = { type: 'notify', tone: 'info', title: 'committed update' };
  let finish: ((value: unknown) => void) | undefined;
  const gateway = new BridgeGateway({
    request: async (_method, path) => {
      requests.push(path);
      assert.equal(new URL(path, 'http://local').searchParams.get('waitMs'), '15000');
      if (requests.length === 1) return { events: [{ id: 1, event }], nextCursor: 1, earliest: 1, reset: false, longPoll: true };
      return await new Promise(resolve => { finish = resolve; });
    }, desktop: async () => undefined,
  }, { timers });
  const delivered: GatewayEvent[] = [];
  const off = gateway.subscribe(value => delivered.push(value));
  await timers.advance(0);
  assert.equal(requests.length, 2, 'do not add a one-second gap after a held read');
  assert.deepEqual(delivered, [event]);
  off();
  finish!({ events: [{ id: 2, event }], nextCursor: 2, earliest: 1, reset: false, longPoll: true });
  await flush();
  assert.deepEqual(delivered, [event]);
  assert.equal(timers.size(), 0);
});
