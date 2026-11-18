import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ensureLocalBackend } from '../app/launch-backend.js';
import { BackendClient } from '../extensions/client.js';
import { ideAssets, launchIde } from './launcher.js';
import { attachResourceBudget } from '../app/resource-budget.js';

const argument = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
async function main() {
  const productRoot = path.resolve(argument('--product-root') ?? process.cwd());
  const packaged = existsSync(path.join(productRoot, 'resources', 'app', 'package.json'));
  const appRoot = packaged ? path.join(productRoot, 'resources', 'app') : path.join(productRoot, 'build');
  const dataDir = path.resolve(argument('--data-dir') ?? path.join(productRoot, 'data'));
  const metadata = JSON.parse(readFileSync(path.join(packaged ? appRoot : productRoot, 'package.json'), 'utf8'));
  const projectRoot = metadata.workspaceBoundary ?? productRoot;
  const runtime = packaged ? path.join(productRoot, 'resources', 'runtime', 'node.exe') : path.join(productRoot, '.deps', 'runtime', 'node.exe');
  await attachResourceBudget(path.join(appRoot, 'native', 'resource-budget.exe'));
  await ensureLocalBackend({ dataDir, projectRoot, productRoot: metadata.productRoot ?? productRoot, cwd: productRoot, runtime, entry: path.join(appRoot, 'src', 'entry.js') });
  let workspace = argument('--workspace');
  if (workspace) workspace = (await new BackendClient({ dataDir }).openWorkspace(path.resolve(workspace))).path;
  const launched = await launchIde({ productRoot, dataDir, workspace, workspaceBoundary: workspace ?? projectRoot, inspectPort: argument('--ide-inspect-port') ? Number(argument('--ide-inspect-port')) : undefined, ...ideAssets(productRoot, appRoot, packaged) });
  console.log(JSON.stringify(launched));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
