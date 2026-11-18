import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ExternalTools } from '../src/app/external-tools.js';

test('explicit search configuration survives restart without changing an approved request', async () => {
  const directory = await mkdtemp(path.resolve('.tmp', 'web-settings-'));
  try {
    const options = { dataDir: path.join(directory, 'data'), projectRoot: process.cwd() };
    const external = new ExternalTools(options);
    const original = external.prepare({ name: 'web_search', arguments: { query: 'local regression' } })!;
    external.configureWeb({ searchProvider: 'searxng', searxUrl: 'https://search.example.org/' });
    const restarted = new ExternalTools(options);
    assert.deepEqual(restarted.webConfiguration(), { searchProvider: 'searxng', searxUrl: 'https://search.example.org/' });
    assert.equal((original.arguments.searchConfiguration as { searchProvider: string }).searchProvider, 'auto');
    assert.throws(() => restarted.configureWeb({ searchProvider: 'searxng', searxUrl: 'http://127.0.0.1' }), /private|local|IP|HTTPS/);
    assert.equal(new ExternalTools(options).webConfiguration().searchProvider, 'searxng');
    await external.close(); await restarted.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('corrupt optional network settings are visible without preventing ordinary startup', async () => {
  const directory = await mkdtemp(path.resolve('.tmp', 'web-settings-corrupt-'));
  try {
    const dataDir = path.join(directory, 'data'); await mkdir(dataDir);
    await writeFile(path.join(dataDir, 'web-settings.json'), '{broken');
    const external = new ExternalTools({ dataDir, projectRoot: process.cwd() });
    const view = external.webConfiguration() as { searchProvider: string; searchConfigurationError?: string };
    assert.match(view.searchConfigurationError ?? '', /invalid|repair/i);
    assert.equal(view.searchProvider, 'mwmbl');
    external.configureWeb({ searchProvider: 'wikipedia' });
    assert.equal((external.webConfiguration() as typeof view).searchConfigurationError, undefined);
    await external.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
