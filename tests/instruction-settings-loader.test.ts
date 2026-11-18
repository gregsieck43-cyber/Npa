import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { installationVolume, isLocalPath } from '../src/app/local-paths.js';
import {
  INSTRUCTION_FILE_LIMIT_BYTES, SKILL_DISCOVERY_LIMITS, discoverSkills, loadInstructions, readBoundedText,
} from '../src/runtime/instructions.js';
import { assertProjectFixtureRoot, projectRoot } from './project-boundary.js';

/**
 * The instruction surface in one place: the bounded read primitive every instruction and skill
 * goes through, bounded skill discovery with restart-stable ids, and disable switches that really
 * remove a skill from the injected text instead of hiding it in the UI.
 */

const project = projectRoot(), tempRoot = path.join(project, '.tmp');
const LOCAL_VOLUME = /volume that hosts this installation|installation volume|outside the installation volume/i;

/** An owned fixture directory inside this checkout; nothing outside it is written or removed. */
function owned(t: TestContext, prefix: string): string {
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, prefix));
  assertProjectFixtureRoot(root);
  t.after(() => {
    const relative = path.relative(tempRoot, root);
    assert.ok(relative.startsWith(prefix) && !relative.includes(path.sep) && !path.isAbsolute(relative),
      'Only the owned fixture may be removed.');
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  });
  return root;
}

/** A leaf on a drive that is not the installation volume; the test never writes there. */
function offVolume(leaf: string): string {
  const installed = installationVolume().slice(0, 2).toUpperCase();
  const other = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'].find(candidate => candidate !== installed);
  assert.ok(other, 'An off-volume fixture drive is required to test path rejection.');
  return other + '\npn-instruction-settings-' + leaf;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const write = (filename: string, contents: string | Buffer): string => {
  mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, contents); return filename;
};
const skillDocument = (name: string, description: string, body: string) => '---\nname: ' + name + '\ndescription: ' + description + '\n---\n' + body;

test('instruction reads are bounded and distinguish missing files from unreadable text', async t => {
  const root = owned(t, 'instruction-reads-'), workspace = path.join(root, 'workspace');
  mkdirSync(workspace);
  const note = write(path.join(root, 'note.md'), 'Bounded instruction text.');
  const loaded = await readBoundedText(note);
  assert.equal(loaded.status, 'loaded');
  assert.equal(loaded.path.toLowerCase(), realpathSync(note).toLowerCase());
  assert.equal(loaded.bytes, Buffer.byteLength('Bounded instruction text.'));
  assert.equal(loaded.sha256, sha256('Bounded instruction text.'));

  const absent = path.join(root, 'absent.md');
  assert.deepEqual(await readBoundedText(absent), { status: 'missing', path: absent });
  assert.equal(INSTRUCTION_FILE_LIMIT_BYTES, 131_072, 'The bound is 128 KiB, not an approximate character count.');

  const rejected: [string, string | Buffer, RegExp][] = [
    ['binary.md', Buffer.from([0x41, 0x00, 0x42]), /NUL/i],
    ['invalid.md', Buffer.from([0xc3, 0x28]), /UTF-8/i],
    ['oversized.md', 'x'.repeat(INSTRUCTION_FILE_LIMIT_BYTES + 1), /128 KiB/],
  ];
  for (const [name, contents, pattern] of rejected) {
    const result = await readBoundedText(write(path.join(root, name), contents));
    assert.equal(result.status, 'error', name + ' must not load as instructions');
    assert.match((result as { error: string }).error, pattern, name);
  }
  const exact = await readBoundedText(write(path.join(root, 'exact.md'), 'y'.repeat(INSTRUCTION_FILE_LIMIT_BYTES)));
  assert.equal(exact.status, 'loaded');
  assert.equal(exact.bytes, INSTRUCTION_FILE_LIMIT_BYTES, 'A file exactly at the bound still loads');

  const foreign = await readBoundedText(offVolume('AGENTS.md'));
  assert.equal(foreign.status, 'error');
  assert.match((foreign as { error: string }).error, LOCAL_VOLUME);

  // The loader shares the primitive: a missing global path is skipped, the same unreadable text is refused.
  await assert.rejects(loadInstructions({ workspace, globalPaths: [absent, path.join(root, 'oversized.md')], query: '' }), /128 KiB/);
  await assert.rejects(loadInstructions({ workspace, globalPaths: [path.join(root, 'binary.md')], query: '' }), /NUL/i);
  const loadedSources = await loadInstructions({ workspace, globalPaths: [absent, note, path.join(root, 'exact.md')], query: '' });
  assert.deepEqual(loadedSources.sources.filter(source => source.kind === 'global').map(source => source.path.toLowerCase()),
    [realpathSync(note), realpathSync(path.join(root, 'exact.md'))].map(value => value.toLowerCase()));
});

test('skill discovery stays inside explicit roots and gives each skill a stable path-derived id', async t => {
  const root = owned(t, 'skill-discovery-'), skills = path.join(root, 'skills');
  const mathText = skillDocument('math', 'arithmetic calculations', 'Show arithmetic evidence.');
  write(path.join(skills, 'math', 'SKILL.md'), mathText);
  write(path.join(skills, 'cooking', 'SKILL.md'), skillDocument('cooking', 'recipe selection', 'Recipes.'));
  write(path.join(skills, 'deep', 'one', 'two', 'SKILL.md'), skillDocument('too-deep', 'depth limit', 'Never discovered.'));
  write(path.join(skills, '.hidden', 'SKILL.md'), skillDocument('hidden', 'hidden directory', 'Never discovered.'));

  const discovered = await discoverSkills({ skillRoots: [skills] });
  assert.deepEqual(discovered.map(skill => skill.name).sort(), ['cooking', 'math']);
  const math = discovered.find(skill => skill.name === 'math')!;
  assert.equal(math.sha256, sha256(mathText));
  assert.equal(math.bytes, Buffer.byteLength(mathText));
  assert.equal(math.root.toLowerCase(), realpathSync(skills).toLowerCase());
  assert.match(math.id, /^skill-[0-9a-f]{32}$/);
  assert.deepEqual((await discoverSkills({ skillRoots: [skills] })).map(skill => skill.id), discovered.map(skill => skill.id),
    'A fresh discovery returns the same ids');

  write(path.join(skills, 'math', 'SKILL.md'), mathText + '\nRewritten body.');
  assert.equal((await discoverSkills({ skillRoots: [skills] })).find(skill => skill.name === 'math')!.id, math.id,
    'The id follows the resolved path, so editing a skill keeps its switch');
  assert.deepEqual(await discoverSkills({ skillRoots: [path.join(root, 'absent')] }), [], 'A missing root is skipped, not an error');
});

test('skill discovery enforces directory entry, skill count and total byte budgets', { timeout: 120_000 }, async t => {
  const root = owned(t, 'skill-budgets-');
  assert.deepEqual(SKILL_DISCOVERY_LIMITS, { directoryEntries: 2_000, skills: 500, totalBytes: 4 * 1024 * 1024, depth: 2 });

  const many = path.join(root, 'many');
  for (let index = 0; index <= SKILL_DISCOVERY_LIMITS.skills; index++) {
    write(path.join(many, 's' + index, 'SKILL.md'), skillDocument('s' + index, 'budget fixture', 'body'));
  }
  await assert.rejects(discoverSkills({ skillRoots: [many] }), /more than 500 SKILL\.md/i);

  const heavy = path.join(root, 'heavy');
  for (let index = 0; index <= 32; index++) write(path.join(heavy, 'h' + index, 'SKILL.md'), 'z'.repeat(INSTRUCTION_FILE_LIMIT_BYTES));
  await assert.rejects(discoverSkills({ skillRoots: [heavy] }), /4 MiB/i);

  const crowded = path.join(root, 'crowded');
  for (let index = 0; index <= SKILL_DISCOVERY_LIMITS.directoryEntries; index++) write(path.join(crowded, 'f' + index + '.txt'), 'x');
  await assert.rejects(discoverSkills({ skillRoots: [crowded] }), /more than 2000 entries/i);
});

test('an off-volume skill root is an explicit error and is never scanned', async t => {
  const root = owned(t, 'skill-escape-'), systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  if (!existsSync(systemRoot) || isLocalPath(systemRoot)) {
    t.diagnostic('No off-volume system directory is available as a junction target; the escape path is not exercised.');
    return;
  }
  const linked = path.join(root, 'linked-skills');
  try { symlinkSync(systemRoot, linked, 'junction'); }
  catch { t.diagnostic('This machine cannot create a junction for the fixture.'); return; }
  try {
    assert.equal(realpathSync(linked).toLowerCase(), path.resolve(systemRoot).toLowerCase());
    await assert.rejects(discoverSkills({ skillRoots: [linked] }), LOCAL_VOLUME);
    await assert.rejects(loadInstructions({ workspace: root, skillRoots: [linked], query: '' }), LOCAL_VOLUME);
    const escaped = await readBoundedText(linked);
    assert.equal(escaped.status, 'error');
    assert.match((escaped as { error: string }).error, LOCAL_VOLUME);
  } finally { unlinkSync(linked); }
});

test('disabled skill ids are never selected or injected while global and project precedence is unchanged', async t => {
  const root = owned(t, 'instruction-priority-'), workspace = path.join(root, 'project'), skills = path.join(root, 'skills');
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  const globalPath = write(path.join(root, 'global.md'), 'GLOBAL RULE FIXTURE');
  write(path.join(workspace, 'AGENTS.md'), 'PROJECT RULE FIXTURE');
  write(path.join(workspace, 'src', 'AGENTS.md'), 'NEARER RULE FIXTURE');
  const skillText = skillDocument('math', 'arithmetic calculations', 'SKILL BODY FIXTURE');
  write(path.join(skills, 'math', 'SKILL.md'), skillText);

  const options = { workspace, globalPaths: [globalPath], skillRoots: [skills], query: '$math calculation', targetPath: 'src/example.ts' };
  const enabled = await loadInstructions(options);
  const fixtureSources = enabled.sources.filter(source => source.path.startsWith(root));
  assert.deepEqual(fixtureSources.map(source => source.kind), ['global', 'project', 'project', 'skill'],
    'Global instructions precede the ancestor chain and the nearer project file is appended last');
  assert.ok(enabled.text.indexOf('PROJECT RULE FIXTURE') < enabled.text.indexOf('NEARER RULE FIXTURE'));
  const skill = enabled.skills.find(item => item.name === 'math')!;
  assert.equal(skill.selected, true);
  assert.equal(skill.sha256, sha256(skillText));
  assert.match(skill.id, /^skill-[0-9a-f]{32}$/);
  assert.ok(enabled.text.includes('SKILL BODY FIXTURE'));

  const disabled = await loadInstructions({ ...options, disabledSkillIds: [skill.id] });
  assert.equal(disabled.skills.find(item => item.name === 'math')!.selected, false, 'A disabled skill is still listed but never selected');
  assert.equal(disabled.text.includes('SKILL BODY FIXTURE'), false);
  assert.equal(disabled.sources.some(source => source.kind === 'skill'), false);
  assert.deepEqual(disabled.sources.filter(source => source.path.startsWith(root)).map(source => source.kind), ['global', 'project', 'project']);
  assert.equal(disabled.sources.find(source => source.path.toLowerCase() === realpathSync(globalPath).toLowerCase())!.sha256, sha256('GLOBAL RULE FIXTURE'));
});
