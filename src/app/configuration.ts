import { discoverModels } from '../runtime/model-directory.js';
import { wireSettings } from '../runtime/provider-wire.js';
import { ModelClient, DEFAULT_PROVIDER, type ModelObserver } from '../runtime/model.js';
import type { RequestContext } from '../harness/types.js';
import type { ProviderConfig } from '../contracts.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeAtomicJson } from './atomic-json.js';
import { assertLocalPath, isLocalPath } from './local-paths.js';
interface RequestAllowance { limit: number; used: number; expiresAt: number }
/** Secrets stay in memory or an explicitly selected external file, never in settings. */
export class Configuration {
    private credential = '';
    private credentialFile = '';
    private allowance: RequestAllowance = { limit: 0, used: 0, expiresAt: 0 };
    provider: ProviderConfig;
    globalPaths: string[] = [];
    skillRoots: string[] = [];
    configurationError?: string;
    modelObserver?: (context: RequestContext, config: ProviderConfig) => ModelObserver;
    constructor(readonly mockUrl: string, private readonly dataDir?: string) {
        this.provider = { ...DEFAULT_PROVIDER, baseUrl: mockUrl, mode: 'mock' };
        if (dataDir && existsSync(path.join(dataDir, 'configuration.json'))) {
            try {
                const saved = JSON.parse(readFileSync(path.join(dataDir, 'configuration.json'), 'utf8'));
                if (!saved.provider || !['mock', 'live'].includes(saved.provider.mode) || !Array.isArray(saved.globalPaths) || !Array.isArray(saved.skillRoots)) throw new Error('Invalid saved configuration shape.');
                if (saved.allowance !== undefined) {
                    const { limit, used, expiresAt } = saved.allowance;
                    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000000 || !Number.isSafeInteger(used) || used < 0 || used > limit || !Number.isSafeInteger(expiresAt) || expiresAt < 0) throw new Error('Invalid request allowance.');
                }
                this.set({ ...saved.provider, credentialFile: saved.credentialFile ?? '', globalPaths: saved.globalPaths, skillRoots: saved.skillRoots }, false);
                this.allowance = saved.allowance ?? this.allowance;
            } catch {
                this.configurationError = 'Saved configuration is invalid. The original file is preserved; mock mode is available so you can repair settings.';
                this.provider = { ...DEFAULT_PROVIDER, baseUrl: mockUrl, mode: 'mock' };
                this.globalPaths = []; this.skillRoots = [];
            }
        }
    }
    view() {
        return { provider: this.provider, globalPaths: this.globalPaths, skillRoots: this.skillRoots, liveDefaults: DEFAULT_PROVIDER,
            credentialPresent: Boolean(this.credential), credentialFile: this.credentialFile,
            remainingLiveRequests: this.allowance.limit - this.allowance.used,
            authorizationExpiresAt: this.allowance.expiresAt ? new Date(this.allowance.expiresAt).toISOString() : null,
            configurationError: this.configurationError };
    }
    set(input: Record<string, unknown>, persist = true) {
        const mode = input.mode === 'live' ? 'live' : 'mock';
        const baseUrl = mode === 'mock' ? this.mockUrl : String(input.baseUrl ?? DEFAULT_PROVIDER.baseUrl);
        const url = new URL(baseUrl);
        if (mode === 'live' && (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash))
            throw new Error('Live provider requires an HTTPS base URL without credentials, query parameters or a fragment.');
        const nextProvider = { ...this.provider, ...(input.wire ? { wire: wireSettings(input.wire) } : {}), mode: mode as 'live' | 'mock', baseUrl, model: String(input.model ?? DEFAULT_PROVIDER.model), maxOutputTokens: Number(input.maxOutputTokens ?? this.provider.maxOutputTokens), maxRequestBytes: Number(input.maxRequestBytes ?? this.provider.maxRequestBytes ?? 131072), supportsDeveloper: input.supportsDeveloper === undefined ? this.provider.supportsDeveloper ?? false : input.supportsDeveloper === true };
        if (!Number.isInteger(nextProvider.maxOutputTokens) || nextProvider.maxOutputTokens < 64 || nextProvider.maxOutputTokens > 131072)
            throw new Error('Output token limit must be an integer between 64 and 131072.');
        if (!Number.isInteger(nextProvider.maxRequestBytes) || nextProvider.maxRequestBytes < 4096 || nextProvider.maxRequestBytes > 262144)
            throw new Error('Request byte limit must be an integer between 4096 and 262144.');
        const contextValue = input.contextWindowTokens === undefined ? (nextProvider.model === this.provider.model ? this.provider.contextWindowTokens : undefined) : input.contextWindowTokens;
        const contextWindowTokens = contextValue === null || contextValue === '' ? undefined : contextValue === undefined ? undefined : Number(contextValue);
        if (contextWindowTokens !== undefined && (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1)) throw new Error('Context window must be a positive integer, or empty if unknown.');
        const nextPaths = { globalPaths: this.globalPaths, skillRoots: this.skillRoots };
        for (const name of ['globalPaths', 'skillRoots'] as const) {
            if (input[name] !== undefined) {
                if (!Array.isArray(input[name]) || input[name].some(value => !isLocalPath(value)))
                    throw new Error(`${name} must be explicit absolute paths on the volume that hosts this installation.`);
                nextPaths[name] = input[name] as string[];
            }
        }
        const endpointChanged = baseUrl !== this.provider.baseUrl || JSON.stringify(nextProvider.wire) !== JSON.stringify(this.provider.wire);
        const providerChanged = endpointChanged || nextProvider.baseUrl !== this.provider.baseUrl || nextProvider.model !== this.provider.model;
        let allowance = providerChanged ? { limit: 0, used: 0, expiresAt: 0 } : this.allowance;
        if (input.authorizePaid === true) {
            const limit = Number(input.maxRequests);
            const days = Number(input.authorizeDays ?? 20);
            if (!Number.isInteger(limit) || limit < 1 || limit > 1000000)
                throw new Error('Request allowance must be an integer between 1 and 1000000.');
            if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('Authorization duration must be between 1 and 30 days.');
            allowance = { limit, used: 0, expiresAt: Date.now() + days * 86400000 };
        }
        let credentialFile = input.credentialFile === undefined ? (endpointChanged ? '' : this.credentialFile) : String(input.credentialFile).trim();
        let credential = endpointChanged ? '' : this.credential;
        if (input.credentialFile !== undefined) credential = credentialFile ? this.readCredentialFile(credentialFile) : '';
        if (typeof input.apiKey === 'string' && input.apiKey.trim()) { credential = input.apiKey.trim(); credentialFile = ''; }
        const sanitize = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' && credential ? item.split(credential).join('[credential redacted]') : item));
        const next = { provider: sanitize({ ...nextProvider, contextWindowTokens }), ...sanitize(nextPaths), credentialFile, allowance };
        if (this.dataDir && persist) writeAtomicJson(path.join(this.dataDir, 'configuration.json'), next);
        this.credential = credential;
        this.credentialFile = credentialFile;
        this.provider = next.provider;
        this.globalPaths = next.globalPaths;
        this.skillRoots = next.skillRoots;
        this.allowance = allowance;
        this.configurationError = undefined;
        return this.view();
    }
    discover(base: string, wire: import('../runtime/provider-wire.js').WireSettings, key?: string) {
        const same = this.provider.mode === 'live' && new URL(base).href === new URL(this.provider.baseUrl).href;
        return discoverModels(base, wire, key || (same ? this.credential : undefined));
    }
    client(context?: RequestContext, overrides: Partial<ProviderConfig> = {}, observerOverride?: ModelObserver): ModelClient {
        const config = { ...this.provider, ...overrides, baseUrl: this.provider.baseUrl, mode: this.provider.mode };
        // The credential is requested only after admission, body validation and cancellation checks,
        // immediately before fetch. An unused adapter is free; every reuse is a separate attempt.
        return new ModelClient(config, () => {
            if (config.mode !== this.provider.mode || config.baseUrl !== this.provider.baseUrl || config.model !== this.provider.model || JSON.stringify(config.wire) !== JSON.stringify(this.provider.wire))
                throw new Error('The provider changed after this request was prepared. Prepare it again using the current profile.');
            if (this.allowance.used >= this.allowance.limit)
                throw new Error('Paid requests are blocked. Configure an explicit request allowance in Settings.');
            if (Date.now() >= this.allowance.expiresAt) throw new Error('Provider authorization expired. Renew the allowance in Settings.');
            if (this.credentialFile) this.credential = this.readCredentialFile(this.credentialFile);
            if (!this.credential) throw new Error('A provider credential is required before sending a live request.');
            const allowance = { ...this.allowance, used: this.allowance.used + 1 };
            // Persist the attempt before dispatch; a crash must not restore spent requests.
            if (this.dataDir) writeAtomicJson(path.join(this.dataDir, 'configuration.json'), {
                provider: this.provider, globalPaths: this.globalPaths, skillRoots: this.skillRoots, credentialFile: this.credentialFile, allowance,
            });
            this.allowance = allowance;
            return this.credential;
        }, observerOverride ?? (context ? this.modelObserver?.(context, config) : undefined));
    }
    private readCredentialFile(filename: string): string {
        try {
            const file = assertLocalPath(filename, 'Credential file');
            if (!statSync(file).isFile() || statSync(file).size > 8192) throw new Error('Invalid credential file.');
            const value = readFileSync(file, 'utf8').trim();
            if (!value || /\s/.test(value)) throw new Error('Expected one credential without whitespace.');
            return value;
        } catch { throw new Error('Cannot read credential file. Select a regular local file containing only the API key.'); }
    }
    redact(value: string): string {
        return this.credential ? value.split(this.credential).join('[credential redacted]') : value;
    }
    sanitize<T>(value: T): T {
        return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? this.redact(item) : item)) as T;
    }
}
