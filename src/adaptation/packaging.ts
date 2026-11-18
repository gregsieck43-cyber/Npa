/**
 * Static payload allowlist for the packaged release.
 *
 * Packaging copies a fixed set of build outputs into the release and writes the remaining entries
 * itself. This module states, from the release's point of view, which entries are required, which
 * names are forbidden and which tree ships as opaque vendor content. The rules are pure so packaging
 * and its tests share one definition: the caller declares the files it intends to ship and the
 * assertions reject a payload that is incomplete or that carries state, tests or secrets.
 */

/** Release-relative entries the payload must contain. A trailing slash-star requires at least one entry below that directory. */
export const REQUIRED_PAYLOAD_ENTRIES: readonly string[] = [
  'resources/app/package.json',
  'resources/app/src/entry.js',
  'resources/app/desktop/main.cjs',
  'resources/app/desktop/preload.cjs',
  'resources/app/native/resource-budget.exe',
  'resources/app/frontend/index.html',
  'resources/app/frontend/main.js',
  'resources/app/frontend/main.css',
  'resources/app/ide-extension/package.json',
  'resources/app/assets/*',
  'resources/app/examples/*',
  'resources/app/THIRD_PARTY_NOTICES.txt',
  'resources/runtime/node.exe',
  'resources/ide-host/*',
  'resources/ide-host.json',
  'resources/recovery/*',
  'NPN-Gamma.exe',
  'NPN-Gamma-Desktop.exe',
  'NPN-Gamma-IDE-*.vsix',
  '*.cmd',
];

/**
 * Names that must never appear as a path segment in the payload: dependency trees, scratch and state
 * directories, test and tooling trees, the repository itself and the legacy renderer.
 */
export const FORBIDDEN_PAYLOAD_SEGMENTS: readonly string[] = [
  'node_modules',
  '.tmp',
  '.cache',
  '.git',
  'tests',
  'tools',
  'data',
  'cache',
  'logs',
  'evidence',
  'release',
  'renderer',
];

/**
 * Multi-segment paths that must never appear: the frontend source tree (the bundled frontend is the
 * only frontend that ships), the legacy UI sources compiled for tests, and the legacy renderer build.
 */
export const FORBIDDEN_PAYLOAD_PATH_SEQUENCES: readonly (readonly string[])[] = [
  ['src', 'frontend'],
  ['src', 'ui'],
  ['build', 'renderer'],
];

/**
 * The shipped backend has one module directory whose name is otherwise forbidden: src/tools holds the
 * tool gateway, policy and worker that the app, extensions, harness, IDE and integrations import. It is
 * the only place the "tools" segment may appear.
 */
const SEGMENT_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  tools: ['resources/app/src/tools/'],
};

/** File names that identify user configuration, credentials or tool state and never ship. Compared case-insensitively. */
export const FORBIDDEN_PAYLOAD_NAMES: readonly string[] = ['API.txt', 'configuration.json', 'backend.json'];

/** File-name patterns that cover secrets, databases, logs, source maps and compiled tests. */
export const FORBIDDEN_PAYLOAD_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env.*$/i,
  /\.(?:key|pem|pfx|p12)$/i,
  /\.db.*$/i,
  /\.log$/i,
  /\.map$/i,
  /\.test\..*$/i,
];

/**
 * The branded IDE host is a vendored VSCodium/Code - OSS runtime. It legitimately contains
 * node_modules, source maps and other names the application payload forbids, and its integrity is
 * established separately by .deps/ide-host/npn-host.json (checksumVerified, brandingApplied,
 * npnVersion). It ships as one opaque tree, so it is exempt from the file rules below; the required
 * resources/ide-host/* entry still proves it was planned.
 */
export const OPAQUE_PAYLOAD_PREFIXES: readonly string[] = ['resources/ide-host/'];

/** One declared payload entry that must not ship, with the rule it breaks. */
export interface StaticPayloadViolation {
  readonly path: string;
  readonly reason: string;
}

/** Result of inspecting a declared payload against the allowlist rules. */
export interface StaticPayloadReport {
  readonly offending: readonly StaticPayloadViolation[];
  readonly missing: readonly string[];
}

/** A frontend bundle literal that exists only in the mock gateway or its seed data. */
export interface MockFrontendMarker {
  readonly marker: string;
  readonly origin: string;
}

function invalidPath(relativePath: string): Error {
  return new Error(`Invalid payload path: ${JSON.stringify(relativePath)}`);
}

/**
 * Normalizes one release-relative path: backslashes become separators, "./" and empty segments are
 * dropped. Absolute paths, drive or stream colons and ".." segments are programming errors in the
 * packaging plan, so they are rejected instead of being normalized away.
 */
export function normalizePayloadPath(relativePath: string): string {
  if (relativePath.includes(':')) throw invalidPath(relativePath);
  const unified = relativePath.replace(/\\/g, '/');
  if (unified.startsWith('/')) throw invalidPath(relativePath);
  const segments = unified.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) throw invalidPath(relativePath);
  return segments.join('/');
}

function isOpaque(pathName: string, opaquePrefixes: readonly string[]): boolean {
  return opaquePrefixes.some(prefix => pathName.startsWith(prefix));
}

function hasSegmentException(pathName: string, segment: string): boolean {
  return (SEGMENT_EXCEPTIONS[segment] ?? []).some(prefix => pathName.startsWith(prefix));
}

function containsSequence(segments: readonly string[], sequence: readonly string[]): boolean {
  return segments.some((_, index) => sequence.every((name, offset) => segments[index + offset] === name));
}

/** Returns why one declared payload entry breaks the rules, or null when it is allowed. */
function forbiddenReason(pathName: string, opaquePrefixes: readonly string[]): string | null {
  if (isOpaque(pathName, opaquePrefixes)) return null;
  const segments = pathName.split('/');
  for (const segment of FORBIDDEN_PAYLOAD_SEGMENTS) {
    if (segments.includes(segment) && !hasSegmentException(pathName, segment)) return `forbidden segment "${segment}"`;
  }
  for (const sequence of FORBIDDEN_PAYLOAD_PATH_SEQUENCES) {
    if (containsSequence(segments, sequence)) return `forbidden path "${sequence.join('/')}"`;
  }
  const basename = segments[segments.length - 1].toLowerCase();
  for (const name of FORBIDDEN_PAYLOAD_NAMES) {
    if (basename === name.toLowerCase()) return `forbidden file name "${name}"`;
  }
  for (const pattern of FORBIDDEN_PAYLOAD_NAME_PATTERNS) {
    if (pattern.test(basename)) return `forbidden file name matching ${String(pattern)}`;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether one declared payload path satisfies a required-entry pattern. */
export function isRequiredEntryPresent(requirement: string, payloadPaths: readonly string[]): boolean {
  if (requirement.endsWith('/*')) {
    const directory = requirement.slice(0, -1);
    return payloadPaths.some(pathName => pathName.startsWith(directory) && pathName.length > directory.length);
  }
  if (!requirement.includes('*')) return payloadPaths.includes(requirement);
  const pattern = new RegExp(`^${requirement.split('*').map(escapeRegExp).join('[^/]*')}$`);
  return payloadPaths.some(pathName => pattern.test(pathName));
}

/** Reports forbidden and missing payload entries without throwing; empty lists mean the payload is complete. */
export function inspectStaticPayload(
  relativePaths: readonly string[],
  opaquePrefixes: readonly string[] = OPAQUE_PAYLOAD_PREFIXES,
): StaticPayloadReport {
  const paths = relativePaths.map(normalizePayloadPath);
  const offending: StaticPayloadViolation[] = [];
  for (const pathName of paths) {
    const reason = forbiddenReason(pathName, opaquePrefixes);
    if (reason !== null) offending.push({ path: pathName, reason });
  }
  const missing = REQUIRED_PAYLOAD_ENTRIES.filter(requirement => !isRequiredEntryPresent(requirement, paths));
  return { offending, missing };
}

/**
 * Rejects a payload that is incomplete or carries forbidden entries. The message lists every offending
 * path with the rule it breaks and every required entry that is absent, so a failed packaging run can
 * be fixed in one pass.
 */
export function assertStaticPayload(
  relativePaths: readonly string[],
  opaquePrefixes: readonly string[] = OPAQUE_PAYLOAD_PREFIXES,
): void {
  const report = inspectStaticPayload(relativePaths, opaquePrefixes);
  if (report.offending.length === 0 && report.missing.length === 0) return;
  const lines = ['Static payload rejected.'];
  if (report.offending.length > 0) {
    lines.push('Forbidden entries:', ...report.offending.map(violation => `- ${violation.path} (${violation.reason})`));
  }
  if (report.missing.length > 0) {
    lines.push('Missing required entries:', ...report.missing.map(requirement => `- ${requirement}`));
  }
  throw new Error(lines.join('\n'));
}

/**
 * The Electron shell loads resources/app/frontend, and a shipped bundle must talk to the real bridge.
 * The mock gateway and its seed data exist only for --gateway=mock; these literals are the build-time
 * contract that proves which gateway was compiled in. z-ai/glm-5.3-flash appears in both builds (real
 * model catalog), so it is deliberately not a marker.
 */
export const MOCK_FRONTEND_MARKERS: readonly MockFrontendMarker[] = [
  { marker: 'demo-gateway', origin: 'mock gateway backendVersion (src/frontend/api/mock/gateway.ts)' },
  { marker: 'mock-local', origin: 'seed model id (src/frontend/api/mock/seed.ts)' },
  { marker: 's-cowork', origin: 'seed session id (src/frontend/api/mock/seed.ts)' },
  { marker: 'p-agent', origin: 'seed project id (src/frontend/api/mock/seed.ts)' },
  { marker: 'pl-rea', origin: 'seed plugin id (src/frontend/api/mock/seed.ts)' },
];

/** Mock-gateway markers contained in the bundle; an empty list means the bridge gateway was compiled in. */
export function findMockFrontendMarkers(bundleSource: string): readonly MockFrontendMarker[] {
  return MOCK_FRONTEND_MARKERS.filter(({ marker }) => bundleSource.includes(marker));
}

/** Rejects a frontend bundle that still contains the mock gateway or its seed data. */
export function assertBridgeFrontendBundle(bundleSource: string): void {
  if (bundleSource.trim() === '') throw new Error('The frontend bundle is empty. Run node scripts/build.mjs first.');
  const found = findMockFrontendMarkers(bundleSource);
  if (found.length === 0) return;
  throw new Error([
    'The frontend bundle contains the mock gateway or its seed data; build it with --gateway=bridge.',
    ...found.map(({ marker, origin }) => `- "${marker}" from ${origin}`),
  ].join('\n'));
}
