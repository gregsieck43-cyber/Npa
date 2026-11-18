import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { skillTool, SkillToolError, SKILL_PAGE_LIMITS } from '../src/runtime/skill-tools.js';
import { INSTRUCTION_FILE_LIMIT_BYTES, readBoundedText } from '../src/runtime/instructions.js';

const ROOT = path.resolve('.tmp/skills-discovery-20261104/unit');
function fixture(t: TestContext) {
  mkdirSync(ROOT, { recursive: true });
  const owned = mkdtempSync(path.join(ROOT, 'skills-')), workspace = path.join(owned, 'workspace'), skillRoot = path.join(owned, 'global-skills');
  mkdirSync(workspace); mkdirSync(skillRoot);
  t.after(() => { assert.equal(path.dirname(owned), ROOT); rmSync(owned, { recursive: true, force: true }); });
  const write = (name: string, body = 'PROCEDURE_BODY_' + name, description = 'Task workflow instructions') => {
    const file = path.join(skillRoot, name, 'SKILL.md'); mkdirSync(path.dirname(file), { recursive: true });
    const text = `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
    writeFileSync(file, text); return { file, text };
  };
  const options = { workspace, skillRoots: [skillRoot] };
  const list = async (args: Record<string, unknown> = {}) => JSON.parse(await skillTool(options, { name: 'list_skills', arguments: args }));
  return { owned, options, write, list };
}
const code = (value: string) => (error: unknown) => error instanceof SkillToolError && error.code === value;

test('500-skill catalog pages are metadata-only, UTF-8 byte bounded and stable without a retained cache', async t => {
  const f = fixture(t);
  for (let i = 0; i < 500; i++) f.write(`procedure-${String(i).padStart(3, '0')}`, 'SECRET_BODY_FOR_TEST_NOT_METADATA', '适用于整理记录与复核依据。'.repeat(60));
  const seen = new Set<string>(); let cursor: string | undefined, pages = 0;
  do {
    const page = await f.list({ limit: 20, ...(cursor ? { cursor } : {}) });
    const encoded = JSON.stringify(page);
    assert.ok(Buffer.byteLength(encoded, 'utf8') <= SKILL_PAGE_LIMITS.metadataBytes);
    assert.equal(encoded.includes('SECRET_BODY_FOR_TEST_NOT_METADATA'), false);
    assert.equal(page.total, 500); assert.ok(page.skills.length > 0 && page.skills.length <= 20);
    for (const item of page.skills) { assert.equal(seen.has(item.id), false); seen.add(item.id); assert.match(item.sha256, /^[a-f0-9]{64}$/); }
    cursor = page.nextCursor ?? undefined; pages++;
    assert.ok(pages <= 500);
  } while (cursor);
  assert.equal(seen.size, 500);
  const initial = await f.list({ limit: 1 });
  const reopened = JSON.parse(await skillTool({ ...f.options, skillRoots: [...f.options.skillRoots] }, { name: 'list_skills', arguments: { limit: 1 } }));
  assert.deepEqual(reopened, initial, 'fresh invocations have stable ids/snapshot without a process-owned token cache');
  f.write('overflow');
  await assert.rejects(f.list(), /More than 500/);
});

test('body pages bind id, SHA, configured roots, workspace and disabled settings; changed pages fail explicitly', async t => {
  const f = fixture(t), source = f.write('table-workflow', '步骤😀引用\n'.repeat(1200));
  const listed = await f.list(), item = listed.skills[0];
  const args = { id: item.id, sha256: item.sha256, scope: listed.scope };
  let offset = 0, reconstructed = '', pages = 0;
  for (;;) {
    const page = JSON.parse(await skillTool(f.options, { name: 'read_skill', arguments: { ...args, offset, limit: 997 } }));
    assert.equal(page.sha256, item.sha256); assert.equal(page.guidanceOnly, true); assert.ok(page.content.length <= 997);
    reconstructed += page.content; pages++;
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  assert.ok(pages > 1); assert.equal(reconstructed, source.text);
  await assert.rejects(skillTool({ ...f.options, workspace: path.join(f.owned, 'other-project') }, { name: 'read_skill', arguments: args }), code('SKILL_SCOPE_STALE'));
  await assert.rejects(skillTool({ ...f.options, skillRoots: [] }, { name: 'read_skill', arguments: args }), code('SKILL_SCOPE_STALE'));
  await assert.rejects(skillTool({ ...f.options, disabledSkillIds: [item.id] }, { name: 'read_skill', arguments: args }), code('SKILL_SCOPE_STALE'));
  await assert.rejects(skillTool({ ...f.options, enabled: false }, { name: 'read_skill', arguments: args }), code('SKILLS_DISABLED'));
  const off = JSON.parse(await skillTool({ ...f.options, disabledSkillIds: [item.id] }, { name: 'list_skills', arguments: {} }));
  assert.deepEqual(off.skills, []);
  await assert.rejects(skillTool({ ...f.options, disabledSkillIds: [item.id] }, { name: 'read_skill', arguments: { ...args, scope: off.scope } }), code('SKILL_NOT_FOUND'));
  writeFileSync(source.file, source.text + '\nnew revision');
  await assert.rejects(skillTool(f.options, { name: 'read_skill', arguments: { ...args, offset: 997 } }), code('SKILL_SOURCE_CHANGED'));
  rmSync(source.file);
  await assert.rejects(skillTool(f.options, { name: 'read_skill', arguments: args }), code('SKILL_NOT_FOUND'));
});

test('catalog cursors refuse mutations and malformed requests never grant arbitrary path access', async t => {
  const f = fixture(t); f.write('one'); const two = f.write('two');
  const first = await f.list({ limit: 1 }); assert.ok(first.nextCursor);
  writeFileSync(two.file, two.text + '\nchanged');
  await assert.rejects(f.list({ cursor: first.nextCursor }), code('SKILL_SNAPSHOT_STALE'));
  for (const limit of [0, -1, 21, 0.5, Infinity]) await assert.rejects(f.list({ limit }), code('SKILL_PAGE_INVALID'));
  for (const cursor of ['', '!', 'e30', 'x'.repeat(1025)]) await assert.rejects(f.list({ cursor }), /SKILL_CURSOR_INVALID|SKILL_SNAPSHOT_STALE/);
  await assert.rejects(f.list({ path: path.join(f.owned, 'outside.md') }), code('SKILL_ARGUMENT_INVALID'));
  for (const args of [null, false, [], 'path']) await assert.rejects(f.list(args as unknown as Record<string, unknown>), code('SKILL_ARGUMENT_INVALID'));
  const page = await f.list(), item = page.skills[0], args = { scope: page.scope, id: item.id, sha256: item.sha256 };
  await assert.rejects(skillTool(f.options, { name: 'read_skill', arguments: { ...args, path: 'outside.md' } }), code('SKILL_ARGUMENT_INVALID'));
  await assert.rejects(skillTool(f.options, { name: 'read_skill', arguments: { ...args, offset: -1 } }), code('SKILL_PAGE_INVALID'));
  await assert.rejects(skillTool(f.options, { name: 'read_skill', arguments: { ...args, limit: 4001 } }), code('SKILL_PAGE_INVALID'));
  const outside = path.join(f.owned, 'outside.md'); writeFileSync(outside, 'outside procedure data');
  const rejected = await readBoundedText(outside, INSTRUCTION_FILE_LIMIT_BYTES, f.options.skillRoots[0]);
  assert.equal(rejected.status, 'error');
  if (rejected.status === 'error') assert.match(rejected.error, /outside its configured root/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(skillTool({ ...f.options, signal: controller.signal }, { name: 'list_skills', arguments: {} }), { name: 'AbortError' });
});

test('directory-entry discovery budget covers the whole tree, including directories without skills', async t => {
  const f = fixture(t), root = f.options.skillRoots[0]!;
  for (let parent = 0; parent < 3; parent++) {
    const directory = path.join(root, `section-${parent}`); mkdirSync(directory);
    for (let index = 0; index < 700; index++) writeFileSync(path.join(directory, `note-${index}.txt`), 'ordinary metadata fixture');
  }
  await assert.rejects(f.list(), /2000.*entries/);
});
