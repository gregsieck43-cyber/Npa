import { isOfficeFile } from '../product/office-input.js';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { assertLocalPath } from '../app/local-paths.js';

/**
 * The Electron boundary of the desktop shell: which frame may call it, which local-backend
 * requests the renderer may make on its own, and what a native file pick may become.
 *
 * This module is plain Node so the policy can be tested without opening a window: the Electron
 * handlers in main.ts only collect the caller's identity and hand the decision to these functions.
 */

export type FrameTrust = 'trusted' | 'closed' | 'untrusted';

export interface FrameIdentity {
    /** webContents id of the application window; undefined once that window is gone. */
    windowContentsId: number | undefined;
    /** webContents id of the process that sent the call. */
    senderContentsId: number;
    /** Browser-global frame id of the calling frame; undefined when the frame was already disposed. */
    senderFrameId: number | undefined;
    /** Browser-global frame id of the application window's main frame. */
    mainFrameId: number | undefined;
}

/** Only the main frame of the window this shell created may use the desktop channel. */
export function frameTrust(identity: FrameIdentity): FrameTrust {
    if (identity.windowContentsId === undefined || identity.mainFrameId === undefined) return 'closed';
    if (identity.senderContentsId !== identity.windowContentsId) return 'untrusted';
    if (identity.senderFrameId !== identity.mainFrameId) return 'untrusted';
    return 'trusted';
}

export function requireTrustedSender(trust: FrameTrust): void {
    if (trust === 'trusted') return;
    throw new Error(trust === 'closed'
        ? 'The application window is closed; the desktop channel is no longer available.'
        : 'The desktop channel is available to the main frame of the application window only.');
}

export const AUTHORIZATION_ERROR = 'Select a project through the native folder picker to authorize it.';

/** The same JSON body bound the local backend enforces. */
const MAX_REQUEST_BODY_BYTES = 1_200_000;
const MAX_ROUTE_LENGTH = 8192;

/**
 * Whether this request would register a folder on disk as an authorized workspace through
 * Services.openWorkspace. A renderer may never do that: the native picker is the only approval of
 * a folder. GET /v1/product/workspace/projects is the read-only project list and stays available,
 * so only its POST form is refused; /v1/workspaces/open has no read form, so every method is
 * refused, exactly as the previous handler did.
 */
function authorizesWorkspace(method: 'GET' | 'POST', keys: readonly string[]): boolean {
    return keys.some(key => key === '/v1/workspaces/open' || (method === 'POST' && (key === '/v1/product/workspace/projects' || key === '/v1/product/workspace/project-edit' || key === '/v1/product/models/configure')));
}

/** Comparison key: the backend resolves routes without a query, without trailing slashes and, for this guard, without case. */
function routeKey(pathname: string): string {
    return (pathname.replace(/\/+$/, '') || '/').toLowerCase();
}

/**
 * The path a renderer request reaches. Absolute URLs, `..` segments, dot segments and backslashes
 * are resolved by the URL parser, the same way `fetch` resolves them, so the guard cannot disagree
 * with the request that is actually sent.
 */
export function routePath(route: unknown): string {
    if (typeof route !== 'string' || route.length === 0 || route.length > MAX_ROUTE_LENGTH || route.includes('\0'))
        throw new Error('Desktop requests need a route path of at most 8192 characters.');
    if (!route.startsWith('/') || route.startsWith('//'))
        throw new Error('Desktop requests must use a path on the local backend, not an absolute URL.');
    try {
        return new URL(route, 'http://127.0.0.1').pathname;
    } catch {
        throw new Error('Desktop request route is not a valid local path.');
    }
}

/** Every spelling of the reached path that must be treated as that path, including one percent-encoded form. */
function routeKeys(pathname: string): string[] {
    const keys = [routeKey(pathname)];
    try {
        const decoded = routeKey(decodeURIComponent(pathname));
        if (!keys.includes(decoded)) keys.push(decoded);
    } catch { /* malformed escapes cannot reach a route either */ }
    return keys;
}

export interface RendererRequest {
    method: 'GET' | 'POST';
    /** Route path the request reaches, without the query string. */
    path: string;
}

/**
 * Everything the renderer may ask the local backend for. Reads and ordinary mutations are allowed;
 * authorizing a folder is not, because that decision belongs to the native picker in the main
 * process. The method and body bounds match the local backend, so nothing is refused later that
 * could have been refused here.
 */
export function checkRendererRequest(method: unknown, route: unknown, body: unknown): RendererRequest {
    if (method !== 'GET' && method !== 'POST') throw new Error('Desktop requests support GET and POST only.');
    const pathname = routePath(route);
    // The folder-authorization rule is decided first: it is the one refusal that must never be lost
    // behind a transport or spelling rule, including its upper-case and encoded spellings.
    if (authorizesWorkspace(method, routeKeys(pathname))) throw new Error(AUTHORIZATION_ERROR);
    if (pathname !== '/health' && !pathname.startsWith('/v1/')) throw new Error('Desktop requests must target the local backend (/v1 or /health).');
    if (body !== undefined) {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Desktop request bodies must be a JSON object.');
        let size = 0;
        try { size = Buffer.byteLength(JSON.stringify(body)); } catch { throw new Error('Desktop request bodies must be JSON-serializable.'); }
        if (size > MAX_REQUEST_BODY_BYTES) throw new Error('Desktop request bodies are limited to 1.2 MB.');
    }
    return { method, path: pathname };
}

export interface RequestHandlerDeps {
    /** Identity of the frame that invoked the channel. */
    senderTrust(event: unknown): FrameTrust;
    /** Sends an authorized request to the local backend with the process-only token. */
    forward(method: 'GET' | 'POST', route: string, body: unknown): Promise<unknown>;
}

/** The one IPC entry the renderer uses to talk to the local backend. */
export function createRequestHandler(deps: RequestHandlerDeps) {
    return async (event: unknown, method?: unknown, route?: unknown, body?: unknown): Promise<unknown> => {
        requireTrustedSender(deps.senderTrust(event));
        checkRendererRequest(method, route, body);
        // The original route is forwarded, not the parsed path, so query parameters survive untouched.
        return deps.forward(method as 'GET' | 'POST', route as string, body);
    };
}

/** File metadata the native picker returns; it mirrors the front end attachment shape and claims nothing it did not read. */
export interface PickedFile {
    id: string;
    name: string;
    kind: 'file' | 'image';
    bytes: number;
    path: string;
}

export interface PickOptions {
    /** Roots that hold the running application's state; nothing inside them can become an attachment. */
    protectedRoots: readonly string[];
}

const MAX_PICKED_FILES = 5;
const MAX_PICKED_FILE_BYTES = 8 * 1024 * 1024;
/** Chunk size for reading a file: bounds memory and keeps a UTF-8 sequence split across chunks valid. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Credential files that must never be attached to a message or reach a model. */
const protectedNames = /^(?:api\.txt|configuration\.json|backend\.json|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|[^\\/]+\.(?:key|pem|pfx|p12))$/i;
/** Folders that hold credentials, third-party runtime or agent configuration. */
const protectedSegments = new Set(['.git', '.aws', '.ssh', '.gnupg', '.codex', '.agents', 'node_modules', '.deps']);

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/**
 * Reads a file through one handle, up to the attachment bound. The size check before the read
 * depends on stat, and the file can grow after it; the running total is therefore the real limit,
 * so a file that grows past the bound is refused instead of being read further.
 */
export function readBoundedSync(handle: number, name: string): Buffer {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
        const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        const read = readSync(handle, chunk, 0, chunk.length, total);
        if (read === 0) break;
        total += read;
        if (total > MAX_PICKED_FILE_BYTES) throw new Error(`${name} is larger than 8 MB.`);
        chunks.push(chunk.subarray(0, read));
    }
    return Buffer.concat(chunks, total);
}

function isImageSignature(prefix: Buffer): boolean {
    if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
    if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return true;
    if (prefix.length >= 6 && /^GIF8[79]a$/.test(prefix.subarray(0, 6).toString('latin1'))) return true;
    return prefix.length >= 12 && prefix.subarray(0, 4).toString('latin1') === 'RIFF' && prefix.subarray(8, 12).toString('latin1') === 'WEBP';
}

/** A picked file is attached only when its real content is UTF-8 text or an image; a binary is never described as text. */
function classify(file: string, name: string): { kind: PickedFile['kind']; bytes: number } {
    const info = statSync(file, { throwIfNoEntry: false });
    if (!info) throw new Error(`${name} no longer exists.`);
    if (!info.isFile()) throw new Error(`${name} is not a regular file.`);
    if (info.size > MAX_PICKED_FILE_BYTES) throw new Error(`${name} is larger than 8 MB.`);
    const handle = openSync(file, 'r');
    let content: Buffer;
    try { content = readBoundedSync(handle, name); } finally { closeSync(handle); }
    if (isOfficeFile(name, content)) return { kind: 'file', bytes: content.length };
    if (isImageSignature(content)) return { kind: 'image', bytes: content.length };
    // A binary byte or malformed UTF-8 anywhere in the file makes the whole file untrustworthy as text.
    if (content.includes(0)) throw new Error(`${name} is a binary file; only UTF-8 text and images can be attached.`);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
        for (let offset = 0; offset < content.length; offset += READ_CHUNK_BYTES)
            decoder.decode(content.subarray(offset, offset + READ_CHUNK_BYTES), { stream: true });
        // The final flush is what rejects a sequence truncated by the end of the file.
        decoder.decode();
    } catch {
        throw new Error(`${name} is not UTF-8 text; only text and images can be attached.`);
    }
    return { kind: 'file', bytes: content.length };
}

function assertAttachable(selected: string, options: PickOptions): string {
    const absolute = assertLocalPath(selected, 'Selected file');
    let file: string;
    try { file = realpathSync(absolute); }
    catch (error) { throw new Error(`The selected file cannot be read: ${messageOf(error)}`); }
    const root = path.parse(file).root;
    const parts = file.slice(root.length).split(path.sep).filter(Boolean);
    // Windows drops trailing dots and spaces from a name, so the protected-name test has to see the stripped form.
    const name = parts[parts.length - 1] ?? '';
    if (protectedNames.test(name) || protectedNames.test(name.replace(/[ .]+$/, '')))
        throw new Error(`${name} is a credential or runtime configuration file and cannot be attached.`);
    if (parts.slice(0, -1).some(part => protectedSegments.has(part.toLowerCase())))
        throw new Error(`${name} is inside a credential or protected runtime folder and cannot be attached.`);
    for (const protectedRoot of options.protectedRoots) {
        const relative = path.relative(path.resolve(protectedRoot), file);
        if (relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative)))
            throw new Error(`${name} belongs to the running application state and cannot be attached.`);
    }
    return file;
}

/**
 * The native picker's result as attachment metadata. Cancelling yields no entries; a selection is
 * bounded to five files of at most eight megabytes, and anything that is not honest text or image
 * metadata is refused instead of being described as something it is not.
 */
export function describePickedFiles(candidates: readonly unknown[], options: PickOptions): PickedFile[] {
    const picked: PickedFile[] = [];
    for (const candidate of candidates.slice(0, MAX_PICKED_FILES)) {
        if (typeof candidate !== 'string' || !candidate) throw new Error('The file picker returned an invalid path.');
        const file = assertAttachable(candidate, options);
        const { kind, bytes } = classify(file, path.basename(file));
        picked.push({ id: createHash('sha256').update(file.toLowerCase()).digest('hex').slice(0, 16), name: path.basename(file), kind, bytes, path: file });
    }
    return picked;
}
