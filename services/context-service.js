export const DEFAULT_CONTEXT_POLICY = {
  autoCompactEnabled: true,
  compactAtRatio: 0.82,
  emergencyAtRatio: 0.92,
  keepLastMessages: 8,
  maxSnapshotChars: 60000
};

export function normalizeContextPolicy(input = {}) {
  return {
    autoCompactEnabled: input.autoCompactEnabled !== false,
    compactAtRatio: clampNumber(input.compactAtRatio, 0.2, 0.98, DEFAULT_CONTEXT_POLICY.compactAtRatio),
    emergencyAtRatio: clampNumber(input.emergencyAtRatio, 0.3, 0.995, DEFAULT_CONTEXT_POLICY.emergencyAtRatio),
    keepLastMessages: Math.trunc(clampNumber(input.keepLastMessages, 2, 40, DEFAULT_CONTEXT_POLICY.keepLastMessages)),
    maxSnapshotChars: Math.trunc(clampNumber(input.maxSnapshotChars, 8000, 120000, DEFAULT_CONTEXT_POLICY.maxSnapshotChars))
  };
}

export function estimateTokensFromText(text = "") {
  return Math.ceil(String(text || "").length / 3.6);
}

export function messageText(message = {}) {
  const content = message.displayContent ?? message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content.map((item) => item?.text || item?.content || JSON.stringify(item)).join("\n");
}

export function estimateContextUsage({
  chat = {},
  project = null,
  settings = {},
  system = "",
  knowledge = "",
  memory = "",
  claudeAssets = {},
  pendingTools = []
} = {}) {
  const messagesText = (chat.messages || []).map(messageText).join("\n");
  const attachmentsText = (chat.messages || [])
    .flatMap((message) => message.attachments || [])
    .map((attachment) => `${attachment.name || ""}\n${attachment.preview || ""}\n${attachment.content || ""}`)
    .join("\n");
  const rulesText = (claudeAssets.rules || []).map((rule) => rule.content || "").join("\n");
  const claudeText = [claudeAssets.claudeMemory, claudeAssets.localMemory].filter(Boolean).join("\n");
  const customCommandsText = (claudeAssets.commands || []).map((command) => `${command.name}: ${command.description || ""}`).join("\n");
  const buckets = {
    system: estimateTokensFromText(system),
    messages: estimateTokensFromText(messagesText),
    attachments: estimateTokensFromText(attachmentsText),
    knowledge: estimateTokensFromText(knowledge),
    memory: estimateTokensFromText(memory),
    claude: estimateTokensFromText(claudeText),
    rules: estimateTokensFromText(rulesText),
    commands: estimateTokensFromText(customCommandsText),
    pendingTools: estimateTokensFromText((pendingTools || []).map((tool) => `${tool.name}:${tool.input?.path || tool.input?.command || ""}`).join("\n"))
  };
  const usedTokens = Object.values(buckets).reduce((sum, value) => sum + value, 0);
  const limit = Math.max(1, Number(settings.contextWindowHint || 200000));
  const policy = normalizeContextPolicy(settings.contextPolicy || {});
  const ratio = usedTokens / limit;
  return {
    usedTokens,
    limitTokens: limit,
    ratio,
    percent: Math.round(ratio * 100),
    buckets,
    counts: {
      messages: (chat.messages || []).length,
      snapshots: chat.contextSnapshotId ? 1 : 0,
      memories: Number(project?.memory ? 1 : 0),
      rules: (claudeAssets.rules || []).length,
      commands: (claudeAssets.commands || []).length,
      pendingTools: (pendingTools || []).length
    },
    recommendation: contextRecommendation({ ratio, chat, policy }),
    policy
  };
}

export function contextRecommendation({ ratio = 0, chat = {}, policy = DEFAULT_CONTEXT_POLICY } = {}) {
  const normalized = normalizeContextPolicy(policy);
  if ((chat.messages || []).length <= normalized.keepLastMessages + 2) {
    return { action: "none", reason: "short_chat", shouldCompact: false };
  }
  if (ratio >= normalized.emergencyAtRatio) return { action: "compact_now", reason: "emergency_threshold", shouldCompact: true };
  if (normalized.autoCompactEnabled && ratio >= normalized.compactAtRatio) return { action: "auto_compact", reason: "threshold", shouldCompact: true };
  return { action: "none", reason: "within_budget", shouldCompact: false };
}

export function messagesForModel(chat = {}, policyInput = {}, snapshot = null) {
  const messages = chat.messages || [];
  const policy = normalizeContextPolicy(policyInput);
  if (!snapshot && !chat.contextSummary) return messages;
  const keepLast = Math.min(Math.max(Number(policy.keepLastMessages || 8), 2), 40);
  const kept = messages.slice(-keepLast);
  const summary = snapshot?.summary || chat.contextSummary || "";
  const summaryMessage = summary
    ? {
        id: `context_${snapshot?.id || chat.contextSnapshotId || "summary"}`,
        role: "user",
        content: `Compacted prior context:\n${summary}`,
        displayContent: "/compact context summary",
        compactedContext: true,
        createdAt: snapshot?.createdAt || ""
      }
    : null;
  return summaryMessage ? [summaryMessage, ...kept] : kept;
}

export function buildSnapshot({ chat = {}, input = {}, idFactory = defaultId, now = defaultNow } = {}) {
  const policy = normalizeContextPolicy(input.policy || {});
  const keepLast = Math.min(Math.max(Number(input.keepLast || policy.keepLastMessages), 2), 40);
  const messages = chat.messages || [];
  const compacted = messages.slice(0, Math.max(0, messages.length - keepLast));
  const baseSummary = String(input.summary || compacted.map((message) => `${message.role || "message"}: ${shortSummary(messageText(message), 500)}`).join("\n"))
    .slice(0, policy.maxSnapshotChars);
  const sectionInput = input.sections && typeof input.sections === "object" ? input.sections : {};
  const focus = String(input.preserveFocus || input.focus || "").slice(0, 12000);
  const latestFailures = String(sectionInput.latestFailures || baseSummary.match(/(?:fail|error|exception|failed)[\s\S]{0,1200}/i)?.[0] || "").slice(0, 12000);
  const sections = {
    taskSummary: String(sectionInput.taskSummary || baseSummary || "No prior context compacted.").slice(0, 20000),
    preservedFocus: focus,
    changedFiles: Array.isArray(sectionInput.changedFiles) ? sectionInput.changedFiles.map(String).slice(0, 80) : [],
    openDecisions: String(sectionInput.openDecisions || "").slice(0, 12000),
    latestFailures,
    nextActions: String(sectionInput.nextActions || input.nextActions || "").slice(0, 12000)
  };
  const summary = [
    `Task summary:\n${sections.taskSummary}`,
    sections.preservedFocus ? `Preserve focus:\n${sections.preservedFocus}` : "",
    sections.changedFiles.length ? `Changed files:\n${sections.changedFiles.join("\n")}` : "",
    sections.openDecisions ? `Open decisions:\n${sections.openDecisions}` : "",
    sections.latestFailures ? `Latest failures:\n${sections.latestFailures}` : "",
    sections.nextActions ? `Next actions:\n${sections.nextActions}` : ""
  ].filter(Boolean).join("\n\n").slice(0, policy.maxSnapshotChars);
  return {
    id: idFactory("ctx"),
    chatId: chat.id,
    projectId: chat.projectId || null,
    trigger: input.trigger || "manual",
    keepLast,
    messageCount: compacted.length,
    summary,
    sections,
    createdAt: now()
  };
}

function shortSummary(text = "", limit = 500) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}...` : cleaned;
}

function defaultId(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2, 10)}`;
}

function defaultNow() {
  return new Date().toISOString();
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
