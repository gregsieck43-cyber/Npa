const PROVIDERS = new Set(["auto", "anthropic", "openai", "rehdasu", "gemini", "deepseek", "custom"]);
const PROTOCOLS = new Set(["auto", "anthropic_messages", "openai_responses", "openai_chat", "gemini_generate"]);

export const EFFORTS = {
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],
  rehdasu: ["none", "minimal", "low", "medium", "high", "xhigh"],
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  geminiLevel: ["minimal", "low", "medium", "high"],
  deepseek: ["auto", "low", "medium", "high"],
  custom: ["auto", "low", "medium", "high"]
};

export const MODEL_CATALOG = [
  { provider: "openai", model: "gpt-5.5", label: "GPT-5.5", protocol: "openai_responses", effortDefault: "xhigh" },
  { provider: "openai", model: "gpt-5.4", label: "GPT-5.4", protocol: "openai_responses", effortDefault: "high" },
  { provider: "openai", model: "gpt-5.3", label: "GPT-5.3", protocol: "openai_responses", effortDefault: "medium" },
  { provider: "openai", model: "gpt-5.2", label: "GPT-5.2", protocol: "openai_responses", effortDefault: "medium" },
  { provider: "openai", model: "gpt-5", label: "GPT-5", protocol: "openai_responses", effortDefault: "medium" },
  { provider: "openai", model: "gpt-4.1", label: "GPT-4.1", protocol: "openai_chat", effortDefault: "none" },
  { provider: "rehdasu", model: "gpt-5.5", label: "Rehdasu GPT-5.5", protocol: "openai_responses", effortDefault: "xhigh" },
  { provider: "anthropic", model: "claude-opus-4-7", label: "Claude Opus 4.7", protocol: "anthropic_messages", effortDefault: "high" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", protocol: "anthropic_messages", effortDefault: "high" },
  { provider: "anthropic", model: "claude-opus-4-5", label: "Claude Opus 4.5", protocol: "anthropic_messages", effortDefault: "medium" },
  { provider: "gemini", model: "gemini-3-pro", label: "Gemini 3 Pro", protocol: "gemini_generate", effortDefault: "high" },
  { provider: "gemini", model: "gemini-3-flash", label: "Gemini 3 Flash", protocol: "gemini_generate", effortDefault: "medium" },
  { provider: "gemini", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro", protocol: "gemini_generate", effortDefault: "medium" },
  { provider: "deepseek", model: "deepseek-chat", label: "DeepSeek Chat", protocol: "openai_chat", effortDefault: "auto" },
  { provider: "deepseek", model: "deepseek-reasoner", label: "DeepSeek Reasoner", protocol: "openai_chat", effortDefault: "medium" }
];

function clean(value) {
  return String(value || "").trim();
}

export function inferModelProvider(settings = {}) {
  const explicit = clean(settings.modelProvider).toLowerCase();
  const model = clean(settings.model).toLowerCase();
  const base = clean(settings.apiBaseUrl).toLowerCase();
  if (base.includes("rehdasu.cn")) return "rehdasu";
  if (PROVIDERS.has(explicit) && explicit !== "auto" && explicit !== "custom") return explicit;
  if (/claude|anthropic/.test(model) || base.includes("anthropic") || base.includes("cc.580ai.net")) return "anthropic";
  if (/gemini/.test(model) || base.includes("generativelanguage.googleapis.com") || base.includes("googleapis.com")) return "gemini";
  if (/deepseek/.test(model) || base.includes("deepseek")) return "deepseek";
  if (/^(gpt-|o[0-9]|chatgpt)/.test(model) || base.includes("api.openai.com") || base.includes("openai")) return "openai";
  if (explicit === "custom") return "custom";
  return "custom";
}

export function inferApiProtocol(settings = {}) {
  const explicit = clean(settings.apiProtocol).toLowerCase();
  if (PROTOCOLS.has(explicit) && explicit !== "auto") return explicit;
  const provider = inferModelProvider(settings);
  const model = clean(settings.model).toLowerCase();
  if (provider === "anthropic") return "anthropic_messages";
  if (provider === "rehdasu") return "openai_responses";
  if (provider === "gemini") return "gemini_generate";
  if (provider === "deepseek") return "openai_chat";
  if (provider === "openai") {
    if (/^(gpt-5|o[0-9]|gpt-4\.1)/.test(model)) return "openai_responses";
    return "openai_chat";
  }
  return "openai_chat";
}

export function effortOptionsFor(settings = {}) {
  const provider = inferModelProvider(settings);
  const model = clean(settings.model).toLowerCase();
  if (provider === "anthropic") return EFFORTS.anthropic;
  if (provider === "rehdasu") return EFFORTS.rehdasu;
  if (provider === "gemini") return model.includes("2.5") ? ["budget"] : EFFORTS.geminiLevel;
  if (provider === "openai") return EFFORTS.openai;
  if (provider === "deepseek") return EFFORTS.deepseek;
  return EFFORTS.custom;
}

export function resolveModelProfile(settings = {}) {
  const provider = inferModelProvider(settings);
  const protocol = inferApiProtocol({ ...settings, modelProvider: provider });
  const requestedModel = clean(settings.model);
  const catalogItem = MODEL_CATALOG.find((item) => item.provider === provider && item.model === requestedModel)
    || MODEL_CATALOG.find((item) => item.model === requestedModel);
  const effortOptions = effortOptionsFor({ ...settings, modelProvider: provider });
  const defaultEffort = catalogItem?.effortDefault || (effortOptions.includes("medium") ? "medium" : effortOptions[0] || "auto");
  let effort = clean(settings.effort || defaultEffort).toLowerCase();
  if (!effortOptions.includes(effort)) effort = defaultEffort;
  return {
    provider,
    protocol,
    effort,
    effortOptions,
    effortDefault: defaultEffort,
    supportsTools: provider === "custom"
      ? settings.supportsTools === true
      : protocol === "anthropic_messages" || protocol === "openai_responses" || protocol === "openai_chat" || protocol === "gemini_generate",
    supportsVision: provider === "custom"
      ? settings.supportsVision === true
      : provider === "anthropic" || provider === "openai" || provider === "rehdasu" || provider === "gemini",
    usesNumericThinkingBudget: provider === "gemini" && clean(settings.model).toLowerCase().includes("2.5"),
    label: catalogItem?.label || clean(settings.model) || provider
  };
}

export function normalizeModelSettings(input = {}, current = {}) {
  const merged = { ...current, ...input };
  const requestedProvider = PROVIDERS.has(clean(merged.modelProvider).toLowerCase())
    ? clean(merged.modelProvider).toLowerCase()
    : "auto";
  const requestedProtocol = PROTOCOLS.has(clean(merged.apiProtocol).toLowerCase())
    ? clean(merged.apiProtocol).toLowerCase()
    : "auto";
  const profile = resolveModelProfile({ ...merged, modelProvider: requestedProvider, apiProtocol: requestedProtocol });
  const legacyRehdasuSelection = profile.provider === "rehdasu"
    && requestedProvider === "custom"
    && clean(merged.model).toLowerCase() === "gpt-5.5"
    && clean(merged.effort).toLowerCase() === "high";
  const thinkingMode = ["auto", "adaptive", "enabled", "off", "budget"].includes(clean(merged.thinkingMode).toLowerCase())
    ? clean(merged.thinkingMode).toLowerCase()
    : "auto";
  return {
    modelProvider: profile.provider,
    apiProtocol: requestedProtocol === "auto" ? profile.protocol : requestedProtocol,
    thinkingMode,
    effort: legacyRehdasuSelection ? "xhigh" : profile.effort,
    thinkingBudgetTokens: Number(merged.thinkingBudgetTokens || current.thinkingBudgetTokens || 1024),
    reasoningBudgetTokens: Number(merged.reasoningBudgetTokens || merged.thinkingBudgetTokens || current.reasoningBudgetTokens || 1024)
  };
}

export function modelSupportsAdaptiveThinking(model = "") {
  return /claude-(opus-4-7|opus-4-6|sonnet-4-6)|claude-mythos-preview/i.test(String(model || ""));
}

export function modelSupportsExtendedThinking(model = "") {
  return /claude-(opus-4-5|sonnet-4-5|opus-4-1|opus-4|sonnet-4|3-7-sonnet)/i.test(String(model || ""));
}

export function applyReasoningParameters(body, settings = {}, profile = resolveModelProfile(settings)) {
  const mode = clean(settings.thinkingMode || "auto").toLowerCase();
  const model = clean(settings.model);
  if (profile.protocol === "anthropic_messages") {
    const adaptive = mode === "adaptive" || (mode === "auto" && modelSupportsAdaptiveThinking(model));
    const extended = mode === "enabled" || (mode === "auto" && modelSupportsExtendedThinking(model));
    if (adaptive) {
      body.thinking = { type: "adaptive", display: "omitted" };
      body.output_config = { effort: profile.effort };
    } else if (extended) {
      const maxTokens = Number(body.max_tokens || settings.maxTokens || 4096);
      const requestedBudget = Number(settings.thinkingBudgetTokens || 1024);
      const budgetTokens = Math.min(Math.max(1024, requestedBudget), Math.max(1024, maxTokens - 1));
      body.thinking = { type: "enabled", budget_tokens: budgetTokens };
    }
    return body;
  }
  if (profile.protocol === "openai_responses") {
    if (profile.effort && profile.effort !== "auto") body.reasoning = { effort: profile.effort };
    return body;
  }
  if (profile.protocol === "openai_chat") {
    if (profile.provider === "openai" && profile.effort && profile.effort !== "auto" && profile.effort !== "none") {
      body.reasoning_effort = profile.effort;
    }
    return body;
  }
  if (profile.protocol === "gemini_generate") {
    body.generationConfig ||= {};
    if (profile.usesNumericThinkingBudget || mode === "budget") {
      body.generationConfig.thinkingConfig = { thinkingBudget: Number(settings.thinkingBudgetTokens || 1024) };
    } else if (profile.effort && profile.effort !== "auto") {
      body.generationConfig.thinkingConfig = { thinkingLevel: profile.effort };
    }
  }
  return body;
}
