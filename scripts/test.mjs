import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from './project-paths.mjs';

const root = projectRoot();
const temp = path.join(root, '.tmp', 'tests');
mkdirSync(temp, { recursive: true });
const runtime = path.join(root, '.deps', 'runtime', 'node.exe');
const args = process.argv.slice(2);
const result = spawnSync(runtime, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
