import path from 'node:path';
import type { PolicyCapability, PolicyOutcome, RiskLevel } from '../contracts.js';
import { fail } from './types.js';

/**
 * Settings.rules turn operator intent into authority, so this module is the single validator and
 * matcher for them. A pattern is a bounded glob, never a regular expression: only '*' (any run,
 * including path separators) and '?' (exactly one character) have meaning, matching is
 * case-insensitive, and the matcher walks the two strings once with backtracking over stars, so no
 * user-supplied pattern can cause catastrophic backtracking. Anything else is literal text.
 */

export type PermissionRuleDecision = 'allow' | 'ask' | 'deny';

/** Structurally identical to the frontend Settings rule; capability names are the policy vocabulary. */
export interface PermissionRule {
    id: string;
    pattern: string;
    capability: PolicyCapability;
    decision: PermissionRuleDecision;
}

export interface PermissionRuleLimits {
    rules: number;
    id: number;
    pattern: number;
}

export const permissionRuleLimits: PermissionRuleLimits = { rules: 100, id: 100, pattern: 200 };
export const permissionRuleCapabilities: readonly PolicyCapability[] = ['read', 'write', 'exec', 'network', 'mcp'];
export const permissionRuleDecisions: readonly PermissionRuleDecision[] = ['allow', 'ask', 'deny'];
const ruleFields = new Set(['id', 'pattern', 'capability', 'decision']);
const controlCharacters = /[\u0000-\u001f\u007f]/;
const decisionRank: Record<PermissionRuleDecision, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * Validate once, at the settings boundary and again whenever stored authority is read back.
 * Rejecting the whole array (instead of silently dropping bad entries) keeps the operator's
 * intended set and the active set identical.
 */
export function validatePermissionRules(input: unknown): PermissionRule[] {
    if (!Array.isArray(input)) fail('INVALID_PERMISSION_RULE', 'Permission rules must be an array');
    if (input.length > permissionRuleLimits.rules)
        fail('INVALID_PERMISSION_RULE', `Permission rules are limited to ${permissionRuleLimits.rules} entries`);
    const seen = new Set<string>();
    return input.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            fail('INVALID_PERMISSION_RULE', `Permission rule at index ${index} must be an object`);
        const record = entry as Record<string, unknown>;
        for (const key of Object.keys(record))
            if (!ruleFields.has(key)) fail('INVALID_PERMISSION_RULE', `Permission rule at index ${index} has unknown field ${key}`);
        for (const key of ruleFields)
            if (!(key in record)) fail('INVALID_PERMISSION_RULE', `Permission rule at index ${index} is missing ${key}`);
        const id = record.id;
        if (typeof id !== 'string' || id.length < 1 || id.length > permissionRuleLimits.id)
            fail('INVALID_PERMISSION_RULE', `Permission rule id at index ${index} must be 1-${permissionRuleLimits.id} characters`);
        if (controlCharacters.test(id)) fail('INVALID_PERMISSION_RULE', `Permission rule id at index ${index} contains a control character`);
        if (seen.has(id)) fail('INVALID_PERMISSION_RULE', `Permission rule id ${id} is duplicated`);
        seen.add(id);
        const pattern = record.pattern;
        if (typeof pattern !== 'string' || pattern.length < 1 || pattern.length > permissionRuleLimits.pattern)
            fail('INVALID_PERMISSION_RULE', `Permission rule pattern at index ${index} must be 1-${permissionRuleLimits.pattern} characters`);
        if (controlCharacters.test(pattern)) fail('INVALID_PERMISSION_RULE', `Permission rule pattern at index ${index} contains a control character`);
        if (!pattern.trim()) fail('INVALID_PERMISSION_RULE', `Permission rule pattern at index ${index} is blank`);
        const capability = record.capability;
        if (typeof capability !== 'string' || !permissionRuleCapabilities.includes(capability as PolicyCapability))
            fail('INVALID_PERMISSION_RULE', `Permission rule capability at index ${index} must be one of ${permissionRuleCapabilities.join(', ')}`);
        const decision = record.decision;
        if (typeof decision !== 'string' || !permissionRuleDecisions.includes(decision as PermissionRuleDecision))
            fail('INVALID_PERMISSION_RULE', `Permission rule decision at index ${index} must be one of ${permissionRuleDecisions.join(', ')}`);
        return { id, pattern, capability: capability as PolicyCapability, decision: decision as PermissionRuleDecision };
    });
}

/** Lowercase POSIX form: backslashes become separators and a leading './' is noise, not a prefix. */
export function normalizePermissionTarget(value: string): string {
    return value.replace(/\\/g, '/').trim().replace(/^(?:\.\/)+/, '').toLowerCase();
}

function workspaceRelative(workspace: string, value: string): string | undefined {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return undefined;
    const root = path.resolve(workspace);
    const full = path.resolve(root, value);
    const relative = path.relative(root, full);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    return relative;
}

/** run_shell keeps a command line; run_command carries an executable plus argv. */
function execCommand(argumentsRecord: Record<string, unknown>): string {
    if (typeof argumentsRecord.command === 'string') return argumentsRecord.command;
    const argv = Array.isArray(argumentsRecord.argv) ? argumentsRecord.argv.filter((part): part is string => typeof part === 'string') : [];
    if (argv.length) return ['node', ...argv].join(' ');
    return typeof argumentsRecord.executable === 'string' ? argumentsRecord.executable : '';
}

export interface PermissionTargetInput {
    workspace: string;
    capability: PolicyCapability;
    resources: string[];
    paths: string[];
    arguments: Record<string, unknown>;
}

/**
 * The candidate strings a rule may match. Both the absolute and the workspace-relative form of a
 * path are candidates so an operator can write either; exec effects also expose the command line
 * with and without the workspace prefix, because argv paths are absolute by the time a tool runs.
 */
export function permissionRuleTargets(input: PermissionTargetInput): string[] {
    const targets = new Set<string>();
    const add = (value: unknown): void => {
        if (typeof value !== 'string') return;
        const normalized = normalizePermissionTarget(value);
        if (normalized) targets.add(normalized);
    };
    const addPath = (value: unknown): void => {
        if (typeof value !== 'string' || !value.trim()) return;
        add(value);
        add(workspaceRelative(input.workspace, value));
    };
    for (const resource of input.resources) addPath(resource);
    for (const resourcePath of input.paths) addPath(resourcePath);
    if (input.capability === 'exec') {
        const command = execCommand(input.arguments);
        if (command) {
            add(command);
            const prefix = normalizePermissionTarget(input.workspace);
            const lowercase = command.toLowerCase();
            if (prefix && lowercase.includes(prefix)) add(lowercase.split(prefix).join(''));
        }
    }
    return [...targets];
}

/** Greedy single-pass glob: '?' consumes one character, '*' consumes any run (including '/'). */
export function globMatches(pattern: string, target: string): boolean {
    const p = pattern.toLowerCase();
    const t = target.toLowerCase();
    let pi = 0;
    let ti = 0;
    let star = -1;
    let mark = 0;
    while (ti < t.length) {
        if (pi < p.length && (p[pi] === '?' || p[pi] === t[ti])) { pi += 1; ti += 1; }
        else if (pi < p.length && p[pi] === '*') { star = pi; pi += 1; mark = ti; }
        else if (star !== -1) { pi = star + 1; mark += 1; ti = mark; }
        else return false;
    }
    while (pi < p.length && p[pi] === '*') pi += 1;
    return pi === p.length;
}

/**
 * Deny always outranks ask and allow, and the first deny in the operator's order wins so the
 * recorded rule id is deterministic. Later rules never weaken an earlier deny.
 */
export function matchPermissionRule(rules: readonly PermissionRule[], capability: PolicyCapability, targets: readonly string[]): PermissionRule | undefined {
    let matched: PermissionRule | undefined;
    let rank = -1;
    for (const rule of rules) {
        if (rule.capability !== capability) continue;
        if (!targets.some(target => globMatches(rule.pattern, target))) continue;
        const current = decisionRank[rule.decision];
        if (current > rank) { matched = rule; rank = current; }
        if (rule.decision === 'deny') return rule;
    }
    return matched;
}

export interface PermissionRuleEffect {
    risk: RiskLevel;
    protected?: boolean;
}

/**
 * Rules layer on top of the mode table: deny is final, ask always wins over a grant, and allow may
 * only remove a human ask. It never converts a denied mode (read-only/Chat), a critical effect or a
 * protected tool into executable authority.
 */
export function applyPermissionRule(base: PolicyOutcome, rule: PermissionRule | undefined, effect: PermissionRuleEffect): PolicyOutcome {
    if (!rule) return base;
    if (rule.decision === 'deny') return 'deny';
    if (rule.decision === 'ask') return base === 'deny' ? 'deny' : 'ask';
    return base === 'ask' && effect.risk !== 'critical' && !effect.protected ? 'allow' : base;
}

/** True when the rule actually supplied the effective verdict rather than merely matching. */
export function permissionRuleApplied(rule: PermissionRule | undefined, base: PolicyOutcome, outcome: PolicyOutcome): boolean {
    if (!rule) return false;
    if (rule.decision === 'deny') return outcome === 'deny';
    if (rule.decision === 'ask') return outcome === 'ask' && base !== 'deny';
    return outcome === 'allow' && base !== 'allow';
}

export function permissionRuleReason(rule: PermissionRule, outcome: PolicyOutcome): string {
    const verb = outcome === 'deny' ? 'blocks' : outcome === 'ask' ? 'asks before' : 'allows';
    return `Permission rule ${rule.id} ${verb} ${rule.capability} effects matching ${rule.pattern}`;
}

/** Order-insensitive equality: saving the same set again is a no-op, not a policy epoch bump. */
export function samePermissionRules(left: readonly PermissionRule[], right: readonly PermissionRule[]): boolean {
    if (left.length !== right.length) return false;
    const key = (rule: PermissionRule): string => [rule.id, rule.pattern, rule.capability, rule.decision].join('\u0000');
    const first = left.map(key).sort();
    const second = right.map(key).sort();
    return first.every((value, index) => value === second[index]);
}
