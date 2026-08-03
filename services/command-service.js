export const BUILTIN_COMMANDS = [
  { name: "help", description: "Show built-in commands and workflow shortcuts.", category: "core", kind: "local" },
  { name: "doctor", description: "Run local workbench health checks.", category: "core", kind: "local" },
  { name: "status", description: "Alias for /doctor.", category: "core", kind: "local" },
  { name: "context", description: "Show context usage, rules, memory, and compaction recommendations.", category: "context", kind: "local" },
  { name: "compact", description: "Compact long chat context into an auditable summary.", category: "context", kind: "local" },
  { name: "rules", description: "Show or reload CLAUDE.md, CLAUDE.local.md, and .claude/rules assets.", category: "context", kind: "local" },
  { name: "memory", description: "List, add, suggest, accept, reject, pause, resume, or clean memory.", category: "memory", kind: "local" },
  { name: "plan", description: "Create a development plan for the current repository.", category: "dev", kind: "prompt" },
  { name: "fix", description: "Start a Dev Session that edits, tests, and repairs failures.", category: "dev", kind: "prompt" },
  { name: "test", description: "Run the configured Dev Session test command.", category: "dev", kind: "prompt" },
  { name: "review", description: "Review current git diff or PR context.", category: "dev", kind: "prompt" },
  { name: "commit", description: "Prepare commit message and gated finalize flow.", category: "git", kind: "prompt" },
  { name: "pr", description: "Prepare PR title/body and gated GitHub PR creation.", category: "git", kind: "prompt" },
  { name: "permissions", description: "Open structured local tool permission settings.", category: "security", kind: "prompt" },
  { name: "cost", description: "Show token and estimated cost statistics.", category: "metrics", kind: "prompt" }
];

const PROMPTS = {
  plan: "Create a concise implementation plan for the current repository. Identify files to inspect, risk areas, and verification steps.",
  fix: "Start from the failure or request below, edit the repository through approved tools, run tests, and iterate until the fix is ready.",
  test: "Run or propose the most relevant allowed tests for this repository and summarize failures with next actions.",
  review: "Review the current repository changes for bugs, regressions, security risks, and missing tests.",
  commit: "Prepare a commit message and final verification checklist. Do not commit without explicit confirmation.",
  pr: "Prepare a PR title, body, test notes, and rollout risks. Do not publish without explicit confirmation.",
  permissions: "Explain which local tool permissions or approvals are needed for this task.",
  cost: "Summarize recent model token usage and estimated cost from the usage panel."
};

export function parseSlashCommand(text = "") {
  const raw = String(text || "").trim();
  const match = raw.match(/^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return {
    raw,
    name,
    args: String(match[2] || "").trim()
  };
}

export function parseCommandArgs(args = "") {
  const tokens = String(args || "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const flags = {};
  const positional = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripQuotes(tokens[index]);
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [keyRaw, inlineValue] = token.slice(2).split(/=(.*)/s).filter((item) => item !== undefined);
    const key = keyRaw.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      flags[key] = stripQuotes(inlineValue);
      continue;
    }
    const next = tokens[index + 1] ? stripQuotes(tokens[index + 1]) : "";
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { tokens: positional, text: positional.join(" "), flags };
}

export function resolveCommand(text = "", customCommands = []) {
  const parsed = parseSlashCommand(text);
  if (!parsed) return { type: "message", text: String(text || "") };
  const builtIn = BUILTIN_COMMANDS.find((command) => command.name === parsed.name);
  if (builtIn) return { type: builtIn.kind, command: builtIn, ...parsed, parsedArgs: parseCommandArgs(parsed.args) };
  const custom = (customCommands || []).find((command) => String(command.name || "").toLowerCase() === parsed.name);
  if (custom) return { type: "custom", command: custom, ...parsed, parsedArgs: parseCommandArgs(parsed.args) };
  return { type: "unknown", ...parsed, parsedArgs: parseCommandArgs(parsed.args) };
}

export function publicCommands(customCommands = []) {
  const custom = (Array.isArray(customCommands) ? customCommands : [])
    .map((command) => ({
      name: String(command.name || "").replace(/^\//, ""),
      description: String(command.description || command.path || "Custom command"),
      category: "custom",
      kind: "custom"
    }))
    .filter((command) => command.name);
  return [...BUILTIN_COMMANDS, ...custom];
}

export function expandPromptCommand(resolved, customCommands = []) {
  if (!resolved || resolved.type === "message") return String(resolved?.text || "");
  if (resolved.type === "prompt") {
    const prompt = PROMPTS[resolved.name] || resolved.command?.description || "";
    return `${prompt}\n\nUser arguments: ${resolved.args || ""}`;
  }
  if (resolved.type === "custom") {
    const command = resolved.command || (customCommands || []).find((item) => item.name === resolved.name);
    return `${command?.prompt || ""}\n\nUser arguments: ${resolved.args || ""}`.trim();
  }
  return String(resolved.raw || "");
}

export function helpText(customCommands = []) {
  return publicCommands(customCommands)
    .map((command) => `/${command.name} - ${command.description}`)
    .join("\n");
}

export function memoryCommandInput(resolved = {}) {
  const { tokens, text, flags } = resolved.parsedArgs || parseCommandArgs(resolved.args || "");
  const action = String(tokens[0] || "list").toLowerCase();
  return {
    action,
    id: tokens[1] || flags.id || "",
    title: flags.title || "",
    category: flags.category || "custom",
    scope: flags.scope || "",
    text: flags.text || tokens.slice(action === "add" || action === "suggest" ? 1 : 2).join(" ") || text,
    mode: flags.mode || "auto",
    reason: flags.reason || "",
    rawText: text,
    flags
  };
}

export function compactCommandInput(resolved = {}) {
  const { text, flags } = resolved.parsedArgs || parseCommandArgs(resolved.args || "");
  return {
    keepLast: flags.keep ? Number(flags.keep) : flags.keepLast ? Number(flags.keepLast) : undefined,
    preserveFocus: flags.focus || flags.preserveFocus || text || "",
    nextActions: flags.next || flags.nextActions || "",
    trigger: "manual",
    summary: text
  };
}

function stripQuotes(value = "") {
  const text = String(value || "");
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}
