import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';

import { listenLoopback } from '../src/app/loopback.js';

type ListenFailure = 'EACCES' | 'EADDRINUSE' | 'EAFNOSUPPORT';

interface FixtureCall {
  port: number;
  host: string;
}

interface FixtureOptions {
  /** Per-attempt failure code; an undefined entry makes that attempt succeed. */
  failures?: (ListenFailure | undefined)[];
  /** 1-based attempt whose listen() throws synchronously instead of emitting. */
  throwOnAttempt?: number;
}

interface ListenerFixture {
  server: Server;
  calls: FixtureCall[];
  thrown: Error[];
}

/** EventEmitter stand-in for net.Server: records listen() calls and resolves them
 * asynchronously as the real server would, without touching the network. */
function listenerFixture(options: FixtureOptions = {}): ListenerFixture {
  const { failures = [], throwOnAttempt } = options;
  const server = new EventEmitter() as unknown as Server;
  const calls: FixtureCall[] = [];
  const thrown: Error[] = [];
  const listen = (port: number, host: string, callback?: () => void): Server => {
    calls.push({ port, host });
    if (calls.length === throwOnAttempt) {
      const error: NodeJS.ErrnoException = Object.assign(
        new Error('fixture synchronous listen throw'),
        { code: 'EINVAL', syscall: 'listen' },
      );
      thrown.push(error);
      throw error;
    }
    if (callback) server.once('listening', callback);
    const failure = failures[calls.length - 1];
    queueMicrotask(() => {
      if (failure === undefined) {
        server.emit('listening');
        return;
      }
      server.emit(
        'error',
        Object.assign(new Error(`fixture ${failure}`), { code: failure, syscall: 'listen' }),
      );
    });
    return server;
  };
  server.listen = listen as unknown as Server['listen'];
  return { server, calls, thrown };
}

function assertPrivateLoopbackCandidate(call: FixtureCall): void {
  assert.equal(call.host, '127.0.0.1');
  assert.ok(call.port >= 49152 && call.port <= 65535, `port ${call.port} outside 49152-65535`);
}

test('EACCES candidate is retried and the next candidate binds', async () => {
  const { server, calls } = listenerFixture({ failures: ['EACCES'] });

  const port = await listenLoopback(server);

  assert.equal(calls.length, 2);
  assert.equal(port, calls[1].port);
  calls.forEach(assertPrivateLoopbackCandidate);
  assert.equal(server.listenerCount('error'), 0);
  assert.equal(server.listenerCount('listening'), 0);
});

test('16 EADDRINUSE candidates reject at the bound and leave no listeners behind', async () => {
  const { server, calls } = listenerFixture({
    failures: Array<ListenFailure>(16).fill('EADDRINUSE'),
  });

  await assert.rejects(listenLoopback(server), /No free loopback port found after 16 attempts/);

  assert.equal(calls.length, 16);
  calls.forEach(assertPrivateLoopbackCandidate);
  assert.equal(server.listenerCount('error'), 0);
  assert.equal(server.listenerCount('listening'), 0);
});

test('an unrelated listen error propagates after exactly one attempt', async () => {
  const { server, calls } = listenerFixture({ failures: ['EAFNOSUPPORT'] });

  await assert.rejects(
    listenLoopback(server),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EAFNOSUPPORT',
  );

  assert.equal(calls.length, 1);
});

test('a synchronous listen throw rejects and removes only the attempt listeners', async () => {
  const { server, calls, thrown } = listenerFixture({ throwOnAttempt: 1 });
  const received: Error[] = [];
  server.on('error', (error: Error) => received.push(error));

  await assert.rejects(listenLoopback(server), (error: unknown) => error === thrown[0]);

  assert.equal(calls.length, 1);
  assert.equal(server.listenerCount('error'), 1);
  assert.equal(server.listenerCount('listening'), 0);
  const probe = new Error('caller listener probe');
  server.emit('error', probe);
  assert.deepEqual(received, [probe]);
});

test('caller listeners are preserved across a successful bind', async () => {
  const { server } = listenerFixture();
  const received: Error[] = [];
  let markerCalls = 0;
  server.on('error', (error: Error) => received.push(error));
  server.on('listening', () => {
    markerCalls += 1;
  });

  const port = await listenLoopback(server);

  assert.ok(port >= 49152 && port <= 65535);
  assert.equal(server.listenerCount('error'), 1);
  assert.equal(server.listenerCount('listening'), 1);
  assert.equal(markerCalls, 1);
  const probe = new Error('caller listener probe');
  server.emit('error', probe);
  assert.deepEqual(received, [probe]);
});

test('caller listeners are preserved when all candidates are exhausted', async () => {
  const { server } = listenerFixture({
    failures: Array<ListenFailure>(16).fill('EADDRINUSE'),
  });
  let markerCalls = 0;
  server.on('error', () => undefined);
  server.on('listening', () => {
    markerCalls += 1;
  });

  await assert.rejects(listenLoopback(server), /16 attempts/);

  assert.equal(server.listenerCount('error'), 1);
  assert.equal(server.listenerCount('listening'), 1);
  assert.equal(markerCalls, 0);
});

test('a real HTTP server binds a private loopback port, connects, closes and rebinds', async () => {
  const server = createServer((_request, response) => response.end('ok'));
  // node:http installs one internal 'listening' listener at construction; the
  // function must preserve that baseline and add nothing of its own.
  const baselineListening = server.listenerCount('listening');
  const baselineError = server.listenerCount('error');
  const port = await listenLoopback(server);

  assert.ok(port >= 49152 && port <= 65535);
  assert.equal(server.listening, true);
  assert.equal(server.listenerCount('error'), baselineError);
  assert.equal(server.listenerCount('listening'), baselineListening);
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  assert.equal(address.port, port);

  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
  assert.equal(server.listenerCount('error'), baselineError);
  assert.equal(server.listenerCount('listening'), baselineListening);

  const rebound = createServer();
  const reboundBaselineListening = rebound.listenerCount('listening');
  const reboundPort = await listenLoopback(rebound);
  assert.ok(reboundPort >= 49152 && reboundPort <= 65535);
  assert.equal(rebound.listening, true);
  await new Promise<void>((resolve, reject) => {
    rebound.close(error => (error ? reject(error) : resolve()));
  });
  assert.equal(rebound.listenerCount('error'), 0);
  assert.equal(rebound.listenerCount('listening'), reboundBaselineListening);
});
