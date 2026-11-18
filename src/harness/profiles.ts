import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Configuration } from '../app/configuration.js';
import { DEFAULT_PROVIDER } from '../runtime/model.js';
import { HarnessStore } from './store.js';
import type { ProviderProfile } from './types.js';

/** Native model input modality; mirrors the frontend ModelInputType without importing UI code. */
export type ModelInputType = 'text' | 'image' | 'video' | 'pdf';
/** Native model capability; mirrors the frontend ModelCapability without importing UI code. */
export type ModelCapability = 'structuredOutput' | 'nativeWebSearch' | 'systemMessageInChat';
/** Reasoning mapping values are scalars only: templates never become request structure. */
export type ReasoningValue = number | boolean | string;

/**
 * Product-level model facts that a ProviderConfig cannot express. Credentials stay in
 * Configuration/credential files; these fields are labels, limits and reasoning templates.
 */
export interface ModelMetadata {
  providerLabel?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoning?: boolean;
  autoConfig?: boolean;
  inputTypes?: readonly ModelInputType[];
  capabilities?: readonly ModelCapability[];
  reasoningLevels?: readonly string[];
  reasoningMapping?: Readonly<Record<string, ReasoningValue>>;
}

export const MODEL_METADATA_LIMITS = {
  contextWindow: 10_000_000,
  maxOutputTokens: 64,
  maxOutputTokenLimit: 8192,
  reasoningLevels: 20,
  reasoningLevelChars: 64,
  mappingBytes: 16 * 1024,
  storeBytes: 256 * 1024,
} as const;

/** The only request parameters a reasoning mapping may set; everything else stays app-owned. */
export const REASONING_PARAMETERS = [
  'temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty',
  'repetition_penalty', 'reasoning_effort', 'reasoning', 'thinking', 'enable_thinking',
] as const;

/** Named so rejection messages explain why a shape is refused instead of looking like a typo. */
const FORBIDDEN_MAPPING_KEYS = [
  'messages', 'tools', 'model', 'baseUrl', 'apiKey', 'authorization', 'headers', 'stream',
  'stream_options', 'max_tokens', 'max_completion_tokens', 'endpoint', 'credentials', 'transport',
] as const;

const METADATA_KEYS = [
  'providerLabel', 'contextWindow', 'maxOutputTokens', 'supportsReasoning', 'autoConfig',
  'inputTypes', 'capabilities', 'reasoningLevels', 'reasoningMapping',
] as const;

const INPUT_TYPES: readonly ModelInputType[] = ['text', 'image', 'video', 'pdf'];
const CAPABILITIES: readonly ModelCapability[] = ['structuredOutput', 'nativeWebSearch', 'systemMessageInChat'];
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PROVIDER_ID = /^provider-[a-f0-9-]+$/;

const fail = (message: string): never => { throw new Error(message); };
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
};
const bytesOf = (value: unknown): number => {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return fail('value must be JSON-serializable.'); }
};

function parseEnumList<T extends string>(value: unknown, label: string, allowed: readonly T[], maximum: number): T[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  const items = value as unknown[];
  if (items.length > maximum) fail(`${label} must contain at most ${maximum} entries.`);
  const seen = new Set<string>(), result: T[] = [];
  for (const item of items) {
    if (typeof item !== 'string' || !(allowed as readonly string[]).includes(item))
      throw new Error(`${label} may only contain ${allowed.join(', ')}.`);
    if (seen.has(item)) throw new Error(`${label} must not repeat "${item}".`);
    seen.add(item); result.push(item as T);
  }
  return result;
}

function parseReasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) fail('reasoningLevels must be an array.');
  const items = value as unknown[];
  if (items.length > MODEL_METADATA_LIMITS.reasoningLevels)
    fail(`reasoningLevels must contain at most ${MODEL_METADATA_LIMITS.reasoningLevels} levels.`);
  const seen = new Set<string>(), result: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') throw new Error('Every reasoning level must be a string.');
    const level = item.trim();
    if (!level || level.length > MODEL_METADATA_LIMITS.reasoningLevelChars)
      fail(`Every reasoning level must be 1-${MODEL_METADATA_LIMITS.reasoningLevelChars} characters.`);
    if (seen.has(level)) fail(`Reasoning level "${level}" is repeated.`);
    seen.add(level); result.push(level);
  }
  return result;
}

/**
 * Reasoning mappings may only carry scalar request parameters. Arrays, nested objects,
 * prototype keys and transport/identity fields are refused here once, for both API input
 * and persisted settings, so no later merge can turn a template into request structure.
 */
function parseReasoningMapping(value: unknown): Record<string, ReasoningValue> {
  const input = record(value, 'reasoningMapping');
  const size = bytesOf(input);
  if (size > MODEL_METADATA_LIMITS.mappingBytes)
    fail(`reasoningMapping must be at most ${MODEL_METADATA_LIMITS.mappingBytes} bytes.`);
  const result: Record<string, ReasoningValue> = {};
  for (const key of Object.keys(input)) {
    if (POLLUTION_KEYS.has(key)) fail(`reasoningMapping cannot contain the key "${key}".`);
    if ((FORBIDDEN_MAPPING_KEYS as readonly string[]).includes(key))
      fail(`reasoningMapping cannot set "${key}": messages, tools, transport and credentials are not reasoning parameters.`);
    if (!(REASONING_PARAMETERS as readonly string[]).includes(key))
      fail(`reasoningMapping parameter "${key}" is not allowed. Allowed parameters: ${REASONING_PARAMETERS.join(', ')}.`);
    const item = input[key];
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail(`reasoningMapping.${key} must be a finite number.`);
    } else if (typeof item === 'string') {
      if (item.length > 64) fail(`reasoningMapping.${key} must be at most 64 characters.`);
    } else if (typeof item !== 'boolean') {
      fail(`reasoningMapping.${key} must be a number, boolean or string template; nested values are not merged into requests.`);
    }
    Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return Object.freeze(result);
}

function parseModelMetadata(value: unknown): ModelMetadata {
  const input = record(value, 'Model metadata');
  const size = bytesOf(input);
  if (size > MODEL_METADATA_LIMITS.storeBytes + MODEL_METADATA_LIMITS.mappingBytes)
    fail(`Model metadata is ${size} bytes; the limit is ${MODEL_METADATA_LIMITS.storeBytes + MODEL_METADATA_LIMITS.mappingBytes}.`);
  for (const key of Object.keys(input)) {
    if (POLLUTION_KEYS.has(key)) fail(`Model metadata cannot contain the key "${key}".`);
    if (!(METADATA_KEYS as readonly string[]).includes(key)) fail(`Unknown model metadata field: ${key}`);
  }
  const output: ModelMetadata = {};
  const text = (key: 'providerLabel', maximum: number): void => {
    const item = input[key];
    if (item === undefined) return;
    if (typeof item !== 'string') fail(`${key} must be 1-${maximum} characters.`);
    const trimmed = (item as string).trim();
    if (!trimmed || trimmed.length > maximum) fail(`${key} must be 1-${maximum} characters.`);
    output[key] = trimmed;
  };
  const integer = (key: 'contextWindow' | 'maxOutputTokens', minimum: number, maximum: number): void => {
    if (input[key] === undefined) return;
    const item = input[key]!;
    if (!Number.isSafeInteger(item) || (item as number) < minimum || (item as number) > maximum)
      fail(`${key} must be an integer from ${minimum} to ${maximum}.`);
    output[key] = item as number;
  };
  const flag = (key: 'supportsReasoning' | 'autoConfig'): void => {
    if (input[key] === undefined) return;
    if (typeof input[key] !== 'boolean') fail(`${key} must be a boolean.`);
    output[key] = input[key] as boolean;
  };
  text('providerLabel', 64);
  integer('contextWindow', 1, MODEL_METADATA_LIMITS.contextWindow);
  integer('maxOutputTokens', MODEL_METADATA_LIMITS.maxOutputTokens, MODEL_METADATA_LIMITS.maxOutputTokenLimit);
  flag('supportsReasoning'); flag('autoConfig');
  if (input.inputTypes !== undefined) output.inputTypes = Object.freeze(parseEnumList(input.inputTypes, 'inputTypes', INPUT_TYPES, INPUT_TYPES.length));
  if (input.capabilities !== undefined) output.capabilities = Object.freeze(parseEnumList(input.capabilities, 'capabilities', CAPABILITIES, CAPABILITIES.length));
  if (input.reasoningLevels !== undefined) output.reasoningLevels = Object.freeze(parseReasoningLevels(input.reasoningLevels));
  if (input.reasoningMapping !== undefined) output.reasoningMapping = parseReasoningMapping(input.reasoningMapping);
  return Object.freeze(output);
}

/** Persisted metadata is a trust boundary: a damaged record fails with an explicit repair message. */
export function modelMetadataFromStore(id: string, value: unknown): ModelMetadata {
  try { return parseModelMetadata(value); }
  catch (error) {
    throw new Error(`Stored model metadata for ${id} is invalid: ${(error as Error).message} Repair or remove the "modelMetadata" setting before starting the backend.`);
  }
}

/** Validated metadata from API input; callers map the plain Error to a product validation error. */
export function modelMetadataInput(value: unknown): ModelMetadata {
  return parseModelMetadata(value);
}

/**
 * Provider credentials and transport stay in Configuration. This store only adds validated
 * model metadata so the product layer can describe a model without inventing facts.
 */
export class Profiles {
  private readonly configurations = new Map<string, Configuration>();
  private entries: { id: string; name: string }[];
  private modelMetadata: Record<string, ModelMetadata>;

  constructor(private readonly store: HarnessStore, readonly primary: Configuration, private readonly dataDir: string) {
    this.configurations.set('default', primary);
    this.entries = store.getSetting('profiles', [{ id: 'default', name: '默认提供方' }]);
    for (const profile of this.entries.filter(item => item.id !== 'default')) {
      if (!/^provider-[a-f0-9-]+$/.test(profile.id)) throw new Error('Invalid stored provider identity.');
      this.configurations.set(profile.id, new Configuration(primary.mockUrl, path.join(dataDir, 'profiles', profile.id)));
    }
    this.modelMetadata = this.loadModelMetadata();
    // Product metadata owns the two limits the provider cannot discover; apply them to every
    // profile at boot so a restarted backend sends the same max_tokens as the saved configuration.
    for (const id of Object.keys(this.modelMetadata)) this.applyMetadata(id, false);
  }

  private loadModelMetadata(): Record<string, ModelMetadata> {
    let raw: unknown;
    try { raw = this.store.getSetting('modelMetadata', {}); }
    catch { throw new Error('Stored model metadata is not valid JSON. Repair or remove the "modelMetadata" setting before starting the backend.'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Stored model metadata must be an object keyed by model id. Repair the "modelMetadata" setting.');
    const source = raw as Record<string, unknown>;
    const size = bytesOf(source);
    if (size > MODEL_METADATA_LIMITS.storeBytes)
      throw new Error(`Stored model metadata is ${size} bytes; the limit is ${MODEL_METADATA_LIMITS.storeBytes}. Repair the "modelMetadata" setting.`);
    const result: Record<string, ModelMetadata> = Object.create(null);
    for (const id of Object.keys(source)) {
      if (id !== 'default' && !PROVIDER_ID.test(id)) throw new Error(`Stored model metadata has an invalid model id: ${id}.`);
      result[id] = modelMetadataFromStore(id, source[id]);
    }
    return result;
  }

  /** Only the two configuration fields the product owns; everything else is preserved. */
  private applyMetadata(id: string, persist: boolean): void {
    const metadata = this.modelMetadata[id], configuration = this.configurations.get(id);
    if (!metadata || !configuration) return;
    const provider = configuration.provider;
    configuration.set({
      ...provider, model: provider.model, mode: provider.mode, baseUrl: provider.baseUrl,
      maxOutputTokens: metadata.maxOutputTokens ?? DEFAULT_PROVIDER.maxOutputTokens,
      contextWindowTokens: metadata.contextWindow ?? null,
    }, persist);
  }

  get(id = 'default'): Configuration { const config = this.configurations.get(id); if (!config) throw new Error('Provider profile not found.'); return config; }
  list(): ProviderProfile[] {
    return this.entries.map(profile => {
      const view = this.get(profile.id).view();
      return { ...profile, provider: view.provider, supportsDeveloper: view.provider.supportsDeveloper ?? false, credentialPresent: view.credentialPresent,
        credentialFile: view.credentialFile, remainingLiveRequests: view.remainingLiveRequests, authorizationExpiresAt: view.authorizationExpiresAt };
    });
  }

  /** Validated product metadata; undefined when this profile never defined any. */
  metadata(id: string): ModelMetadata | undefined { return this.modelMetadata[id]; }
  reasoningLevels(id: string): string[] { return [...(this.modelMetadata[id]?.reasoningLevels ?? [])]; }

  saveMetadata(id: string, value: unknown): ModelMetadata {
    if (!this.configurations.has(id)) throw new Error('Provider profile not found.');
    const metadata = modelMetadataInput(value);
    const next: Record<string, ModelMetadata> = { ...this.modelMetadata, [id]: metadata };
    const size = bytesOf(next);
    if (size > MODEL_METADATA_LIMITS.storeBytes)
      throw new Error(`Model metadata would be ${size} bytes; the limit is ${MODEL_METADATA_LIMITS.storeBytes}.`);
    this.store.setSetting('modelMetadata', next);
    this.modelMetadata = next;
    this.applyMetadata(id, true);
    return metadata;
  }

  /** Removes the profile, its metadata and its data directory; the prefix check keeps deletion local. */
  remove(id: string): void {
    if (id === 'default') throw new Error('The default provider cannot be removed.');
    if (!PROVIDER_ID.test(id)) throw new Error('Invalid provider identity.');
    if (!this.configurations.has(id)) throw new Error('Provider profile not found.');
    const base = path.resolve(this.dataDir, 'profiles'), directory = path.resolve(base, id);
    if (path.dirname(directory) !== base) throw new Error('Invalid provider profile directory.');
    // Delete files first: a failed filesystem removal leaves the profile fully intact.
    rmSync(directory, { recursive: true, force: true });
    const nextMetadata: Record<string, ModelMetadata> = { ...this.modelMetadata };
    delete nextMetadata[id];
    this.entries = this.entries.filter(entry => entry.id !== id);
    this.store.setSetting('profiles', this.entries);
    this.store.setSetting('modelMetadata', nextMetadata);
    this.configurations.delete(id);
    this.modelMetadata = nextMetadata;
  }

  save(input: Record<string, any>): ProviderProfile {
    const id = input.id ? String(input.id) : `provider-${randomUUID()}`;
    let configuration = this.configurations.get(id);
    if (!configuration) {
      if (!/^provider-[a-f0-9-]+$/.test(id)) throw new Error('Invalid provider identity.');
      const directory = path.join(this.dataDir, 'profiles', id); mkdirSync(directory, { recursive: true });
      configuration = new Configuration(this.primary.mockUrl, directory);
    }
    const next = { ...configuration.provider, ...input.provider, ...input };
    if (next.model !== configuration.provider.model && input.contextWindowTokens === undefined && input.provider?.contextWindowTokens === undefined) next.contextWindowTokens = null;
    configuration.set(next);
    configuration.modelObserver = this.primary.modelObserver;
    this.configurations.set(id, configuration);
    const profile = { id, name: this.sanitize(String(input.name ?? this.entries.find(item => item.id === id)?.name ?? '自定义提供方').slice(0, 100)) };
    this.entries = [...this.entries.filter(item => item.id !== id), profile];
    this.store.setSetting('profiles', this.entries); return this.list().find(item => item.id === id)!;
  }
  setObservers(): void { for (const configuration of this.configurations.values()) configuration.modelObserver = this.primary.modelObserver; }
  sanitize<T>(value: T): T {
    let result = value;
    for (const config of this.configurations.values()) result = config.sanitize(result);
    return JSON.parse(JSON.stringify(result, (key, item) => /^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password)$/i.test(key) ? '[credential redacted]' : item)) as T;
  }
}
