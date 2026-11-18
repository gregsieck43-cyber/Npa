import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { archiveArtifact } from '../src/app/artifacts.js';

test('verified artifact snapshots deduplicate by bytes and detect damaged prior archives', t => {
    const temporary = path.resolve('.tmp');
    mkdirSync(temporary, { recursive: true });
    const owned = mkdtempSync(path.join(temporary, 'artifact-test-'));
    t.after(() => rmSync(owned, { recursive: true, force: true }));
    const first = archiveArtifact(owned, Buffer.from('version one'));
    assert.deepEqual(archiveArtifact(owned, Buffer.from('version one')), first);
    const second = archiveArtifact(owned, Buffer.from('version two'));
    assert.notEqual(second.sha256, first.sha256);
    assert.equal(readFileSync(first.archivePath, 'utf8'), 'version one');
    writeFileSync(first.archivePath, 'damaged');
    assert.throws(() => archiveArtifact(owned, Buffer.from('version one')), /integrity check/);
});
