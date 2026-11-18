import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachResourceBudget } from './app/resource-budget.js';
import { startBackend } from './app/backend.js';
import { runCli } from './extensions/cli.js';
import { runMcp } from './extensions/mcp.js';
import { BackendClient } from './extensions/client.js';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const dataDir = path.resolve(option('--data-dir') ?? process.env.NPN_DATA_DIR ?? 'data');
const projectRoot = path.resolve(process.env.NPN_PROJECT_ROOT ?? process.cwd());
process.env.TEMP = path.join(dataDir, 'tmp'); process.env.TMP = process.env.TEMP;
if (args.includes('--backend')) {
  // Only the execution host joins the durable job. CLI/MCP only forward HTTP requests,
  // owned by their invoking client, whose Windows job cannot be reparented into ours.
  const releaseBudget = await attachResourceBudget(fileURLToPath(new URL('../native/resource-budget.exe', import.meta.url)), true);
  const backend = await startBackend({ dataDir, projectRoot, productRoot: process.env.NPN_PRODUCT_ROOT });
  const stop = () => { void backend.close().then(() => { releaseBudget(); process.exit(0); }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} else {
  const stopReporting = await new BackendClient({ dataDir, timeoutMs: 2000 }).observeOwnResources(args.includes('--mcp') ? 'mcp' : 'cli');
  try {
  if (args.includes('--mcp')) await runMcp({ dataDir });
  else {
  const cliArgs = args.filter((_, index) => args[index] !== '--data-dir' && args[index - 1] !== '--data-dir' && args[index] !== '--cli');
  process.exitCode = await runCli(cliArgs, { dataDir });
  }
  } finally { await stopReporting(); }
}
