import { randomInt } from 'node:crypto';
import type { Server } from 'node:http';

/** Some machines allocate ephemeral ports inside Fetch's blocked range (for
 * example 6000/6667). Bind in the private high range without changing OS settings.
 * https://fetch.spec.whatwg.org/#port-blocking */
export async function listenLoopback(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const port = randomInt(49152, 65536);
    try {
      await new Promise<void>((resolve, reject) => {
        // Each attempt adds these two listeners and removes exactly these two:
        // the caller may listen on the same events, and a failed attempt must
        // not leave a 'listening' callback behind for later attempts.
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onListening = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          server.off('error', onError);
          server.off('listening', onListening);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        try {
          server.listen(port, '127.0.0.1');
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      return port;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Both codes are per-candidate failures, so the remaining bounded
      // candidates are still worth trying; anything else is not port-specific.
      if (code !== 'EACCES' && code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No free loopback port found after 16 attempts.');
}
