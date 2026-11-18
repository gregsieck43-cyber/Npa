import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicUrl } from '../src/network/url-policy.js';
test('public page URLs do not persist or send credential parameters', () => {
  for (const key of ['api_key', 'access-token', 'authorization', 'password', 'secret']) assert.throws(() => parsePublicUrl(`https://example.org/page?${key}=fixture-only`), /Credential/);
  assert.equal(parsePublicUrl('https://example.org/search?q=SQLite').searchParams.get('q'), 'SQLite');
});
