import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertGeneratedPath, projectRoot } from './project-paths.mjs';

export async function buildIde() {
  const directory = assertGeneratedPath(path.join(projectRoot(), 'build', 'ide-extension'), ['build', 'ide-extension']);
  mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(readFileSync('ide/extension/package.json', 'utf8'));
  manifest.version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest, null, 2));
  cpSync('ide/extension/media', path.join(directory, 'media'), { recursive: true });
  cpSync('ide/extension/README.md', path.join(directory, 'README.md'));
  cpSync('ide/extension/themes', path.join(directory, 'themes'), { recursive: true });
  cpSync('assets/brand/logo-128.png', path.join(directory, 'media', 'npn-logo.png'));
  // The CJS extension bundle intentionally falls back from import.meta to __filename (local-paths.ts);
  // the empty import.meta warning is expected for both bundles and silenced here.
  await build({ entryPoints: ['ide/extension/ui/index.ts'], bundle: true, platform: 'browser', target: 'chrome140', outfile: path.join(directory, 'media', 'agent-ui.js'), logOverride: { 'empty-import-meta': 'silent' } });
  await build({ entryPoints: ['ide/extension/src/extension.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: path.join(directory, 'extension.cjs'), external: ['vscode'], logOverride: { 'empty-import-meta': 'silent' } });
  console.log(`Built NPN IDE extension ${manifest.version}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await buildIde();
