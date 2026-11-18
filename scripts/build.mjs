import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { build } from 'esbuild';
import path from 'node:path';
import { removeGeneratedPath } from './project-paths.mjs';
import { buildResourceBudget } from './build-resource-budget.mjs';
removeGeneratedPath(path.resolve('build'), ['build']);
const check = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status ?? 1);
buildResourceBudget();
// The Electron shell loads build/frontend/index.html and a shipped build must use the real bridge
// gateway, so the normal build owns that bundle. The legacy src/ui renderer is no longer built or
// shipped; its compiled models stay in build/src/ui because the existing UI tests still import them.
const frontend = spawnSync(process.execPath, ['scripts/build-frontend.mjs', '--gateway=bridge'], { stdio: 'inherit' });
if (frontend.status !== 0) process.exit(frontend.status ?? 1);
cpSync('assets', 'build/assets', { recursive: true });
// src/app/local-paths.ts intentionally falls back to __filename in the CommonJS bundle, so the
// empty import.meta object esbuild warns about is expected and silenced here instead of guarded.
await build({ entryPoints: ['src/desktop/main.ts'], bundle: true, outfile: 'build/desktop/main.cjs', platform: 'node', format: 'cjs', external: ['electron'], logOverride: { 'empty-import-meta': 'silent' } });
await build({ entryPoints: ['src/desktop/preload.ts'], bundle: true, outfile: 'build/desktop/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'] });
await (await import('./build-ide.mjs')).buildIde();
