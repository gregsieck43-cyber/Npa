import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { McpClient, McpClientError, mcpServerDigest, type McpServerConfig, type McpDiagnostic } from '../src/extensions/mcp-client.js';

const fixtureServer = `import {createInterface} from 'node:readline';
const rl=createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
rl.on('line',line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'original-fixture',version:'1.0.0'}}});
 if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo',inputSchema:{type:'object'}},{name:'env',inputSchema:{type:'object'}},{name:'wait',inputSchema:{type:'object'}},{name:'disconnect',inputSchema:{type:'object'}},{name:'garbage',inputSchema:{type:'object'}}]}});
 if(m.method==='tools/call'){
  if(m.params.name==='wait')return;
  if(m.params.name==='disconnect')return process.exit(7);
  if(m.params.name==='garbage')return process.stdout.write('unexpected stdout log\\n');
  const content=m.params.name==='env'?JSON.stringify({TEMP:process.env.TEMP,TMP:process.env.TMP,USERPROFILE:process.env.USERPROFILE,npm_config_cache:process.env.npm_config_cache,fixtureSecret:process.env.NPN_FIXTURE_SECRET??null}):JSON.stringify(m.params.arguments);
  return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:content}]}});
 }
 send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported'}});
});`;
function fixture(): { directory: string; config: McpServerConfig } {
  const root = resolve('.tmp'); mkdirSync(root, { recursive: true }); const directory = mkdtempSync(join(root, 'extensions-mcp-client-'));
  const script = join(directory, 'server.mjs'); writeFileSync(script, fixtureServer);
  return { directory, config: { id: 'fixture', name: 'Original harmless MCP fixture', command: process.execPath, args: [script, '--data-dir', directory], cwd: directory } };
}
function clean(directory: string): void { assert.ok(directory.startsWith(resolve('.tmp') + sep)); rmSync(directory, { recursive: true, force: true }); }
function clientFor(config: McpServerConfig, directory: string, diagnostics: McpDiagnostic[] = []): McpClient { return new McpClient(config, { dataDir: join(directory, 'data'), projectRoot: resolve('.'), approvedDigest: mcpServerDigest(config), timeoutMs: 1500, onDiagnostic: event => diagnostics.push(event) }); }
test('MCP client initializes a real approved child, lists tools, calls safely and isolates its environment to F', async () => {
  const { directory, config } = fixture(); const client = clientFor(config, directory); const previousSecret = process.env.NPN_FIXTURE_SECRET; process.env.NPN_FIXTURE_SECRET = 'do-not-inherit-fixture';
  try {
    const connection = await client.connect(); assert.equal(connection.serverInfo.name, 'original-fixture'); assert.equal(connection.tools.length, 5);
    const result = await client.callTool('echo', { text: 'hello' }); assert.equal(result.content[0]!.text, '{"text":"hello"}');
    const env = JSON.parse((await client.callTool('env', {})).content[0]!.text as string);
    assert.equal(env.fixtureSecret, null); assert.ok([env.TEMP, env.TMP, env.USERPROFILE, env.npm_config_cache].every(path => String(path).startsWith(directory + sep)));
  } finally { if (previousSecret === undefined) delete process.env.NPN_FIXTURE_SECRET; else process.env.NPN_FIXTURE_SECRET = previousSecret; await client.disconnect(); clean(directory); }
});
test('MCP client never starts an unapproved or changed launch artifact', async () => {
  const { directory, config } = fixture();
  try {
    const denied = new McpClient(config, { dataDir: join(directory, 'data'), approvedDigest: 'wrong', projectRoot: resolve('.') });
    await assert.rejects(denied.connect(), (error: unknown) => error instanceof McpClientError && error.kind === 'approval' && error.effect === 'none');
    const digest = mcpServerDigest(config); writeFileSync(config.args[0]!, `${readFileSync(config.args[0]!, 'utf8')}\n// artifact changed\n`);
    const changed = new McpClient(config, { dataDir: join(directory, 'data'), approvedDigest: digest, projectRoot: resolve('.') });
    await assert.rejects(changed.connect(), (error: unknown) => error instanceof McpClientError && error.kind === 'approval');
    assert.throws(() => mcpServerDigest({ ...config, cwd: 'C:\\blocked-user-directory' }), /inside/);
  } finally { clean(directory); }
});
test('MCP timeout, cancel, disconnection and stdout corruption mark dispatched effects UNKNOWN without replay', async () => {
  for (const scenario of ['timeout', 'cancel', 'disconnect', 'garbage'] as const) {
    const { directory, config } = fixture(); const diagnostics: McpDiagnostic[] = []; const client = clientFor(config, directory, diagnostics);
    try {
      await client.connect();
      let requestCount = 0; const abort = new AbortController();
      const result = client.callTool(scenario === 'timeout' || scenario === 'cancel' ? 'wait' : scenario, {}, { signal: abort.signal, timeoutMs: 30, onRequest: () => { requestCount++; if (scenario === 'cancel') abort.abort(); } });
      await assert.rejects(result, (error: unknown) => error instanceof McpClientError && error.effect === 'unknown' && error.kind === (scenario === 'timeout' ? 'timeout' : scenario === 'cancel' ? 'cancelled' : scenario === 'disconnect' ? 'transport' : 'protocol'));
      assert.equal(requestCount, 1);
      if (scenario === 'garbage') assert.ok(diagnostics.some(event => event.kind === 'protocol' && /stdout/.test(event.message)));
    } finally { await client.disconnect(); clean(directory); }
  }
});
