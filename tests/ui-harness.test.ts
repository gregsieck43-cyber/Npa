import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationDrafts, mergeRequestPages, parseRequestBody, requestDifferences, requestMetrics } from '../src/ui/harness-model.js';
import type { RequestRecord } from '../src/harness/types.js';

test('request editing retains extra provider fields and tool-only assistant messages', () => {
  const input = { model: 'local/model', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] }], temperature: 0, parallel_tool_calls: false };
  assert.deepEqual(parseRequestBody(JSON.stringify(input)), input);
});
test('invalid JSON and malformed request fields fail before studio dispatch', () => {
  for (const value of ['{', '[]', '{}', '{"model":"m","messages":[]}', '{"model":"m","messages":[{"role":"root","content":"x"}]}', '{"model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":0}']) assert.throws(() => parseRequestBody(value));
});
test('unknown usage and latency remain unknown and provider zero usage is real', () => {
  assert.match(requestMetrics({}), /用量未知/); assert.match(requestMetrics({}), /耗时未知/);
  assert.match(requestMetrics({ usage: { total_tokens: 0 }, durationMs: 0 }), /实际 0 tokens · 0.00 s/);
  assert.match(requestMetrics({ usage: { prompt_tokens: 7, completion_tokens: 4 }, durationMs: 200 }), /实际 11 tokens · 0.20 s/);
  assert.match(requestMetrics({ usage: { prompt_tokens: 7 } }), /用量未知/);
});
test('request diff ignores key order, reports array reorder, added and removed fields', () => {
  assert.deepEqual(requestDifferences({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
  const diff = requestDifferences({ messages: ['a', 'b'], temperature: 1 }, { messages: ['b', 'a'], max_tokens: 20 });
  assert.deepEqual(diff.map(row => row.path), ['$.messages[0]', '$.messages[1]', '$.temperature', '$.max_tokens']);
  assert.equal(diff[2].after, undefined); assert.equal(diff[3].before, undefined);
});
test('incremental request pages deduplicate updates and show newest first', () => {
  const first = { id: 'a', createdAt: '2026-10-08T01:00:00Z', status: 'running' } as RequestRecord;
  const next = { id: 'b', createdAt: '2026-10-08T02:00:00Z', status: 'draft' } as RequestRecord;
  const result = mergeRequestPages([first], [{ ...first, status: 'completed' }, next]);
  assert.deepEqual(result.map(row => row.id), ['b', 'a']); assert.equal(result[1].status, 'completed');
});
test('conversation switching preserves independent text and attachment drafts', () => {
  const drafts = new ConversationDrafts(), attachments = ['F:/one.txt'];
  drafts.set('a', { text: 'first', attachments }); attachments.push('F:/two.txt');
  drafts.set('b', { text: 'second', attachments: [] });
  assert.deepEqual(drafts.get('a'), { text: 'first', attachments: ['F:/one.txt'] });
  drafts.clear('a'); assert.equal(drafts.get('b').text, 'second'); assert.equal(drafts.dirty, true);
  drafts.clear('b'); assert.equal(drafts.dirty, false);
});
