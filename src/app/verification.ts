import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Task, Intent } from '../contracts.js';
import type { ToolGateway } from '../tools/gateway.js';
import { resolveProjectPath, digestValue } from '../tools/policy.js';
import type { ExternalTools } from './external-tools.js';
import path from 'node:path';
import { archiveArtifact } from './artifacts.js';
import type { IntegrationTools } from '../integrations/tools.js';

export interface EffectSource {
    page(after: number, limit: number): { items: Intent[]; nextCursor: number | null };
    isLatestWrite(intent: Intent): boolean;
    relatedPage?(after: number, limit: number): { items: unknown[]; nextCursor: number | null };
}
export interface EvidenceReview {
    passed: boolean;
    findings: string[];
    artifacts: { path: string; sha256: string; archivePath?: string }[];
    receipts: Record<string, unknown>[];
    findingCount: number;
    hardFindingCount: number;
    artifactCount: number;
    receiptCount: number;
    manualAcceptance: boolean;
    detail?: { path: string; sha256: string; bytes: number; records: number };
}
const identity = (value: string) => path.normalize(value).toLowerCase();

/** The caller supplies a trusted immutable evidence path; model arguments only select its byte page. */
export async function readReviewEvidence(filename: string, cursor = 0, limit = 20, maxBytes = 12_000, signal?: AbortSignal) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50
        || !Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > 16_384) throw new RangeError('Invalid evidence page bounds.');
    signal?.throwIfAborted();
    const file = await open(filename, 'r');
    try {
        const size = (await file.stat()).size;
        if (cursor > size) throw new RangeError('Evidence cursor exceeds the selected archive.');
        const buffer = Buffer.alloc(Math.min(maxBytes, size - cursor));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor);
        signal?.throwIfAborted();
        let end = bytesRead, records = 0, lastNewline = 0;
        for (let index = 0; index < end; index++) if (buffer[index] === 10) {
            lastNewline = index + 1;
            if (++records === limit) break;
        }
        if (lastNewline) end = lastNewline;
        else if (cursor + end < size && end) {
            let lead = end - 1;
            while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead--;
            const first = buffer[lead]!;
            const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
            if (end - lead < width) end = lead;
        }
        return { text: buffer.subarray(0, end).toString('utf8'), cursor, nextCursor: cursor + end < size ? cursor + end : null,
            records, bytes: end, totalBytes: size, partialRecord: end > 0 && buffer[end - 1] !== 10 };
    } finally { await file.close(); }
}

/** Unexpectedly large or modified output is hashed incrementally, never read into one buffer. */
async function observeFile(filename: string, expected: Buffer, signal?: AbortSignal) {
    const hash = createHash('sha256');
    let position = 0, matches = true;
    for await (const chunk of createReadStream(filename, { highWaterMark: 64 * 1024, signal })) {
        const bytes = chunk as Buffer;
        hash.update(bytes);
        if (!bytes.equals(expected.subarray(position, position + bytes.length))) matches = false;
        position += bytes.length;
    }
    return { sha256: hash.digest('hex'), matches: matches && position === expected.length };
}
async function containsText(filename: string, text: string, signal?: AbortSignal): Promise<boolean> {
    const needle = Buffer.from(text);
    if (!needle.length) return true;
    let tail = Buffer.alloc(0);
    for await (const chunk of createReadStream(filename, { highWaterMark: 64 * 1024, signal })) {
        const bytes = Buffer.concat([tail, chunk as Buffer]);
        if (bytes.includes(needle)) return true;
        tail = bytes.subarray(Math.max(0, bytes.length - needle.length + 1));
    }
    return false;
}

/** Full evidence is written once, one observation at a time. The review prompt only gets a sample. */
export async function inspectEffects(task: Task, intents: Intent[] | EffectSource, gateway: ToolGateway, external?: ExternalTools,
    artifactDir?: string, integrations?: IntegrationTools, signal?: AbortSignal): Promise<EvidenceReview> {
    const findings: string[] = [], artifacts: EvidenceReview['artifacts'] = [], receipts: Record<string, unknown>[] = [];
    let findingCount = 0, hardFindingCount = 0, artifactCount = 0, receiptCount = 0, manualAcceptance = false, fixtureOne = false;
    const requiredFiles = new Set(task.goal.acceptance.filter(value => value.startsWith('file:')).map(value => identity(value.slice(5).trim())));
    const seenFiles = new Set<string>();
    // Legacy callers may supply an already bounded array; production uses the indexed source.
    const latestWrites = new Map<string, string>();
    if (Array.isArray(intents)) for (const intent of intents) if (intent.name === 'write_file' && intent.state === 'applied') latestWrites.set(identity(String(intent.arguments.path)), intent.id);
    const latest = (intent: Intent) => Array.isArray(intents) ? latestWrites.get(identity(String(intent.arguments.path))) === intent.id : intents.isLatestWrite(intent);
    const directory = artifactDir ? path.join(artifactDir, 'verification') : undefined;
    if (directory) mkdirSync(directory, { recursive: true });
    const filename = directory ? path.join(directory, `${randomUUID()}.jsonl`) : undefined;
    const fd = filename ? openSync(filename, 'wx') : undefined;
    const hash = createHash('sha256');
    let bytes = 0, records = 0;
    const record = (value: unknown) => {
        if (fd === undefined) return;
        const line = Buffer.from(JSON.stringify(value) + '\n');
        let offset = 0;
        while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset);
        hash.update(line); bytes += line.length; records++;
    };
    const finding = (value: string, manual = false) => { findingCount++; if (!manual) hardFindingCount++; if (findings.length < 20) findings.push(value.slice(0, 600)); record({ kind: 'finding', text: value, manual }); };
    async function inspect(intent: Intent) {
        signal?.throwIfAborted();
        if (intent.state === 'denied' || intent.state === 'failed') return;
        if (intent.state !== 'applied') { finding(`Unresolved effect ${intent.id}: ${intent.state}`); return; }
        const call = { id: intent.toolCallId, name: intent.name, arguments: intent.arguments };
        const remote = Boolean(external && ['web_search', 'web_fetch', 'web_crawl', 'mcp_call'].includes(intent.name));
        const actionDigest = digestValue({ name: call.name, arguments: call.arguments });
        const observer = intent.name === 'rea_analyze_local' && integrations ? integrations : remote ? external! : gateway;
        const observed = await observer.queryOutcome(intent.effectKey, actionDigest);
        if (observed.status !== 'applied' || !observed.receipt) { finding(`Receipt unavailable for ${intent.id}`); return; }
        receiptCount++;
        record({ kind: 'receipt', intentId: intent.id, actionDigest, receipt: observed.receipt });
        fixtureOne ||= observed.receipt.fixtureValue === 1;
        if (receipts.length < 8) {
            const sample: Record<string, unknown> = { intentId: intent.id, actionDigest };
            for (const key of ['fixtureValue', 'exitCode', 'path', 'sha256', 'status']) {
                const value = observed.receipt[key];
                if (typeof value === 'string') sample[key] = value.slice(0, 512);
                else if (typeof value === 'number' || typeof value === 'boolean') sample[key] = value;
            }
            receipts.push(sample);
        }
        if (intent.name !== 'write_file' || !latest(intent)) return;
        const target = await resolveProjectPath(task.workspace, String(intent.arguments.path));
        const expected = Buffer.from(String(intent.arguments.content), 'utf8');
        const observedFile = await observeFile(target, expected, signal);
        if (!observedFile.matches) finding(`Artifact changed since tool receipt: ${intent.arguments.path}`);
        const archived = artifactDir && observedFile.matches ? archiveArtifact(artifactDir, expected) : undefined;
        const artifact = { path: String(intent.arguments.path), sha256: observedFile.sha256, ...archived };
        artifactCount++; record({ kind: 'artifact', intentId: intent.id, ...artifact });
        if (requiredFiles.has(identity(artifact.path))) seenFiles.add(identity(artifact.path));
        if (artifacts.length < 20) artifacts.push({ ...artifact, path: artifact.path.slice(0, 1024) });
    }
    try {
        if (Array.isArray(intents)) for (const intent of intents) await inspect(intent);
        else {
            let after = 0;
            for (;;) {
                signal?.throwIfAborted();
                const page = intents.page(after, 100);
                for (const intent of page.items) await inspect(intent);
                if (page.nextCursor === null) break;
                if (page.nextCursor <= after) throw new Error('Effect review cursor did not advance.');
                after = page.nextCursor;
            }
            if (intents.relatedPage) {
                let after = 0;
                for (;;) {
                    signal?.throwIfAborted();
                    const page = intents.relatedPage(after, 50);
                    for (const related of page.items) record({ kind: 'delegation', evidence: related });
                    if (page.nextCursor === null) break;
                    if (page.nextCursor <= after) throw new Error('Delegation review cursor did not advance.');
                    after = page.nextCursor;
                }
            }
        }
        if (!receiptCount) finding('No independently observed output exists; manual acceptance is required.', true);
        for (const criterion of task.goal.acceptance) {
            signal?.throwIfAborted();
            if (criterion.startsWith('file:')) {
                const requested = criterion.slice(5).trim();
                if (!seenFiles.has(identity(requested))) finding(`Required artifact missing: ${requested}`);
            } else if (criterion.startsWith('contains:')) {
                const [, requested, ...parts] = criterion.split(':');
                const target = await resolveProjectPath(task.workspace, requested!);
                if (!await containsText(target, parts.join(':'), signal)) finding(`Required text absent: ${requested}`);
            } else if (criterion !== 'fixture:count=1') {
                manualAcceptance = true; finding(`Manual acceptance needed for criterion: ${criterion}`, true);
            } else if (!fixtureOne) finding('Fixture counter is not independently observed as 1.');
        }
        record({ kind: 'summary', passed: findingCount === 0, findingCount, hardFindingCount, artifactCount, receiptCount, manualAcceptance });
        if (fd !== undefined) fsyncSync(fd);
        return { passed: findingCount === 0, findings, artifacts, receipts, findingCount, hardFindingCount, artifactCount, receiptCount, manualAcceptance,
            ...(filename ? { detail: { path: filename, sha256: hash.digest('hex'), bytes, records } } : {}) };
    } finally { if (fd !== undefined) closeSync(fd); }
}
