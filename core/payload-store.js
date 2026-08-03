import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { accessSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const FILE_MAGIC = Buffer.from('WBPL1\0', 'ascii');
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value), (_key, nested) => {
    if (typeof nested === 'bigint') return { __workbenchType: 'bigint', value: nested.toString() };
    return nested;
  });
}

function normalizeKey(input, root) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (input.byteLength !== KEY_BYTES) throw new RangeError('payload encryption key must be 32 bytes');
    return Buffer.from(input);
  }
  const source = String(input || process.env.WORKBENCH_PAYLOAD_KEY || `local-claude-workbench:${resolve(root)}`);
  if (/^[a-f0-9]{64}$/i.test(source)) return Buffer.from(source, 'hex');
  if (/^[a-z0-9+/]{43}=$/i.test(source)) {
    const decoded = Buffer.from(source, 'base64');
    if (decoded.length === KEY_BYTES) return decoded;
  }
  return createHash('sha256').update(source, 'utf8').digest();
}

function normalizeHash(hash) {
  const value = String(hash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError('payload hash must be a 64-character SHA-256 hex string');
  return value;
}

function payloadBytes(value) {
  if (Buffer.isBuffer(value)) return { bytes: Buffer.from(value), encoding: 'binary' };
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value), encoding: 'binary' };
  if (typeof value === 'string') return { bytes: Buffer.from(value, 'utf8'), encoding: 'utf8' };
  return { bytes: Buffer.from(stableJson(value), 'utf8'), encoding: 'json' };
}

function descriptorFromMeta(hash, filePath, meta) {
  return {
    id: hash,
    payloadId: hash,
    hash,
    sha256: hash,
    checksum: hash,
    path: filePath,
    size: Number(meta.size || 0),
    mimeType: meta.mimeType || 'application/octet-stream',
    encoding: meta.encoding || 'binary',
    createdAt: meta.createdAt || null
  };
}

function parseRange(range, size) {
  if (range === undefined || range === null) return null;
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    if (!match) throw new RangeError('invalid byte range');
    if (match[1] === '' && match[2] === '') throw new RangeError('invalid byte range');
    if (match[1] === '' && match[2] !== '') {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix < 0) throw new RangeError('invalid byte range');
      return { start: Math.max(0, size - suffix), end: size };
    }
    const start = match[1] === '' ? 0 : Number(match[1]);
    const requestedEnd = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) throw new RangeError('invalid byte range');
    return { start, end: requestedEnd + 1 };
  }
  if (typeof range === 'object') {
    const start = range.start ?? range.offset ?? 0;
    const end = range.end ?? (range.length !== undefined ? Number(start) + Number(range.length) : undefined);
    return { start, end };
  }
  throw new RangeError('invalid byte range');
}

function applyRange(bytes, options = {}) {
  const parsedRange = options.range !== undefined ? parseRange(options.range, bytes.length) : null;
  const range = parsedRange || (options.start !== undefined || options.end !== undefined
    ? { start: options.start, end: options.end }
    : null);
  if (!range) return bytes;
  const start = range.start === undefined || range.start === null ? 0 : Number(range.start);
  let end = range.end === undefined || range.end === null ? bytes.length : Number(range.end);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start > bytes.length) {
    throw new RangeError('invalid payload byte range');
  }
  end = Math.min(end, bytes.length);
  return bytes.subarray(start, end);
}

function decodeResult(bytes, options = {}) {
  if (options.as === 'text' || options.encoding === 'utf8' || options.text === true) return bytes.toString('utf8');
  if (options.as === 'json' || options.json === true) return JSON.parse(bytes.toString('utf8'), (_key, value) => {
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
    if (value && value.__workbenchType === 'bigint') {
      try { return BigInt(value.value); } catch { return value.value; }
    }
    return value;
  });
  return Buffer.from(bytes);
}

/** Encrypted SHA-256 content-addressed payload storage. */
export class PayloadStore {
  constructor(rootOrOptions = {}, maybeOptions = {}) {
    const options = rootOrOptions && typeof rootOrOptions === 'object'
      ? { ...rootOrOptions }
      : { ...maybeOptions, root: rootOrOptions };
    this.root = resolve(String(options.root ?? options.directory ?? (options.dataDir ? join(String(options.dataDir), 'payloads') : '.payloads')));
    let configuredKey = options.key ?? options.encryptionKey;
    if (!configuredKey && options.keyPath) {
      try {
        const candidate = readFileSync(resolve(String(options.keyPath)));
        configuredKey = candidate.length === KEY_BYTES ? candidate : candidate.toString('utf8').trim();
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        configuredKey = options.keyPath;
      }
    }
    this.key = normalizeKey(configuredKey, this.root);
    this.defaultMimeType = options.mimeType || 'application/octet-stream';
    mkdirSync(this.root, { recursive: true });
  }

  pathFor(hash) {
    const normalized = normalizeHash(hash);
    return join(this.root, normalized.slice(0, 2), normalized.slice(2, 4), `${normalized}.payload`);
  }

  path(hash) {
    return this.pathFor(hash);
  }

  async _ensurePath(hash) {
    const filePath = this.pathFor(hash);
    await mkdir(dirname(filePath), { recursive: true });
    return filePath;
  }

  async put(value, options = {}) {
    return this._putAsync(value, options);
  }

  async store(value, options = {}) {
    return this.put(value, options);
  }

  _encryptedEnvelope(value, options = {}) {
    const { bytes, encoding } = payloadBytes(value);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const metadata = {
      hash,
      size: bytes.length,
      encoding: options.encoding || encoding,
      mimeType: options.mimeType || this.defaultMimeType,
      createdAt: new Date().toISOString()
    };
    const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8');
    const clear = Buffer.alloc(4 + metadataBytes.length + bytes.length);
    clear.writeUInt32BE(metadataBytes.length, 0);
    metadataBytes.copy(clear, 4);
    bytes.copy(clear, 4 + metadataBytes.length);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { hash, metadata, encrypted: Buffer.concat([FILE_MAGIC, iv, authTag, ciphertext]) };
  }

  putSync(value, options = {}) {
    const { hash, metadata, encrypted } = this._encryptedEnvelope(value, options);
    const filePath = this.pathFor(hash);
    mkdirSync(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      try { renameSync(temporary, filePath); } catch (error) {
        if (error?.code === 'EEXIST') rmSync(temporary, { force: true });
        else throw error;
      }
    } finally {
      rmSync(temporary, { force: true });
    }
    return descriptorFromMeta(hash, filePath, metadata);
  }

  storeSync(value, options = {}) {
    return this.putSync(value, options);
  }

  async _putAsync(value, options = {}) {
    const { hash, metadata, encrypted } = this._encryptedEnvelope(value, options);
    const filePath = await this._ensurePath(hash);
    const temporary = `${filePath}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      try { await rename(temporary, filePath); } catch (error) {
        if (error?.code === 'EEXIST') await rm(temporary, { force: true });
        else throw error;
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return descriptorFromMeta(hash, filePath, metadata);
  }

  async putAsync(value, options = {}) {
    return this._putAsync(value, options);
  }

  async putJson(value, options = {}) {
    return this.put(value, { ...options, encoding: 'json', mimeType: options.mimeType || 'application/json' });
  }

  async _decrypt(hash) {
    const normalized = normalizeHash(hash);
    const filePath = this.pathFor(normalized);
    let encrypted;
    try {
      encrypted = await readFile(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`Payload ${normalized} not found`);
      throw error;
    }
    const headerLength = FILE_MAGIC.length + IV_BYTES + AUTH_TAG_BYTES;
    if (encrypted.length < headerLength || !encrypted.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
      throw new Error(`Payload ${normalized} has an invalid envelope`);
    }
    const ivStart = FILE_MAGIC.length;
    const tagStart = ivStart + IV_BYTES;
    const cipherStart = tagStart + AUTH_TAG_BYTES;
    const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(ivStart, tagStart));
    decipher.setAuthTag(encrypted.subarray(tagStart, cipherStart));
    let clear;
    try {
      clear = Buffer.concat([decipher.update(encrypted.subarray(cipherStart)), decipher.final()]);
    } catch {
      throw new Error(`Payload ${normalized} failed authentication`);
    }
    if (clear.length < 4) throw new Error(`Payload ${normalized} has an invalid metadata section`);
    const metadataLength = clear.readUInt32BE(0);
    if (metadataLength > clear.length - 4) throw new Error(`Payload ${normalized} has an invalid metadata length`);
    let metadata;
    try { metadata = JSON.parse(clear.subarray(4, 4 + metadataLength).toString('utf8')); } catch {
      throw new Error(`Payload ${normalized} has invalid metadata`);
    }
    const bytes = clear.subarray(4 + metadataLength);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    if (checksum !== normalized || metadata.hash !== normalized) throw new Error(`Payload ${normalized} checksum mismatch`);
    return { hash: normalized, path: filePath, metadata, bytes };
  }

  async get(hash, options = {}) {
    const result = await this._decrypt(hash);
    return decodeResult(applyRange(result.bytes, options), options);
  }

  _decryptSync(hash) {
    const normalized = normalizeHash(hash);
    const filePath = this.pathFor(normalized);
    let encrypted;
    try { encrypted = readFileSync(filePath); } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`Payload ${normalized} not found`);
      throw error;
    }
    const headerLength = FILE_MAGIC.length + IV_BYTES + AUTH_TAG_BYTES;
    if (encrypted.length < headerLength || !encrypted.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) throw new Error(`Payload ${normalized} has an invalid envelope`);
    const ivStart = FILE_MAGIC.length;
    const tagStart = ivStart + IV_BYTES;
    const cipherStart = tagStart + AUTH_TAG_BYTES;
    const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(ivStart, tagStart));
    decipher.setAuthTag(encrypted.subarray(tagStart, cipherStart));
    let clear;
    try { clear = Buffer.concat([decipher.update(encrypted.subarray(cipherStart)), decipher.final()]); } catch {
      throw new Error(`Payload ${normalized} failed authentication`);
    }
    if (clear.length < 4) throw new Error(`Payload ${normalized} has an invalid metadata section`);
    const metadataLength = clear.readUInt32BE(0);
    if (metadataLength > clear.length - 4) throw new Error(`Payload ${normalized} has an invalid metadata length`);
    let metadata;
    try { metadata = JSON.parse(clear.subarray(4, 4 + metadataLength).toString('utf8')); } catch {
      throw new Error(`Payload ${normalized} has invalid metadata`);
    }
    const bytes = clear.subarray(4 + metadataLength);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    if (checksum !== normalized || metadata.hash !== normalized) throw new Error(`Payload ${normalized} checksum mismatch`);
    return { hash: normalized, path: filePath, metadata, bytes };
  }

  getSync(hash, options = {}) {
    const result = this._decryptSync(hash);
    return decodeResult(applyRange(result.bytes, options), options);
  }

  async read(hash, options) {
    return this.get(hash, options);
  }

  async restore(hash, options) {
    return this.get(hash, options);
  }

  async readRange(hash, start = 0, end = undefined) {
    return this.get(hash, { start, end });
  }

  async getRange(hash, rangeOrStart = 0, end = undefined) {
    if (rangeOrStart && typeof rangeOrStart === 'object') return this.get(hash, { range: rangeOrStart });
    return this.readRange(hash, rangeOrStart, end);
  }

  readRangeSync(hash, start = 0, end = undefined) {
    return this.getSync(hash, { start, end });
  }

  getRangeSync(hash, rangeOrStart = 0, end = undefined) {
    if (rangeOrStart && typeof rangeOrStart === 'object') return this.getSync(hash, { range: rangeOrStart });
    return this.readRangeSync(hash, rangeOrStart, end);
  }

  async descriptor(hash) {
    const result = await this._decrypt(hash);
    return descriptorFromMeta(result.hash, result.path, result.metadata);
  }

  async getDescriptor(hash) {
    return this.descriptor(hash);
  }

  descriptorSync(hash) {
    const result = this._decryptSync(hash);
    return descriptorFromMeta(result.hash, result.path, result.metadata);
  }

  async exists(hash) {
    try {
      await access(this.pathFor(hash));
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  existsSync(hash) {
    try { accessSync(this.pathFor(hash)); return true; } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async verify(hash, expectedChecksum = undefined) {
    try {
      const normalized = normalizeHash(hash);
      const result = await this._decrypt(normalized);
      if (expectedChecksum && String(expectedChecksum).toLowerCase() !== normalized) return false;
      return createHash('sha256').update(result.bytes).digest('hex') === normalized;
    } catch {
      return false;
    }
  }

  async checksum(hash) {
    return (await this.verify(hash)) ? normalizeHash(hash) : null;
  }

  verifySync(hash, expectedChecksum = undefined) {
    try {
      const normalized = normalizeHash(hash);
      const result = this._decryptSync(normalized);
      if (expectedChecksum && String(expectedChecksum).toLowerCase() !== normalized) return false;
      return createHash('sha256').update(result.bytes).digest('hex') === normalized;
    } catch {
      return false;
    }
  }

  checksumSync(hash) {
    return this.verifySync(hash) ? normalizeHash(hash) : null;
  }

  async remove(hash) {
    await rm(this.pathFor(hash), { force: true });
    return true;
  }

  async delete(hash) {
    return this.remove(hash);
  }

  removeSync(hash) {
    rmSync(this.pathFor(hash), { force: true });
    return true;
  }

  deleteSync(hash) {
    return this.removeSync(hash);
  }

  async size(hash) {
    const result = await this._decrypt(hash);
    return result.bytes.length;
  }
}

export function createPayloadStore(rootOrOptions, maybeOptions) {
  return new PayloadStore(rootOrOptions, maybeOptions);
}

export const EncryptedPayloadStore = PayloadStore;
