import crypto from "node:crypto";

const SUPPORTED_EVENTS = new Set([
  "issue_comment",
  "pull_request_review_comment",
  "pull_request",
  "workflow_run",
  "check_run"
]);

function now() {
  return new Date().toISOString();
}

export function generateWebhookSecret() {
  return crypto.randomBytes(32).toString("hex");
}

export function signGitHubWebhook(secret = "", rawBody = "") {
  const digest = crypto.createHmac("sha256", String(secret || "")).update(String(rawBody || ""), "utf8").digest("hex");
  return `sha256=${digest}`;
}

export function verifyGitHubWebhook({ secret = "", rawBody = "", signature = "" } = {}) {
  const expected = signGitHubWebhook(secret, rawBody);
  const provided = String(signature || "");
  if (!secret || !provided.startsWith("sha256=")) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function normalizeGitHubSettings(input = {}) {
  return {
    mentionTrigger: String(input.mentionTrigger || "@workbench").trim().slice(0, 80) || "@workbench",
    commentMarker: String(input.commentMarker || "<!-- claude-workbench -->").slice(0, 200),
    repoBinding: String(input.repoBinding || "").trim().slice(0, 1000),
    autofix: {
      enabled: input.autofix?.enabled === true,
      testCommand: String(input.autofix?.testCommand || "npm test").slice(0, 240),
      maxRepairRounds: Math.min(Math.max(Number(input.autofix?.maxRepairRounds || 3), 0), 8)
    }
  };
}

export function publicGitHubSettings(input = {}) {
  return normalizeGitHubSettings(input);
}

export function normalizeGitHubEvent(input = {}) {
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const eventType = SUPPORTED_EVENTS.has(input.eventType) ? input.eventType : String(input.eventType || "unknown").slice(0, 120);
  const repo = String(input.repository || repositoryName(payload)).slice(0, 240);
  const action = String(payload.action || input.action || "").slice(0, 80);
  const comment = payload.comment || payload.review || {};
  const pullRequest = payload.pull_request || payload.workflow_run?.pull_requests?.[0] || payload.check_run?.pull_requests?.[0] || {};
  const body = String(input.body || comment.body || payload.issue?.body || pullRequest.body || "").slice(0, 60000);
  const number = Number(input.number || payload.issue?.number || pullRequest.number || payload.workflow_run?.pull_requests?.[0]?.number || 0) || null;
  const headBranch = input.headBranch || pullRequest.head?.ref || payload.workflow_run?.head_branch || payload.check_run?.check_suite?.head_branch || "";
  const conclusion = input.conclusion || payload.workflow_run?.conclusion || payload.check_run?.conclusion || "";
  const status = input.ciStatus || payload.workflow_run?.status || payload.check_run?.status || "";
  return {
    id: String(input.id || githubEventId(eventType, input.deliveryId || input.githubDelivery || "", payload)),
    githubDelivery: String(input.deliveryId || input.githubDelivery || "").slice(0, 160),
    eventType,
    action,
    repository: repo,
    sender: String(input.sender || payload.sender?.login || "").slice(0, 120),
    number,
    title: String(input.title || payload.issue?.title || pullRequest.title || payload.workflow_run?.display_title || payload.check_run?.name || "").slice(0, 240),
    body,
    htmlUrl: String(input.htmlUrl || comment.html_url || payload.issue?.html_url || pullRequest.html_url || payload.workflow_run?.html_url || payload.check_run?.html_url || "").slice(0, 1000),
    headBranch: String(headBranch || "").slice(0, 240),
    conclusion: String(conclusion || "").slice(0, 80),
    ciStatus: String(status || "").slice(0, 80),
    status: ["received", "ignored", "blocked", "session_created", "handled", "failed"].includes(input.status) ? input.status : "received",
    reason: String(input.reason || "").slice(0, 4000),
    devSessionId: input.devSessionId || null,
    createdAt: input.createdAt || now(),
    updatedAt: input.updatedAt || now()
  };
}

export function shouldTriggerMention(event = {}, trigger = "@workbench") {
  const normalized = normalizeGitHubEvent(event);
  const needle = String(trigger || "@workbench").toLowerCase();
  if (!needle) return false;
  if (!["issue_comment", "pull_request_review_comment"].includes(normalized.eventType)) return false;
  return normalized.body.toLowerCase().includes(needle);
}

export function shouldTriggerCiAutofix(event = {}, settings = {}) {
  const normalized = normalizeGitHubEvent(event);
  const github = normalizeGitHubSettings(settings);
  if (!github.autofix.enabled) return false;
  if (!["workflow_run", "check_run"].includes(normalized.eventType)) return false;
  return ["failure", "timed_out", "cancelled", "startup_failure"].includes(normalized.conclusion);
}

export function eventToDevSessionInput(event = {}, settings = {}, project = null) {
  const normalized = normalizeGitHubEvent(event);
  const github = normalizeGitHubSettings(settings);
  const mention = shouldTriggerMention(normalized, github.mentionTrigger);
  const ci = shouldTriggerCiAutofix(normalized, github);
  const reason = mention ? "github_mention" : ci ? "ci_autofix" : "manual_triage";
  const goal = mention
    ? `Handle GitHub mention from ${normalized.sender || "user"} on ${normalized.repository}#${normalized.number || ""}.\n\n${normalized.body}`
    : `Investigate failed CI for ${normalized.repository} ${normalized.headBranch || ""}.\n\nEvent: ${normalized.eventType} ${normalized.conclusion || normalized.ciStatus}`;
  return {
    title: mention ? `PR mention: ${normalized.title || normalized.repository}` : `CI autofix: ${normalized.title || normalized.repository}`,
    goal,
    source: reason,
    githubEventId: normalized.id,
    projectId: project?.id || null,
    workspacePath: project?.workspacePath || "",
    branch: normalized.headBranch || "",
    testCommand: github.autofix.testCommand || "npm test",
    maxRepairRounds: github.autofix.maxRepairRounds
  };
}

export function redactGitHubPayload(payload = {}) {
  return redactNested(JSON.parse(JSON.stringify(payload || {})));
}

function redactNested(value) {
  if (Array.isArray(value)) return value.map(redactNested);
  if (!value || typeof value !== "object") return value;
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:^|_)(?:access_)?token$|authorization|secret|password|api[_-]?key/i.test(key)) value[key] = "[redacted]";
    else value[key] = redactNested(nested);
  }
  return value;
}

function repositoryName(payload = {}) {
  const repo = payload.repository || {};
  return String(repo.full_name || [repo.owner?.login, repo.name].filter(Boolean).join("/") || "").slice(0, 240);
}

function githubEventId(eventType, deliveryId, payload) {
  const source = JSON.stringify({
    eventType,
    deliveryId,
    repo: repositoryName(payload),
    action: payload?.action || "",
    number: payload?.issue?.number || payload?.pull_request?.number || payload?.workflow_run?.id || payload?.check_run?.id || ""
  });
  return `ghe_${crypto.createHash("sha256").update(source).digest("hex").slice(0, 18)}`;
}
