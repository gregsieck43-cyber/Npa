import { createServer, type IncomingMessage } from 'node:http';
import { resourceBudget } from './resource-budget.js';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { listenLoopback } from './loopback.js';
import type { Command } from '../contracts.js';
import { startMockProvider, type MockProviderOptions } from '../fixtures/mock-provider.js';
import { KernelError } from '../kernel/index.js';
import { Services } from './services.js';
import { acquireInstanceLock } from './instance-lock.js';
import { writeAtomicJson } from './atomic-json.js';
import { assertLocalPath } from './local-paths.js';
import { initializeDataDirectory } from './data-directory.js';
import { Harness } from '../harness/service.js';
import { ProductApi } from '../product/api.js';
import { ProductError } from '../product/shared.js';
import { WebError } from '../network/index.js';
import { ideAgentView } from '../ide/service.js';
import { integrationRoute } from './integration-routes.js';
async function body(request: IncomingMessage): Promise<Record<string, any>> {
    request.setEncoding('utf8');
    let value = '';
    for await (const chunk of request) {
        value += String(chunk);
        if (value.length > 1200000)
            throw new Error('Request body exceeds 1.2 MB.');
    }
    const parsed: unknown = value ? JSON.parse(value) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Request body must be an object.');
    return parsed as Record<string, any>;
}
/** Real transport error codes -> HTTP status; unknown transport failures are upstream failures (502). */
const WEB_STATUS: Record<string, number> = {
    INVALID_QUERY: 400, INVALID_URL: 400, URL_BLOCKED: 400, CRAWL_LIMIT: 400,
    NETWORK_DISABLED: 409, PROXY_UNSUPPORTED: 409, SEARCH_CONFIGURATION: 409,
    TIMEOUT: 504, CANCELLED: 408, CLOSED: 503,
};
/** Legacy browsing accepts only its documented fields so a typo cannot silently change the operation. */
const WEB_FIELDS: Record<string, string[]> = {
    search: ['query'], fetch: ['url'], crawl: ['url', 'maxPages', 'maxDepth'],
};
function assertWebFields(action: string, input: Record<string, unknown>): void {
    const allowed = WEB_FIELDS[action];
    if (!allowed) return;
    const unknown = Object.keys(input).filter(key => !allowed.includes(key));
    if (unknown.length) throw new ProductError('validation', `Unknown web ${action} field: ${unknown[0]}`);
}
export async function startBackend(options: {
    dataDir: string;
    projectRoot: string;
    productRoot?: string;
    mockFault?: any;
    mockOptions?: MockProviderOptions;
}) {
    const dataDir = path.resolve(options.dataDir);
    assertLocalPath(options.projectRoot, 'Project root'); assertLocalPath(dataDir, 'Data directory');
    const relativeData = path.relative(path.resolve(options.projectRoot), dataDir);
    if (relativeData.startsWith('..') || path.isAbsolute(relativeData))
        throw new Error('Data directory must be inside the configured project.');
    const dataDirectoryAccess = initializeDataDirectory(dataDir);
    const instance = acquireInstanceLock(dataDir);
    const mock = await startMockProvider({ ...options.mockOptions, ...(options.mockFault ? { fault: options.mockFault } : {}) }).catch(error => {
        instance.release();
        throw error;
    });
    let services: Services;
    try {
        services = new Services(dataDir, options.projectRoot, mock.url, options.productRoot, dataDirectoryAccess);
        services.harness = new Harness(services);
        await services.harness.requests.recoverAccountingScopes();
        services.product = new ProductApi(services);
    }
    catch (error) {
        await mock.close();
        instance.release();
        throw error;
    }
    const token = randomBytes(32).toString('hex');
    const server = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        if (request.headers.authorization !== `Bearer ${token}`) {
            response.writeHead(401);
            response.end(JSON.stringify({ error: 'Local backend authorization required.' }));
            return;
        }
        const controller = new AbortController();
        // A disconnected client cancels only its own manual browse; a fully written response never aborts.
        response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        try {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            let result: unknown;
            const route = url.pathname;
            const submitted = request.method === 'POST' ? await body(request) : {};
            const input = ['/v1/config', '/v1/harness/profiles'].includes(route) || route.startsWith('/v1/product') ? submitted : services.harness!.sanitize(submitted);
            if (route.startsWith('/v1/product'))
                result = await services.product!.route(request.method ?? 'GET', url, input, controller.signal);
            else if (request.method === 'GET' && route === '/health')
                result = services.health();
            else if (request.method === 'POST' && route === '/v1/resources/proxy') {
                if (typeof input.id !== 'string' || !['cli', 'mcp'].includes(String(input.kind)) || !input.id.startsWith(`${input.kind}-`)
                    || !Number.isSafeInteger(input.pid) || Number(input.pid) <= 0) throw new Error('Invalid NPN proxy resource identity.');
                // Authenticated self-reports affect admission only; a supplied PID never authorizes process control.
                if (input.remove === true) resourceBudget.removeExternalProcess(input.id, Number(input.pid));
                else resourceBudget.updateExternalProcess(input.id, { pid: Number(input.pid), workingSetBytes: Number(input.workingSetBytes) });
                result = { recorded: true };
            }
            else if (route.startsWith('/v1/harness/'))
                result = await services.harness!.route(request.method ?? 'GET', url, input);
            else if (route.startsWith('/v1/integrations/') || /^\/v1\/tasks\/[^/]+\/integrations(?:\/|$)/.test(route))
                result = await integrationRoute(services, request.method ?? 'GET', url, input);
            else if (request.method === 'GET' && route === '/v1/activity')
                result = services.kernel.activity(Number(url.searchParams.get('days') ?? 90));
            else if (request.method === 'GET' && ['/v1/snapshot', '/snapshot'].includes(route))
                result = services.snapshot(url.searchParams.get('taskId') ?? undefined, url.searchParams.get('compact') === 'true');
            else if (request.method === 'GET' && /^\/v1\/tasks\/[^/]+\/history-page$/.test(route))
                result = services.kernel.historyPage(decodeURIComponent(route.split('/')[3]!), url.searchParams.get('kind') ?? 'messages', Number(url.searchParams.get('after') ?? 0), Number(url.searchParams.get('limit') ?? 100), url.searchParams.has('through') ? Number(url.searchParams.get('through')) : undefined);
            else if (request.method === 'GET' && /^\/v1\/tasks\/[^/]+\/messages$/.test(route))
                result = services.kernel.messagePage(route.split('/')[3]!, Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER), Number(url.searchParams.get('limit') ?? 100));
            else if (request.method === 'POST' && ['/v1/commands', '/commands'].includes(route))
                result = services.command(input as unknown as Command);
            else if (request.method === 'GET' && /^\/v1\/tasks\/[^/]+\/events$/.test(route))
                result = services.kernel.events(route.split('/')[3]!, Number(url.searchParams.get('after') ?? 0), url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined);
            else if (request.method === 'GET' && route === '/v1/config')
                result = services.config();
            else if (request.method === 'GET' && route === '/v1/instructions')
                result = await services.instructions(String(url.searchParams.get('taskId')));
            else if (request.method === 'GET' && route === '/v1/recall') {
                const task = services.task(url.searchParams.get('taskId'));
                const query = (url.searchParams.get('q') ?? '').toLowerCase();
                result = services.kernel.recall(task.id, query);
            }
            else if (request.method === 'POST' && route === '/v1/config')
                result = services.configure(input);
            else if (request.method === 'POST' && route === '/v1/connection-test')
                result = await services.configuration.client().complete([{ role: 'user', content: 'Return the single word connected.' }], []);
            else if (request.method === 'POST' && route === '/v1/sidechat')
                result = await services.sidechat(input);
            else if (request.method === 'POST' && route === '/v1/sidechat/cancel')
                result = services.cancelSidechat(input);
            else if (request.method === 'POST' && route.startsWith('/v1/web/')) {
                const action = route.slice('/v1/web/'.length);
                assertWebFields(action, input);
                result = await services.web(action, input, controller.signal);
            }
            else if (request.method === 'GET' && route === '/v1/mcp')
                result = services.external.listMcp();
            else if (request.method === 'POST' && route === '/v1/mcp/connect')
                result = await services.external.connect(input as any);
            else if (request.method === 'POST' && route === '/v1/mcp/tools')
                result = await services.external.tools(String(input.id));
            else if (request.method === 'POST' && route === '/v1/mcp/disconnect')
                result = await services.external.disconnect(String(input.id));
            else if (request.method === 'POST' && route === '/v1/mcp/call')
                result = await services.proposeTool(input, 'mcp_call');
            else if (request.method === 'GET' && route === '/v1/ide/agent')
                result = await ideAgentView(services, String(url.searchParams.get('workspace') ?? ''), { taskId: url.searchParams.get('taskId') ?? undefined, chatId: url.searchParams.get('chatId') ?? undefined });
            else if (request.method === 'POST' && route === '/v1/ide/editors') {
                if (input.remove === true) services.editors.remove(String(input.owner));
                else {
                    const workspace = await services.ideWorkspace(String(input.workspace ?? ''));
                    services.editors.update(String(input.owner), workspace.path, input.dirtyPaths, Date.now(), input.sequence);
                }
                result = { recorded: true };
            }
            else if (request.method === 'POST' && route === '/v1/workspaces/open')
                result = await services.openWorkspace(String(input.path ?? ''));
            else if (request.method === 'GET' && route === '/v1/ide/workspace')
                result = await services.ideWorkspace(String(url.searchParams.get('path') ?? ''));
            else if (request.method === 'GET' && route === '/v1/ide/tasks') {
                const workspace = await services.ideWorkspace(String(url.searchParams.get('workspace') ?? ''));
                const page = services.kernel.workspaceTaskPage(workspace.path, Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER));
                response.setHeader('X-NPN-History-Window', 'true');
                if (page.nextCursor) response.setHeader('X-NPN-Next-Cursor', String(page.nextCursor));
                result = page.items;
            }
            else if (request.method === 'GET' && route === '/v1/files')
                result = await services.files(url.searchParams);
            else if (request.method === 'GET' && route === '/v1/file-search')
                result = await services.fileSearch(url.searchParams);
            else if (request.method === 'POST' && route === '/v1/files')
                result = await services.proposeTool(input, 'write_file');
            else if (request.method === 'POST' && route === '/v1/terminal')
                result = await services.proposeTool(input, input.shell === 'powershell' ? 'run_shell' : 'run_command');
            else if (request.method === 'GET' && route === '/v1/plugins')
                result = services.plugins.list();
            else if (request.method === 'POST' && route.startsWith('/v1/plugins/'))
                result = await services.plugin(route.slice('/v1/plugins/'.length), input);
            else if (request.method === 'GET' && route === '/v1/candidates')
                result = services.candidates.list(url.searchParams.get('taskId') ?? undefined);
            else if (request.method === 'POST' && route.startsWith('/v1/candidates/'))
                result = await services.candidate(route.slice('/v1/candidates/'.length), input);
            else if (request.method === 'POST' && route === '/v1/accept-result')
                result = await services.acceptResult(input);
            else if (request.method === 'POST' && route === '/v1/shutdown') {
                result = { stopped: true };
                setTimeout(() => {
                    void close().catch(error => {
                        process.stderr.write(`Shutdown failed: ${String(error)}\n`);
                    });
                }, 50);
            }
            else {
                response.writeHead(404);
                response.end(JSON.stringify({ error: 'Unknown backend route.' }));
                return;
            }
            if (!response.destroyed && !response.writableEnded)
                response.end(JSON.stringify(route.startsWith('/v1/product') ? result : services.harness!.sanitize(result)));
        }
        catch (error) {
            const product = error instanceof ProductError;
            const web = error instanceof WebError;
            const code = product ? error.code : error instanceof KernelError ? error.code : web ? error.code : 'REQUEST_FAILED';
            // The transport attempt list is the diagnostic record of what providers actually said;
            // keep it structured (sanitized) so callers can distinguish empty from failed searches.
            const candidateAttempts = web ? (error as unknown as { attempts?: unknown }).attempts : undefined;
            const attempts = Array.isArray(candidateAttempts) ? candidateAttempts : undefined;
            if (response.destroyed || response.writableEnded)
                return;
            response.writeHead(product ? error.status : web ? (WEB_STATUS[code] ?? 502) : /CONFLICT|STALE|REVISION/.test(code) ? 409 : /DENIED|SCOPE|FORBIDDEN/.test(code) ? 403 : 400);
            response.end(JSON.stringify({
                code,
                error: services.harness!.sanitize(error instanceof Error ? error.message : String(error)),
                ...(attempts ? { attempts: services.harness!.sanitize(attempts) } : {}),
            }));
        }
    });
    const port = await listenLoopback(server);
    const discovery = { port, token, pid: process.pid, startedAt: new Date().toISOString() };
    writeAtomicJson(path.join(dataDir, 'backend.json'), discovery);
    services.runner.start();
    let closed = false;
    const close = async () => {
        if (closed)
            return;
        closed = true;
        services.product?.store.stopEventWaits();
        await services.stop();
        // Requests already in flight were signalled by stop(); do not hang shutdown on a socket
        // that never finishes. Bounded close then force-closes the remaining connections.
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { server.closeAllConnections(); resolve(); }, 5000);
            timer.unref();
            server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
        });
        await services.external.close();
        await mock.close();
        await services.product?.close();
        services.harness!.close();
        services.integrations.close();
        services.kernel.close();
        const discoveryPath = path.join(dataDir, 'backend.json');
        try {
            if (existsSync(discoveryPath) && JSON.parse(readFileSync(discoveryPath, 'utf8')).token === token) unlinkSync(discoveryPath);
        } catch { /* Preserve a damaged discovery file; release the writer lock for the next restart. */ }
        instance.release();
    };
    return { ...discovery, services, mock, close };
}
