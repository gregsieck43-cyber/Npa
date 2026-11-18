import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertProjectPath, projectRoot } from './project-paths.mjs';
import { brandProduct, npnWatermark } from '../build/src/ide/branding.js';

const root = projectRoot(), version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const upstream = JSON.parse(readFileSync('.deps/ide-host/host.json', 'utf8'));
if (!upstream.checksumVerified) throw new Error('Use the verified upstream host.');
const source = path.resolve(upstream.directory), hostRoot = path.join(root, '.deps', 'ide-host');
const target = assertProjectPath(path.join(hostRoot, `NPN-Gamma-IDE-${version}`));
if (path.relative(hostRoot, target) !== `NPN-Gamma-IDE-${version}`) throw new Error(`The branded host must stay inside ${hostRoot}.`);
const marker = path.join(target, 'npn-branding.json');
if (existsSync(target)) {
  if (!existsSync(marker) || JSON.parse(readFileSync(marker, 'utf8')).version !== version) throw new Error('An unknown branding directory already exists; do not overwrite it.');
  console.log(`Branded IDE already prepared: ${target}`);
} else {
  console.log(`Preparing NPN product from the immutable ${upstream.version} host...`);
  mkdirSync(path.dirname(target), { recursive: true }); cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
  const app = path.join(target, 'resources/app'), product = path.join(app, 'product.json');
  writeFileSync(product, JSON.stringify(brandProduct(JSON.parse(readFileSync(product, 'utf8')), version), null, 2));
  const media = path.join(app, 'out/media');
  const image = readFileSync('assets/brand/logo-128.png').toString('base64');
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><image width="128" height="128" href="data:image/png;base64,${image}"/></svg>`;
  for (const name of ['code-icon.svg', 'vscode-icon.svg']) { if (!existsSync(path.join(media, name))) throw new Error('Pinned host icon layout changed.'); writeFileSync(path.join(media, name), icon); }
  for (const name of ['letterpress-light.svg', 'letterpress-hcLight.svg']) writeFileSync(path.join(media, name), npnWatermark(false));
  for (const name of ['letterpress-dark.svg', 'letterpress-hcDark.svg']) writeFileSync(path.join(media, name), npnWatermark(true));
  copyFileSync('assets/brand/app.ico', path.join(app, 'resources/win32/code.ico'));
  copyFileSync('assets/brand/logo-256.png', path.join(app, 'resources/win32/code_150x150.png'));
  copyFileSync('assets/brand/logo-128.png', path.join(app, 'resources/win32/code_70x70.png'));
  copyFileSync(path.join(target, 'bin/codium.cmd'), path.join(target, 'bin/npn-ide.cmd'));
  const rceditRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('rcedit'))), '..');
  const editor = path.join(rceditRoot, 'bin', 'rcedit-x64.exe');
  const edited = spawnSync(editor, [path.join(target, 'VSCodium.exe'), '--set-icon', path.resolve('assets/brand/app.ico'), '--set-file-version', version, '--set-product-version', version,
    '--set-version-string', 'ProductName', 'NPN Gamma IDE', '--set-version-string', 'FileDescription', 'NPN Gamma IDE (Code - OSS based)'], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
  if (edited.error) throw edited.error;
  if (edited.status !== 0) throw new Error('Native IDE icon branding failed.');
  const changed = ['VSCodium.exe', 'resources/app/product.json', 'resources/app/out/media/code-icon.svg', 'resources/app/out/media/letterpress-light.svg', 'resources/app/out/media/letterpress-dark.svg', 'resources/app/resources/win32/code.ico'];
  const record = { version, basedOn: upstream, changes: changed.map(file => ({ path: file, sha256: createHash('sha256').update(readFileSync(path.join(target, file))).digest('hex') })),
    upstreamNoticesPreserved: readFileSync(path.join(app, 'LICENSE.txt')).equals(readFileSync(path.join(source, 'resources/app/LICENSE.txt'))) };
  writeFileSync(marker, JSON.stringify(record, null, 2));
}
const record = { ...upstream, directory: path.relative(root, target).replaceAll('\\', '/'), product: 'NPN Gamma IDE', brandingApplied: true, npnVersion: version,
  branding: JSON.parse(readFileSync(marker, 'utf8')) };
writeFileSync('.deps/ide-host/npn-host.json', JSON.stringify(record, null, 2));
console.log(`NPN Gamma IDE ${version} branding ready; original upstream host was not modified.`);
