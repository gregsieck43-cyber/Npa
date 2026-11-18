import path from 'node:path';

export class EditorBusyError extends Error {
  readonly code = 'EDITOR_DIRTY';
  constructor(filename: string) { super(`The IDE has unsaved edits in ${filename}. Save or revert that document before approving an Agent write.`); this.name = 'EditorBusyError'; }
}

/** Live editor coordination, not task authority or an OS lock. Crashed windows expire after 30 seconds. */
export class IdeEditors {
  private sessions = new Map<string, { owner: string; workspace: string; dirty: Set<string>; expires: number; sequence: number }>();
  update(owner: string, workspace: string, paths: string[], at = Date.now(), sequence?: number): void {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(owner) || !Array.isArray(paths) || paths.length > 512) throw new Error('Invalid IDE editor session.');
    const root = path.resolve(workspace);
    const dirty = new Set(paths.map(value => {
      if (typeof value !== 'string') throw new Error('Dirty document paths must be strings.');
      const filename = path.resolve(root, value), relative = path.relative(root, filename);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Dirty document is outside the IDE workspace.');
      return filename.toLowerCase();
    }));
    this.expire(at);
    const key = `${owner}:${root.toLowerCase()}`, previous = this.sessions.get(key);
    const nextSequence = sequence ?? (previous?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(nextSequence) || nextSequence < 0) throw new Error('Invalid IDE editor sequence.');
    if (previous && nextSequence <= previous.sequence) return;
    if (!this.sessions.has(key) && this.sessions.size >= 64) throw new Error('Too many live IDE workspace sessions.');
    this.sessions.set(key, { owner, workspace: root, dirty, expires: at + 30000, sequence: nextSequence });
  }
  remove(owner: string): void { for (const [key, session] of this.sessions) if (session.owner === owner) this.sessions.delete(key); }
  assertWritable(filename: string, at = Date.now()): void {
    this.expire(at);
    const target = path.resolve(filename).toLowerCase();
    for (const session of this.sessions.values()) if (session.dirty.has(target)) throw new EditorBusyError(filename);
  }
  assertWorkspaceClean(workspace: string, at = Date.now()): void {
    this.expire(at);
    const root = path.resolve(workspace);
    for (const session of this.sessions.values()) for (const filename of session.dirty) {
      const relative = path.relative(root, filename);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new EditorBusyError(filename);
    }
  }
  private expire(at: number): void { for (const [key, session] of this.sessions) if (session.expires <= at) this.sessions.delete(key); }
}
