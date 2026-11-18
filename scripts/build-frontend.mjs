// 构建 NPN-Gamma 新前端（src/frontend）。
//   node scripts/build-frontend.mjs                   演示网关构建 → build/frontend
//   node scripts/build-frontend.mjs --gateway=bridge  真实网关构建（需 Electron preload 提供 window.npn）
//   node scripts/build-frontend.mjs --serve           演示网关 + 监听重建 + http://127.0.0.1:5199
//   --outdir=<build/ 或 .tmp/ 下的 frontend-* 目录>   改变输出目录（默认 build/frontend）
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { context, build } from 'esbuild';
import { projectRoot, removeGeneratedPath } from './project-paths.mjs';

const root = projectRoot();
const args = new Set(process.argv.slice(2));
const outArg = [...args].find(arg => arg.startsWith('--outdir='))?.slice('--outdir='.length);
const outdir = path.resolve(root, outArg ?? path.join('build', 'frontend'));
const outSegments = path.relative(root, outdir).split(path.sep).filter(Boolean);
const generatedFrontend = outSegments.length === 2
  && (outSegments[0] === 'build' || outSegments[0] === '.tmp')
  && (outSegments[1] === 'frontend' || /^frontend-[a-z0-9-]+$/i.test(outSegments[1]));
if (!generatedFrontend) throw new Error(`Frontend output must be ${path.join(root, 'build', 'frontend')} or a frontend-* directory directly inside build/ or .tmp/: ${outdir}`);
const gatewayArg = [...args].find(arg => arg.startsWith('--gateway='))?.slice('--gateway='.length) ?? 'mock';
if (!['mock', 'bridge'].includes(gatewayArg)) throw new Error(`Unknown gateway: ${gatewayArg}`);
const serve = args.has('--serve');

const check = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'src/frontend/tsconfig.json')], { stdio: 'inherit', cwd: root });
if (check.status !== 0) process.exit(check.status ?? 1);

removeGeneratedPath(outdir, outSegments);
mkdirSync(outdir, { recursive: true });
copyFileSync(path.join(root, 'src/frontend/index.html'), path.join(outdir, 'index.html'));

// bridge 构建必须不含演示网关与种子数据：把 mock/gateway 解析为调用即报错的空壳。
const excludeMock = {
  name: 'exclude-mock-gateway',
  setup(build) {
    build.onResolve({ filter: /[\\/]mock[\\/]gateway$/ }, () => ({ path: 'mock-gateway-excluded', namespace: 'npn-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'npn-stub' }, () => ({ contents: "export class MockGateway { constructor() { throw new Error('Mock gateway is excluded from bridge builds.'); } }", loader: 'js' }));
  },
};

const options = {
  plugins: !serve && gatewayArg === 'bridge' ? [excludeMock] : [],
  absWorkingDir: root,
  entryPoints: { main: 'src/frontend/main.tsx' },
  outdir,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  jsx: 'automatic',
  minify: !serve,
  sourcemap: serve ? 'inline' : false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': serve ? '"development"' : '"production"', __NPN_GATEWAY__: JSON.stringify(serve ? 'mock' : gatewayArg) },
  logLevel: 'info',
};

if (serve) {
  const ctx = await context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: outdir, host: '127.0.0.1', port: 5199 });
  console.log(`NPN frontend preview: http://127.0.0.1:${port}/`);
} else {
  await build(options);
}
