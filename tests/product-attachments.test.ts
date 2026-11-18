import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { readBounded, readSideAttachments } from '../src/product/attachments.js';
import { ProductError } from '../src/product/shared.js';

const tempRoot = path.resolve(process.env.TEMP ?? '.tmp');

interface Fixture { dir: string; links: string[] }

/** One owned fixture directory under the configured temp root, removed after the test. */
function fixture(t: TestContext): Fixture {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tempRoot, 'product-attachments-'));
  assert.equal(path.resolve(path.dirname(dir)), tempRoot, 'the fixture must stay inside the configured temp root');
  const links: string[] = [];
  t.after(() => {
    // Junctions are removed before the owned directory so recursive cleanup never sees a reparse point.
    for (const link of links) {
      try { unlinkSync(link); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, links };
}

function attachment(file: string, name?: string) {
  return { id: 'attachment-1', ...(name === undefined ? {} : { name }), kind: 'file' as const, path: file };
}

function junction(target: string, pathname: string, links: string[]): string {
  symlinkSync(target, pathname, 'junction');
  links.push(pathname);
  assert.ok(lstatSync(pathname).isSymbolicLink(), 'the fixture must be a real junction');
  return pathname;
}

function errorCode(...codes: string[]) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ProductError, 'expected a ProductError');
    assert.ok(codes.includes(error.code), `unexpected ProductError code: ${error.code}`);
    return true;
  };
}

const sideError = errorCode('denied', 'validation', 'scope');
const validation = errorCode('validation');

test('denies a credential-denylisted filename before stat or read', async t => {
  const f = fixture(t);
  const file = path.join(f.dir, 'API.txt');
  writeFileSync(file, 'Synthetic fixture. No real credential.', 'utf8');
  await assert.rejects(readSideAttachments([attachment(file)]), sideError);
  // Windows resolves api.txt to the same file, so only a case-insensitive name check that runs
  // before stat/read can deny it.
  await assert.rejects(readSideAttachments([attachment(path.join(f.dir, 'api.txt'))]), errorCode('denied'));

  // A directory with a denied name distinguishes the name policy from the readability check:
  // stat would report "not a readable file" (validation), so "denied" proves the name check runs first.
  const second = fixture(t);
  const directory = path.join(second.dir, 'API.txt');
  mkdirSync(directory);
  await assert.rejects(readSideAttachments([attachment(directory)]), errorCode('denied'));
});

test('rejects a junction ancestor instead of reading through it', async t => {
  const f = fixture(t);
  const target = path.join(f.dir, 'target');
  mkdirSync(target);
  writeFileSync(path.join(target, 'note.txt'), 'Text behind a junction.', 'utf8');
  const link = junction(target, path.join(f.dir, 'link'), f.links);
  const file = path.join(link, 'note.txt');
  assert.equal(readFileSync(file, 'utf8'), 'Text behind a junction.', 'the fixture must resolve to readable text through the junction');
  await assert.rejects(readSideAttachments([attachment(file)]), sideError);
});

test('rejects a dangling junction even though existsSync reports it missing', async t => {
  const f = fixture(t);
  const link = junction(path.join(f.dir, 'absent-target'), path.join(f.dir, 'dangling'), f.links);
  assert.equal(existsSync(link), false, 'Windows reports a dangling junction as missing');
  await assert.rejects(readSideAttachments([attachment(path.join(link, 'note.txt'))]), sideError);
});

test('reads an explicitly selected ordinary UTF-8 text file exactly', async t => {
  const f = fixture(t);
  const text = 'Ordinary selected UTF-8 text.\nSecond line: 你好。\r\n';
  const file = path.join(f.dir, 'note.txt');
  writeFileSync(file, text, 'utf8');
  assert.deepEqual(await readSideAttachments([attachment(file)]), [{ name: 'note.txt', text }]);
  assert.deepEqual(await readSideAttachments([attachment(file, 'shown.md')]), [{ name: 'shown.md', text }]);
  assert.deepEqual(await readSideAttachments([attachment(file, '')]), [{ name: 'note.txt', text }]);
  assert.deepEqual(await readSideAttachments(undefined), []);
});

test('rejects binary NUL content and invalid UTF-8', async t => {
  const f = fixture(t);
  const binary = path.join(f.dir, 'binary.txt');
  writeFileSync(binary, Buffer.from([0x41, 0x00, 0x42]));
  await assert.rejects(readSideAttachments([attachment(binary)]), validation);
  const invalid = path.join(f.dir, 'invalid.txt');
  writeFileSync(invalid, Buffer.from([0xff, 0xfe, 0x41]));
  await assert.rejects(readSideAttachments([attachment(invalid)]), validation);
});

test('enforces the 128 KB per-file and 256 KB total bounds', async t => {
  const f = fixture(t);
  const oversized = path.join(f.dir, 'oversized.txt');
  writeFileSync(oversized, Buffer.alloc(128 * 1024 + 1, 0x61));
  await assert.rejects(readSideAttachments([attachment(oversized)]), validation);

  const first = path.join(f.dir, 'first.txt');
  const second = path.join(f.dir, 'second.txt');
  const third = path.join(f.dir, 'third.txt');
  writeFileSync(first, Buffer.alloc(128 * 1024, 0x61));
  writeFileSync(second, Buffer.alloc(100 * 1024, 0x62));
  writeFileSync(third, Buffer.alloc(100 * 1024, 0x63));
  const allowed = await readSideAttachments([attachment(first), attachment(second)]);
  assert.equal(allowed.length, 2);
  assert.equal(allowed[0]!.text.length, 128 * 1024);
  await assert.rejects(readSideAttachments([attachment(first), attachment(second), attachment(third)]), validation);
});

test('rejects missing paths and directories as unreadable', async t => {
  const f = fixture(t);
  await assert.rejects(readSideAttachments([attachment(path.join(f.dir, 'absent.txt'))]), validation);
  const directory = path.join(f.dir, 'folder');
  mkdirSync(directory);
  await assert.rejects(readSideAttachments([attachment(directory)]), validation);
});

test('validates attachment shapes, kinds and absolute local paths', async t => {
  const f = fixture(t);
  const file = path.join(f.dir, 'note.txt');
  writeFileSync(file, 'note', 'utf8');
  await assert.rejects(readSideAttachments(Array.from({ length: 6 }, () => attachment(file))), validation);
  await assert.rejects(readSideAttachments({ attachments: [] }), validation);
  await assert.rejects(readSideAttachments([{ id: 'a', kind: 'file', path: 'relative.txt' }]), validation);
  await assert.rejects(readSideAttachments([{ id: 'a', kind: 'movie', path: file }]), validation);
  await assert.rejects(readSideAttachments([{ id: 'a', kind: 'file', path: file, extra: true }]), validation);
  await assert.rejects(readSideAttachments([{ id: 'a', kind: 'file', path: 42 }]), validation);
});

test('denies protected ancestor folders from the native attachment policy', async t => {
  for (const segment of ['.git', '.aws', '.ssh', '.gnupg', '.codex', '.agents', 'node_modules', '.deps']) {
    const f = fixture(t);
    const file = path.join(f.dir, segment, 'config');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'Synthetic fixture, no real credential.', 'utf8');
    await assert.rejects(readSideAttachments([attachment(file)]), errorCode('denied'));
    // A missing child still proves the folder rule runs before the filesystem: the answer is denied,
    // not the validation error an unreadable file produces.
    await assert.rejects(readSideAttachments([attachment(path.join(f.dir, segment, 'absent.txt'))]), errorCode('denied'));
  }
  const f = fixture(t);
  const nested = path.join(f.dir, 'one', 'two', '.GIT', 'config');
  mkdirSync(path.dirname(nested), { recursive: true });
  writeFileSync(nested, 'Synthetic fixture.', 'utf8');
  await assert.rejects(readSideAttachments([attachment(nested)]), errorCode('denied'));
});

test('denies protected credential and runtime basenames at any depth', async t => {
  for (const name of ['configuration.json', 'backend.json', '.env', '.env.local', 'credentials.json', 'secrets.yaml',
    'id_rsa', 'id_ed25519', 'server.key', 'server.pem', 'chain.pfx', 'cert.p12', 'api.txt']) {
    const f = fixture(t);
    const file = path.join(f.dir, 'nested', 'deeper', name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'Synthetic fixture, no real credential.', 'utf8');
    await assert.rejects(readSideAttachments([attachment(file)]), errorCode('denied'));
  }
  const f = fixture(t);
  // Windows drops a trailing dot from a name, so the stripped spelling must be screened too. The
  // device name is denied by name without ever opening the console device.
  const trailing = path.join(f.dir, 'backend.json');
  writeFileSync(trailing, 'Synthetic fixture.', 'utf8');
  await assert.rejects(readSideAttachments([attachment(trailing + '.')]), errorCode('denied'));
  await assert.rejects(readSideAttachments([attachment(path.join(f.dir, 'con.txt'))]), errorCode('denied'));
  const allowed = path.join(f.dir, 'nested', 'configuration.txt');
  mkdirSync(path.dirname(allowed), { recursive: true });
  writeFileSync(allowed, 'ordinary text', 'utf8');
  assert.deepEqual(await readSideAttachments([attachment(allowed)]), [{ name: 'configuration.txt', text: 'ordinary text' }]);
});

test('keeps ordinary selected text below a .tmp task temp root readable', async t => {
  const f = fixture(t);
  const file = path.join(f.dir, '.tmp', 'task-1', 'notes', 'note.txt');
  mkdirSync(path.dirname(file), { recursive: true });
  const text = 'Ordinary selected text below a task temp folder.\r\nSecond line: 你好。';
  writeFileSync(file, text, 'utf8');
  assert.deepEqual(await readSideAttachments([attachment(file)]), [{ name: 'note.txt', text }]);
});

test('rejects a junction above a nested selected file', async t => {
  const f = fixture(t);
  const target = path.join(f.dir, 'target');
  mkdirSync(path.join(target, 'sub'), { recursive: true });
  writeFileSync(path.join(target, 'sub', 'note.txt'), 'Text behind a junction.', 'utf8');
  const link = junction(target, path.join(f.dir, 'plain'), f.links);
  const file = path.join(link, 'sub', 'note.txt');
  assert.equal(readFileSync(file, 'utf8'), 'Text behind a junction.');
  await assert.rejects(readSideAttachments([attachment(file)]), errorCode('denied'));
});

test('decodes UTF-8 text that spans read chunks and rejects late binary content', async t => {
  const f = fixture(t);
  // The three-byte character starts at 65535, so its bytes straddle the 64 KiB chunk boundary.
  const text = 'a'.repeat(64 * 1024 - 1) + '你' + 'b'.repeat(100);
  const file = path.join(f.dir, 'boundary.txt');
  writeFileSync(file, text, 'utf8');
  assert.deepEqual(await readSideAttachments([attachment(file)]), [{ name: 'boundary.txt', text }]);

  const lateNul = path.join(f.dir, 'late-nul.txt');
  writeFileSync(lateNul, Buffer.concat([Buffer.alloc(70 * 1024, 0x61), Buffer.from([0]), Buffer.from('tail')]));
  await assert.rejects(readSideAttachments([attachment(lateNul)]), validation);

  const truncated = path.join(f.dir, 'truncated.txt');
  writeFileSync(truncated, Buffer.concat([Buffer.alloc(64 * 1024, 0x61), Buffer.from([0xe4])]));
  await assert.rejects(readSideAttachments([attachment(truncated)]), validation);
});

test('stops reading at the per-file bound instead of loading a larger file', async t => {
  const requests: number[] = [];
  let position = 0;
  const endless = {
    async read(buffer: Buffer, _offset: number, length: number, at: number) {
      assert.equal(at, position, 'the bound must be read in order');
      requests.push(length);
      buffer.fill(0x61, 0, length);
      position += length;
      return { bytesRead: length };
    },
  };
  await assert.rejects(readBounded(endless, 'attachments[0]'), (error: unknown) =>
    error instanceof ProductError && error.code === 'validation' && /128 KB/.test(error.message));
  // One byte past the limit proves the file is larger; the remaining bytes are never requested.
  assert.deepEqual(requests, [64 * 1024, 64 * 1024, 1]);
  assert.equal(position, 128 * 1024 + 1);

  const f = fixture(t);
  const oversized = path.join(f.dir, 'oversized-megabyte.txt');
  writeFileSync(oversized, Buffer.alloc(1024 * 1024, 0x61));
  await assert.rejects(readSideAttachments([attachment(oversized)]), (error: unknown) =>
    error instanceof ProductError && error.code === 'validation' && /128 KB/.test(error.message));
  // Windows refuses to rename a file that is still open, so this proves the handle was closed.
  renameSync(oversized, path.join(f.dir, 'oversized-megabyte.moved'));
});
