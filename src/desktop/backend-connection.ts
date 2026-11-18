import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The loopback endpoint and bearer token published in dataDir/backend.json. */
export interface BackendEndpoint {
    port: number;
    token: string;
}

export interface BackendGatewayOptions {
    /** Directory that contains backend.json and the desktop configuration. */
    dataDir: string;
    /** Starts or reuses the local backend; called by ensure() and by safe GET recovery. */
    launch: () => Promise<BackendEndpoint>;
    /** Read-only discovery used to recover a cached endpoint. Never starts a backend. */
    discover?: (dataDir: string) => Promise<BackendEndpoint | undefined>;
    fetchImpl?: typeof fetch;
}

/** A failed desktop backend call that keeps the method and the ambiguity fact visible. */
export class BackendRequestError extends Error {
    constructor(message: string, readonly method: string, readonly route: string,
        /** True when an effectful request may have reached the backend and was deliberately not replayed. */
        readonly ambiguous: boolean, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'BackendRequestError';
    }
}

function parseEndpoint(value: unknown): BackendEndpoint | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const port = record.port;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return undefined;
    const token = record.token;
    if (typeof token !== 'string' || !token || token.length > 4096) return undefined;
    return { port: port as number, token };
}

function sameEndpoint(left: BackendEndpoint | undefined, right: BackendEndpoint | undefined): boolean {
    return Boolean(left && right && left.port === right.port && left.token === right.token);
}

/**
 * Read the endpoint the running backend published and prove it still answers /health with that
 * token. A stale file, a stopped process or a token change all read as "no endpoint"; nothing is
 * started or killed here, so shutdown and POST discovery can never spawn a second backend.
 */
export async function discoverLocalBackend(dataDir: string, fetchImpl: typeof fetch = fetch, timeoutMs = 2000): Promise<BackendEndpoint | undefined> {
    const filename = path.join(dataDir, 'backend.json');
    if (!existsSync(filename)) return undefined;
    let endpoint: BackendEndpoint | undefined;
    try { endpoint = parseEndpoint(JSON.parse(readFileSync(filename, 'utf8'))); }
    catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
    if (!endpoint) return undefined;
    try {
        const response = await fetchImpl(`http://127.0.0.1:${endpoint.port}/health`, {
            headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
        });
        if (!response.ok) return undefined;
        const body = await response.json() as { status?: unknown };
        return body.status === 'ready' ? endpoint : undefined;
    }
    catch (error) { if (error instanceof TypeError || error instanceof DOMException) return undefined; throw error; }
}

interface BackendResponse { ok: boolean; status: number; data: unknown; }

/**
 * The desktop shell's connection to the local backend.
 *
 * GET requests are safe to repeat: a dead endpoint (including "the process exited and left a
 * stale backend.json") or a 401 (backend restarted, token changed) triggers one bounded recovery
 * and one retry. Recovery first reads backend.json and proves /health; when nothing answers it
 * reuses the existing launcher once. Recovery is single-flight, so a burst of concurrent GETs
 * performs one discovery and at most one launch.
 *
 * POST never launches and never replays: a transport failure may already have been applied, so it
 * is reported with the ambiguity marked, and an existing endpoint is only discovered read-only.
 *
 * Shutdown is a lifecycle barrier. It marks the gateway closing, waits for in-flight discovery,
 * recovery and launch attempts to settle, then stops exactly the endpoint that was reached. A
 * recovery that starts after closing refuses to launch or cache anything, so a late launch can
 * never write an endpoint back after the stopped backend was cleared.
 */
export class BackendGateway {
    private endpoint: BackendEndpoint | undefined;
    private discovering: Promise<BackendEndpoint | undefined> | undefined;
    private recovering: Promise<BackendEndpoint | undefined> | undefined;
    private ensuring: Promise<BackendEndpoint> | undefined;
    private closing = false;
    private readonly discover: (dataDir: string) => Promise<BackendEndpoint | undefined>;
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly options: BackendGatewayOptions) {
        this.discover = options.discover ?? (dataDir => discoverLocalBackend(dataDir));
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    /** The endpoint in use, for diagnostics; undefined means no usable endpoint is cached. */
    get current(): BackendEndpoint | undefined { return this.endpoint; }

    /** Start or reuse the backend through the existing launcher and cache its endpoint. */
    async ensure(): Promise<BackendEndpoint> {
        if (this.closing) throw new Error('The local backend is shutting down; it was not started again.');
        if (!this.ensuring) {
            this.ensuring = this.launch().finally(() => { this.ensuring = undefined; });
        }
        return await this.ensuring;
    }

    async request<T = Record<string, any>>(method: string, route: string, body?: unknown, timeoutMs = 65_000): Promise<T> {
        if (!/^\/(health|v1\/)/.test(route) || route.includes('://') || route.includes('\0') || route.length > 8192)
            throw new Error('Unsupported desktop backend route.');
        if (this.closing) throw new BackendRequestError(`The local backend is shutting down; ${method} ${route} was not sent.`, method, route, false);
        let endpoint = this.endpoint;
        if (!endpoint) {
            try { endpoint = method === 'GET' ? await this.recover(undefined) : await this.discoverOnly(); }
            catch (error) { throw new BackendRequestError(`The local backend could not be started; ${method} ${route} was not sent.`, method, route, false, error); }
            if (!endpoint) throw new BackendRequestError(`The local backend is not connected; ${method} ${route} was not sent.`, method, route, false);
        }
        let retried = false;
        let result: BackendResponse;
        try { result = await this.send(endpoint, method, route, body, timeoutMs); }
        catch (error) {
            this.invalidate(endpoint);
            if (method !== 'GET') throw this.transportError(method, route, error, true);
            retried = true;
            const recovered = await this.recover(endpoint);
            if (!recovered) throw this.transportError(method, route, error, false);
            try { result = await this.send(recovered, method, route, body, timeoutMs); }
            catch (retryError) { this.invalidate(recovered); throw this.transportError(method, route, retryError, false); }
        }
        if (result.ok) return result.data as T;
        if (result.status === 401) {
            this.invalidate(endpoint);
            if (method === 'GET' && !retried) {
                const recovered = await this.recover(endpoint);
                if (recovered) {
                    let retriedResult: BackendResponse;
                    try { retriedResult = await this.send(recovered, method, route, body, timeoutMs); }
                    catch (error) { this.invalidate(recovered); throw this.transportError(method, route, error, false); }
                    if (retriedResult.ok) return retriedResult.data as T;
                    return this.withStatus(retriedResult) as T;
                }
            }
        }
        return this.withStatus(result) as T;
    }

    /**
     * Ask the currently reachable backend to stop. The barrier waits for in-flight discovery,
     * recovery and launch first, so a backend started just before closing is stopped instead of
     * being leaked; after this resolves nothing can cache or restart an endpoint.
     */
    async shutdown(timeoutMs = 5000): Promise<{ attempted: boolean; stopped: boolean }> {
        this.closing = true;
        await Promise.allSettled([this.discovering, this.recovering, this.ensuring]);
        const endpoint = this.endpoint;
        this.endpoint = undefined;
        if (!endpoint) return { attempted: false, stopped: false };
        try {
            const result = await this.send(endpoint, 'POST', '/v1/shutdown', undefined, timeoutMs);
            return { attempted: true, stopped: result.ok };
        }
        catch { return { attempted: true, stopped: false }; }
    }

    private async launch(): Promise<BackendEndpoint> {
        const endpoint = parseEndpoint(await this.options.launch());
        if (!endpoint) throw new Error('The local backend returned an invalid endpoint.');
        // A shutdown may already be waiting on this launch; caching lets its barrier stop the
        // process instead of leaking it. After that barrier finishes, closing rejects new launches.
        this.endpoint = endpoint;
        return endpoint;
    }

    private invalidate(endpoint: BackendEndpoint): void {
        if (sameEndpoint(this.endpoint, endpoint)) this.endpoint = undefined;
    }

    /**
     * Single-flight read-only discovery, used before a POST and by safe GET recovery. It never
     * starts a backend and never caches after closing began.
     */
    private async discoverOnly(): Promise<BackendEndpoint | undefined> {
        if (!this.discovering) {
            this.discovering = this.discover(this.options.dataDir)
                .then(found => { if (found && !this.closing) this.endpoint = found; return found; })
                .finally(() => { this.discovering = undefined; });
        }
        return await this.discovering;
    }

    /**
     * Single-flight safe GET recovery: prove an existing backend, otherwise reuse the launcher
     * exactly once, then cache the endpoint. A recovery that begins after closing returns without
     * launching or caching; callers cannot start a backend behind the shutdown barrier.
     */
    private async recover(stale: BackendEndpoint | undefined): Promise<BackendEndpoint | undefined> {
        if (this.closing) return undefined;
        if (this.endpoint && !sameEndpoint(this.endpoint, stale)) return this.endpoint;
        if (!this.recovering) {
            this.recovering = this.recoverOnce(stale).finally(() => { this.recovering = undefined; });
        }
        return await this.recovering;
    }

    private async recoverOnce(stale: BackendEndpoint | undefined): Promise<BackendEndpoint | undefined> {
        if (this.endpoint && !sameEndpoint(this.endpoint, stale)) return this.endpoint;
        const found = await this.discover(this.options.dataDir);
        if (this.closing) return undefined;
        if (found) { this.endpoint = found; return found; }
        const endpoint = await this.ensure();
        return this.closing ? undefined : endpoint;
    }

    private withStatus(result: BackendResponse): unknown {
        const body = result.data !== null && typeof result.data === 'object' && !Array.isArray(result.data)
            ? result.data as Record<string, unknown>
            : { value: result.data };
        return { ...body, httpStatus: result.status };
    }

    private async send(endpoint: BackendEndpoint, method: string, route: string, body: unknown, timeoutMs: number): Promise<BackendResponse> {
        const response = await this.fetchImpl(`http://127.0.0.1:${endpoint.port}${route}`, {
            method,
            headers: {
                Authorization: `Bearer ${endpoint.token}`,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'error',
        });
        let data: unknown = {};
        try { data = await response.json(); }
        catch { if (response.ok) throw new Error(`The local backend returned a non-JSON response (HTTP ${response.status}).`); }
        return { ok: response.ok, status: response.status, data };
    }

    private transportError(method: string, route: string, cause: unknown, ambiguous: boolean): BackendRequestError {
        const detail = cause instanceof Error ? cause.message : String(cause);
        const suffix = ambiguous ? ' It may or may not have been applied and was not replayed.' : '';
        return new BackendRequestError(`The local backend ${method} ${route} failed: ${detail}${suffix}`, method, route, ambiguous, cause);
    }
}
