import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
    PROVIDER_IMPORT_MAX_BYTES, parseProviderImport, providerImportSummary, providerProfileBody,
    type ProviderImportSettings,
} from '../src/desktop/provider-connection.js';

const worktree = path.resolve(process.cwd());
const scratchParent = path.join(worktree, '.tmp', 'native-delivery', 'b');
mkdirSync(scratchParent, { recursive: true });
const fixtureRoot = mkdtempSync(path.join(scratchParent, 'provider-connection-'));
after(() => {
    assert.ok(path.resolve(fixtureRoot).startsWith(path.resolve(scratchParent) + path.sep), 'fixture stays inside its scratch directory');
    rmSync(fixtureRoot, { recursive: true, force: true });
});

const TEMPLATE_PATH = path.join(worktree, 'examples', 'native-provider-import.template.json');
const SOURCE_PATH = path.join(worktree, 'src', 'desktop', 'provider-connection.ts');
const FAKE_KEY = 'not-a-real-credential-7c1f2a';
const ALLOWED_TEMPLATE_FIELDS = new Set([
    'name', 'providerLabel', 'baseUrl', 'model', 'credentialFile', 'maxRequests', 'authorizeDays',
    'contextWindowTokens', 'supportsDeveloper',
]);
let fixtures = 0;

/** A fake key file inside the test scratch directory. Its content is never a real credential. */
function keyFile(options: { content?: string; size?: number } = {}): string {
    fixtures += 1;
    const file = path.join(fixtureRoot, `provider-${fixtures}.key`);
    writeFileSync(file, options.size === undefined ? options.content ?? FAKE_KEY : 'k'.repeat(options.size));
    return file;
}

function template(): Record<string, unknown> {
    return JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8')) as Record<string, unknown>;
}

/** A valid import document: the shipped template with a real (fake) credential file path. */
function importText(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ ...template(), credentialFile: keyFile(), ...overrides });
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every rejection must be an Error and must never echo the fake credential file's contents. */
function rejects(text: unknown, expected: RegExp | string, label?: string): void {
    assert.throws(() => parseProviderImport(text as string), (error: unknown) => {
        assert.ok(error instanceof Error, label ?? 'rejection is an Error');
        const message = error.message;
        assert.ok(message.length > 0, 'error message is not empty');
        assert.doesNotMatch(message, new RegExp(escapeRegExp(FAKE_KEY)), 'error message must not echo credential file contents');
        if (typeof expected === 'string') assert.ok(message.includes(expected), `${label ?? 'rejection'}: expected "${expected}" in "${message}"`);
        else assert.match(message, expected, label);
        return true;
    }, label);
}

test('the shipped template is valid JSON whose fields all belong to the import document', () => {
    const parsed = template();
    assert.equal(Array.isArray(parsed), false);
    for (const key of Object.keys(parsed)) assert.ok(ALLOWED_TEMPLATE_FIELDS.has(key), `template field ${key} must be part of the import format`);
    const raw = readFileSync(TEMPLATE_PATH, 'utf8');
    assert.equal(raw.includes('\uFEFF'), false, 'template is UTF-8 without a BOM');
    assert.match(raw, /\n$/);
    // The template carries only placeholders, never a real-looking provider key.
    assert.doesNotMatch(raw, /sk-[A-Za-z0-9]{24,}|AIza[\w-]{30}/);
    // The placeholder credential path cannot exist, so the untouched template must fail on that
    // field alone: every other template field is accepted by the parser.
    rejects(raw, /credentialFile/, 'template placeholder credential path is rejected as a missing local file');
});

test('the template parses into the exact settings, summary and profile body', () => {
    const credentialFile = keyFile();
    const parsed = template();
    const text = JSON.stringify({ ...parsed, credentialFile });
    const settings: ProviderImportSettings = parseProviderImport(text);
    assert.deepEqual(settings, {
        name: String(parsed.name).trim(),
        providerLabel: String(parsed.providerLabel).trim(),
        baseUrl: 'https://provider.example.invalid/v1',
        model: String(parsed.model).trim(),
        credentialFile,
        maxRequests: 1,
        authorizeDays: 1,
    });
    assert.deepEqual(providerImportSummary(settings), {
        name: settings.name,
        providerLabel: settings.providerLabel,
        endpoint: 'https://provider.example.invalid/v1',
        model: settings.model,
        requestLimit: 1,
        authorizeDays: 1,
        credentialFile,
        supportsDeveloper: false,
    });
    assert.deepEqual(providerProfileBody(settings), {
        name: settings.name,
        mode: 'live',
        baseUrl: 'https://provider.example.invalid/v1',
        model: settings.model,
        credentialFile,
        authorizePaid: true,
        maxRequests: 1,
        authorizeDays: 1,
    });
});

test('optional fields are omitted instead of invented', () => {
    const credentialFile = keyFile();
    const text = JSON.stringify({
        name: 'Minimal provider', providerLabel: 'Minimal', baseUrl: 'https://example.com/v1',
        model: 'example/minimal', credentialFile, maxRequests: 1, authorizeDays: 30,
    });
    const settings = parseProviderImport(text);
    assert.equal('contextWindowTokens' in settings, false);
    assert.equal('supportsDeveloper' in settings, false);
    const summary = providerImportSummary(settings);
    assert.equal('contextWindowTokens' in summary, false);
    assert.equal(summary.supportsDeveloper, false);
    const body = providerProfileBody(settings);
    assert.equal('contextWindowTokens' in body, false);
    assert.equal('supportsDeveloper' in body, false);
    assert.equal(body.mode, 'live');
    assert.equal(body.authorizePaid, true);
});

test('an explicit developer-message flag is carried as a boolean', () => {
    const settings = parseProviderImport(importText({ supportsDeveloper: true }));
    assert.equal(settings.supportsDeveloper, true);
    assert.equal(providerImportSummary(settings).supportsDeveloper, true);
    assert.equal(providerProfileBody(settings).supportsDeveloper, true);
});

test('strings are trimmed and the endpoint normalizes deterministically through URL.href', () => {
    const credentialFile = keyFile();
    const base = { name: 'Padded', providerLabel: 'Padded provider', baseUrl: 'https://example.com/v1', model: 'example/model', credentialFile, maxRequests: 2, authorizeDays: 3 };
    assert.equal(parseProviderImport(JSON.stringify({ ...base, name: '  Padded  ', providerLabel: '  Label  ', model: '  model  ' })).name, 'Padded');
    assert.equal(parseProviderImport(JSON.stringify({ ...base, providerLabel: '  Label  ' })).providerLabel, 'Label');
    assert.equal(parseProviderImport(JSON.stringify({ ...base, model: '  model  ' })).model, 'model');
    // WHATWG URL: host name is lower-cased, the default :443 port is dropped and a bare origin gains one trailing slash.
    assert.equal(parseProviderImport(JSON.stringify({ ...base, baseUrl: 'https://API.Example.COM:443/v1' })).baseUrl, 'https://api.example.com/v1');
    assert.equal(parseProviderImport(JSON.stringify({ ...base, baseUrl: 'https://example.com' })).baseUrl, 'https://example.com/');
    assert.equal(parseProviderImport(JSON.stringify({ ...base, baseUrl: '  https://example.com/v1  ' })).baseUrl, 'https://example.com/v1');
});

test('non-HTTPS, credential-bearing, query, fragment and relative endpoints are rejected', () => {
    const credentialFile = keyFile();
    const base = { name: 'Endpoint', providerLabel: 'Endpoint', model: 'example/model', credentialFile, maxRequests: 2, authorizeDays: 3 };
    for (const [label, baseUrl] of [
        ['http', 'http://example.com/v1'], ['ftp', 'ftp://example.com/v1'],
        ['user and password', 'https://TEST_ONLY_USER:TEST_ONLY_PASSWORD@example.com/v1'], ['user only', 'https://user@example.com/v1'],
        ['query', 'https://example.com/v1?key=1'], ['fragment', 'https://example.com/v1#section'],
        ['relative', 'example.com/v1'], ['scheme only', 'https://'], ['text', 'not a url'],
    ] as const) rejects(JSON.stringify({ ...base, baseUrl }), /baseUrl/, `rejects ${label} endpoint`);
    rejects(JSON.stringify({ ...base, baseUrl: 42 }), /baseUrl/, 'rejects numeric endpoint');
    rejects(JSON.stringify({ ...base, baseUrl: '   ' }), /baseUrl/, 'rejects blank endpoint');
});

test('credentialFile must be an existing regular local file of 1..8192 bytes', () => {
    const settings = (credentialFile: unknown): string => JSON.stringify({
        name: 'Credential', providerLabel: 'Credential', baseUrl: 'https://example.com/v1', model: 'example/model',
        credentialFile, maxRequests: 1, authorizeDays: 1,
    });
    rejects(settings('keys/provider.key'), /credentialFile/, 'relative path');
    rejects(settings('\\\\server\\share\\provider.key'), /UNC|device/, 'UNC share');
    rejects(settings('\\\\?\\J:\\provider.key'), /UNC|device/, 'device path');
    rejects(settings(path.parse(worktree).root), /volume root/, 'volume root');
    rejects(settings('C:\\Windows\\System32\\drivers\\etc\\hosts'), /credentialFile/, 'another volume');
    rejects(settings(fixtureRoot), /regular file/, 'directory');
    rejects(settings(keyFile({ size: 0 })), /empty/, 'zero-byte file');
    rejects(settings(keyFile({ size: 8193 })), /8192/, 'oversized file');
    rejects(settings(''), /required/, 'blank path');
    rejects(settings('   '), /required/, 'whitespace path');
    rejects(settings(`J:\\scratch\\bad\u0000.key`), /NUL/, 'NUL in path');
    rejects(settings(42), /credentialFile/, 'non-string path');
    // The exact size bounds are accepted (a one-byte file and an 8192-byte file).
    assert.equal(parseProviderImport(settings(keyFile({ size: 1 }))).credentialFile.length > 0, true);
    assert.equal(parseProviderImport(settings(keyFile({ size: 8192 }))).credentialFile.length > 0, true);
});

test('a credential path through a junction is refused', t => {
    const realDirectory = path.join(fixtureRoot, 'real-keys');
    mkdirSync(realDirectory, { recursive: true });
    writeFileSync(path.join(realDirectory, 'provider.key'), FAKE_KEY);
    const link = path.join(fixtureRoot, 'linked-keys');
    try {
        symlinkSync(realDirectory, link, 'junction');
    } catch {
        // Creating junctions needs a Windows privilege this account may lack; the shared path gate is covered by existing tests.
        t.skip('junction creation is not permitted for this account');
        return;
    }
    const text = JSON.stringify({
        name: 'Junction', providerLabel: 'Junction', baseUrl: 'https://example.com/v1', model: 'example/model',
        credentialFile: path.join(link, 'provider.key'), maxRequests: 1, authorizeDays: 1,
    });
    rejects(text, /junction|symbolic/i, 'junction segment');
});

test('unknown, credential-bearing and prototype-polluting fields are rejected', () => {
    for (const key of ['apiKey', 'api_key', 'API_KEY', 'authorization', 'headers', 'credentials', 'secret', 'token', 'password']) {
        rejects(importText({ [key]: FAKE_KEY }), /(?:unknown|credential)/i, `rejects ${key}`);
    }
    rejects(importText({ mode: 'live' }), /Unknown provider import field "mode"/, 'rejects an unknown structural field');
    rejects(importText({ provider: { baseUrl: 'https://example.com' } }), /Unknown provider import field "provider"/, 'rejects a nested provider object');
    for (const key of ['__proto__', 'prototype', 'constructor']) {
        const text = importText().replace(/^\{/, `{"${key}": {"polluted": true},`);
        rejects(text, new RegExp('"' + key + '"'), 'prototype-polluting field');
    }
});

test('strict field types are required: no coercion, no string numbers, no non-integers', () => {
    const cases: [string, unknown, RegExp][] = [
        ['name', 7, /name must be a string/],
        ['providerLabel', true, /providerLabel must be a string/],
        ['model', null, /model must be a string/],
        ['maxRequests', '5', /maxRequests/],
        ['authorizeDays', '7', /authorizeDays/],
        ['maxRequests', 1.5, /maxRequests/],
        ['authorizeDays', 2.25, /authorizeDays/],
        ['contextWindowTokens', '128000', /contextWindowTokens/],
        ['supportsDeveloper', 'false', /supportsDeveloper/],
        ['maxRequests', 0, /maxRequests/],
    ];
    for (const [field, value, expected] of cases) rejects(importText({ [field]: value }), expected, `rejects ${field}=${String(value)}`);
    // JSON has no NaN literal; 1e400 parses to Infinity and must be refused as a non-integer.
    rejects(importText({ maxRequests: 100 }).replace('"maxRequests":100', '"maxRequests":1e400'), /maxRequests/, 'rejects Infinity');
});

test('every string bound and numeric bound is enforced at both edges', () => {
    const accept = (overrides: Record<string, unknown>): ProviderImportSettings => parseProviderImport(importText(overrides));
    assert.equal(accept({ name: 'n'.repeat(100) }).name.length, 100);
    assert.equal(accept({ name: 'x' }).name, 'x');
    rejects(importText({ name: '' }), /name/, 'empty name');
    rejects(importText({ name: '   ' }), /name/, 'blank name');
    rejects(importText({ name: 'n'.repeat(101) }), /name/, 'name too long');
    assert.equal(accept({ providerLabel: 'p'.repeat(64) }).providerLabel.length, 64);
    rejects(importText({ providerLabel: '' }), /providerLabel/, 'empty label');
    rejects(importText({ providerLabel: 'p'.repeat(65) }), /providerLabel/, 'label too long');
    assert.equal(accept({ model: 'm'.repeat(200) }).model.length, 200);
    rejects(importText({ model: '' }), /model/, 'empty model');
    rejects(importText({ model: 'm'.repeat(201) }), /model/, 'model too long');
    assert.equal(accept({ maxRequests: 1 }).maxRequests, 1);
    assert.equal(accept({ maxRequests: 1000000 }).maxRequests, 1000000);
    rejects(importText({ maxRequests: 0 }), /maxRequests/, 'zero request limit');
    rejects(importText({ maxRequests: 1000001 }), /maxRequests/, 'request limit above the maximum');
    assert.equal(accept({ authorizeDays: 1 }).authorizeDays, 1);
    assert.equal(accept({ authorizeDays: 30 }).authorizeDays, 30);
    rejects(importText({ authorizeDays: 0 }), /authorizeDays/, 'zero authorization days');
    rejects(importText({ authorizeDays: 31 }), /authorizeDays/, 'authorization days above the maximum');
    assert.equal(accept({ contextWindowTokens: 1 }).contextWindowTokens, 1);
    assert.equal(accept({ contextWindowTokens: 10000000 }).contextWindowTokens, 10000000);
    rejects(importText({ contextWindowTokens: 0 }), /contextWindowTokens/, 'zero context window');
    rejects(importText({ contextWindowTokens: 10000001 }), /contextWindowTokens/, 'context window above the maximum');
});

test('the document is bounded to 65536 UTF-8 bytes and rejects NUL, BOM and non-object JSON', () => {
    assert.equal(PROVIDER_IMPORT_MAX_BYTES, 65536);
    const credentialFile = keyFile();
    const base = { name: 'Bound', providerLabel: 'Bound', baseUrl: 'https://example.com/', model: 'example/model', credentialFile, maxRequests: 1, authorizeDays: 1 };
    const unpadded = JSON.stringify({ ...base });
    const padding = PROVIDER_IMPORT_MAX_BYTES - Buffer.byteLength(unpadded, 'utf8');
    assert.ok(padding > 0);
    const exact = JSON.stringify({ ...base, baseUrl: base.baseUrl + 'p'.repeat(padding) });
    assert.equal(Buffer.byteLength(exact, 'utf8'), PROVIDER_IMPORT_MAX_BYTES);
    assert.equal(parseProviderImport(exact).baseUrl.length, base.baseUrl.length + padding);
    rejects(JSON.stringify({ ...base, baseUrl: base.baseUrl + 'p'.repeat(padding + 1) }), /65536/, 'one byte over the limit');
    rejects('x'.repeat(PROVIDER_IMPORT_MAX_BYTES + 1), /65536/, 'plain oversized document');
    rejects('{"name":"a\u0000"}', /NUL/, 'NUL character');
    rejects('\uFEFF' + importText(), /byte-order mark/, 'UTF-8 BOM');
    for (const text of ['[]', 'null', '"text"', '42', 'true']) rejects(text, /single JSON object/, `non-object document ${text}`);
    for (const text of ['{"name":', '{"name":"x"', '{"name":"x",}', 'not json', '']) rejects(text, /valid JSON/, `malformed document ${JSON.stringify(text)}`);
    rejects(null, /UTF-8 JSON text/, 'null input');
    rejects(42, /UTF-8 JSON text/, 'numeric input');
    rejects(Buffer.from(importText()).toString('utf8') + 'trailing', /valid JSON/, 'trailing garbage');
});

test('the profile body carries the credential path and no secret-bearing keys', () => {
    const settings = parseProviderImport(importText({ contextWindowTokens: 128000, supportsDeveloper: false }));
    const body = providerProfileBody(settings);
    assert.equal(body.credentialFile, settings.credentialFile);
    assert.deepEqual(Object.keys(body).sort(), [
        'authorizeDays', 'authorizePaid', 'baseUrl', 'contextWindowTokens', 'credentialFile', 'maxRequests', 'mode', 'model', 'name', 'supportsDeveloper',
    ]);
    for (const key of ['apiKey', 'api_key', 'authorization', 'headers', 'credentials', 'secret', 'token', 'password']) {
        assert.equal(key in body, false, `body must not carry ${key}`);
    }
    assert.equal(body.mode, 'live');
    assert.equal(body.authorizePaid, true);
    const serialized = JSON.stringify(body) + JSON.stringify(providerImportSummary(settings));
    assert.equal(serialized.includes(FAKE_KEY), false, 'neither body nor summary may contain the key file contents');
});

test('error messages never echo the credential file contents', () => {
    const credentialFile = keyFile();
    for (const overrides of [{ model: '' }, { baseUrl: 'http://example.com' }, { maxRequests: 0 }, { name: 'n'.repeat(500) }]) {
        const text = JSON.stringify({ ...template(), credentialFile, ...overrides });
        assert.throws(() => parseProviderImport(text), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message.includes(FAKE_KEY), false);
            return true;
        });
    }
    const oversized = keyFile({ size: 9000 });
    const text = JSON.stringify({ ...template(), credentialFile: oversized });
    assert.throws(() => parseProviderImport(text), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes('kkkkkkkk'), false);
        return true;
    });
});

test('the module has no network, model or credential-reading calls', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(/, 'no fetch');
    assert.doesNotMatch(source, /from 'node:(?:http|https|net|tls|dns|child_process)'(?:;|\s)/, 'no network or process modules');
    assert.doesNotMatch(source, /\b(readFileSync|readFile|createReadStream)\s*\(/, 'never reads file contents');
    assert.doesNotMatch(source, /ModelClient|runtime\/model\.js/, 'no model client');
    assert.doesNotMatch(source, /XMLHttpRequest|WebSocket|require\s*\(/, 'no alternate transports');
    assert.match(source, /statSync\(/, 'statistics are the only credential-file inspection');
    assert.match(source, /assertLocalPath\(/, 'reuses the shared local-path gate');
    assert.match(source, /new URL\(/, 'endpoint validation uses the platform URL parser');
});
