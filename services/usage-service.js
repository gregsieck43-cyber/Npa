export const BUILTIN_COMMANDS = [
  { name: "help", description: "Show built-in commands and workflow shortcuts.", category: "core" },
  { name: "plan", description: "Create a development plan for the current repository.", category: "dev" },
  { name: "fix", description: "Start a Dev Session that edits, tests, and repairs failures.", category: "dev" },
  { name: "test", description: "Run the configured Dev Session test command.", category: "dev" },
  { name: "review", description: "Review current git diff or PR context.", category: "dev" },
  { name: "commit", description: "Prepare commit message and gated finalize flow.", category: "git" },
  { name: "pr", description: "Prepare PR title/body and gated GitHub PR creation.", category: "git" },
  { name: "permissions", description: "Open structured local tool permission settings.", category: "security" },
  { name: "cost", description: "Show token and estimated cost statistics.", category: "metrics" },
  { name: "compact", description: "Compact long chat context into an auditable summary.", category: "context" }
];

const MODEL_PRICES_PER_MILLION = {
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-5": { input: 15, output: 75 },
  "gpt-5.5": { input: 5, output: 20 },
  "gpt-5.4": { input: 4, output: 16 },
  "gpt-5.3": { input: 3, output: 12 },
  "gpt-5.2": { input: 2, output: 8 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-4.1": { input: 2, output: 8 },
  "gemini-3-pro": { input: 2, output: 12 },
  "gemini-3-flash": { input: 0.35, output: 1.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 }
};

function now() {
  return new Date().toISOString();
}

export function parseBuiltInCommand(text = "") {
  const value = String(text || "").trim();
  const match = value.match(/^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const command = BUILTIN_COMMANDS.find((item) => item.name === name);
  return {
    name,
    args: String(match[2] || "").trim(),
    known: Boolean(command),
    command: command || null
  };
}

export function publicBuiltInCommands(extraCommands = []) {
  const extra = (Array.isArray(extraCommands) ? extraCommands : []).map((command) => ({
    name: String(command.name || "").replace(/^\//, ""),
    description: String(command.description || command.path || "Custom command"),
    category: "custom"
  })).filter((command) => command.name);
  return [...BUILTIN_COMMANDS, ...extra];
}

export function extractUsage(payload = {}, profile = {}) {
  const protocol = profile.protocol || "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  if (protocol === "anthropic_messages") {
    inputTokens = number(payload.usage?.input_tokens);
    outputTokens = number(payload.usage?.output_tokens);
    cacheReadTokens = number(payload.usage?.cache_read_input_tokens);
    cacheWriteTokens = number(payload.usage?.cache_creation_input_tokens);
  } else if (protocol === "openai_responses") {
    inputTokens = number(payload.usage?.input_tokens);
    outputTokens = number(payload.usage?.output_tokens);
    const details = payload.usage?.input_tokens_details || {};
    cacheReadTokens = number(details.cached_tokens);
  } else if (protocol === "openai_chat") {
    inputTokens = number(payload.usage?.prompt_tokens);
    outputTokens = number(payload.usage?.completion_tokens);
    cacheReadTokens = number(payload.usage?.prompt_tokens_details?.cached_tokens);
  } else if (protocol === "gemini_generate") {
    inputTokens = number(payload.usageMetadata?.promptTokenCount);
    outputTokens = number(payload.usageMetadata?.candidatesTokenCount);
  }
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens
  };
}

export function createUsageRecord({ payload = {}, profile = {}, settings = {}, chatId = null, devSessionId = null } = {}) {
  const usage = extractUsage(payload, profile);
  if (!usage.totalTokens) return null;
  const model = String(payload.model || settings.model || "").trim();
  const pricing = estimateCost({ model, ...usage });
  return {
    id: `usage_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
    provider: String(profile.provider || settings.modelProvider || "custom"),
    protocol: String(profile.protocol || settings.apiProtocol || "unknown"),
    model,
    chatId,
    devSessionId,
    ...usage,
    estimatedUsd: pricing.estimatedUsd,
    priceKnown: pricing.priceKnown,
    createdAt: now()
  };
}

export function estimateCost({ model = "", inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 } = {}) {
  const pricing = MODEL_PRICES_PER_MILLION[String(model || "").toLowerCase()];
  if (!pricing) return { estimatedUsd: null, priceKnown: false };
  const billableInput = Number(inputTokens || 0) + Number(cacheWriteTokens || 0) + Number(cacheReadTokens || 0) * 0.1;
  const cost = (billableInput * pricing.input + Number(outputTokens || 0) * pricing.output) / 1_000_000;
  return { estimatedUsd: Number(cost.toFixed(6)), priceKnown: true };
}

export function summarizeUsage(records = []) {
  const summary = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedUsd: 0,
    unknownCostRecords: 0,
    byModel: {},
    byDate: {}
  };
  for (const record of records || []) {
    const model = record.model || "unknown";
    const date = String(record.createdAt || "").slice(0, 10) || "unknown";
    add(summary, record);
    summary.byModel[model] ||= blankBucket();
    summary.byDate[date] ||= blankBucket();
    add(summary.byModel[model], record);
    add(summary.byDate[date], record);
  }
  summary.estimatedUsd = Number(summary.estimatedUsd.toFixed(6));
  for (const bucket of Object.values(summary.byModel)) bucket.estimatedUsd = Number(bucket.estimatedUsd.toFixed(6));
  for (const bucket of Object.values(summary.byDate)) bucket.estimatedUsd = Number(bucket.estimatedUsd.toFixed(6));
  return summary;
}

function add(bucket, record = {}) {
  bucket.totalTokens += Number(record.totalTokens || 0);
  bucket.inputTokens += Number(record.inputTokens || 0);
  bucket.outputTokens += Number(record.outputTokens || 0);
  if (record.priceKnown && Number.isFinite(Number(record.estimatedUsd))) bucket.estimatedUsd += Number(record.estimatedUsd);
  else bucket.unknownCostRecords += 1;
}

function blankBucket() {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0, unknownCostRecords: 0 };
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}
