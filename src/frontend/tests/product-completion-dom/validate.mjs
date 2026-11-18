import { build } from 'esbuild';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../../..');
const out = path.join(root, '.tmp/product-completion-ui/frontend-tests');
const evidence = path.join(root, 'evidence/backend-20261026/product-completion-ui-20261030');
mkdirSync(out, { recursive: true }); mkdirSync(evidence, { recursive: true });
const results = [];
function run(name, args) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: process.env, maxBuffer: 10 * 1024 * 1024 });
  writeFileSync(path.join(evidence, `${name}.txt`), (result.stdout ?? '') + (result.stderr ?? ''));
  results.push({ name, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, error: result.error?.message });
  console.log(`${name}: ${result.status}`);
  return result.status === 0;
}
let ok = run('frontend-typecheck', ['node_modules/typescript/bin/tsc', '-p', 'src/frontend/tsconfig.json']);
ok = run('frontend-test-typecheck', ['node_modules/typescript/bin/tsc', '-p', 'src/frontend/tests/tsconfig.json']) && ok;
if (ok) {
  const entries = readdirSync(path.join(root, 'src/frontend/tests')).filter(file => file.endsWith('.test.ts')).map(file => path.join(root, 'src/frontend/tests', file));
  await build({ absWorkingDir: root, entryPoints: entries, outdir: out, bundle: true, platform: 'node', format: 'esm', target: 'node24', outExtension: { '.js': '.mjs' }, define: { __NPN_GATEWAY__: '"bridge"' }, logLevel: 'warning' });
  ok = run('frontend-tests', ['--test', ...entries.map(file => path.join(out, path.basename(file).replace(/\.ts$/, '.mjs')))]) && ok;
}
ok = run('lint', ['scripts/lint.mjs']) && ok;
writeFileSync(path.join(evidence, 'validation.json'), JSON.stringify({ results }, null, 2));
process.exitCode = ok ? 0 : 1;
