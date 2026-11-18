import { lstat, open, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { isLocalPath } from '../app/local-paths.js';
import { isForbiddenRelative } from '../tools/policy.js';
import { ProductError, invalid, optionalString, pickFields, type Attachment } from './shared.js';

const ATTACHMENT_KINDS: readonly Attachment['kind'][] = ['file', 'image', 'folder', 'selection'];
const SIDE_ATTACHMENTS_MAX = 5;
const SIDE_ATTACHMENT_BYTES = 128 * 1024;
const SIDE_ATTACHMENTS_TOTAL = 256 * 1024;
/** Read chunk: bounds memory per step and keeps a UTF-8 sequence split across chunks decodable. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * The native picker's credential and runtime policy (src/desktop/ipc-policy.ts), mirrored so SideAsk
 * refuses the same selections. Side chat reads a path the user selected, so it must not become a
 * second, weaker way to reach credentials or runtime configuration.
 */
const PROTECTED_NAMES = /^(?:api\.txt|configuration\.json|backend\.json|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|[^\\/]+\.(?:key|pem|pfx|p12))$/i;
/** Folders that hold credentials, agent configuration or third-party runtime. */
const PROTECTED_SEGMENTS = new Set(['.git', '.aws', '.ssh', '.gnupg', '.codex', '.agents', 'node_modules', '.deps']);

/**
 * Read the explicitly selected UTF-8 text attachments of a SideAsk request.
 *
 * This is the only place where SideAsk touches user content, so the protected-path policy runs on
 * the requested path before any stat or read, and no model request is built here. The returned text
 * is untrusted data; the caller is responsible for framing it as such.
 */
export async function readSideAttachments(value: unknown): Promise<{ name: string; text: string }[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SIDE_ATTACHMENTS_MAX) invalid('Attach at most five text files.');
  const files: { name: string; text: string }[] = [];
  let total = 0;
  for (const [index, item] of value.entries()) {
    const label = `attachments[${index}]`;
    const attachment = pickFields(item, ['id', 'name', 'kind', 'bytes', 'path'], label);
    if (!ATTACHMENT_KINDS.includes(attachment.kind as Attachment['kind'])) invalid(`${label}.kind must be file, image, folder or selection.`);
    const requested = optionalString(attachment.path, `${label}.path`, 4096);
    if (!requested || !path.isAbsolute(requested) || !isLocalPath(requested)) invalid(`${label}.path must be an absolute local file path on this drive.`);
    const absolute = path.resolve(requested);
    assertUnprotected(absolute, label);
    const real = await linkFreePath(absolute, label);
    const info = await lstat(real, { bigint: true }).catch(() => undefined);
    if (!info?.isFile()) invalid(`${label} is not a readable file.`);
    const handle = await open(real, 'r').catch(() => invalid(`${label} cannot be read.`));
    let raw: Buffer;
    try {
      // The walk, the stat and the open are separate steps. Proving that the open handle is the file
      // that was just validated -- same canonical path, same volume and file index -- rejects a link
      // that was swapped in between instead of reading through it.
      const current = await realpath(absolute).catch(() => undefined);
      if (!current || current.toLowerCase() !== real.toLowerCase()) denied(`${label} must not use junctions or symbolic links.`);
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== info.dev || opened.ino !== info.ino) denied(`${label} must not use junctions or symbolic links.`);
      if (opened.size > BigInt(SIDE_ATTACHMENT_BYTES)) invalid(`${label} exceeds 128 KB.`);
      raw = await readBounded(handle, label);
    } finally {
      await handle.close();
    }
    total += raw.length;
    if (total > SIDE_ATTACHMENTS_TOTAL) invalid('Side chat attachments are limited to 256 KB in total.');
    if (raw.includes(0)) invalid(`${label} is binary; side chat accepts UTF-8 text only.`);
    const text = decodeUtf8(raw, label);
    files.push({ name: typeof attachment.name === 'string' && attachment.name.trim() ? attachment.name : path.basename(absolute), text });
  }
  return files;
}

/**
 * The protected-content policy. The file name and the folders above it are screened, because a
 * protected file is reachable through any ordinary-looking name inside them (.git/config, .aws/config).
 * Only the ancestors are screened and the folders are named individually: a blanket rule for .tmp,
 * .cache or node_modules would reject legitimate selected text, while these folders must never be read.
 */
function assertUnprotected(absolute: string, label: string): void {
  const name = path.basename(absolute);
  // Windows drops trailing dots and spaces from a name, so the stripped spelling is screened too.
  if (PROTECTED_NAMES.test(name) || PROTECTED_NAMES.test(name.replace(/[ .]+$/, '')))
    denied(`${label} names a credential or runtime configuration file that side chat cannot read.`);
  // The tool policy adds the Windows name hazards the credential list does not describe: device
  // names (con, nul), drive/stream separators and a trailing dot or space.
  if (isForbiddenRelative(name)) denied(`${label} names a credential or protected file that side chat cannot read.`);
  const volume = path.parse(absolute).root;
  const ancestors = absolute.slice(volume.length).split(path.sep).filter(Boolean).slice(0, -1);
  if (ancestors.some(part => PROTECTED_SEGMENTS.has(part.toLowerCase())))
    denied(`${label} is inside a credential or protected runtime folder that side chat cannot read.`);
}

/**
 * Reject a junction or symbolic link on any path segment. lstat does not follow links, so a link
 * whose target is missing is still seen and rejected instead of becoming a future-looking path.
 * The final realpath comparison proves the canonical path is the requested path: no segment was
 * redirected anywhere, including through a link created after the walk.
 */
async function linkFreePath(absolute: string, label: string): Promise<string> {
  const volume = path.parse(absolute).root;
  let cursor = volume;
  for (const part of absolute.slice(volume.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor).catch(() => undefined);
    if (!info) invalid(`${label} is not a readable file.`);
    if (info.isSymbolicLink()) denied(`${label} must not use junctions or symbolic links.`);
  }
  const real = await realpath(absolute).catch(() => invalid(`${label} is not a readable file.`));
  if (real.toLowerCase() !== absolute.toLowerCase()) denied(`${label} must not use junctions or symbolic links.`);
  return real;
}

/**
 * The one FileHandle operation the bounded read needs. It is structural so the bound can be tested
 * without creating a file larger than the limit.
 */
export interface BoundedReadHandle {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

/**
 * Read at most the per-file bound through an open handle. The bytes actually read are counted, so a
 * file that grew after the size check -- or whose reported size was never trustworthy -- is refused
 * after at most one byte past the limit instead of being loaded into memory whole.
 */
export async function readBounded(handle: BoundedReadHandle, label: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    // The last request asks for exactly one byte past the limit: that is enough to prove the file is
    // larger, and it is the only read that can never contribute text.
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, SIDE_ATTACHMENT_BYTES + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > SIDE_ATTACHMENT_BYTES) invalid(`${label} exceeds 128 KB.`);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function decodeUtf8(raw: Buffer, label: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { invalid(`${label} is not valid UTF-8 text.`); }
}

function denied(message: string): never {
  throw new ProductError('denied', message, 403);
}
