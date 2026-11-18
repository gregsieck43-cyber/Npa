import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertLocalPath } from './local-paths.js';

export function writeAtomicJson(filename: string, value: unknown): void {
  assertLocalPath(filename, 'Application data and configuration files');
  const temporary = path.join(path.dirname(filename), `.npn-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, filename);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
