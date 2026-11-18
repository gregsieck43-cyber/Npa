import path from 'node:path';
import type { ProductRuntime } from './shared.js';
import { invalid, pickFields, requiredString } from './shared.js';
import type { ProductSessions } from './sessions.js';

/** Authenticated operator routes resolve scope from existing sessions/projects, never a supplied path/from. */
export class ProductCoordination {
  constructor(private readonly rt: ProductRuntime, private readonly sessions: ProductSessions) {}
  private async work(id: unknown): Promise<string> {
    const sessionId = requiredString(id, 'sessionId');
    const session = await this.sessions.get(sessionId);
    if (session.mode === 'chat' || !this.rt.services.kernel.getTask(sessionId)) invalid('Coordination inbox belongs to a Work task.');
    return sessionId;
  }
  async route(method: string, route: string, query: Record<string, string>, body: Record<string, unknown>): Promise<unknown> {
    const service = this.rt.services.kernel.coordination;
    if (method === 'GET' && (route === '/presence' || route === '/claims')) {
      pickFields(query, ['projectId', 'sessionId', 'after', 'limit']);
      if (Boolean(query.projectId) === Boolean(query.sessionId)) invalid('Choose exactly one projectId or sessionId.');
      let workspace: string | undefined;
      let projectId = query.projectId;
      if (query.sessionId) {
        const id = requiredString(query.sessionId, 'sessionId');
        const session = await this.sessions.get(id);
        if (session.mode === 'chat') {
          workspace = this.rt.harness.store.getSession(id).workspace;
          // The implicit Chat read scope has no coordination participants or file claims.
          if (workspace && path.isAbsolute(workspace) && path.relative(this.rt.services.projectRoot, workspace) === '') workspace = undefined;
          if (!workspace && session.projectId) projectId = session.projectId;
        } else workspace = this.rt.services.kernel.getTask(id)?.workspace;
      }
      if (projectId) workspace = this.rt.services.projectPath(requiredString(projectId, 'projectId')) ?? invalid('Project is not registered or authorized.');
      if (!workspace) return { items: [] };
      this.rt.services.assertWorkspacePath(workspace);
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      if (route === '/claims') return this.rt.services.kernel.fileClaims.claims(workspace, query.after, limit);
      await this.rt.services.observeWorkspace(workspace);
      return { ...service.presence(workspace, query.after, limit), external: { ...this.rt.services.workspacePresence.snapshot(workspace), ...(this.rt.services.workspacePresenceIssue ? { error: this.rt.services.workspacePresenceIssue } : {}) } };
    }
    if (method === 'GET' && route === '/inbox') {
      pickFields(query, ['sessionId', 'after', 'through', 'limit']);
      const id = await this.work(query.sessionId);
      return service.inbox(id, { after: query.after === undefined ? undefined : Number(query.after), through: query.through === undefined ? undefined : Number(query.through), limit: query.limit === undefined ? undefined : Number(query.limit) });
    }
    if (method === 'POST' && route === '/send') {
      const value = pickFields(body, ['sessionId', 'to', 'kind', 'body', 'clientMessageId']);
      const id = await this.work(value.sessionId);
      return service.send(id, requiredString(value.to, 'to'), requiredString(value.kind, 'kind', 30), requiredString(value.body, 'body', 3000), requiredString(value.clientMessageId, 'clientMessageId'), 'operator');
    }
    if (method === 'POST' && route === '/claims') {
      const value = pickFields(body, ['sessionId', 'paths']);
      const id = await this.work(value.sessionId);
      return this.rt.services.kernel.fileClaims.claimFiles(id, value.paths as string[]);
    }
    if (method === 'POST' && route === '/release') {
      const value = pickFields(body, ['sessionId', 'ids']);
      const id = await this.work(value.sessionId);
      this.rt.services.kernel.fileClaims.releaseClaims(id, value.ids as string[]);
      return { released: true };
    }
    if (method === 'POST' && route === '/ack') {
      const value = pickFields(body, ['sessionId', 'noticeIds']);
      const id = await this.work(value.sessionId);
      service.ack(id, value.noticeIds as string[], 'operator');
      return { acknowledged: true };
    }
    invalid('Unsupported coordination route.');
  }
}
