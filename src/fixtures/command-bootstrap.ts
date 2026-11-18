import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';

// Trusted project script guard. Node 24 permissions do not themselves deny networking.
// Node lazily creates stdio using net.Socket; initialize those local handles first.
void process.stdout; void process.stderr; void process.stdin;
const denied = () => { throw new Error('NPN_NETWORK_DENIED: approved project commands have no network permission.'); };
for (const [module, names] of [
  [net, ['connect', 'createConnection', 'createServer', 'Socket', 'Server']],
  [http, ['request', 'get', 'createServer', 'Agent']], [https, ['request', 'get', 'createServer', 'Agent']],
  [http2, ['connect', 'createServer', 'createSecureServer']], [tls, ['connect', 'createServer', 'TLSSocket']],
  [dgram, ['createSocket']], [dns, ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']],
] as [object, string[]][]) {
  for (const name of names) (module as Record<string, unknown>)[name] = denied;
}
syncBuiltinESMExports();
globalThis.fetch = async () => denied();
Object.defineProperty(globalThis, 'WebSocket', { value: denied, writable: false, configurable: false });
