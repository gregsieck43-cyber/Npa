import { cpSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { assertGeneratedPath } from './project-paths.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRecoveryManifest, verifyRecoveryArchive, withRecoveryArchive } from '../build/src/adaptation/recovery.js';
import { REQUIRED_PAYLOAD_ENTRIES, assertBridgeFrontendBundle, assertStaticPayload } from '../build/src/adaptation/packaging.js';

const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
const checkOnly = process.argv.includes('--check');
const ideHost = JSON.parse(readFileSync('.deps/ide-host/npn-host.json', 'utf8'));
// build/src/ui holds the compiled legacy UI models that existing tests import, and build/src/frontend
// is the type-only frontend contract; neither is runtime code, so both stay out of the shipped app.
const EXCLUDED_APP_SOURCE_DIRECTORIES = ['ui', 'frontend'];
const APP_PAYLOAD_DIRECTORIES = [
  { target: 'resources/app/src', source: 'build/src', excluded: EXCLUDED_APP_SOURCE_DIRECTORIES },
  { target: 'resources/app/desktop', source: 'build/desktop' },
  { target: 'resources/app/native', source: 'build/native' },
  { target: 'resources/app/frontend', source: 'build/frontend' },
  { target: 'resources/app/ide-extension', source: 'build/ide-extension' },
  { target: 'resources/app/assets', source: 'assets' },
  { target: 'resources/app/examples', source: 'examples' },
];
// These launchers are generated further down; the planned entries must match the written names.
const LAUNCHER_NAMES = ['恢复已知良好版本.cmd', 'NPN-CLI.cmd', 'NPN-MCP.cmd', 'NPN-IDE.cmd'];

// Every file the release must contain is planned here once, so --check and full packaging validate
// the same allowlist instead of drifting apart.
function collectFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  walk(root);
  return files;
}

function appPayloadEntries() {
  const entries = [];
  for (const directory of APP_PAYLOAD_DIRECTORIES) {
    if (!existsSync(directory.source)) throw new Error(`The packaged source ${directory.source} is missing. Run node scripts/build.mjs first.`);
    for (const file of collectFiles(directory.source)) {
      const firstSegment = path.relative(directory.source, file).split(path.sep)[0];
      if ((directory.excluded ?? []).includes(firstSegment)) continue;
      const relative = path.relative(directory.source, file).split(path.sep).join('/');
      entries.push({ path: `${directory.target}/${relative}`, source: file });
    }
  }
  return entries;
}

function generatedPayloadPaths() {
  return [
    'resources/app/package.json',
    'resources/app/LICENSE',
    'resources/app/THIRD_PARTY_NOTICES.txt',
    'resources/runtime/node.exe',
    'resources/runtime/LICENSE',
    'resources/recovery/restore.ps1',
    'resources/recovery/manifest.json',
    'resources/recovery/bundle.zip',
    'NPN-Gamma.exe',
    'NPN-Gamma-Desktop.exe',
    `NPN-Gamma-IDE-${metadata.version}.vsix`,
    ...LAUNCHER_NAMES,
  ];
}

function plannedStaticPayload() {
  const paths = appPayloadEntries().map((entry) => entry.path);
  paths.push(...generatedPayloadPaths());
  for (const name of readdirSync(ideHost.directory)) paths.push(`resources/ide-host/${name}`);
  paths.push('resources/ide-host.json');
  return paths;
}

function ideHostProblems() {
  const problems = [];
  if (ideHost.checksumVerified !== true) problems.push('checksumVerified is not true');
  if (ideHost.brandingApplied !== true) problems.push('brandingApplied is not true');
  if (ideHost.npnVersion !== metadata.version) problems.push(`npnVersion ${JSON.stringify(ideHost.npnVersion)} does not match package version ${JSON.stringify(metadata.version)}`);
  if (!existsSync(path.join(ideHost.directory, 'VSCodium.exe'))) problems.push(`VSCodium.exe is missing from ${ideHost.directory}`);
  return problems;
}

// Packaging refuses to start when the frontend bundle, the Electron preload, a license input or any
// payload path is wrong; the allowlist report names every offending path instead of stopping at the first.
const REQUIRED_PACKAGING_INPUTS = [
  'build/frontend/index.html',
  'build/frontend/main.js',
  'build/frontend/main.css',
  'build/desktop/main.cjs',
  'build/desktop/preload.cjs',
  'build/native/resource-budget.exe',
  'build/native/resource-launcher.exe',
  'assets/brand/app.ico',
  'assets/brand/manifest.json',
  'LICENSE',
  'licenses/DSH-MIT.txt',
  'licenses/node-v24.16.0-LICENSE.txt',
  'node_modules/electron/dist/electron.exe',
];

function verifyStaticPayload() {
  for (const required of REQUIRED_PACKAGING_INPUTS) {
    if (!existsSync(required)) throw new Error(`${required} is missing. Run node scripts/build.mjs first.`);
  }
  assertBridgeFrontendBundle(readFileSync('build/frontend/main.js', 'utf8'));
  const paths = plannedStaticPayload();
  assertStaticPayload(paths);
  return paths;
}

const plannedPayload = verifyStaticPayload();
if (checkOnly) {
  console.log(`Static payload check passed: ${plannedPayload.length} files planned, ${REQUIRED_PAYLOAD_ENTRIES.length} required entries present, no forbidden paths, bridge frontend bundle verified.`);
  const problems = ideHostProblems();
  if (problems.length > 0) console.log(`Full packaging stays blocked by the read-only IDE host metadata: ${problems.join('; ')}.`);
  else console.log('Full packaging preconditions for the IDE host are satisfied.');
  process.exit(0);
}
const releaseName = process.env.NPN_RELEASE_NAME ?? `NPN-Gamma-${metadata.version}`;
if (!/^NPN-Gamma-\d+\.\d+\.\d+(?:-(?:preview\d*|reviewed))?$/.test(releaseName)) throw new Error('Use a distinct versioned release name.');
const releaseRoot = path.resolve('release', releaseName);
assertGeneratedPath(releaseRoot, ['release', releaseName]);
mkdirSync(path.dirname(releaseRoot), { recursive: true });
// A release is immutable. Exclusive creation also prevents two packagers from sharing an output.
mkdirSync(releaseRoot);
cpSync('node_modules/electron/dist', releaseRoot, { recursive: true });
renameSync(path.join(releaseRoot, 'electron.exe'), path.join(releaseRoot, 'NPN-Gamma-Desktop.exe'));
copyFileSync('build/native/resource-launcher.exe', path.join(releaseRoot, 'NPN-Gamma.exe'));
const executable = path.join(releaseRoot, 'NPN-Gamma.exe');
const iconPath = path.resolve('assets/brand/app.ico');
if (!existsSync(iconPath)) throw new Error('The approved product icon is required for packaging.');
const rceditRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('rcedit'))), '..');
const resourceEditor = path.join(rceditRoot, 'bin', process.arch === 'x64' ? 'rcedit-x64.exe' : 'rcedit.exe');
for (const name of ['NPN-Gamma.exe', 'NPN-Gamma-Desktop.exe']) {
const edited = spawnSync(resourceEditor, [path.join(releaseRoot, name), '--set-icon', iconPath,
  '--set-file-version', metadata.version, '--set-product-version', metadata.version,
  '--set-version-string', 'ProductName', 'NPN-Gamma Code Agent',
  '--set-version-string', 'FileDescription', 'NPN-Gamma Code Agent',
  '--set-version-string', 'CompanyName', 'NPN-Gamma',
  '--set-version-string', 'OriginalFilename', name,
  '--set-version-string', 'InternalName', 'NPN-Gamma'],
{ cwd: process.cwd(), env: process.env, windowsHide: true, stdio: 'inherit' });
if (edited.error) throw edited.error;
if (edited.status !== 0) throw new Error(`Product icon/version resource edit failed (${edited.status}).`);
}
const appRoot = path.join(releaseRoot, 'resources/app');
mkdirSync(appRoot, { recursive: true });
cpSync('build/src', path.join(appRoot, 'src'), { recursive: true, filter: (source) => !EXCLUDED_APP_SOURCE_DIRECTORIES.includes(path.relative('build/src', source).split(path.sep)[0]) });
cpSync('build/desktop', path.join(appRoot, 'desktop'), { recursive: true });
cpSync('build/native', path.join(appRoot, 'native'), { recursive: true });
// build/frontend replaced the legacy build/renderer bundle: the Electron shell loads frontend/index.html.
cpSync('build/frontend', path.join(appRoot, 'frontend'), { recursive: true });
cpSync('build/ide-extension', path.join(appRoot, 'ide-extension'), { recursive: true });
if (ideHostProblems().length > 0) throw new Error('Prepare and verify the matching NPN branded IDE before packaging.');
cpSync(ideHost.directory, path.join(releaseRoot, 'resources/ide-host'), { recursive: true });
copyFileSync('.deps/ide-host/npn-host.json', path.join(releaseRoot, 'resources/ide-host.json'));
const extensionPackage = spawnSync('python', ['-I', '-B', path.resolve('scripts/package-ide-extension.py'), '--source', path.join(appRoot, 'ide-extension'), '--output', path.join(releaseRoot, `NPN-Gamma-IDE-${metadata.version}.vsix`)], { cwd: process.cwd(), env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: 'inherit' });
if (extensionPackage.error) throw extensionPackage.error;
if (extensionPackage.status !== 0) throw new Error('IDE extension packaging failed.');
cpSync('examples', path.join(appRoot, 'examples'), { recursive: true });
copyFileSync('LICENSE', path.join(appRoot, 'LICENSE'));
writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'npn-gamma-agent', version: metadata.version, type: 'module', main: 'desktop/main.cjs' }, null, 2));
if (existsSync('assets')) cpSync('assets', path.join(appRoot, 'assets'), { recursive: true });
const licenses = ['Model metadata — models.dev\n' + readFileSync('licenses/models.dev-MIT.txt', 'utf8'),'DSH frontend components — DeepSeek Harness 0.2.0-rc.2\n' + readFileSync('licenses/DSH-MIT.txt', 'utf8'),
  'VSCodium / Code - OSS portable editor\n' + readFileSync(path.join(ideHost.directory, 'resources/app/LICENSE.txt'), 'utf8') + '\nThe complete editor ThirdPartyNotices.txt and Chromium notices are preserved under resources/ide-host.'];
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
for (const dependency of Object.keys(lock.packages).filter(key => /^node_modules\/(?:pptxgenjs$|fflate$|jszip$|pako$|lie$|immediate$|setimmediate$|image-size$|queue$|readable-stream$|core-util-is$|inherits$|isarray$|process-nextick-args$|safe-buffer$|string_decoder$|util-deprecate$|@codemirror\/|@lezer\/|codemirror$|react$|react-dom$|scheduler$|loose-envify$|object-assign$|style-mod$|w3c-keyname$|crelt$)/.test(key))) {
  const packageJson = JSON.parse(readFileSync(path.join(dependency, 'package.json'), 'utf8'));
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE-MIT']) {
    if (existsSync(path.join(dependency, filename))) { licenses.push(`${packageJson.name}@${packageJson.version}\n${readFileSync(path.join(dependency, filename), 'utf8')}`); break; }
  }
}
writeFileSync(path.join(appRoot, 'THIRD_PARTY_NOTICES.txt'), licenses.join('\n\n--------------------\n\n'));
mkdirSync(path.join(releaseRoot, 'resources/runtime'), { recursive: true });
copyFileSync(process.execPath, path.join(releaseRoot, 'resources/runtime/node.exe'));
copyFileSync('licenses/node-v24.16.0-LICENSE.txt', path.join(releaseRoot, 'resources/runtime/LICENSE'));
const recoveryRoot = path.join(releaseRoot, 'resources/recovery');
mkdirSync(recoveryRoot, { recursive: true });
copyFileSync('src/adaptation/restore.ps1', path.join(releaseRoot, 'resources/recovery/restore.ps1'));
// Read-only clients do not create data; IDE's backend initializer establishes its private ACL first.
// Offline recovery needs only a separate package-local scratch directory, never the application's data root.
writeFileSync(path.join(releaseRoot, '恢复已知良好版本.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nset "TEMP=%~dp0.tmp\\recovery-temp"\r\nset "TMP=%TEMP%"\r\nif not exist "%TEMP%" mkdir "%TEMP%"\r\nset "PSModuleAnalysisCachePath=%TEMP%\\powershell-cache"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\\recovery\\restore.ps1" -PackageRoot "%~dp0."\r\npause\r\n');
writeFileSync(path.join(releaseRoot, 'NPN-CLI.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nset "TEMP=%~dp0data\\tmp"\r\nset "TMP=%TEMP%"\r\n"%~dp0resources\\runtime\\node.exe" "%~dp0resources\\app\\src\\entry.js" --cli %*\r\n');
writeFileSync(path.join(releaseRoot, 'NPN-MCP.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nset "TEMP=%~dp0data\\tmp"\r\nset "TMP=%TEMP%"\r\n"%~dp0resources\\runtime\\node.exe" "%~dp0resources\\app\\src\\entry.js" --mcp %*\r\n');
writeFileSync(path.join(releaseRoot, 'NPN-IDE.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nset "TEMP=%~dp0data\\tmp"\r\nset "TMP=%TEMP%"\r\n"%~dp0resources\\runtime\\node.exe" "%~dp0resources\\app\\src\\ide\\start.js" --product-root "%~dp0." %*\r\n');
const payloadManifest = buildRecoveryManifest(releaseRoot, metadata.version, 'package');
const manifestPath = path.join(recoveryRoot, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify(payloadManifest, null, 2));
const compressed = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', path.resolve('scripts/package-recovery.ps1'), '-PackageRoot', releaseRoot],
{ cwd: process.cwd(), env: process.env, windowsHide: true, stdio: 'inherit' });
if (compressed.error) throw compressed.error;
if (compressed.status !== 0) throw new Error(`Compressed recovery creation failed (${compressed.status}).`);
const manifest = withRecoveryArchive(payloadManifest, path.join(recoveryRoot, 'bundle.zip'));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const archiveCheck = verifyRecoveryArchive(recoveryRoot, manifest);
if (!archiveCheck.valid) throw new Error(archiveCheck.errors.join('\n'));
const credentialFilesExcluded = manifest.files.every(file => !/^(?:API\.txt|configuration\.json|backend\.json|\.env.*|.*\.key)$/i.test(path.basename(file.path))) && !existsSync(path.join(releaseRoot, 'data'));
if (!credentialFilesExcluded) throw new Error('A credential/configuration/data file entered the static release.');
const evidence = { createdAt: new Date().toISOString(), version: metadata.version, executable, sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'), iconSha256: createHash('sha256').update(readFileSync(iconPath)).digest('hex'), sourceLogoSha256: JSON.parse(readFileSync('assets/brand/manifest.json', 'utf8')).source.sha256, bundledNode: process.version, appFiles: manifest.files.length, recoveryManifestSha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'), recoveryArchive: manifest.archive, staticBytes: manifest.files.reduce((sum, file) => sum + file.size, 0), credentialFilesExcluded, knownGoodPayloadValidated: true };
mkdirSync('build/packaging', { recursive: true });
writeFileSync(path.join('build/packaging', releaseName + '.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
