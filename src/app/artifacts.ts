import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Immutable snapshots of independently verified writes, addressed by their exact bytes. */
export function archiveArtifact(directory: string, bytes: Buffer): { sha256: string; archivePath: string } {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    mkdirSync(directory, { recursive: true });
    const archivePath = path.join(directory, sha256);
    if (existsSync(archivePath)) {
        if (!readFileSync(archivePath).equals(bytes))
            throw new Error(`Archived artifact failed integrity check: ${sha256}`);
    } else {
        const fd = openSync(archivePath, 'wx');
        try {
            writeFileSync(fd, bytes);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
    }
    return { sha256, archivePath };
}
