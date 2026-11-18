import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_PAYLOAD_NAME_PATTERNS,
  FORBIDDEN_PAYLOAD_NAMES,
  FORBIDDEN_PAYLOAD_PATH_SEQUENCES,
  FORBIDDEN_PAYLOAD_SEGMENTS,
  MOCK_FRONTEND_MARKERS,
  REQUIRED_PAYLOAD_ENTRIES,
  assertBridgeFrontendBundle,
  assertStaticPayload,
  inspectStaticPayload,
  normalizePayloadPath,
} from '../src/adaptation/packaging.js';

const MINIMAL_PAYLOAD: readonly string[] = [
  'resources/app/package.json',
  'resources/app/src/entry.js',
  'resources/app/desktop/main.cjs',
  'resources/app/desktop/preload.cjs',
  'resources/app/native/resource-budget.exe',
  'resources/app/frontend/index.html',
  'resources/app/frontend/main.js',
  'resources/app/frontend/main.css',
  'resources/app/ide-extension/package.json',
  'resources/app/assets/logo.png',
  'resources/app/examples/mcp/fixture-server.mjs',
  'resources/app/THIRD_PARTY_NOTICES.txt',
  'resources/runtime/node.exe',
  'resources/ide-host/VSCodium.exe',
  'resources/ide-host.json',
  'resources/recovery/restore.ps1',
  'NPN-Gamma.exe',
  'NPN-Gamma-Desktop.exe',
  'NPN-Gamma-IDE-0.7.0.vsix',
  'NPN-CLI.cmd',
];

function rejectionMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('The payload was expected to be rejected.');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertRejected(payload: readonly string[], offendingPath: string): void {
  const message = rejectionMessage(() => assertStaticPayload(payload));
  assert.match(message, /Static payload rejected\./);
  assert.match(message, new RegExp(escapeRegExp(offendingPath)));
}

function payloadWithout(requirement: string): string[] {
  if (requirement.endsWith('/*')) {
    const directory = requirement.slice(0, -1);
    return MINIMAL_PAYLOAD.filter(pathName => !pathName.startsWith(directory));
  }
  if (requirement.includes('*')) {
    const pattern = new RegExp(`^${requirement.split('*').map(escapeRegExp).join('[^/]*')}$`);
    return MINIMAL_PAYLOAD.filter(pathName => !pattern.test(pathName));
  }
  return MINIMAL_PAYLOAD.filter(pathName => pathName !== requirement);
}

test('a complete minimal payload passes the allowlist', () => {
  assert.deepEqual(inspectStaticPayload(MINIMAL_PAYLOAD), { offending: [], missing: [] });
  assert.doesNotThrow(() => assertStaticPayload(MINIMAL_PAYLOAD));
});

test('every required entry is required and named when absent', () => {
  for (const requirement of REQUIRED_PAYLOAD_ENTRIES) {
    const message = rejectionMessage(() => assertStaticPayload(payloadWithout(requirement)));
    assert.match(message, /Missing required entries:/, requirement);
    assert.ok(message.includes(requirement), `The absent entry ${requirement} must be named in: ${message}`);
  }
});

test('all absent required entries are listed together', () => {
  const absent = ['resources/app/frontend/index.html', 'resources/app/ide-extension/package.json', 'NPN-Gamma.exe'];
  const message = rejectionMessage(() => assertStaticPayload(MINIMAL_PAYLOAD.filter(pathName => !absent.includes(pathName))));
  for (const requirement of absent) assert.ok(message.includes(requirement), requirement);
});

test('every forbidden segment is rejected and named', () => {
  for (const segment of FORBIDDEN_PAYLOAD_SEGMENTS) {
    const offending = segment === 'tools' ? 'resources/app/assets/tools/sample.js' : `resources/app/${segment}/sample.js`;
    assertRejected([...MINIMAL_PAYLOAD, offending], offending);
  }
});

test('forbidden source and legacy build paths are rejected', () => {
  assert.deepEqual(FORBIDDEN_PAYLOAD_PATH_SEQUENCES, [['src', 'frontend'], ['src', 'ui'], ['build', 'renderer']]);
  for (const sequence of FORBIDDEN_PAYLOAD_PATH_SEQUENCES) {
    const offending = `resources/app/${sequence.join('/')}/sample.js`;
    assertRejected([...MINIMAL_PAYLOAD, offending], offending);
  }
});

test('credential and configuration names are rejected case-insensitively', () => {
  assert.deepEqual(FORBIDDEN_PAYLOAD_NAMES, ['API.txt', 'configuration.json', 'backend.json']);
  for (const name of [...FORBIDDEN_PAYLOAD_NAMES, 'api.txt', 'CONFIGURATION.JSON']) {
    const offending = `resources/app/${name}`;
    assertRejected([...MINIMAL_PAYLOAD, offending], offending);
  }
});

test('secret, database, log, source-map and compiled-test names are rejected', () => {
  assert.equal(FORBIDDEN_PAYLOAD_NAME_PATTERNS.length, 6);
  const samples = ['.env', '.env.local', 'signing.key', 'cert.pem', 'cert.pfx', 'store.p12', 'session.db', 'session.db-wal', 'app.log', 'main.js.map', 'packaging.test.js'];
  for (const name of samples) {
    const offending = `resources/app/${name}`;
    assertRejected([...MINIMAL_PAYLOAD, offending], offending);
  }
});

test('the shipped backend, assets and opaque IDE host stay allowed', () => {
  const allowed = [
    'resources/app/src/tools/gateway.js',
    'resources/app/src/tools/policy.js',
    'resources/app/src/adaptation/recovery.js',
    'resources/app/assets/brand/app.ico',
    'resources/app/examples/plugins/formatter/plugin.json',
    'resources/app/frontend/assets/logo.svg',
    'resources/ide-host/node_modules/example/index.js',
    'resources/ide-host/resources/app/out/main.js.map',
  ];
  assert.doesNotThrow(() => assertStaticPayload([...MINIMAL_PAYLOAD, ...allowed]));
});

test('the tools segment is allowed only below the shipped backend', () => {
  assert.doesNotThrow(() => assertStaticPayload([...MINIMAL_PAYLOAD, 'resources/app/src/tools/worker.js']));
  assertRejected([...MINIMAL_PAYLOAD, 'resources/app/src/tools/node_modules/dependency.js'], 'resources/app/src/tools/node_modules/dependency.js');
});

test('the opaque IDE host exemption is explicit and can be disabled', () => {
  const payload = [...MINIMAL_PAYLOAD, 'resources/ide-host/node_modules/example/index.js'];
  assert.doesNotThrow(() => assertStaticPayload(payload));
  assert.throws(() => assertStaticPayload(payload, []), /forbidden segment "node_modules"/);
});

test('backslash and dot-relative payload paths are normalized', () => {
  assert.equal(normalizePayloadPath('resources\\app\\frontend\\main.js'), 'resources/app/frontend/main.js');
  assert.equal(normalizePayloadPath('./resources/app/frontend/main.js'), 'resources/app/frontend/main.js');
  assert.equal(normalizePayloadPath('resources//app/frontend/main.js'), 'resources/app/frontend/main.js');
  assert.doesNotThrow(() => assertStaticPayload(MINIMAL_PAYLOAD.map(pathName => pathName.replaceAll('/', '\\'))));
  assertRejected([...MINIMAL_PAYLOAD, 'resources\\app\\src\\ui\\panel.js'], 'resources/app/src/ui/panel.js');
});

test('absolute, drive-qualified and parent-relative payload paths are invalid', () => {
  for (const invalid of ['', '/etc/passwd', 'C:/release/file.txt', '../escape.txt', 'resources/../escape.txt', 'resources/app/:stream']) {
    assert.throws(() => normalizePayloadPath(invalid), /Invalid payload path/, JSON.stringify(invalid));
  }
});

test('inspectStaticPayload reports every violation without throwing', () => {
  const report = inspectStaticPayload([...MINIMAL_PAYLOAD, 'resources/app/API.txt', 'resources/app/src/ui/panel.js']);
  assert.equal(report.missing.length, 0);
  assert.deepEqual(report.offending.map(violation => violation.path), ['resources/app/API.txt', 'resources/app/src/ui/panel.js']);
  assert.match(report.offending[0].reason, /API\.txt/);
  assert.match(report.offending[1].reason, /src\/ui/);
});

test('a bridge bundle passes and every mock marker is rejected', () => {
  assert.doesNotThrow(() => assertBridgeFrontendBundle('const gateway = new Bridge(window.npn);'));
  assert.doesNotThrow(() => assertBridgeFrontendBundle('const catalog = "z-ai/glm-5.3-flash";'));
  for (const { marker } of MOCK_FRONTEND_MARKERS) {
    const message = rejectionMessage(() => assertBridgeFrontendBundle(`const id = '${marker}';`));
    assert.match(message, /mock gateway/);
    assert.ok(message.includes(marker), marker);
  }
  const seeded = MOCK_FRONTEND_MARKERS.map(({ marker }) => marker).join(' ');
  const message = rejectionMessage(() => assertBridgeFrontendBundle(`const seed = '${seeded}';`));
  for (const { marker } of MOCK_FRONTEND_MARKERS) assert.ok(message.includes(marker), marker);
});

test('an empty frontend bundle is rejected', () => {
  assert.throws(() => assertBridgeFrontendBundle('   '), /empty/);
});

test('the packaging fixtures contain no secret-like literals', () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const pattern of [/AIza[0-9A-Za-z_-]{30}/, /sk-[0-9A-Za-z]{24,}/]) {
    assert.equal(pattern.test(source), false, 'Packaging fixtures must not embed credential-like literals.');
  }
});
