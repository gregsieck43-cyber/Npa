import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { BackendGateway } from '../src/desktop/backend-connection.js';
import { formatProviderImportConfirmation, performProviderImport } from '../src/desktop/provider-import.js';
import { parseProviderImport, type ProviderImportSettings } from '../src/desktop/provider-connection.js';

function fixture() {
    const root = mkdtempSync(path.resolve('.tmp', 'desktop-provider-import-'));
    const credentialFile = path.join(root, 'fixture.key');
    writeFileSync(credentialFile, 'fixture-only-value', 'utf8');
    return { root, credentialFile };
}

function document(credentialFile: string): Record<string, unknown> {
    return {
        name: 'Fixture live profile',
        providerLabel: 'Fixture provider',
        baseUrl: 'https://api.example.test/v1',
        model: 'fixture-model-1',
        credentialFile,
        maxRequests: 25,
        authorizeDays: 3,
        contextWindowTokens: 32768,
        supportsDeveloper: true,
    };
}

test('a confirmed import saves exactly the non-secret provider-profile fields', async t => {
    const { root, credentialFile } = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const confirmed: ProviderImportSettings[] = [];
    const saved: Record<string, unknown>[] = [];
    const outcome = await performProviderImport({
        text: JSON.stringify(document(credentialFile)),
        confirm: async settings => { confirmed.push(settings); return true; },
        save: async body => { saved.push(body); return { id: 'provider-fixture' }; },
    });
    assert.equal(outcome.status, 'imported');
    assert.deepEqual(outcome.profile, { id: 'provider-fixture' });
    assert.equal(confirmed.length, 1);
    assert.equal(saved.length, 1);
    const body = saved[0];
    assert.equal(body.mode, 'live');
    assert.equal(body.baseUrl, 'https://api.example.test/v1');
    assert.equal(body.model, 'fixture-model-1');
    assert.equal(body.credentialFile, credentialFile);
    assert.equal(body.authorizePaid, true);
    assert.equal(body.maxRequests, 25);
    assert.equal(body.authorizeDays, 3);
    assert.equal(body.contextWindowTokens, 32768);
    assert.equal(body.supportsDeveloper, true);
    const secretKeys = ['apikey', 'api_key', 'api-key', 'authorization', 'auth', 'bearer', 'headers', 'header', 'credentials', 'credential', 'secret', 'token'];
    assert.ok(!Object.keys(body).some(key => secretKeys.includes(key.toLowerCase())));
    assert.ok(!JSON.stringify(body).includes('fixture-only-value'));
});

test('a cancelled confirmation saves nothing', async t => {
    const { root, credentialFile } = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let saves = 0;
    const outcome = await performProviderImport({
        text: JSON.stringify(document(credentialFile)),
        confirm: async () => false,
        save: async () => { saves += 1; return { id: 'must-not-be-saved' }; },
    });
    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.profile, undefined);
    assert.equal(saves, 0);
});

test('an invalid document never reaches confirmation or save', async t => {
    const { root, credentialFile } = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let confirms = 0;
    let saves = 0;
    await assert.rejects(performProviderImport({
        text: JSON.stringify({ ...document(credentialFile), apiKey: 'fixture-only-value' }),
        confirm: async () => { confirms += 1; return true; },
        save: async () => { saves += 1; return {}; },
    }), /cannot carry "apiKey"/);
    assert.equal(confirms, 0);
    assert.equal(saves, 0);
});

test('the confirmation shows non-secret facts and never the credential content', async t => {
    const { root, credentialFile } = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const settings = parseProviderImport(JSON.stringify(document(credentialFile)));
    const confirmation = formatProviderImportConfirmation(settings);
    assert.equal(confirmation.message, '确认导入模型连接');
    assert.match(confirmation.detail, /https:\/\/api\.example\.test\/v1/);
    assert.match(confirmation.detail, /fixture-model-1/);
    assert.match(confirmation.detail, /25 次 \/ 授权 3 天/);
    assert.ok(confirmation.detail.includes(credentialFile));
    assert.match(confirmation.detail, /不会发起任何模型请求/);
    assert.ok(!confirmation.detail.includes('fixture-only-value'));
    assert.ok(!confirmation.detail.includes('apiKey'));
});

test('a save failure is reported and the import is not claimed as imported', async t => {
    const { root, credentialFile } = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let confirms = 0;
    await assert.rejects(performProviderImport({
        text: JSON.stringify(document(credentialFile)),
        confirm: async () => { confirms += 1; return true; },
        save: async () => { throw new Error('The backend rejected the model configuration (HTTP 400).'); },
    }), /HTTP 400/);
    assert.equal(confirms, 1);
});

test('the import persists through the real Profiles authority, survives a restart and never calls a model', { timeout: 90_000 }, async t => {
    const root = mkdtempSync(path.resolve('.tmp', 'desktop-provider-import-http-'));
    const credentialFile = path.join(root, 'fixture.key');
    const secret = 'fixture-only-value';
    writeFileSync(credentialFile, secret, 'utf8');
    const dataDir = path.join(root, 'data');
    const trace: unknown[] = [];
    let backend = await startBackend({ dataDir, projectRoot: process.cwd(), mockOptions: { trace: (body: unknown) => trace.push(body) } });
    t.after(async () => { await backend.close(); rmSync(root, { recursive: true, force: true }); });
    const text = JSON.stringify({ ...document(credentialFile), name: 'Native import HTTP fixture' });
    let launches = 0;
    const gateway = new BackendGateway({ dataDir, launch: async () => { launches += 1; return { port: backend.port, token: backend.token }; } });
    await gateway.ensure();
    const outcome = await performProviderImport({
        text,
        confirm: async () => true,
        save: async body => {
            const saved = await gateway.request('POST', '/v1/harness/profiles', body);
            if ((saved.httpStatus !== undefined && Number(saved.httpStatus) >= 400) || saved.error)
                throw new Error(String(saved.error ?? 'The backend rejected the model configuration.'));
            return saved;
        },
    });
    assert.equal(outcome.status, 'imported');
    assert.equal(launches, 1);
    const profile = outcome.profile as {
        id: string; name: string; provider: { mode: string; baseUrl: string; model: string };
        credentialPresent: boolean; credentialFile: string; remainingLiveRequests: number; authorizationExpiresAt: string | null;
    };
    assert.equal(profile.name, 'Native import HTTP fixture');
    assert.match(profile.id, /^provider-[a-f0-9-]+$/);
    assert.equal(profile.provider.mode, 'live');
    assert.equal(profile.provider.baseUrl, 'https://api.example.test/v1');
    assert.equal(profile.provider.model, 'fixture-model-1');
    assert.equal(profile.credentialPresent, true);
    assert.equal(profile.credentialFile, credentialFile);
    assert.equal(profile.remainingLiveRequests, 25);
    assert.ok(profile.authorizationExpiresAt);
    assert.ok(!JSON.stringify(profile).includes(secret), 'the profile view never contains the credential value');
    assert.equal(trace.length, 0, 'importing a configuration must not make any model request');
    const persistedFile = path.join(dataDir, 'profiles', profile.id, 'configuration.json');
    assert.ok(existsSync(persistedFile));
    const persisted = readFileSync(persistedFile, 'utf8');
    assert.ok(persisted.includes('"credentialFile"'));
    assert.ok(persisted.includes(credentialFile.replace(/\\/g, '\\\\')), 'the persisted configuration keeps the explicit credential file path');
    assert.ok(!persisted.includes(secret), 'the persisted configuration never stores the credential value');

    await backend.close();
    backend = await startBackend({ dataDir, projectRoot: process.cwd() });
    const restarted = new BackendGateway({ dataDir, launch: async () => { throw new Error('A restart must not launch a backend.'); } });
    const listed = await restarted.request('GET', '/v1/harness/profiles');
    const profiles = (listed as { profiles?: any[] }).profiles ?? [];
    const restored = profiles.find(item => item.id === profile.id);
    assert.ok(restored, 'the imported profile is listed after a backend restart');
    assert.equal(restored.name, 'Native import HTTP fixture');
    assert.equal(restored.credentialPresent, true);
    assert.equal(restored.credentialFile, credentialFile);
    assert.equal(restored.remainingLiveRequests, 25);
    assert.ok(!JSON.stringify(profiles).includes(secret));
    assert.equal(trace.length, 0, 'listing profiles after restart makes no model request');
});

test('the completion message points at 设置 → 模型 without demanding an application restart', async () => {
    const module = await import('../src/desktop/provider-import.js') as Record<string, unknown>;
    assert.equal(typeof module.formatProviderImportCompletion, 'function', 'the completion text must come from the import module');
    const completion = (module.formatProviderImportCompletion as (profileId?: string) => { message: string; detail: string })('provider-fixture');
    assert.match(completion.message, /设置 → 模型/);
    assert.doesNotMatch(completion.message + '\n' + completion.detail, /重新启动/);
    assert.match(completion.detail, /后台.*读取|读取该文件/);
    assert.match(completion.detail, /内存/);
    assert.match(completion.detail, /只.*路径|路径.*写入配置/);
    assert.match(completion.detail, /不会.*日志|不记录/);
    assert.match(completion.detail, /不会发起任何模型请求/);
});

test('the confirmation states the save-time credential read honestly', async t => {
    const { root, credentialFile } = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const confirmation = formatProviderImportConfirmation(parseProviderImport(JSON.stringify(document(credentialFile))));
    assert.match(confirmation.detail, /后台.*读取/);
    assert.match(confirmation.detail, /内存/);
    assert.doesNotMatch(confirmation.detail, /校验凭据/);
    assert.ok(!confirmation.detail.includes('fixture-only-value'));
});

test('desktop main shows the truthful completion and neither source claims the file is unread', () => {
    const main = readFileSync(path.resolve('src', 'desktop', 'main.ts'), 'utf8');
    assert.ok(main.includes('formatProviderImportCompletion'), 'main must use the import module completion text');
    assert.ok(!main.includes('重新启动 NPN-Gamma'), 'main must not require restarting the whole application');
    const source = readFileSync(path.resolve('src', 'desktop', 'provider-import.ts'), 'utf8');
    assert.ok(!source.includes('Nothing here reads the credential file'), 'the background save reads the explicit credential file');
});

test('unknown-field parser errors name the field and never echo JSON values', t => {
    const { root, credentialFile } = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.throws(() => parseProviderImport(JSON.stringify({ ...document(credentialFile), extraSecret: 'sk-must-never-appear' })), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /extraSecret/);
        assert.ok(!message.includes('sk-must-never-appear'));
        return true;
    });
});


