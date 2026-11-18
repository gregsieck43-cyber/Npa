import { createContext, Script } from 'node:vm';

const prelude = `(() => {
  for (const name of ['console','process','Buffer','require','module','fetch','WebSocket','Date','Intl','setTimeout','setInterval','setImmediate','queueMicrotask']) {
    Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});
  }
  Object.defineProperty(Math,'random',{value:()=>{throw new Error('randomness unavailable');},writable:false,configurable:false});
})()`;

function transform(source: string, input: string): string {
  // No host values or callbacks enter the realm. A separate realm for every call removes retained state.
  const realm = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  new Script(prelude).runInContext(realm, { timeout: 50 });
  const output: unknown = new Script(`"use strict"; (${source})(${JSON.stringify(input)});`, { filename: 'task-local-transform' }).runInContext(realm, { timeout: 50 });
  if (typeof output !== 'string' || output.length > 65536) throw new Error('Invalid text result');
  return output;
}

process.stdin.setEncoding('utf8');
try {
  if (!process.permission || ['fs.read', 'fs.write', 'child', 'worker', 'addons'].some(scope => process.permission.has(scope))) {
    throw new Error('Task module worker requires its restricted launcher.');
  }
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 2_097_152) throw new Error('Input bound'); }
  const request = JSON.parse(input) as { source: string; inputs: string[] };
  if (typeof request.source !== 'string' || request.source.length > 8192 || !Array.isArray(request.inputs) ||
      request.inputs.length < 1 || request.inputs.length > 16 || request.inputs.some(value => typeof value !== 'string' || value.length > 65536)) throw new Error('Invalid input');
  const outputs = request.inputs.map(value => transform(request.source, value));
  process.stdout.write(JSON.stringify({ ok: true, outputs }));
} catch {
  // Avoid reading properties/getters of an exception created by candidate code.
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'MODULE_EXECUTION', message: 'Task module failed or exceeded its VM bound; no transformed output was applied.' } }));
}
