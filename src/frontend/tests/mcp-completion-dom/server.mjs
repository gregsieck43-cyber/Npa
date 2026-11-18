import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
// This deliberately has no network, model or user-file tools. Its process lifecycle is observable.
appendFileSync('starts.jsonl', JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
const beat = setInterval(() => writeFileSync('heartbeat.txt', String(Date.now())), 40);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const tools = Array.from({ length: 42 }, (_, index) => ({
  name: `fixture_${String(index).padStart(2, '0')}`,
  description: `Actual fixture description ${index}`,
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: `Query ${index}` } } },
  annotations: { readOnlyHint: true, ...(index === 41 ? { destructiveHint: true } : {}) },
}));
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
  if (request.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mcp-dom-fixture', version: '1' } });
  if (request.method === 'tools/list') return reply({ tools });
  if (request.method === 'tools/call') {
    appendFileSync('calls.jsonl', JSON.stringify(request.params) + '\n');
    return reply({ content: [{ type: 'text', text: 'Unexpected call recorded for the test to reject.' }] });
  }
  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported fixture method' } });
}).on('close', () => { clearInterval(beat); process.exit(0); });
