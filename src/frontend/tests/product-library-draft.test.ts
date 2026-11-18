import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRequestFile, requestObject, REQUEST_IMPORT_BYTES, downloadJson } from '../features/inspector/request-draft';
import { versionDiff } from '../features/inspector/version-diff';

test('request import preserves provider extras, ordered roles and nested message metadata', async () => {
  const value = { model: 'model', messages: [{ role: 'developer', content: 'policy', cache_control: { type: 'ephemeral' } }, { role: 'user', content: 'question' }], provider_options: { mode: 'custom' } };
  const imported = await readRequestFile(new File([JSON.stringify(value)], 'request.json'));
  assert.deepEqual(imported, value);
});

test('request import rejects malformed JSON and non-object JSON without model calls', async () => {
  await assert.rejects(readRequestFile(new File(['{broken'], 'broken.json')), SyntaxError);
  for (const value of ['null', '[]', 'false', '42', '"body"']) assert.throws(() => requestObject(value), /JSON 对象/);
});

test('oversize import rejects before reading file content', async () => {
  let read = false;
  const file = { size: REQUEST_IMPORT_BYTES + 1, text: async () => { read = true; return '{}'; } } as File;
  await assert.rejects(readRequestFile(file), /1 MiB/);
  assert.equal(read, false);
});

test('download byte boundary is enforced before touching the DOM', () => {
  assert.throws(() => downloadJson('large.json', { value: '界'.repeat(100) }, 200), /导出大小限制/);
});

test('saved version diff refuses unbounded LCS allocation but compares ordinary bodies', () => {
  assert.equal(versionDiff('x\n'.repeat(2000), 'y\n'.repeat(2000)), undefined);
  assert.equal(versionDiff('x'.repeat(512 * 1024), 'y'), undefined);
  assert.deepEqual(versionDiff('old', 'new')?.map(line => line.kind), ['del', 'add']);
});
