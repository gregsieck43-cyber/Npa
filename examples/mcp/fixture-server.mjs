// Original harmless MCP fixture: useful for trying the consuming MCP controls offline.
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of input) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'NPN harmless echo fixture', version: '1.0.0' } } });
  else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Return the supplied text; no external effects.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  else if (message.method === 'tools/call' && message.params?.name === 'echo') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(message.params.arguments?.text ?? '') }] } });
  else if (message.method === 'ping') send({ jsonrpc: '2.0', id: message.id, result: {} });
  else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method.' } });
}
