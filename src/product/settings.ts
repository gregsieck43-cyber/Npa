import type {
  AppMode, InstructionFileView, McpServerInput, McpServerView, PermissionMode, PermissionRule,
  PluginView, RiskLevel, Settings, SkillView,
} from '../frontend/api/types.js';
import { ProductError, invalid, pickFields, requiredString, type ProductRuntime } from './shared.js';
import { ProductMcpSettings } from './mcp-settings.js';
import { pluginViews } from './plugin-settings.js';

const APPEARANCE_FIELDS = ['theme', 'accent', 'density', 'motion', 'fontScale', 'ambient'] as const;
const DEFAULTS_FIELDS = ['mode', 'permission', 'modelId', 'sendKey'] as const;
const AUTO_REVIEW_FIELDS = ['reviewerModelId', 'escalateAt', 'explain'] as const;
const PRIVACY_FIELDS = ['recordContent', 'redactSecrets'] as const;
const NETWORK_FIELDS = ['webSearch', 'fetch', 'proxy'] as const;
const SETTINGS_FIELDS = ['appearance', 'defaults', 'autoReview', 'rules', 'privacy', 'network'] as const;

const THEMES: readonly Settings['appearance']['theme'][] = ['light', 'dark', 'system'];
const ACCENTS: readonly Settings['appearance']['accent'][] = ['ember', 'indigo', 'jade', 'violet', 'ocean'];
const DENSITIES: readonly Settings['appearance']['density'][] = ['comfortable', 'compact'];
const MOTIONS: readonly Settings['appearance']['motion'][] = ['full', 'reduced'];
const MODES: readonly AppMode[] = ['chat', 'cowork', 'code'];
const PERMISSIONS: readonly PermissionMode[] = ['read-only', 'ask', 'auto-review', 'full-access'];
const SEND_KEYS: readonly Settings['defaults']['sendKey'][] = ['enter', 'mod-enter'];
const RISKS: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];
const DECISIONS: readonly PermissionRule['decision'][] = ['allow', 'ask', 'deny'];
const CAPABILITIES: readonly PermissionRule['capability'][] = ['read', 'write', 'exec', 'network', 'mcp'];

// These are the approved frontend defaults (src/frontend/api/mock/seed.ts), not arbitrary backend
// colors: a fresh install must render the reviewed light/ambient design until the operator changes it.
const DEFAULT_APPEARANCE: Settings['appearance'] = {
  theme: 'light', accent: 'ember', density: 'comfortable', motion: 'full', fontScale: 1, ambient: true,
};
const DEFAULT_DEFAULTS: Settings['defaults'] = { mode: 'chat', permission: 'ask', modelId: 'default', sendKey: 'enter' };
const APPEARANCE_KEY = 'settings.appearance';
const DEFAULTS_KEY = 'settings.defaults';
const AUTO_REVIEW_KEY = 'autoReview';

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label + ' must be an object.');
  return value as Record<string, unknown>;
};

function enumValue<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
    invalid(label + ' must be one of: ' + allowed.join(', ') + '.');
  return value as T;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(label + ' must be a boolean.');
  return value;
}

// Every section validates a deep partial into an explicit patch. Update merges that patch over the
// current values, so setting one field never resets its siblings; unknown keys are rejected instead
// of ignored, which keeps a typo from silently doing nothing.
function appearancePatch(value: unknown): Partial<Settings['appearance']> {
  const patch = object(value, 'appearance');
  pickFields(patch, APPEARANCE_FIELDS, 'appearance');
  const next: Partial<Settings['appearance']> = {};
  if (patch.theme !== undefined) next.theme = enumValue(patch.theme, 'appearance.theme', THEMES);
  if (patch.accent !== undefined) next.accent = enumValue(patch.accent, 'appearance.accent', ACCENTS);
  if (patch.density !== undefined) next.density = enumValue(patch.density, 'appearance.density', DENSITIES);
  if (patch.motion !== undefined) next.motion = enumValue(patch.motion, 'appearance.motion', MOTIONS);
  if (patch.fontScale !== undefined) {
    if (typeof patch.fontScale !== 'number' || !Number.isFinite(patch.fontScale) || patch.fontScale < 0.9 || patch.fontScale > 1.2)
      invalid('appearance.fontScale must be a number between 0.9 and 1.2.');
    next.fontScale = Math.round(patch.fontScale * 100) / 100;
  }
  if (patch.ambient !== undefined) next.ambient = booleanValue(patch.ambient, 'appearance.ambient');
  return next;
}

function appearance(value: unknown): Settings['appearance'] {
  return { ...DEFAULT_APPEARANCE, ...appearancePatch(value) };
}

function defaultsPatch(value: unknown, profileIds: Set<string>): Partial<Settings['defaults']> {
  const patch = object(value, 'defaults');
  pickFields(patch, DEFAULTS_FIELDS, 'defaults');
  const next: Partial<Settings['defaults']> = {};
  if (patch.mode !== undefined) next.mode = enumValue(patch.mode, 'defaults.mode', MODES);
  if (patch.permission !== undefined) next.permission = enumValue(patch.permission, 'defaults.permission', PERMISSIONS);
  if (patch.sendKey !== undefined) next.sendKey = enumValue(patch.sendKey, 'defaults.sendKey', SEND_KEYS);
  if (patch.modelId !== undefined) {
    const id = requiredString(patch.modelId, 'defaults.modelId', 200);
    if (!profileIds.has(id)) invalid('defaults.modelId must be an existing model profile id.');
    next.modelId = id;
  }
  return next;
}

function defaults(value: unknown, profileIds: Set<string>): Settings['defaults'] {
  return { ...DEFAULT_DEFAULTS, ...defaultsPatch(value, profileIds) };
}

function autoReviewPatch(value: unknown, profileIds: Set<string>): Partial<Settings['autoReview']> {
  const patch = object(value, 'autoReview');
  pickFields(patch, AUTO_REVIEW_FIELDS, 'autoReview');
  const next: Partial<Settings['autoReview']> = {};
  if (patch.reviewerModelId !== undefined) {
    // Legacy field name: the value is an exact ModelProfile.id, never a provider name. An explicit
    // empty string disables automatic review, so it must be accepted rather than treated as a typo.
    if (patch.reviewerModelId === '') next.reviewerModelId = '';
    else {
      const id = requiredString(patch.reviewerModelId, 'autoReview.reviewerModelId', 200);
      if (!profileIds.has(id)) invalid('autoReview.reviewerModelId must be an existing model profile id; use an empty string to disable automatic review.');
      next.reviewerModelId = id;
    }
  }
  if (patch.escalateAt !== undefined) next.escalateAt = enumValue(patch.escalateAt, 'autoReview.escalateAt', RISKS);
  if (patch.explain !== undefined) next.explain = booleanValue(patch.explain, 'autoReview.explain');
  return next;
}

function privacyPatch(value: unknown): Partial<Settings['privacy']> {
  const patch = object(value, 'privacy');
  pickFields(patch, PRIVACY_FIELDS, 'privacy');
  const next: Partial<Settings['privacy']> = {};
  if (patch.recordContent !== undefined) next.recordContent = booleanValue(patch.recordContent, 'privacy.recordContent');
  if (patch.redactSecrets !== undefined && patch.redactSecrets !== true) {
    // Credential redaction is a hard boundary of the request recorder; a switch that pretends to
    // disable it would silently leak secrets, so the only legal saved value is true.
    throw new ProductError('validation', 'privacy.redactSecrets cannot be disabled: recorded requests and exports always redact credentials.', 400);
  }
  return next;
}

function networkPatch(value: unknown): Partial<Settings['network']> {
  const patch = object(value, 'network');
  pickFields(patch, NETWORK_FIELDS, 'network');
  const next: Partial<Settings['network']> = {};
  if (patch.webSearch !== undefined) next.webSearch = booleanValue(patch.webSearch, 'network.webSearch');
  if (patch.fetch !== undefined) next.fetch = booleanValue(patch.fetch, 'network.fetch');
  if (patch.proxy !== undefined) {
    if (typeof patch.proxy !== 'string' || patch.proxy.length > 2048) invalid('network.proxy must be a string of at most 2048 characters.');
    if (patch.proxy.trim()) {
      throw new ProductError('unsupported', 'HTTP proxy is not supported by this build. Clear network.proxy to use a direct connection.', 501);
    }
    next.proxy = '';
  }
  return next;
}

/** The Product Settings authority: one source per section, never a second divergent copy. */
export class ProductSettings {
  readonly mcp: ProductMcpSettings;
  // Settings live in several stores, so an update is a read-modify-write across them. Serializing
  // updates keeps two concurrent patches from both reading the same old value and losing one.
  private updateTail: Promise<void> = Promise.resolve();
  constructor(private readonly rt: ProductRuntime, private readonly projects: () => Promise<{ id: string; path: string }[]>) {
    this.mcp = new ProductMcpSettings(rt);
  }

  async get(): Promise<Settings> {
    const storedAppearance = this.rt.store.meta<unknown>(APPEARANCE_KEY, undefined);
    const storedDefaults = this.rt.store.meta<unknown>(DEFAULTS_KEY, undefined);
    let resolvedAppearance: Settings['appearance'];
    let resolvedDefaults: Partial<Settings['defaults']>;
    try {
      resolvedAppearance = storedAppearance === undefined ? { ...DEFAULT_APPEARANCE } : appearance(storedAppearance);
      resolvedDefaults = storedDefaults === undefined ? {} : defaults(storedDefaults, new Set(this.profiles().map(profile => profile.id)));
    } catch (error) {
      throw new ProductError('internal', 'Saved Settings values are invalid: ' + (error instanceof Error ? error.message : String(error)), 500);
    }
    const autoReview = this.rt.harness.autoReviewSettings();
    return {
      appearance: resolvedAppearance,
      defaults: { ...DEFAULT_DEFAULTS, ...resolvedDefaults },
      autoReview: { reviewerModelId: autoReview.reviewerModelId, escalateAt: autoReview.escalateAt, explain: autoReview.explain },
      rules: this.rules(),
      privacy: { recordContent: this.recordContent(), redactSecrets: true },
      network: this.rt.services.external.networkSettings(),
    };
  }

  /**
   * Strict deep partial update. Every section is validated before anything is written; if a later
   * section still fails (for example the settings file is read-only), the previous values are
   * restored so callers never observe a half-applied patch.
   */
  async update(input: unknown): Promise<Settings> {
    const run = this.updateTail.then(() => this.applyUpdate(input));
    this.updateTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async applyUpdate(input: unknown): Promise<Settings> {
    const patch = object(input, 'Settings patch');
    pickFields(patch, SETTINGS_FIELDS, 'Settings patch');
    const profileIds = new Set(this.profiles().map(profile => profile.id));
    const previous = {
      appearance: this.rt.store.meta<unknown>(APPEARANCE_KEY, undefined),
      defaults: this.rt.store.meta<unknown>(DEFAULTS_KEY, undefined),
      autoReview: this.rt.harness.store.getSetting<Record<string, unknown>>(AUTO_REVIEW_KEY, {}),
      rules: this.rules(),
      recordContent: this.recordContent(),
      network: this.rt.services.external.networkSettings(),
    };
    const current = await this.get();
    const nextAppearance = patch.appearance === undefined ? current.appearance : { ...current.appearance, ...appearancePatch(patch.appearance) };
    const nextDefaults = patch.defaults === undefined ? current.defaults : { ...current.defaults, ...defaultsPatch(patch.defaults, profileIds) };
    const nextAutoReview = patch.autoReview === undefined ? current.autoReview : { ...current.autoReview, ...autoReviewPatch(patch.autoReview, profileIds) };
    const nextRules = patch.rules === undefined ? current.rules : this.rt.services.kernel.validatePermissionRules(patch.rules);
    const nextPrivacy = patch.privacy === undefined ? current.privacy : { ...current.privacy, ...privacyPatch(patch.privacy) };
    const nextRecordContent = nextPrivacy.recordContent;
    const nextNetwork = patch.network === undefined ? current.network : { ...current.network, ...networkPatch(patch.network) };
    // Restore only the sections this patch actually wrote. A section whose write threw (for example an
    // unwritable web-settings.json) keeps its previous on-disk value, so retrying it during rollback would
    // fail again and mask the original storage error behind a misleading "rollback was incomplete" 500.
    const applied: string[] = [];
    try {
      if (patch.rules !== undefined) { this.rt.services.kernel.setPermissionRules(nextRules); applied.push('rules'); }
      if (patch.appearance !== undefined) { this.rt.store.setMeta(APPEARANCE_KEY, nextAppearance); applied.push('appearance'); }
      if (patch.defaults !== undefined) { this.rt.store.setMeta(DEFAULTS_KEY, nextDefaults); applied.push('defaults'); }
      if (patch.autoReview !== undefined) { this.rt.harness.store.setSetting(AUTO_REVIEW_KEY, nextAutoReview); applied.push('autoReview'); }
      if (patch.privacy !== undefined) { this.rt.harness.store.setSetting('recordContent', nextRecordContent); applied.push('recordContent'); }
      if (patch.network !== undefined) { this.rt.services.external.configureWeb({ network: nextNetwork }); applied.push('network'); }
    } catch (error) {
      this.rollback(previous, applied);
      if (error instanceof ProductError) throw error;
      // A local storage write is an operational failure, never a bad request: keep the real cause visible
      // with an internal 500 instead of letting the generic route mapper report 400 REQUEST_FAILED.
      throw new ProductError('internal', 'The Settings update failed: ' + (error instanceof Error ? error.message : String(error)), 500);
    }
    return this.get();
  }

  rules(): PermissionRule[] {
    return this.rt.services.kernel.permissionRules().map(rule => ({
      id: String(rule.id), pattern: String(rule.pattern),
      capability: rule.capability as PermissionRule['capability'], decision: rule.decision as PermissionRule['decision'],
    }));
  }

  async mcpServers(): Promise<McpServerView[]> { return this.mcp.list(); }
  async saveMcp(input: McpServerInput): Promise<McpServerView> { return this.mcp.save(input); }
  async removeMcp(id: string): Promise<void> { await this.mcp.remove(requiredString(id, 'MCP server id', 200)); }
  async reconnectMcp(id: string): Promise<McpServerView> { return this.mcp.reconnect(requiredString(id, 'MCP server id', 200)); }

  async instructions(): Promise<InstructionFileView[]> {
    const projects = (await this.projects()).map(project => ({ id: project.id, path: project.path }));
    try {
      return await this.rt.services.instructionSettings.listInstructionFiles({
        globalPaths: this.rt.services.configuration.globalPaths, projects,
      });
    } catch (error) { this.instructionError(error); }
  }

  plugins(): PluginView[] { return pluginViews(this.rt.services.plugins.list()); }

  async skills(): Promise<SkillView[]> {
    try {
      return await this.rt.services.instructionSettings.listSkills({ skillRoots: this.rt.services.configuration.skillRoots });
    } catch (error) { this.instructionError(error); }
  }

  async toggleSkill(id: string, enabled: boolean): Promise<SkillView> {
    const skillId = requiredString(id, 'Skill id', 200);
    if (typeof enabled !== 'boolean') invalid('enabled must be a boolean.');
    try {
      return await this.rt.services.instructionSettings.toggleSkill(skillId, enabled, { skillRoots: this.rt.services.configuration.skillRoots });
    } catch (error) { this.instructionError(error); }
  }

  /** A damaged or unwritable skill switch file is an operational failure, not a bad request. */
  private instructionError(error: unknown): never {
    const text = error instanceof Error ? error.message : String(error);
    if (/corrupt|data must live|requires a data directory/i.test(text)) throw new ProductError('internal', text, 500);
    throw new ProductError('validation', text, 400);
  }

  /**
   * Clear the non-pinned conversation display index only. Running work and any active chat request
   * are a conflict (nothing is deleted); Kernel audit, project files, models, settings, permissions
   * and pinned sessions stay intact. Chat request/trace records are the Inspector's audit and are
   * deliberately not erased here.
   */
  async clearHistory(): Promise<void> {
    // Check every page before deleting anything. No await separates preflight from the sweep.
    for (const page of this.rt.store.unpinnedSessionPages()) {
      for (const { id, kind } of page) {
        if (kind === 'chat') {
          if (this.rt.harness.chat.busy(id) || this.rt.harness.tools.busy(id)) {
            throw new ProductError('busy', 'A chat request is still running. Stop active sessions before clearing history.', 409, true);
          }
        } else {
          const task = this.rt.services.kernel.getTask(id);
          if (task && !['completed', 'failed', 'cancelled'].includes(task.status)) {
            throw new ProductError('busy', 'A Work task is still running. Stop active sessions before clearing history.', 409, true);
          }
        }
      }
    }
    for (const page of this.rt.store.unpinnedSessionPages()) {
      this.rt.harness.store.transaction(() => {
        for (const row of page) {
          if (row.kind === 'chat') this.rt.harness.store.deleteSession(row.id, { ifExists: true });
        }
      });
      this.rt.store.removeHistoryPage(page);
    }
  }

  private profiles() { return this.rt.harness.profiles.list(); }

  private recordContent(): boolean {
    const value = this.rt.harness.store.getSetting<unknown>('recordContent', true);
    if (typeof value !== 'boolean') throw new ProductError('internal', 'Saved recordContent setting is invalid.', 500);
    return value;
  }

  private rollback(previous: {
    appearance: unknown; defaults: unknown; autoReview: Record<string, unknown>; rules: PermissionRule[];
    recordContent: boolean; network: { webSearch: boolean; fetch: boolean; proxy: string };
  }, applied: string[]): void {
    const failures: string[] = [];
    const attempt = (label: string, action: () => void): void => {
      if (!applied.includes(label)) return;
      try { action(); } catch (error) { failures.push(label + ': ' + (error instanceof Error ? error.message : String(error))); }
    };
    attempt('rules', () => this.rt.services.kernel.setPermissionRules(previous.rules));
    attempt('appearance', () => this.rt.store.setMeta(APPEARANCE_KEY, previous.appearance ?? DEFAULT_APPEARANCE));
    attempt('defaults', () => this.rt.store.setMeta(DEFAULTS_KEY, previous.defaults ?? DEFAULT_DEFAULTS));
    attempt('autoReview', () => this.rt.harness.store.setSetting(AUTO_REVIEW_KEY, previous.autoReview));
    attempt('recordContent', () => this.rt.harness.store.setSetting('recordContent', previous.recordContent));
    attempt('network', () => this.rt.services.external.configureWeb({ network: previous.network }));
    if (failures.length) throw new ProductError('internal', 'The Settings update failed and rollback was incomplete: ' + failures.join('; '), 500);
  }
}
