import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
    checkRendererRequest, createRequestHandler, describePickedFiles, frameTrust, readBoundedSync, requireTrustedSender, type FrameTrust,
} from '../src/desktop/ipc-policy.js';
import { assertProjectFixtureRoot } from './project-boundary.js';

const authorizationBlocked = (label: string, method: string, route: string): void => {
    assert.throws(
        () => checkRendererRequest(method, route, undefined),
        (error: unknown) => error instanceof Error && error.message.includes('native folder picker'),
        label,
    );
};

test('ordinary renderer requests stay available', () => {
    assert.equal(checkRendererRequest('GET', '/v1/product/workspace/projects', undefined).path, '/v1/product/workspace/projects');
    assert.equal(checkRendererRequest('GET', '/v1/product/projects?mode=chat', undefined).path, '/v1/product/projects');
    assert.equal(checkRendererRequest('POST', '/v1/chat/send', { sessionId: 's', text: 'hi' }).path, '/v1/chat/send');
    assert.equal(checkRendererRequest('POST', '/v1/product/chat/send', {}).path, '/v1/product/chat/send');
    assert.equal(checkRendererRequest('POST', '/v1/commands', { type: 'create_task' }).path, '/v1/commands');
    assert.equal(checkRendererRequest('GET', '/v1/harness/sessions?text=a', undefined).path, '/v1/harness/sessions');
    assert.equal(checkRendererRequest('GET', '/health', undefined).path, '/health');
    assert.equal(checkRendererRequest('GET', '/v1/ide/workspace?path=J%3A%5Cp', undefined).path, '/v1/ide/workspace');
});

test('the renderer cannot authorize a workspace without the native picker', () => {
    authorizationBlocked('legacy route', 'POST', '/v1/workspaces/open');
    authorizationBlocked('legacy route with trailing slash', 'POST', '/v1/workspaces/open/');
    authorizationBlocked('legacy route with query', 'POST', '/v1/workspaces/open?path=J%3A%5Cproject');
    authorizationBlocked('dotted legacy route', 'POST', '/v1/harness/../workspaces/open');
    authorizationBlocked('encoded legacy route', 'POST', '/v1/workspaces/%6Fpen');
    authorizationBlocked('product route', 'POST', '/v1/product/workspace/projects');
    authorizationBlocked('product route with trailing slash', 'POST', '/v1/product/workspace/projects//');
    authorizationBlocked('product route with query', 'POST', '/v1/product/workspace/projects?path=J%3A%5Cproject');
    authorizationBlocked('dotted product route', 'POST', '/v1/product/x/../workspace/projects');
    authorizationBlocked('encoded product route', 'POST', '/v1/product/workspace/%70rojects');
    authorizationBlocked('upper-case product route', 'POST', '/V1/PRODUCT/WORKSPACE/PROJECTS');
    authorizationBlocked('backslash product route', 'POST', '/v1\\product\\workspace\\projects');
    authorizationBlocked('legacy route from a different method', 'GET', '/v1/workspaces/open');
});

test('absolute URLs and non-backend paths never reach the local backend', () => {
    assert.throws(() => checkRendererRequest('POST', 'http://127.0.0.1:9/v1/product/workspace/projects', { path: 'J:\\project' }), /local backend|local path/);
    assert.throws(() => checkRendererRequest('GET', '/snapshot', undefined), /local backend|local path/);
    assert.throws(() => checkRendererRequest('GET', 'v1/chat/send', undefined), /local backend|local path/);
    assert.throws(() => checkRendererRequest('GET', '', undefined), /route path/);
    assert.throws(() => checkRendererRequest('DELETE', '/v1/commands', undefined), /GET and POST/);
    assert.throws(() => checkRendererRequest('post', '/v1/commands', {}), /GET and POST/);
    assert.throws(() => checkRendererRequest('POST', '/v1/commands', []), /JSON object/);
    assert.throws(() => checkRendererRequest('POST', '/v1/commands', 'text'), /JSON object/);
    assert.throws(() => checkRendererRequest('POST', '/v1/commands', null), /JSON object/);
    assert.throws(() => checkRendererRequest('POST', '/v1/commands', { text: 'x'.repeat(1_200_001) }), /1\.2 MB/);
});

test('only the application window main frame is trusted', () => {
    const trusted = { windowContentsId: 3, senderContentsId: 3, senderFrameId: 11, mainFrameId: 11 };
    assert.equal(frameTrust(trusted), 'trusted');
    assert.equal(frameTrust({ ...trusted, senderContentsId: 4 }), 'untrusted');
    assert.equal(frameTrust({ ...trusted, senderFrameId: 12 }), 'untrusted');
    assert.equal(frameTrust({ ...trusted, senderFrameId: undefined }), 'untrusted');
    assert.equal(frameTrust({ ...trusted, windowContentsId: undefined, mainFrameId: undefined }), 'closed');
    assert.equal(frameTrust({ ...trusted, mainFrameId: undefined }), 'closed');
    assert.doesNotThrow(() => requireTrustedSender('trusted' satisfies FrameTrust));
    assert.throws(() => requireTrustedSender('untrusted'), /main frame of the application window only/);
    assert.throws(() => requireTrustedSender('closed'), /window is closed/);
});

test('the registered handler forwards trusted requests and refuses everything else', async () => {
    const forwarded: unknown[] = [];
    const handlerFor = (trust: FrameTrust) => createRequestHandler({
        senderTrust: () => trust,
        forward: async (method, route, body) => { forwarded.push({ method, route, body }); return { forwarded: true }; },
    });

    const accepted = await handlerFor('trusted')({}, 'POST', '/v1/chat/send?mode=chat', { text: 'hi' });
    assert.deepEqual(accepted, { forwarded: true });
    assert.deepEqual(forwarded, [{ method: 'POST', route: '/v1/chat/send?mode=chat', body: { text: 'hi' } }]);

    await assert.rejects(handlerFor('untrusted')({}, 'POST', '/v1/chat/send', {}), /main frame of the application window only/);
    await assert.rejects(handlerFor('closed')({}, 'GET', '/v1/harness/sessions'), /window is closed/);
    await assert.rejects(handlerFor('trusted')({}, 'POST', '/v1/product/workspace/projects', { path: 'J:\\project' }), /native folder picker/);
    assert.equal(forwarded.length, 1, 'Only the trusted, authorized request reached the backend.');
});

const fixtureRoot = path.join(path.resolve('.tmp'), 'desktop-boundary', 'attach-fixtures');

/** A fresh fixture folder inside this checkout, removed when the test ends. */
function fixtureDirectory(t: TestContext): string {
    mkdirSync(fixtureRoot, { recursive: true });
    assertProjectFixtureRoot(fixtureRoot);
    const root = mkdtempSync(path.join(fixtureRoot, 'pick-'));
    assertProjectFixtureRoot(root);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);

test('the native pick describes only the files it actually read', t => {
    const root = fixtureDirectory(t);
    const note = path.join(root, 'note.txt');
    writeFileSync(note, 'hello world');
    const image = path.join(root, 'shot.png');
    writeFileSync(image, png);
    const boundary = path.join(root, 'boundary.txt');
    // The 8192nd byte is the first byte of a three-byte character: a bounded prefix read must not
    // turn a valid text file into "binary" just because the prefix ends inside a character.
    writeFileSync(boundary, 'a'.repeat(8191) + '\u16a0');

    const picked = describePickedFiles([note, image, boundary], { protectedRoots: [] });
    assert.equal(picked.length, 3);
    assert.deepEqual(picked[0], { id: picked[0]!.id, name: 'note.txt', kind: 'file', bytes: 11, path: realpathSync(note) });
    assert.match(picked[0]!.id, /^[0-9a-f]{16}$/);
    assert.deepEqual(describePickedFiles([note], { protectedRoots: [] })[0]!.id, picked[0]!.id, 'The same file keeps one attachment id.');
    assert.deepEqual({ name: picked[1]!.name, kind: picked[1]!.kind, bytes: picked[1]!.bytes }, { name: 'shot.png', kind: 'image', bytes: png.length });
    assert.equal(picked[2]!.kind, 'file', 'A multi-byte character at the prefix boundary stays text.');
});

test('binary or unreadable files are refused instead of being described as text', t => {
    const root = fixtureDirectory(t);
    const binary = path.join(root, 'archive.bin');
    writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00]));
    assert.throws(() => describePickedFiles([binary], { protectedRoots: [] }), /archive\.bin is a binary file/);
    const invalid = path.join(root, 'broken.txt');
    writeFileSync(invalid, Buffer.from([0xc3, 0x28, 0x41]));
    assert.throws(() => describePickedFiles([invalid], { protectedRoots: [] }), /broken\.txt is not UTF-8 text/);
    const huge = path.join(root, 'huge.txt');
    writeFileSync(huge, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    assert.throws(() => describePickedFiles([huge], { protectedRoots: [] }), /huge\.txt is larger than 8 MB/);
    assert.throws(() => describePickedFiles([root], { protectedRoots: [] }), /is not a regular file/);
    assert.throws(() => describePickedFiles([path.join(root, 'missing.txt')], { protectedRoots: [] }), /cannot be read/);
});

test('credential and runtime paths never become attachments', t => {
    const root = fixtureDirectory(t);
    const apiText = path.join(root, 'API.txt');
    writeFileSync(apiText, 'secret');
    assert.throws(() => describePickedFiles([apiText], { protectedRoots: [] }), /credential or runtime configuration file/);
    const configuration = path.join(root, 'configuration.json');
    writeFileSync(configuration, '{}');
    assert.throws(() => describePickedFiles([configuration], { protectedRoots: [] }), /credential or runtime configuration file/);
    const git = path.join(root, '.git');
    mkdirSync(git);
    const gitConfig = path.join(git, 'config');
    writeFileSync(gitConfig, '[remote]');
    assert.throws(() => describePickedFiles([gitConfig], { protectedRoots: [] }), /protected runtime folder/);
    const state = path.join(root, 'state');
    mkdirSync(state);
    const stateFile = path.join(state, 'events.json');
    writeFileSync(stateFile, '[]');
    assert.throws(() => describePickedFiles([stateFile], { protectedRoots: [state] }), /belongs to the running application state/);
});

test('a pick is bounded to five files and a cancel attaches nothing', t => {
    const root = fixtureDirectory(t);
    assert.deepEqual(describePickedFiles([], { protectedRoots: [] }), []);
    const files = Array.from({ length: 6 }, (_, index) => {
        const file = path.join(root, `file-${index}.txt`);
        writeFileSync(file, `content ${index}`);
        return file;
    });
    assert.deepEqual(describePickedFiles(files, { protectedRoots: [] }).map(item => item.name), ['file-0.txt', 'file-1.txt', 'file-2.txt', 'file-3.txt', 'file-4.txt']);
});

test('a junction on the way to a picked file is refused', t => {
    const root = fixtureDirectory(t);
    const target = path.join(root, 'real');
    mkdirSync(target);
    writeFileSync(path.join(target, 'note.txt'), 'hello');
    const link = path.join(root, 'linked');
    try { symlinkSync(target, link, 'junction'); }
    catch { t.skip('This machine cannot create a junction for the fixture.'); return; }
    assert.throws(() => describePickedFiles([path.join(link, 'note.txt')], { protectedRoots: [] }), /junctions or symbolic links/);
});

test('text classification reads the whole file, not just its first 8 KB', t => {
    const root = fixtureDirectory(t);
    // The old defect: the first 8192 bytes decided the kind, so anything after them was never examined.
    const lateBinary = path.join(root, 'late-binary.txt');
    writeFileSync(lateBinary, Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00, 0xff])]));
    assert.throws(() => describePickedFiles([lateBinary], { protectedRoots: [] }), /late-binary\.txt is a binary file/);
    const lateInvalid = path.join(root, 'late-invalid.txt');
    writeFileSync(lateInvalid, Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0xff])]));
    assert.throws(() => describePickedFiles([lateInvalid], { protectedRoots: [] }), /late-invalid\.txt is not UTF-8 text/);
    // A file that ends inside a multi-byte sequence is not valid text: the decoder has to be flushed.
    const truncated = path.join(root, 'truncated.txt');
    writeFileSync(truncated, Buffer.from([0x61, 0xe2, 0x82]));
    assert.throws(() => describePickedFiles([truncated], { protectedRoots: [] }), /truncated\.txt is not UTF-8 text/);
    const full = path.join(root, 'full.txt');
    writeFileSync(full, Buffer.alloc(8 * 1024 * 1024, 0x61));
    assert.equal(describePickedFiles([full], { protectedRoots: [] })[0]!.bytes, 8 * 1024 * 1024, 'A full-size text file is read to the end.');
});

test('a multi-byte character split across read chunks stays valid text', t => {
    const root = fixtureDirectory(t);
    const split = path.join(root, 'split.txt');
    // U+20AC starts at offset 65535 and ends at 65537: the 64 KiB read boundary falls inside it.
    writeFileSync(split, 'a'.repeat(64 * 1024 - 1) + '\u20ac' + 'z');
    const [picked] = describePickedFiles([split], { protectedRoots: [] });
    assert.deepEqual({ kind: picked!.kind, bytes: picked!.bytes }, { kind: 'file', bytes: 64 * 1024 + 3 });
});

test('a file that grows past the bound after the size check is refused', t => {
    const root = fixtureDirectory(t);
    const growing = path.join(root, 'growing.txt');
    writeFileSync(growing, 'a');
    const handle = openSync(growing, 'r');
    t.after(() => closeSync(handle));
    // The size check saw one byte; reading through the open handle finds the grown file instead.
    writeFileSync(growing, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    assert.throws(() => readBoundedSync(handle, 'growing.txt'), /growing\.txt is larger than 8 MB/);
});

