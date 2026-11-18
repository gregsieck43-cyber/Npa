import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { BackendGateway, BackendRequestError, discoverLocalBackend } from '../src/desktop/backend-connection.js';

type RunningBackend = Awaited<ReturnType<typeof startBackend>>;

function fixture(prefix: string): { root: string; dataDir: string } {
    const root = mkdtempSync(path.resolve('.tmp', prefix));
    return { root, dataDir: path.join(root, 'data') };
}

function endpointOf(backend: RunningBackend): { port: number; token: string } {
    return { port: backend.port, token: backend.token };
}

async function closeAll(backends: RunningBackend[]): Promise<void> {
    for (const backend of backends.splice(0)) await backend.close().catch(() => undefined);
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') reject(new Error('The fixture server did not bind a port.'));
            else resolve(address.port);
        });
    });
}

test('recovers GETs after the backend restarts with a new port and token', { timeout: 60000 }, async () => {
    const { root, dataDir } = fixture('desktop-gateway-restart-');
    const backends: RunningBackend[] = [];
    let launches = 0;
    try {
        const first = await startBackend({ dataDir, projectRoot: process.cwd() });
        backends.push(first);
        const gateway = new BackendGateway({ dataDir, launch: async () => { launches += 1; return endpointOf(first); } });
        await gateway.ensure();
        assert.equal((await gateway.request('GET', '/health')).status, 'ready');
        const oldToken = first.token;
        await first.close();
        backends.length = 0;
        const second = await startBackend({ dataDir, projectRoot: process.cwd() });
        backends.push(second);
        assert.notEqual(second.token, oldToken, 'A restarted backend must publish a new token.');
        const health = await gateway.request('GET', '/health');
        assert.equal(health.status, 'ready');
        assert.equal(gateway.current?.token, second.token);
        assert.equal(launches, 1, 'Recovery must not relaunch the backend.');
    }
    finally {
        await closeAll(backends);
        rmSync(root, { recursive: true, force: true });
    }
});

test('one bounded single-flight rediscovery repairs a 401 from a stale token', { timeout: 60000 }, async () => {
    const { root, dataDir } = fixture('desktop-gateway-401-');
    const backends: RunningBackend[] = [];
    let probes = 0;
    try {
        const backend = await startBackend({ dataDir, projectRoot: process.cwd() });
        backends.push(backend);
        const gateway = new BackendGateway({
            dataDir,
            launch: async () => ({ port: backend.port, token: 'stale-token-that-the-backend-rejects' }),
            discover: async data => { probes += 1; return discoverLocalBackend(data); },
        });
        await gateway.ensure();
        const health = await gateway.request('GET', '/health');
        assert.equal(health.status, 'ready');
        assert.equal(probes, 1);
        assert.equal(gateway.current?.token, backend.token);
    }
    finally {
        await closeAll(backends);
        rmSync(root, { recursive: true, force: true });
    }
});

test('concurrent GETs over a stale token share one rediscovery', { timeout: 60000 }, async () => {
    const { root, dataDir } = fixture('desktop-gateway-concurrent-');
    const backends: RunningBackend[] = [];
    let probes = 0;
    try {
        const backend = await startBackend({ dataDir, projectRoot: process.cwd() });
        backends.push(backend);
        const gateway = new BackendGateway({
            dataDir,
            launch: async () => ({ port: backend.port, token: 'stale-token-that-the-backend-rejects' }),
            discover: async data => { probes += 1; return discoverLocalBackend(data); },
        });
        await gateway.ensure();
        const results = await Promise.all(Array.from({ length: 8 }, () => gateway.request('GET', '/health')));
        for (const health of results) assert.equal(health.status, 'ready');
        assert.equal(probes, 1, 'A burst of GETs must probe discovery once.');
    }
    finally {
        await closeAll(backends);
        rmSync(root, { recursive: true, force: true });
    }
});

test('an ambiguous POST is reported once and never replayed; later GETs recover', { timeout: 60000 }, async () => {
    const { root, dataDir } = fixture('desktop-gateway-post-');
    const backends: RunningBackend[] = [];
    let received = 0;
    const socketDropper = createServer((request, response) => {
        request.on('data', () => undefined);
        request.on('end', () => { received += 1; request.socket.destroy(); });
        response.on('error', () => undefined);
    });
    try {
        const port = await listen(socketDropper);
        const backend = await startBackend({ dataDir, projectRoot: process.cwd() });
        backends.push(backend);
        const gateway = new BackendGateway({ dataDir, launch: async () => ({ port, token: 'ambiguous-token' }) });
        await gateway.ensure();
        await assert.rejects(
            gateway.request('POST', '/v1/harness/profiles', { name: 'fixture' }),
            (error: unknown) => error instanceof BackendRequestError && error.method === 'POST'
                && error.ambiguous === true && /not replayed/.test(error.message),
        );
        assert.equal(received, 1, 'A POST whose outcome is unknown must reach the server at most once.');
        assert.equal(gateway.current, undefined);
        const health = await gateway.request('GET', '/health');
        assert.equal(health.status, 'ready', 'The next call must recover through read-only discovery.');
    }
    finally {
        socketDropper.close();
        await closeAll(backends);
        rmSync(root, { recursive: true, force: true });
    }
});

test('a POST is not replayed on 401 and a non-401 4xx is returned without rediscovery', { timeout: 60000 }, async () => {
    const { root, dataDir } = fixture('desktop-gateway-status-');
    let received = 0;
    let probes = 0;
    let unauthorizedSent = false;
    const statusServer = createServer((request, response) => {
        request.on('data', () => undefined);
        request.on('end', () => {
            received += 1;
            response.setHeader('Content-Type', 'application/json');
            if (request.url === '/v1/harness/profiles' && !unauthorizedSent) {
                unauthorizedSent = true;
                response.writeHead(401);
                response.end(JSON.stringify({ error: 'Local backend authorization required.' }));
            }
            else {
                response.writeHead(400);
                response.end(JSON.stringify({ error: 'Invalid provider configuration.' }));
            }
        });
    });
    try {
        const port = await listen(statusServer);
        const gateway = new BackendGateway({
            dataDir,
            launch: async () => ({ port, token: 'rejected-token' }),
            discover: async () => { probes += 1; return { port, token: 'discovered-token' }; },
        });
        await gateway.ensure();
        const unauthorized = await gateway.request('POST', '/v1/harness/profiles', { name: 'fixture' });
        assert.equal(unauthorized.httpStatus, 401);
        assert.equal(received, 1);
        assert.equal(probes, 0, 'An effectful request is never automatically replayed.');
        assert.equal(gateway.current, undefined, 'A rejected token is dropped so future calls rediscover.');
        await gateway.ensure();
        const invalid = await gateway.request('POST', '/v1/harness/profiles', { name: 'fixture' });
        assert.equal(invalid.httpStatus, 400);
        assert.equal(received, 2);
        assert.equal(probes, 0, 'Other 4xx answers are final and are not retried.');
    }
    finally {
        statusServer.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test('a real JSON array keeps its shape; objects and HTTP errors stay accurate', { timeout: 30000 }, async () => {
    const { root, dataDir } = fixture('desktop-gateway-shape-');
    const server = createServer((request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/v1/product/models') response.end(JSON.stringify([{ id: 'default', name: '默认提供方', mode: 'mock' }]));
        else if (request.url === '/v1/product/settings') response.end(JSON.stringify({ defaults: { modelId: 'default' } }));
        else if (request.url === '/v1/activity') response.end(JSON.stringify([{ date: '2026-10-30', events: 0 }]));
        else {
            response.writeHead(404);
            response.end(JSON.stringify({ code: 'not_found', error: 'Unknown backend route.' }));
        }
    });
    try {
        const port = await listen(server);
        const gateway = new BackendGateway({ dataDir, launch: async () => ({ port, token: 'shape-token' }) });
        await gateway.ensure();
        const models = await gateway.request('GET', '/v1/product/models') as unknown as { id?: unknown }[];
        assert.ok(Array.isArray(models), 'A product list must stay an array, not become an object envelope.');
        assert.equal(models[0]?.id, 'default');
        assert.deepEqual(await gateway.request('GET', '/v1/activity'), [{ date: '2026-10-30', events: 0 }]);
        const settings = await gateway.request('GET', '/v1/product/settings') as { defaults?: { modelId?: unknown } };
        assert.equal(settings.defaults?.modelId, 'default');
        const missing = await gateway.request('GET', '/v1/product/missing') as { httpStatus?: unknown; code?: unknown; error?: unknown };
        assert.equal(missing.httpStatus, 404);
        assert.equal(missing.code, 'not_found');
        assert.match(String(missing.error), /Unknown backend route/);
    }
    finally {
        server.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test('a GET without a cached endpoint launches the existing backend once and shares that recovery', { timeout: 120000 }, async () => {
    const { root, dataDir } = fixture('desktop-gateway-launch-');
    const backends: RunningBackend[] = [];
    let launches = 0;
    const launch = async () => {
        launches += 1;
        const backend = await startBackend({ dataDir, projectRoot: process.cwd() });
        backends.push(backend);
        return endpointOf(backend);
    };
    try {
        const gateway = new BackendGateway({ dataDir, launch });
        const results = await Promise.all(Array.from({ length: 6 }, () => gateway.request('GET', '/health')));
        for (const health of results) assert.equal(health.status, 'ready');
        assert.equal(launches, 1, 'Concurrent GETs must share one bounded launch and discovery.');
    }
    finally {
        await closeAll(backends);
        rmSync(root, { recursive: true, force: true });
    }
});

test('a GET restarts the backend through the existing launcher after the process exits', { timeout: 120000 }, async () => {
    const { root, dataDir } = fixture('desktop-gateway-relaunch-');
    const backends: RunningBackend[] = [];
    let launches = 0;
    const launch = async () => {
        launches += 1;
        const backend = await startBackend({ dataDir, projectRoot: process.cwd() });
        backends.push(backend);
        return endpointOf(backend);
    };
    try {
        const gateway = new BackendGateway({ dataDir, launch });
        const first = await gateway.ensure();
        assert.equal(launches, 1);
        const stopped = backends.shift()!;
        await stopped.close();
        const health = await gateway.request('GET', '/health');
        assert.equal(health.status, 'ready');
        assert.equal(launches, 2, 'A stopped backend is restarted once through the existing launcher.');
        assert.notEqual(gateway.current?.token, first.token, 'The restarted backend publishes a new token.');
    }
    finally {
        await closeAll(backends);
        rmSync(root, { recursive: true, force: true });
    }
});

test('shutdown waits for an in-flight launch and never caches or starts another endpoint afterwards', { timeout: 60000 }, async () => {
    const { root, dataDir } = fixture('desktop-gateway-barrier-');
    let release!: (endpoint: { port: number; token: string }) => void;
    let launches = 0;
    try {
        const gateway = new BackendGateway({
            dataDir,
            launch: async () => {
                launches += 1;
                return await new Promise<{ port: number; token: string }>(resolve => { release = resolve; });
            },
            discover: async () => undefined,
        });
        const ensured = gateway.ensure();
        await Promise.resolve();
        const shutdown = gateway.shutdown(1000);
        release({ port: 9, token: 'late-endpoint-after-shutdown' });
        await ensured;
        const result = await shutdown;
        assert.equal(result.attempted, true, 'The in-flight endpoint is handed to shutdown instead of being dropped.');
        assert.equal(result.stopped, false, 'The unused fixture port cannot acknowledge a stop.');
        assert.equal(gateway.current, undefined, 'A stopped endpoint is never written back to the cache.');
        await assert.rejects(
            gateway.request('GET', '/health'),
            (error: unknown) => error instanceof BackendRequestError && /not connected|shutting down/.test(error.message) && error.ambiguous === false,
        );
        assert.equal(launches, 1, 'No backend is started while shutting down or after shutdown.');
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('shutdown uses only the cached endpoint and never launches or discovers', { timeout: 60000 }, async () => {
    const { root, dataDir } = fixture('desktop-gateway-shutdown-');
    const backends: RunningBackend[] = [];
    let launches = 0;
    let probes = 0;
    try {
        const backend = await startBackend({ dataDir, projectRoot: process.cwd() });
        backends.push(backend);
        const gateway = new BackendGateway({
            dataDir,
            launch: async () => { launches += 1; return endpointOf(backend); },
            discover: async () => { probes += 1; return endpointOf(backend); },
        });
        await gateway.ensure();
        assert.deepEqual(await gateway.shutdown(), { attempted: true, stopped: true });
        assert.equal(launches, 1);
        assert.equal(probes, 0);
        const idle = new BackendGateway({
            dataDir,
            launch: async () => { launches += 1; return endpointOf(backend); },
            discover: async () => { probes += 1; return endpointOf(backend); },
        });
        assert.deepEqual(await idle.shutdown(), { attempted: false, stopped: false });
        assert.equal(launches, 1, 'Shutdown must never start a backend.');
        assert.equal(probes, 0, 'Shutdown must never rediscover a backend.');
    }
    finally {
        await closeAll(backends);
        rmSync(root, { recursive: true, force: true });
    }
});

test('rejects unsupported routes and never launches a backend for a missing endpoint on POST or shutdown', { timeout: 30000 }, async () => {
    const { root, dataDir } = fixture('desktop-gateway-idle-');
    let launches = 0;
    try {
        const gateway = new BackendGateway({ dataDir, launch: async () => { launches += 1; return { port: 1, token: 'unused' }; } });
        await assert.rejects(gateway.request('GET', '/v2/tasks'), /Unsupported desktop backend route/);
        await assert.rejects(gateway.request('POST', '/v1/commands', { command: 'status' }), (error: unknown) => error instanceof BackendRequestError
            && /not connected/.test(error.message) && error.ambiguous === false);
        assert.equal(launches, 0, 'A POST that may already have been sent must never start or replay the backend.');
        assert.deepEqual(await gateway.shutdown(), { attempted: false, stopped: false });
        assert.equal(launches, 0, 'Shutdown must never start a backend.');
        assert.equal(await discoverLocalBackend(dataDir), undefined);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
