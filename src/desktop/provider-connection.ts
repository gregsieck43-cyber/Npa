import { statSync, type Stats } from 'node:fs';
import path from 'node:path';
import { assertLocalPath, isLocalPath } from '../app/local-paths.js';

/**
 * Native provider import: the pure parse/adapt layer behind the native
 * "NPN-Gamma -> 导入模型配置…" action.
 *
 * The renderer's model editor cannot collect an endpoint, a credential-file path or a paid
 * request allowance, so the desktop shell imports one small JSON document instead, shows the
 * non-secret facts in a native confirmation, and submits the same facts to the existing backend
 * authority (`POST /v1/harness/profiles` -> `Profiles.save` -> `Configuration.set`). This module
 * only validates that document and shapes the request: it never reads the credential file (only
 * its path metadata). Saving the profile through Configuration reads that explicit file into
 * memory, persists only the path, and never calls a model; no secret is ever logged.
 *
 * Endpoint normalization is deterministic: the trimmed string is parsed by the WHATWG URL
 * parser and stored as `URL.href`. That lower-cases the host, drops the default `:443` port and
 * leaves exactly one trailing slash on a bare origin, so one document always yields one endpoint.
 */

export interface ProviderImportSettings {
    name: string;
    providerLabel: string;
    baseUrl: string;
    model: string;
    credentialFile: string;
    maxRequests: number;
    authorizeDays: number;
    contextWindowTokens?: number;
    supportsDeveloper?: boolean;
}

/** One API key file is read by Configuration as a single token and capped at 8192 bytes there too. */
const CREDENTIAL_MAX_BYTES = 8192;
const NAME_MAX = 100;
const PROVIDER_LABEL_MAX = 64;
const MODEL_MAX = 200;
const MAX_REQUESTS = 1_000_000;
const AUTHORIZE_DAYS_MAX = 30;
const CONTEXT_WINDOW_MAX = 10_000_000;

export const PROVIDER_IMPORT_MAX_BYTES = 65536;

/** The complete import format; anything else is refused so a typo cannot silently change meaning. */
const FIELDS = [
    'name', 'providerLabel', 'baseUrl', 'model', 'credentialFile', 'maxRequests', 'authorizeDays',
    'contextWindowTokens', 'supportsDeveloper',
] as const;

/** Credentials never come from this file, so these names are refused before any value is read. */
const SECRET_FIELDS = new Set([
    'apikey', 'api_key', 'api-key', 'authorization', 'auth', 'bearer', 'headers', 'header',
    'credentials', 'credential', 'secret', 'token', 'access_token', 'refresh_token', 'password',
]);

/** JSON.parse keeps these as own keys; refusing them keeps object assembly free of prototype pollution. */
const PROTOTYPE_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);

function importRecord(text: unknown): Record<string, unknown> {
    if (typeof text !== 'string') throw new Error('The provider import must be UTF-8 JSON text.');
    if (text.includes('\0')) throw new Error('The provider import must not contain NUL characters.');
    if (Buffer.byteLength(text, 'utf8') > PROVIDER_IMPORT_MAX_BYTES)
        throw new Error(`The provider import is ${Buffer.byteLength(text, 'utf8')} bytes; the limit is ${PROVIDER_IMPORT_MAX_BYTES} bytes of UTF-8 JSON.`);
    if (text.startsWith('\uFEFF')) throw new Error('Save the provider import as UTF-8 JSON without a byte-order mark.');
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('The provider import is not valid JSON. Repair the braces, quotes and commas and try again.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('The provider import must be a single JSON object.');
    const record = parsed as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (PROTOTYPE_FIELDS.has(key)) throw new Error(`The provider import cannot contain the key "${key}".`);
        if (SECRET_FIELDS.has(key.toLowerCase()))
            throw new Error(`The provider import cannot carry "${key}": credentials are never read from this import file.`);
        if (!(FIELDS as readonly string[]).includes(key))
            throw new Error(`Unknown provider import field "${key}". Allowed fields: ${FIELDS.join(', ')}.`);
    }
    return record;
}

/** Strings are trimmed once and never coerced; a blank value is a missing value. */
function textField(record: Record<string, unknown>, key: 'name' | 'providerLabel' | 'model', maximum: number): string {
    const value = record[key];
    if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${key} is required and must not be blank.`);
    if (trimmed.length > maximum) throw new Error(`${key} must be at most ${maximum} characters.`);
    return trimmed;
}

function integerField(record: Record<string, unknown>, key: 'maxRequests' | 'authorizeDays', maximum: number): number {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new Error(`${key} must be an integer from 1 to ${maximum}.`);
    return value;
}

function optionalInteger(record: Record<string, unknown>, key: 'contextWindowTokens', maximum: number): number | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new Error(`${key} must be an integer from 1 to ${maximum}, or omitted when unknown.`);
    return value;
}

function optionalFlag(record: Record<string, unknown>, key: 'supportsDeveloper'): boolean | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
    return value;
}

/** HTTPS only, no embedded identity, query or fragment; stored as URL.href (see module comment). */
function endpoint(record: Record<string, unknown>): string {
    const value = record.baseUrl;
    if (typeof value !== 'string') throw new Error('baseUrl must be a string.');
    const raw = value.trim();
    if (!raw) throw new Error('baseUrl is required.');
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('baseUrl must be an absolute HTTPS URL, for example https://api.example.com/v1.');
    }
    if (url.protocol !== 'https:') throw new Error('baseUrl must use https:.');
    if (url.username || url.password) throw new Error('baseUrl must not embed a user name or password.');
    if (url.search) throw new Error('baseUrl must not contain a query string.');
    if (url.hash) throw new Error('baseUrl must not contain a fragment.');
    return url.href;
}

/**
 * An explicit absolute path to one existing key file on the installation volume. Only file
 * statistics are inspected: the key itself is read later by Configuration when a live request is
 * actually authorized, and never by this import.
 */
function credentialPath(record: Record<string, unknown>): string {
    const value = record.credentialFile;
    if (typeof value !== 'string') throw new Error('credentialFile must be a string path to a local key file.');
    const raw = value.trim();
    if (!raw) throw new Error('credentialFile is required.');
    if (raw.includes('\0')) throw new Error('credentialFile must not contain NUL characters.');
    if (/^[\\/]{2}/.test(raw)) throw new Error('credentialFile must not be a UNC share or a Windows device path.');
    if (!path.isAbsolute(raw)) throw new Error('credentialFile must be an absolute path.');
    const absolute = path.resolve(raw);
    if (absolute.toLowerCase() === path.parse(absolute).root.toLowerCase())
        throw new Error('credentialFile must name a key file, not a volume root.');
    if (!isLocalPath(raw)) throw new Error('credentialFile must be a local file on the volume that hosts this installation.');
    assertLocalPath(raw, 'Credential file');
    let stats: Stats | undefined;
    try {
        stats = statSync(absolute, { throwIfNoEntry: false });
    } catch {
        throw new Error('credentialFile cannot be inspected. Choose a key file this account can read.');
    }
    if (!stats || !stats.isFile()) throw new Error('credentialFile must point to an existing regular file, not a directory or a missing path.');
    if (stats.size < 1) throw new Error('credentialFile must not be empty.');
    if (stats.size > CREDENTIAL_MAX_BYTES) throw new Error(`credentialFile must be at most ${CREDENTIAL_MAX_BYTES} bytes.`);
    return absolute;
}

/**
 * Strictly validate one import document. Rejections name the offending field and its limit only;
 * they never repeat file contents or the submitted JSON, so a mis-placed key is not echoed.
 */
export function parseProviderImport(text: string): ProviderImportSettings {
    const record = importRecord(text);
    const settings: ProviderImportSettings = {
        name: textField(record, 'name', NAME_MAX),
        providerLabel: textField(record, 'providerLabel', PROVIDER_LABEL_MAX),
        baseUrl: endpoint(record),
        model: textField(record, 'model', MODEL_MAX),
        credentialFile: credentialPath(record),
        maxRequests: integerField(record, 'maxRequests', MAX_REQUESTS),
        authorizeDays: integerField(record, 'authorizeDays', AUTHORIZE_DAYS_MAX),
    };
    const contextWindowTokens = optionalInteger(record, 'contextWindowTokens', CONTEXT_WINDOW_MAX);
    if (contextWindowTokens !== undefined) settings.contextWindowTokens = contextWindowTokens;
    const supportsDeveloper = optionalFlag(record, 'supportsDeveloper');
    if (supportsDeveloper !== undefined) settings.supportsDeveloper = supportsDeveloper;
    return settings;
}

/** The non-secret facts the native confirmation shows; no credential value is involved. */
export function providerImportSummary(settings: ProviderImportSettings): {
    name: string; providerLabel: string; endpoint: string; model: string; requestLimit: number;
    authorizeDays: number; credentialFile: string; contextWindowTokens?: number; supportsDeveloper: boolean;
} {
    const summary: ReturnType<typeof providerImportSummary> = {
        name: settings.name,
        providerLabel: settings.providerLabel,
        endpoint: settings.baseUrl,
        model: settings.model,
        requestLimit: settings.maxRequests,
        authorizeDays: settings.authorizeDays,
        credentialFile: settings.credentialFile,
        supportsDeveloper: settings.supportsDeveloper === true,
    };
    if (settings.contextWindowTokens !== undefined) summary.contextWindowTokens = settings.contextWindowTokens;
    return summary;
}

/**
 * The exact body for `POST /v1/harness/profiles`: only the fields Configuration.set understands
 * plus the display name. It never carries an API key, headers or any other transport setting.
 */
export function providerProfileBody(settings: ProviderImportSettings): Record<string, unknown> {
    const body: Record<string, unknown> = {
        name: settings.name,
        mode: 'live',
        baseUrl: settings.baseUrl,
        model: settings.model,
        credentialFile: settings.credentialFile,
        authorizePaid: true,
        maxRequests: settings.maxRequests,
        authorizeDays: settings.authorizeDays,
    };
    if (settings.contextWindowTokens !== undefined) body.contextWindowTokens = settings.contextWindowTokens;
    if (settings.supportsDeveloper !== undefined) body.supportsDeveloper = settings.supportsDeveloper;
    return body;
}
