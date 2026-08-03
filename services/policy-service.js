function now() {
  return new Date().toISOString();
}

const EFFECTS = new Set(["allow", "deny", "requireApproval"]);
const HOOK_ACTIONS = new Set(["allow", "deny", "requireApproval", "mutateInput", "annotate", "redactObservation", "requestRepair"]);

export function normalizePermissionRule(input = {}, index = 0) {
  if (typeof input === "string") {
    return {
      id: `rule_${index}`,
      effect: "requireApproval",
      tool: input,
      command: "",
      path: "",
      connector: "",
      risk: "",
      enabled: true,
      note: ""
    };
  }
  return {
    id: String(input.id || `rule_${index}`),
    effect: EFFECTS.has(input.effect) ? input.effect : "requireApproval",
    tool: String(input.tool || input.name || "*").trim() || "*",
    command: String(input.command || "").trim().slice(0, 500),
    path: String(input.path || "").trim().slice(0, 1000),
    connector: String(input.connector || "").trim().slice(0, 200),
    risk: String(input.risk || "").trim().slice(0, 40),
    enabled: input.enabled !== false,
    note: String(input.note || "").slice(0, 1000)
  };
}

export function normalizePermissionRules(input = []) {
  const list = Array.isArray(input)
    ? input
    : [
        ...(input.deny || []).map((tool) => ({ effect: "deny", tool })),
        ...(input.allow || []).map((tool) => ({ effect: "allow", tool })),
        ...(input.requireApproval || []).map((tool) => ({ effect: "requireApproval", tool }))
      ];
  return list.map(normalizePermissionRule).filter((rule) => rule.enabled).slice(0, 200);
}

export function legacyPermissionsFromRules(rules = []) {
  const output = { allow: [], deny: [], requireApproval: [] };
  for (const rule of normalizePermissionRules(rules)) {
    const pattern = [rule.tool || "*", rule.command || rule.path || ""].filter(Boolean).join(":");
    if (rule.effect === "allow") output.allow.push(pattern);
    if (rule.effect === "deny") output.deny.push(pattern);
    if (rule.effect === "requireApproval") output.requireApproval.push(pattern);
  }
  return output;
}

export function evaluatePermissionRules(rules = [], request = {}) {
  const normalized = normalizePermissionRules(rules);
  const matches = normalized.filter((rule) => ruleMatches(rule, request));
  const denied = matches.find((rule) => rule.effect === "deny");
  if (denied) return { effect: "deny", rule: denied, matches };
  const approval = matches.find((rule) => rule.effect === "requireApproval");
  if (approval) return { effect: "requireApproval", rule: approval, matches };
  const allowed = matches.find((rule) => rule.effect === "allow");
  if (allowed) return { effect: "allow", rule: allowed, matches };
  return { effect: "none", rule: null, matches: [] };
}

export function normalizeHookRule(input = {}, index = 0) {
  return {
    id: String(input.id || `hook_${index}`),
    event: ["PreToolUse", "PostToolUse"].includes(input.event) ? input.event : "PreToolUse",
    action: HOOK_ACTIONS.has(input.action) ? input.action : "allow",
    tool: String(input.tool || "*").trim() || "*",
    command: String(input.command || "").trim().slice(0, 500),
    path: String(input.path || "").trim().slice(0, 1000),
    risk: String(input.risk || "").trim().slice(0, 40),
    enabled: input.enabled !== false,
    mutateInput: input.mutateInput && typeof input.mutateInput === "object" ? input.mutateInput : {},
    annotation: String(input.annotation || "").slice(0, 4000),
    redactPatterns: normalizeStringList(input.redactPatterns || [], 40, 300),
    note: String(input.note || "").slice(0, 1000)
  };
}

export function normalizeHookRules(input = []) {
  const list = Array.isArray(input) ? input : [];
  return list.map(normalizeHookRule).filter((rule) => rule.enabled).slice(0, 200);
}

export function evaluateHookRules(rules = [], eventName = "PreToolUse", payload = {}) {
  const request = {
    name: payload.tool || payload.name || "",
    input: payload.input || {},
    risk: payload.risk || payload.input?.risk || ""
  };
  const matches = normalizeHookRules(rules).filter((rule) => rule.event === eventName && ruleMatches(rule, request));
  const decisions = [];
  let mutatedInput = null;
  let observation = payload.observation || "";
  for (const rule of matches) {
    decisions.push({ ruleId: rule.id, action: rule.action, note: rule.note || rule.annotation || "" });
    if (rule.action === "deny") return { action: "deny", rule, decisions, reason: rule.note || "Denied by hook." };
    if (rule.action === "requireApproval") return { action: "requireApproval", rule, decisions, reason: rule.note || "Approval required by hook." };
    if (rule.action === "mutateInput") mutatedInput = { ...(mutatedInput || payload.input || {}), ...rule.mutateInput };
    if (rule.action === "redactObservation") {
      for (const pattern of rule.redactPatterns) observation = observation.split(pattern).join("[redacted]");
    }
  }
  const repair = matches.find((rule) => rule.action === "requestRepair");
  const annotate = matches.filter((rule) => rule.action === "annotate").map((rule) => rule.annotation || rule.note).filter(Boolean);
  return {
    action: repair ? "requestRepair" : "allow",
    rule: repair || null,
    decisions,
    mutatedInput,
    observation,
    annotations: annotate
  };
}

export function createPolicyLog({ type = "policy", request = {}, decision = {}, eventName = "" } = {}) {
  return {
    id: `pol_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    type,
    eventName,
    tool: request.name || request.tool || "",
    risk: request.risk || "",
    effect: decision.effect || decision.action || "none",
    ruleId: decision.rule?.id || "",
    note: decision.reason || decision.rule?.note || "",
    createdAt: now()
  };
}

function ruleMatches(rule, request = {}) {
  if (!matchGlob(rule.tool || "*", request.name || request.tool || "")) return false;
  if (rule.risk && rule.risk !== request.risk) return false;
  const command = String(request.input?.command || "");
  const targetPath = String(request.input?.path || request.input?.cwd || "");
  const connector = String(request.input?.connectorId || request.input?.connector || "");
  if (rule.command && !matchGlob(rule.command, command)) return false;
  if (rule.path && !matchGlob(rule.path, targetPath)) return false;
  if (rule.connector && !matchGlob(rule.connector, connector)) return false;
  return true;
}

function matchGlob(pattern = "*", value = "") {
  const source = String(pattern || "*").toLowerCase();
  const target = String(value || "").toLowerCase();
  if (source === "*" || source === target) return true;
  return source.split("*").every((part) => target.includes(part));
}

function normalizeStringList(value, limit, itemLimit) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n|,/) : [];
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean).map((item) => item.slice(0, itemLimit)))].slice(0, limit);
}
