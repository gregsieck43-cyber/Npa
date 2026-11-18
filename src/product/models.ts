import { randomUUID } from 'node:crypto';
import { DEFAULT_PROVIDER, type ModelClient } from '../runtime/model.js';
import {
  MODEL_METADATA_LIMITS, REASONING_PARAMETERS, modelMetadataInput,
  type ModelInputType, type ModelCapability, type ModelMetadata, type ReasoningValue,
} from '../harness/profiles.js';
import type { ProviderProfile, RequestRecord } from '../harness/types.js';
import {
  ProductError, boundedInteger, busy, invalid, notFound, pickFields, requiredString,
  type ModelProfile, type ModelProfileInput, type ModelTestResult, type ModelsDomain, type ProductRuntime,
  type SessionIndexRecord,
} from './shared.js';

const MODEL_FIELDS = [
  'id', 'name', 'provider', 'model', 'mode', 'contextWindow', 'maxOutputTokens', 'supportsReasoning',
  'autoConfig', 'inputTypes', 'capabilities', 'reasoningLevels', 'reasoningMapping',
] as const;
const INPUT_TYPES: readonly ModelInputType[] = ['text', 'image', 'video', 'pdf'];
const CAPABILITIES: readonly ModelCapability[] = ['structuredOutput', 'nativeWebSearch', 'systemMessageInChat'];
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_INDEX_PAGES = 25;
const MAX_REQUEST_PAGES = 20;
const INDEX_PAGE_SIZE = 100;
const REQUEST_PAGE_SIZE = 200;
const TEST_MESSAGE = 'Return the single word connected.';
const TEST_TIMEOUT_MS = 30_000;

const booleanValue = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean.`);
  return value;
};

function enumList<T extends string>(value: unknown, label: string, allowed: readonly T[], maximum: number): T[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  if (value.length > maximum) invalid(`${label} must contain at most ${maximum} entries.`);
  const seen = new Set<string>(), result: T[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !(allowed as readonly string[]).includes(item))
      invalid(`${label} may only contain ${allowed.join(', ')}.`);
    if (seen.has(item)) invalid(`${label} must not repeat "${item}".`);
    seen.add(item); result.push(item as T);
  }
  return result;
}

function reasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) invalid('reasoningLevels must be an array.');
  if (value.length > MODEL_METADATA_LIMITS.reasoningLevels)
    invalid(`reasoningLevels must contain at most ${MODEL_METADATA_LIMITS.reasoningLevels} levels.`);
  const seen = new Set<string>(), result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') invalid('Every reasoning level must be a string.');
    const level = item.trim();
    if (!level || level.length > MODEL_METADATA_LIMITS.reasoningLevelChars)
      invalid(`Every reasoning level must be 1-${MODEL_METADATA_LIMITS.reasoningLevelChars} characters.`);
    if (seen.has(level)) invalid(`Reasoning level "${level}" is repeated.`);
    seen.add(level); result.push(level);
  }
  return result;
}

function reasoningMapping(value: unknown): Record<string, ReasoningValue> {
  try {
    const parsed = modelMetadataInput({ reasoningMapping: value }).reasoningMapping;
    if (!parsed) invalid('reasoningMapping must be an object.');
    return parsed;
  } catch (error) {
    if (error instanceof ProductError) throw error;
    invalid((error as Error).message);
  }
}

/**
 * Bounded copy: objects/arrays up to depth 4 are cloned so the returned body never shares the
 * caller's mutable containers; deeper values are shared, never modified, and dangerous keys
 * (__proto__/prototype/constructor) are dropped instead of being assigned.
 */
function copyJson(value: unknown, depth: number): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => copyJson(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    Object.defineProperty(output, key, { value: copyJson((value as Record<string, unknown>)[key], depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return output;
}

/**
 * 模型配置: 元数据持久化、推理参数映射只作用于允许的参数，最终 Body 仍是真实请求。
 *
 * 凭据与传输仍归 Configuration/credentialFile 所有；本领域只暴露 credentialPresent 和
 * remainingLiveRequests 这类现场事实，缺值就是缺值，不推断。
 */
export class ProductModels implements ModelsDomain {
  constructor(private readonly rt: ProductRuntime) {}

  private profile(modelId: string): ProviderProfile {
    const profile = this.rt.harness.profiles.list().find(item => item.id === modelId);
    if (!profile) notFound(`Model ${modelId} was not found.`);
    return profile;
  }

  private view(profile: ProviderProfile): ModelProfile {
    const metadata = this.rt.harness.profiles.metadata(profile.id);
    const provider = profile.provider, levels = metadata?.reasoningLevels;
    const contextWindow = provider.contextWindowTokens ?? metadata?.contextWindow;
    return {
      id: profile.id,
      name: profile.name,
      // An unnamed provider is only claimed as 'mock' when the profile really is the mock
      // provider; otherwise it is a user-defined 'custom' label, never a guessed brand.
      provider: metadata?.providerLabel ?? (provider.mode === 'mock' ? 'mock' : 'custom'),
      model: provider.model,
      mode: provider.mode,
      credentialPresent: profile.credentialPresent,
      maxOutputTokens: provider.maxOutputTokens,
      supportsReasoning: metadata?.supportsReasoning ?? Boolean(levels?.length),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(provider.mode === 'live' ? { remainingLiveRequests: profile.remainingLiveRequests } : {}),
      ...(metadata?.autoConfig !== undefined ? { autoConfig: metadata.autoConfig } : {}),
      ...(metadata?.inputTypes ? { inputTypes: [...metadata.inputTypes] } : {}),
      ...(metadata?.capabilities ? { capabilities: [...metadata.capabilities] } : {}),
      ...(levels ? { reasoningLevels: [...levels] } : {}),
      ...(metadata?.reasoningMapping ? { reasoningMapping: { ...metadata.reasoningMapping } } : {}),
    };
  }

  private redact(error: unknown): string {
    return this.rt.harness.profiles.sanitize(error instanceof Error ? error.message : String(error));
  }

  async list(): Promise<ModelProfile[]> { return this.rt.harness.profiles.list().map(profile => this.view(profile)); }

  async save(input: ModelProfileInput): Promise<ModelProfile> {
    const body = pickFields(input, MODEL_FIELDS, 'Model profile');
    const name = requiredString(body.name, 'Model name', 100).trim();
    const providerLabel = requiredString(body.provider, 'Provider label', 64).trim();
    const model = requiredString(body.model, 'Model id', 200).trim();
    if (body.mode !== 'mock' && body.mode !== 'live') invalid("mode must be 'mock' or 'live'.");
    const mode = body.mode;
    const contextWindow = body.contextWindow === undefined ? undefined : boundedInteger(body.contextWindow, 'contextWindow', 1, MODEL_METADATA_LIMITS.contextWindow);
    const maxOutputTokens = body.maxOutputTokens === undefined ? undefined
      : boundedInteger(body.maxOutputTokens, 'maxOutputTokens', MODEL_METADATA_LIMITS.maxOutputTokens, MODEL_METADATA_LIMITS.maxOutputTokenLimit);
    const supportsReasoning = body.supportsReasoning === undefined ? undefined : booleanValue(body.supportsReasoning, 'supportsReasoning');
    const autoConfig = body.autoConfig === undefined ? undefined : booleanValue(body.autoConfig, 'autoConfig');
    const inputTypes = body.inputTypes === undefined ? undefined : enumList(body.inputTypes, 'inputTypes', INPUT_TYPES, INPUT_TYPES.length);
    const capabilities = body.capabilities === undefined ? undefined : enumList(body.capabilities, 'capabilities', CAPABILITIES, CAPABILITIES.length);
    const levels = body.reasoningLevels === undefined ? undefined : reasoningLevels(body.reasoningLevels);
    const mapping = body.reasoningMapping === undefined ? undefined : reasoningMapping(body.reasoningMapping);

    const profiles = this.rt.harness.profiles;
    const existing = body.id === undefined ? undefined : profiles.list().find(item => item.id === body.id);
    if (body.id !== undefined && !existing) notFound(`Model ${String(body.id)} was not found.`);
    const id = body.id === undefined ? `provider-${randomUUID()}` : String(body.id);
    // The DTO has no endpoint field: mock profiles always use the local mock URL, live profiles
    // keep their previously configured HTTPS endpoint or fall back to the built-in one. A caller
    // can never inject baseUrl/apiKey/headers because unknown fields were rejected above.
    const baseUrl = mode === 'live' ? (existing?.provider.mode === 'live' ? existing.provider.baseUrl : DEFAULT_PROVIDER.baseUrl) : undefined;
    const metadata: ModelMetadata = {
      providerLabel,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(supportsReasoning !== undefined ? { supportsReasoning } : {}),
      ...(autoConfig !== undefined ? { autoConfig } : {}),
      ...(inputTypes !== undefined ? { inputTypes } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(levels !== undefined ? { reasoningLevels: levels } : {}),
      ...(mapping !== undefined ? { reasoningMapping: mapping } : {}),
    };
    try {
      // Always pass the id the product committed to: a profile created by Profiles.save with
      // its own id would not match the id whose metadata is written immediately after.
      const saved = profiles.save({ id, name, provider: { model, mode, ...(baseUrl ? { baseUrl } : {}) } });
      if (saved.id !== id) throw new Error('The provider profile changed identity while saving.');
      profiles.saveMetadata(id, metadata);
    } catch (error) {
      if (error instanceof ProductError) throw error;
      invalid(error instanceof Error ? error.message : String(error));
    }
    const saved = profiles.list().find(item => item.id === id);
    if (!saved) throw new ProductError('internal', 'The saved model is not available.', 500);
    return this.view(saved);
  }

  async remove(modelId: string): Promise<void> {
    const profile = this.profile(modelId);
    if (modelId === 'default') throw new ProductError('conflict', 'The default model cannot be removed. Choose another default model first.', 409);
    const defaults = this.rt.store.meta<{ modelId?: unknown }>('settings.defaults', {});
    if (defaults.modelId === modelId)
      throw new ProductError('conflict', 'This model is the default for new sessions. Choose another default model first.', 409);
    if (this.rt.harness.autoReviewSettings().reviewerModelId === modelId)
      throw new ProductError('conflict', 'This model is selected as the automatic reviewer. Choose another reviewer model in Settings first.', 409);
    const chat = this.rt.harness.store.listSessions().find(session => session.profileId === modelId);
    if (chat) throw new ProductError('conflict', `This model is used by chat session ${chat.id}. Move that session to another model first.`, 409);
    const indexed = this.indexedSession(modelId);
    if (indexed) throw new ProductError('conflict', `This model is used by ${indexed.kind} session ${indexed.id}. Move that session to another model first.`, 409);
    const pending = this.pendingRequest(modelId);
    if (pending) throw new ProductError('conflict', `This model is used by ${pending.status} request ${pending.id}. Wait for it to finish or cancel it before removing the model.`, 409);
    try { this.rt.harness.profiles.remove(modelId); }
    catch (error) { throw new ProductError('internal', this.redact(error), 500); }
    void profile;
  }

  /** Chat/Work index rows remember the model that produced them; removal must not orphan them. */
  private indexedSession(modelId: string): SessionIndexRecord | undefined {
    let cursor: string | undefined, pages = 0;
    do {
      const page = this.rt.store.listSessions({ limit: INDEX_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      const hit = page.items.find(item => item.modelId === modelId);
      if (hit) return hit;
      cursor = page.nextCursor;
    } while (cursor && ++pages < MAX_INDEX_PAGES);
    if (cursor) busy('Too many indexed sessions to verify model references. Archive old sessions and retry.');
    return undefined;
  }

  private pendingRequest(modelId: string): RequestRecord | undefined {
    let after: number | undefined, pages = 0;
    do {
      const page = this.rt.harness.store.listRequests({ limit: REQUEST_PAGE_SIZE, ...(after !== undefined ? { after } : {}) });
      const hit = page.requests.find(request => request.profileId === modelId && (request.status === 'draft' || request.status === 'running'));
      if (hit) return hit;
      after = page.nextCursor ?? undefined;
    } while (after !== undefined && ++pages < MAX_REQUEST_PAGES);
    if (after !== undefined) busy('Too many request records to verify model references. Clear old history and retry.');
    return undefined;
  }

  /**
   * One bounded probe through this profile's own Configuration: live profiles without an
   * allowance or credential fail before any network call; mock profiles call the mock provider.
   */
  async test(modelId: string): Promise<ModelTestResult> {
    // Resolve the profile first so an unknown id is a product not_found, not a raw store error.
    const profile = this.profile(modelId);
    const configuration = this.rt.harness.profiles.get(profile.id);
    const started = performance.now();
    let client: ModelClient;
    try { client = configuration.client(); }
    catch (error) { return { ok: false, latencyMs: Math.round(performance.now() - started), message: this.redact(error) }; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      const result = await client.complete([{ role: 'user' as const, content: TEST_MESSAGE }], [], controller.signal);
      const reply = result.content.trim();
      return { ok: true, latencyMs: Math.round(performance.now() - started),
        message: reply ? `Connected. Model replied: ${reply.slice(0, 200)}` : 'Connected. The provider returned an empty reply.' };
    } catch (error) {
      return { ok: false, latencyMs: Math.round(performance.now() - started), message: this.redact(error) };
    } finally { clearTimeout(timer); }
  }

  /**
   * 由共享请求层调用: 只合并模型元数据允许的参数，绝不覆盖 messages/tools/model/endpoint/credentials。
   * 未知 profile、未选择等级、等级不在 levels 中或没有映射时原样返回同一个 body。
   */
  applyReasoning(body: Record<string, unknown>, profileId: string, effort?: string): Record<string, unknown> {
    const level = typeof effort === 'string' ? effort.trim() : '';
    if (!level) return body;
    const metadata = this.rt.harness.profiles.metadata(profileId);
    if (!metadata?.reasoningMapping || !metadata.reasoningLevels?.includes(level)) return body;
    const entries = Object.entries(metadata.reasoningMapping)
      .filter(([key]) => (REASONING_PARAMETERS as readonly string[]).includes(key));
    if (!entries.length) return body;
    const next = copyJson(body, 0) as Record<string, unknown>;
    for (const [key, value] of entries) {
      next[key] = typeof value === 'string' ? value.replaceAll('{{level}}', level) : value;
    }
    return next;
  }

  /** Reasoning levels for a profile, in the order the model owner defined them. */
  levels(profileId: string): string[] { return this.rt.harness.profiles.reasoningLevels(profileId); }
}
