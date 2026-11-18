import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class AlreadyRunning extends Error {
  readonly code = 'ALREADY_RUNNING';

  constructor(readonly dataDir: string, cause: unknown) {
    super('A backend already owns this data directory. Close that instance before starting another.', { cause });
    this.name = 'AlreadyRunning';
  }
}

/** SQLite's native process lock disappears on exit, including an unexpected crash. */
export function acquireInstanceLock(dataDir: string): { release(): void } {
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(path.join(dataDir, 'instance-lock.sqlite'));
  try {
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch (error) {
    database.close();
    const sqliteCode = (error as { errcode?: number }).errcode;
    if (sqliteCode === 5 || sqliteCode === 6) throw new AlreadyRunning(dataDir, error);
    throw error;
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try { database.exec('ROLLBACK'); }
      finally { database.close(); }
    },
  };
}
