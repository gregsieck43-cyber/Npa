// 新前端测试：类型检查 → esbuild 打包 src/frontend/tests/*.test.ts → node --test。
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { assertGeneratedPath } from './project-paths.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outdir = path.join(root, 'build', 'frontend-tests');
const run = args => spawnSync(process.execPath, args, { stdio: 'inherit', cwd: root }).status ?? 1;

for (const project of ['src/frontend/tsconfig.json', 'src/frontend/tests/tsconfig.json']) {
  const status = run(['node_modules/typescript/bin/tsc', '-p', project]);
  if (status !== 0) process.exit(status);
}
rmSync(assertGeneratedPath(outdir, ['build', 'frontend-tests']), { recursive: true, force: true });
const entries = readdirSync(path.join(root, 'src/frontend/tests')).filter(name => name.endsWith('.test.ts')).map(name => `src/frontend/tests/${name}`);
// 测试包按真实 bridge 语义构建：动作层测试需要 window.npn，而不是 mock 网关。
await build({ absWorkingDir: root, entryPoints: entries, outdir, bundle: true, platform: 'node', format: 'esm', target: 'node24', outExtension: { '.js': '.mjs' }, define: { __NPN_GATEWAY__: '"bridge"' }, logLevel: 'warning' });
process.exit(run(['--test', ...readdirSync(outdir).map(name => path.join(outdir, name))]));
