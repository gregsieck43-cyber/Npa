import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadInstructions } from '../src/runtime/instructions.js';
import { buildContext } from '../src/runtime/context.js';

test('configured global, ancestor, nearer instructions and relevant skills retain source hashes', async () => {
  const temp = await mkdtemp(path.join(process.cwd(), '.tmp', 'runtime-instructions-'));
  const workspace = path.join(temp, 'project'); const skills = path.join(temp, 'skills');
  try {
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await mkdir(path.join(skills, 'math'), { recursive: true }); await mkdir(path.join(skills, 'unrelated'), { recursive: true });
    await writeFile(path.join(temp, 'global.md'), 'Global configured rule: answer clearly.');
    await writeFile(path.join(workspace, 'AGENTS.md'), 'Project rule: use tabs.'); await writeFile(path.join(workspace, 'src', 'AGENTS.md'), 'Nearer src rule: use two spaces.');
    await writeFile(path.join(skills, 'math', 'SKILL.md'), '---\nname: math\ndescription: arithmetic calculations\n---\nShow arithmetic evidence.');
    await writeFile(path.join(skills, 'unrelated', 'SKILL.md'), '---\nname: cooking\ndescription: recipe selection\n---\nRecipes.');
    const loaded = await loadInstructions({ workspace, globalPaths: [path.join(temp, 'global.md'), path.join(temp, 'global.md')], skillRoots: [skills], query: '$math calculation', targetPath: 'src/example.ts' });
    const custom = loaded.sources.filter(source => source.path.startsWith(temp));
    assert.equal(custom.length, 4); assert.equal(custom[0]?.kind, 'global'); assert.equal(custom[3]?.kind, 'skill');
    assert.match(loaded.text, /Nearer src rule/); assert.equal(loaded.skills.filter(skill => skill.selected).length, 1); assert.ok(custom.every(source => source.sha256.length === 64));
    const context = buildContext({ messages: [], role: 'main', goal: { objective: 'calculate', constraints: [], acceptance: [], maxModelCalls: 4, mode: 'autonomous' }, instructions: loaded, maxChars: 64_000 });
    assert.match(context.messages[0]!.content!, /Nearer src rule/); assert.equal(context.instructionSources.length, loaded.sources.length);
    await assert.rejects(loadInstructions({ workspace, globalPaths: ['C:\\unrelated\\AGENTS.md'], query: '' }), /volume that hosts this installation|installation volume/i);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
