import path from 'node:path';
import type { AppMode, PermissionMode, PolicyCapability, PolicyOutcome, RiskLevel } from '../contracts.js';
import type { Capability } from './types.js';

/**
 * Trusted execution policy. Capability and risk are properties of the installed tool, never of the
 * model's proposal: an unlisted name fails closed instead of inheriting a prefix guess.
 */
export interface ToolSpec {
    capability: PolicyCapability;
    risk: RiskLevel;
    kernelCapability: Capability;
    /** Protected tools touch credentials or external systems and can never be covered by a session grant. */
    protected?: boolean;
}

export const toolRegistry: Record<string, ToolSpec> = {
    read_file: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    list_files: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    search_text: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    git_query: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    list_skills: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    read_skill: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    search_history: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    read_history: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    recall_memory: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    remember: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    read_events: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    delegate: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    list_delegations: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    wait_for_children: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    accept_child_result: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    cancel_child: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    dismiss_child: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    create_plan: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    search_collaboration: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    read_collaboration: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    list_mcp_tools: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    list_plugins: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    ask_user: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    finish: { capability: 'read', risk: 'low', kernelCapability: 'workspace.read' },
    write_file: { capability: 'write', risk: 'high', kernelCapability: 'workspace.write' },
    fixture_increment: { capability: 'write', risk: 'low', kernelCapability: 'fixture.write' },
    run_command: { capability: 'exec', risk: 'high', kernelCapability: 'process.exec' },
    run_shell: { capability: 'exec', risk: 'critical', kernelCapability: 'process.exec' },
    rea_analyze_local: { capability: 'exec', risk: 'high', kernelCapability: 'process.exec' },
    plugin_transform: { capability: 'exec', risk: 'high', kernelCapability: 'plugin.execute', protected: true },
    web_search: { capability: 'network', risk: 'low', kernelCapability: 'network.read' },
    web_fetch: { capability: 'network', risk: 'low', kernelCapability: 'network.read' },
    web_crawl: { capability: 'network', risk: 'low', kernelCapability: 'network.read' },
    mcp_call: { capability: 'mcp', risk: 'high', kernelCapability: 'mcp.call', protected: true },
    mcp_read: { capability: 'mcp', risk: 'low', kernelCapability: 'mcp.call', protected: true },
};

export function classifyTool(name: string): ToolSpec | undefined {
    return Object.prototype.hasOwnProperty.call(toolRegistry, name) ? toolRegistry[name] : undefined;
}

export function isProtectedTool(name: string): boolean {
    return classifyTool(name)?.protected === true;
}

/** One exact session authorization: tool, capability, resources and policy epoch must all still match. */
export interface SessionGrant {
    id: string;
    taskId: string;
    workspace: string;
    tool: string;
    kernelCapability: Capability;
    capability: PolicyCapability;
    risk: RiskLevel;
    resources: string[];
    policyEpoch: number;
    goalVersion: number;
    mode: PermissionMode;
    createdAt: string;
}

export interface TaskPermissionState {
    taskId: string;
    mode: PermissionMode;
    appMode: AppMode;
    policyEpoch: number;
    grants: SessionGrant[];
}

export interface IntentDecision {
    requiresOperator?: boolean;
    outcome: PolicyOutcome;
    mode: PermissionMode;
    appMode: AppMode;
    capability: PolicyCapability;
    risk: RiskLevel;
    reason: string;
    grantId?: string;
}

export interface PermissionChange {
    permissionMode?: PermissionMode;
    appMode?: AppMode;
    ceiling?: string[];
    reason?: string;
}

export const permissionModes: readonly PermissionMode[] = ['read-only', 'ask', 'auto-review', 'full-access'];
export const riskLevels: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];

const riskRank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function isPermissionMode(value: unknown): value is PermissionMode {
    return typeof value === 'string' && (permissionModes as readonly string[]).includes(value);
}

export function isAppMode(value: unknown): value is AppMode {
    return value === 'chat' || value === 'work';
}

export function isRiskLevel(value: unknown): value is RiskLevel {
    return typeof value === 'string' && (riskLevels as readonly string[]).includes(value);
}

/** Authority order for narrowing: read-only 0 … full-access 3. */
export function modeRank(mode: PermissionMode): number {
    return permissionModes.indexOf(mode);
}

/** Delegated subtasks may only keep or narrow the parent mode; invalid requests keep the parent. */
export function narrowMode(parent: PermissionMode, requested: unknown): PermissionMode {
    if (!isPermissionMode(requested)) return parent;
    return modeRank(requested) <= modeRank(parent) ? requested : parent;
}

/** Identical to the frontend table in src/frontend/api/policy.ts. */
export function decide(mode: PermissionMode, capability: PolicyCapability, risk: RiskLevel): PolicyOutcome {
    if (capability === 'read') return 'allow';
    // Critical effects always ask a human in ask/full-access modes; auto-review routes them to the reviewer.
    if (risk === 'critical' && (mode === 'ask' || mode === 'full-access')) return 'ask';
    switch (mode) {
        case 'read-only': return 'deny';
        case 'ask': return 'ask';
        case 'auto-review': return riskRank[risk] === 0 ? 'allow' : 'review';
        case 'full-access': return 'allow';
    }
}

/** Only the trusted read adapter gives MCP low risk; generic MCP, write and exec stay denied. */
export function decideForMode(appMode: AppMode, mode: PermissionMode, capability: PolicyCapability, risk: RiskLevel): PolicyOutcome {
    if (appMode === 'chat') return capability === 'read' || capability === 'network' || capability === 'mcp' && risk === 'low' ? 'allow' : 'deny';
    return decide(mode, capability, risk);
}

export function reviewEscalates(risk: RiskLevel, escalateAt: RiskLevel): boolean {
    return riskRank[risk] >= riskRank[escalateAt];
}

const protectedDirectories = new Set(['.git', '.aws', '.codex', '.agents', '.tools', '.deps', '.cache', '.tmp', 'node_modules', 'secrets']);
const protectedNames = new Set(['.env', 'api.txt', '.npmrc', '.netrc', '.pypirc', '.git-credentials', 'credentials', 'credentials.json']);

/**
 * Lexical protection for credential and product-data locations. This is the policy boundary the
 * kernel can enforce; it is not an OS sandbox for paths outside the workspace.
 */
export function isProtectedPath(workspace: string, resolved: string): boolean {
    const relative = path.relative(path.resolve(workspace), path.resolve(resolved));
    if (relative === '') return false;
    if (relative.startsWith('..') || path.isAbsolute(relative)) return true;
    for (const segment of relative.split(path.sep)) {
        const name = segment.toLocaleLowerCase('en-US');
        if (protectedDirectories.has(name)) return true;
        if (protectedNames.has(name) || name.startsWith('.env') || name.startsWith('credential') || name.startsWith('secret')) return true;
        if (/^id_(rsa|dsa|ed25519|ecdsa)/.test(name)) return true;
    }
    return false;
}
