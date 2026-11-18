import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Configuration } from '../src/app/configuration.js';
import type { Services } from '../src/app/services.js';
import { startMockProvider } from '../src/fixtures/mock-provider.js';
import { ChatService, type ChatDependencies } from '../src/harness/chat.js';
import { customParts } from '../src/harness/prompts.js';
import { HarnessStore } from '../src/harness/store.js';
import type { RequestBody } from '../src/harness/types.js';
import { InstructionSettings } from '../src/runtime/instruction-settings.js';
import { loadInstructions } from '../src/runtime/instructions.js';
import { ModelClient, validateRequestBody } from '../src/runtime/model.js';
import { assertProjectFixtureRoot, projectRoot } from './project-boundary.js';

/**
 * The persisted settings layer: the disabled set is what the real loader and the real Chat wire use,
 * a restart keeps it, a corrupt file fails loudly, and the Settings listing reports exactly the files
 * the loader considers in injection order.
 */

const project = projectRoot(), tempRoot = path.join(project, '.tmp');
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

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

const write = (filename: string, contents: string | Buffer): string => {
  mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, contents); return filename;
};
const skillDocument = (name: string, description: string, body: string) => '---\nname: ' + name + '\ndescription: ' + description + '\n---\n' + body;

test('skill switches persist across restarts and an unknown id is refused', async t => {
  const root = owned(t, 'instruction-settings-'), dataDir = path.join(root, 'data'), skills = path.join(root, 'skills');
  write(path.join(skills, 'math', 'SKILL.md'), skillDocument('math', 'arithmetic calculations', 'MATH BODY'));
  write(path.join(skills, 'cooking', 'SKILL.md'), skillDocument('cooking', 'recipe selection', 'COOKING BODY'));

  const settings = new InstructionSettings({ dataDir });
  assert.deepEqual(settings.disabledSkillIds(), [], 'Nothing is disabled before the first toggle');
  const listed = await settings.listSkills({ skillRoots: [skills] });
  assert.deepEqual(listed.map(skill => [skill.name, skill.enabled]).sort(), [['cooking', true], ['math', true]]);
  assert.ok(listed.every(skill => skill.source.toLowerCase() === path.resolve(skills).toLowerCase()));
  assert.match(listed[0].id, /^skill-[0-9a-f]{32}$/);

  const math = listed.find(skill => skill.name === 'math')!;
  const off = await settings.toggleSkill(math.id, false, { skillRoots: [skills] });
  assert.deepEqual(off, { ...math, enabled: false });
  assert.deepEqual(settings.disabledSkillIds(), [math.id]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'instruction-settings.json'), 'utf8')),
    { version: 1, disabledSkillIds: [math.id] }, 'The disabled set is an explicit versioned JSON document');

  const restarted = new InstructionSettings({ dataDir });
  assert.deepEqual(restarted.disabledSkillIds(), [math.id], 'A restart keeps the switch');
  assert.equal((await restarted.listSkills({ skillRoots: [skills] })).find(skill => skill.id === math.id)!.enabled, false);

  const on = await restarted.toggleSkill(math.id, true, { skillRoots: [skills] });
  assert.equal(on.enabled, true);
  assert.deepEqual(new InstructionSettings({ dataDir }).disabledSkillIds(), []);

  await assert.rejects(restarted.toggleSkill('skill-' + '0'.repeat(32), false, { skillRoots: [skills] }), /unknown skill id/i);
  await assert.rejects(restarted.toggleSkill('', false, { skillRoots: [skills] }), /skill id/i);
  await assert.rejects(restarted.toggleSkill(math.id, false, { skillRoots: [path.join(root, 'absent')] }), /unknown skill id/i,
    'A skill outside the configured roots cannot be toggled');
  assert.deepEqual(restarted.disabledSkillIds(), [], 'A refused toggle writes nothing');
});

test('a corrupt skill switch file is reported instead of silently re-enabling every skill', async t => {
  const root = owned(t, 'instruction-settings-corrupt-'), dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'instruction-settings.json');

  for (const [contents, reason] of [
    ['{broken', /not valid JSON/i],
    ['[]', /root value must be an object/i],
    [JSON.stringify({ version: 2, disabledSkillIds: [] }), /unsupported version/i],
    [JSON.stringify({ version: 1, disabledSkillIds: 'all' }), /array/i],
    [JSON.stringify({ version: 1, disabledSkillIds: Array.from({ length: 2001 }, (_value, index) => 'skill-' + index) }), /more than 2000/i],
    [JSON.stringify({ version: 1, disabledSkillIds: ['x'.repeat(201)] }), /200 characters/i],
    [JSON.stringify({ version: 1, disabledSkillIds: [7] }), /string/i],
  ] as const) {
    writeFileSync(file, contents);
    assert.throws(() => new InstructionSettings({ dataDir }), reason, contents.slice(0, 40));
    assert.equal(readFileSync(file, 'utf8'), contents, 'A corrupt file is left untouched for diagnosis');
  }
  writeFileSync(file, 'x'.repeat(70 * 1024));
  assert.throws(() => new InstructionSettings({ dataDir }), /64.*byte|larger than/i);
});

test('instruction listings report loaded, missing and error states in injection order', async t => {
  const root = owned(t, 'instruction-listing-'), dataDir = path.join(root, 'data');
  const one = path.join(root, 'project-one'), two = path.join(root, 'project-two'), three = path.join(root, 'project-three');
  mkdirSync(one); mkdirSync(two); mkdirSync(three);
  const globalLoaded = write(path.join(root, 'global.md'), 'GLOBAL LISTING FIXTURE');
  const globalMissing = path.join(root, 'absent-global.md');
  const globalBinary = write(path.join(root, 'binary-global.md'), Buffer.from([0x41, 0x00, 0x42]));
  write(path.join(root, 'AGENTS.md'), 'ANCESTOR FIXTURE THAT MUST NOT BE LISTED');
  write(path.join(one, 'AGENTS.md'), 'PROJECT ONE AGENTS');
  write(path.join(two, 'agent.md'), 'PROJECT TWO LOWER CASE AGENT');

  const options = { globalPaths: [globalLoaded, globalMissing, globalBinary], projects: [{ id: 'p1', path: one }, { id: 'p2', path: two }, { id: 'p3', path: three }] };
  const settings = new InstructionSettings({ dataDir });
  const files = await settings.listInstructionFiles(options);
  assert.deepEqual(files.map(file => [file.order, file.scope, file.status, file.projectId ?? null]), [
    [1, 'global', 'loaded', null], [2, 'global', 'missing', null], [3, 'global', 'error', null],
    [4, 'project', 'loaded', 'p1'], [5, 'project', 'loaded', 'p2'],
  ]);
  assert.ok(files.every(file => /^instruction-[0-9a-f]{32}$/.test(file.id)));
  assert.equal(new Set(files.map(file => file.id)).size, files.length);
  assert.equal(files.some(file => file.path === path.join(root, 'AGENTS.md')), false, 'Ancestor instruction files are never listed');
  assert.equal(files[0].bytes, Buffer.byteLength('GLOBAL LISTING FIXTURE'));
  assert.equal(files[0].sha256, sha256('GLOBAL LISTING FIXTURE'));
  assert.equal(files[1].bytes, undefined);
  assert.match(files[2].error!, /NUL/i);

  const loaded = await loadInstructions({ workspace: one, globalPaths: [globalLoaded], query: '' });
  const source = loaded.sources.find(item => item.kind === 'global')!;
  assert.equal(source.sha256, files[0].sha256, 'The listing and the loader share one read primitive');
  assert.equal(source.path.toLowerCase(), files[0].path.toLowerCase());
  assert.ok(loaded.text.indexOf('GLOBAL LISTING FIXTURE') < loaded.text.indexOf('PROJECT ONE AGENTS'));

  const restarted = new InstructionSettings({ dataDir });
  assert.deepEqual((await restarted.listInstructionFiles(options)).map(file => file.id), files.map(file => file.id),
    'Listing ids are stable across restarts');
});

test('a skill switch changes the next real Chat request body and survives a restart', { timeout: 30000 }, async t => {
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, 'instruction-settings-wire-'));
  assertProjectFixtureRoot(root);
  const dataDir = path.join(root, 'data'), workspace = path.join(root, 'workspace'), skills = path.join(root, 'skills');
  mkdirSync(workspace);
  write(path.join(skills, 'math', 'SKILL.md'), skillDocument('math', 'arithmetic calculations', 'SKILL_WIRE_FIXTURE'));

  const wire: RequestBody[] = [];
  const provider = await startMockProvider({ trace: body => wire.push(body) });
  mkdirSync(path.join(root, 'store'));
  const store = new HarnessStore(path.join(root, 'store'));
  const configuration = new Configuration(provider.url);
  configuration.skillRoots = [skills];
  let settings = new InstructionSettings({ dataDir });
  const dependencies: ChatDependencies = {
    store, configuration,
    services: { projectRoot: workspace } as unknown as Services,
    profileConfig: () => configuration.provider,
    getPromptParts: session => customParts(store, session),
    prepareModel: (context, body, sources) => {
      validateRequestBody(body, configuration.provider);
      return store.createRequest({ ...context, profileId: context.profileId ?? 'default', status: 'draft', endpoint: provider.url + '/chat/completions',
        body, bodyHash: sha256(JSON.stringify(body)), sources, recordContent: true, draft: '' });
    },
    sendPrepared: async (requestId, body, signal) => {
      store.updateRequest(requestId, { status: 'running' });
      const result = await new ModelClient(configuration.provider).completeRaw(body!, signal);
      store.updateRequest(requestId, { status: 'completed', response: result, usage: result.usage }); return result;
    },
    disabledSkillIds: () => settings.disabledSkillIds(),
  };
  const chat = new ChatService(dependencies);
  // One cleanup hook: the store and the provider must be closed before the fixture directory can be removed.
  t.after(async () => {
    await chat.stop(); await provider.close(); store.close();
    const relative = path.relative(tempRoot, root);
    assert.ok(relative.startsWith('instruction-settings-wire-') && !relative.includes(path.sep) && !path.isAbsolute(relative),
      'Only the owned fixture may be removed.');
    rmSync(root, { recursive: true, force: true });
  });
  const settle = async (sessionId: string) => {
    const deadline = performance.now() + 10_000;
    while (chat.sessionView(sessionId).activeRequestId && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(chat.sessionView(sessionId).activeRequestId, undefined, 'Chat did not settle within the fixture deadline');
  };
  const session = store.createSession({ title: 'Settings wire', workspace, capabilities: { tools: false, web: false, mcp: false, skills: true, projectInstructions: false } });

  await chat.send({ sessionId: session.id, content: 'Use $math please' }); await settle(session.id);
  assert.ok(JSON.stringify(wire.at(-1)).includes('SKILL_WIRE_FIXTURE'), 'An enabled skill enters the actual request body');
  const math = (await settings.listSkills({ skillRoots: [skills] })).find(skill => skill.name === 'math')!;
  assert.equal(math.enabled, true);

  const off = await settings.toggleSkill(math.id, false, { skillRoots: [skills] });
  assert.equal(off.enabled, false);
  settings = new InstructionSettings({ dataDir });
  assert.deepEqual(settings.disabledSkillIds(), [math.id]);
  await chat.send({ sessionId: session.id, content: 'Use $math again' }); await settle(session.id);
  assert.equal(JSON.stringify(wire.at(-1)).includes('SKILL_WIRE_FIXTURE'), false, 'A disabled skill is absent from the next request body');
  assert.ok(JSON.stringify(wire.at(-2)).includes('SKILL_WIRE_FIXTURE'));
  assert.equal((await settings.listSkills({ skillRoots: [skills] })).find(skill => skill.id === math.id)!.enabled, false);

  await settings.toggleSkill(math.id, true, { skillRoots: [skills] });
  await chat.send({ sessionId: session.id, content: 'Use $math once more' }); await settle(session.id);
  assert.ok(JSON.stringify(wire.at(-1)).includes('SKILL_WIRE_FIXTURE'), 'Re-enabling restores the skill in the next request body');
});
