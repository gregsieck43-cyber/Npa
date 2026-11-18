import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ToolCall } from '../src/contracts.js';
import { startBackend } from '../src/app/backend.js';
import { resourceBudget } from '../src/app/resource-budget.js';
import type { MockCompletion, MockProviderOptions } from '../src/fixtures/mock-provider.js';
import { TOOL_DEFINITIONS } from '../src/runtime/prompts.js';
import { COORDINATION_TOOLS } from '../src/runtime/coordination-tools.js';
import { EXTERNAL_TOOL_DEFINITIONS } from '../src/app/external-tools.js';
import { COLLABORATION_TOOL_DEFINITIONS } from '../src/integrations/index.js';
import { DSH_COMPATIBLE_VERSION, type PluginView } from '../src/extensions/plugins.js';
import { MCP_PROTOCOL_VERSION } from '../src/extensions/mcp.js';
import { assertInsideProject, assertProjectFixtureRoot } from './project-boundary.js';

type Backend = Awaited<ReturnType<typeof startBackend>>;

async function fixture(t: TestContext, mockOptions: MockProviderOptions) {
  const tempRoot = path.resolve('.tmp');
  assertProjectFixtureRoot(tempRoot);
  mkdirSync(tempRoot, { recursive: true });
  const owned = mkdtempSync(path.join(tempRoot, 'model-wire-'));
  let backend: Backend | undefined;
  t.after(async () => {
    if (backend) await backend.close();
    assert.ok(path.relative(tempRoot, owned).startsWith('model-wire-'));
    rmSync(owned, { recursive: true, force: true });
  });
  backend = await startBackend({ dataDir: path.join(owned, 'data'), projectRoot: path.resolve('.'), mockOptions });
  const command = (taskId: string, type: string, parameters?: Record<string, unknown>) =>
    backend!.services.command({ commandId: randomUUID(), taskId, type, parameters });
  const waitFor = async (taskId: string, status: string, until?: (snapshot: ReturnType<Backend['services']['snapshot']>) => boolean) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const snapshot = backend!.services.snapshot(taskId);
      if (snapshot.selectedTask?.status === status && (!until || until(snapshot))) return snapshot;
      assert.notEqual(snapshot.selectedTask?.status, 'failed', snapshot.selectedTask?.error);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const snapshot = backend!.services.snapshot(taskId), task = snapshot.selectedTask!;
    assert.fail(`Expected ${status}; observed ${task.status}: ${task.error ?? task.waitingReason ?? ''}; latest verification: ${JSON.stringify(snapshot.verifications.at(-1))}; diagnostics: ${JSON.stringify({ deadlineOverrunMs: Date.now() - deadline, resource: resourceBudget.status(), events: snapshot.events.slice(-8).map(event => ({type:event.type, at:event.createdAt})) })}`);
  };
  return { owned, backend, command, waitFor };
}

function proposal(id: string, name: string, args: ToolCall['arguments']): MockCompletion {
  return { content: '', toolCalls: [{ id, name, arguments: args }] };
}
function hasResult(body: any, id: string): boolean {
  return body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === id);
}
function systemText(body: any): string {
  return body.messages.find((message: any) => message.role === 'system')?.content ?? '';
}

test('HTTP model responses coordinate a child and send actual main, side, worker, reviewer and skill contexts', { timeout: 45_000 }, async t => {
  const trace: any[] = [];
  const childContent = 'Child evidence from a scripted HTTP response: 中文🙂.\n';
  const parentContent = 'Parent evidence after accepting the verified child.\n';
  const finalResult = 'Final result supplied by the model finish tool.';
  const f = await fixture(t, {
    trace: body => trace.push(body),
    responder: body => {
      const system = systemText(body);
      if (system.includes('REVIEWER ROLE')) return { content: JSON.stringify({ verdict: 'pass', reason: 'The supplied independent receipts and artifacts satisfy the goal.' }) };
      if (system.includes('SIDE ROLE')) return { content: 'Read-only side advice; main task ownership remains unchanged.' };
      if (system.includes('WORKER ROLE')) {
        return hasResult(body, 'wire-child-write') ? { content: 'Child result backed by its actual write receipt.' }
          : proposal('wire-child-write', 'write_file', { path: 'child-wire.txt', content: childContent });
      }
      if (!hasResult(body, 'wire-delegate')) return proposal('wire-delegate', 'delegate', {
        title: 'Wire child', objective: 'Write child-wire.txt with exact scripted evidence. Use $wire-skill.',
        acceptance: ['file:child-wire.txt', 'contains:child-wire.txt:Child evidence'],
      });
      if (!hasResult(body, 'wire-list')) return proposal('wire-list', 'list_delegations', {});
      if (!hasResult(body, 'wire-wait')) return proposal('wire-wait', 'wait_for_children', {});
      if (!hasResult(body, 'wire-accept')) {
        const delegated = JSON.parse(body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'wire-delegate').content);
        return proposal('wire-accept', 'accept_child_result', { childTaskId: delegated.items[0].childTaskId, evidence: 'Reviewed the completed child artifact and its passing independent verification.' });
      }
      if (!hasResult(body, 'wire-parent-write')) return proposal('wire-parent-write', 'write_file', { path: 'nested/parent-wire.txt', content: parentContent });
      const firstWrite = body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'wire-parent-write');
      if (firstWrite.content.includes('No effect was executed') && !hasResult(body, 'wire-parent-write-after-scope')) {
        return proposal('wire-parent-write-after-scope', 'write_file', { path: 'nested/parent-wire.txt', content: parentContent });
      }
      return proposal('wire-finish', 'finish', { result: finalResult });
    },
  });
  const globalPath = path.join(f.owned, 'global.md');
  const skillRoot = path.join(f.owned, 'skills');
  mkdirSync(path.join(skillRoot, 'wire-skill'), { recursive: true });
  mkdirSync(path.join(skillRoot, 'late-skill'), { recursive: true });
  writeFileSync(globalPath, 'Wire global directive: retain independent source evidence.');
  writeFileSync(path.join(skillRoot, 'wire-skill', 'SKILL.md'), '---\nname: wire-skill\ndescription: scripted evidence verification\n---\nWire skill directive: preserve exact Unicode artifact bytes.');
  writeFileSync(path.join(skillRoot, 'late-skill', 'SKILL.md'), '---\nname: late-skill\ndescription: astronomy calibration\n---\nLatest message skill directive: bind exact bytes to the receipt.');
  f.backend.services.configure({ mode: 'mock', globalPaths: [globalPath], skillRoots: [skillRoot], maxOutputTokens: 512, maxRequestBytes: 131_072 });
  const created = f.backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: 'Wire parent', goal: {
    objective: 'Coordinate a verified child and write nested/parent-wire.txt. Use $wire-skill.', constraints: ['Approval is required for every write'],
    acceptance: ['file:nested/parent-wire.txt', 'contains:nested/parent-wire.txt:Parent evidence'], maxModelCalls: 32, mode: 'autonomous',
  } } });
  const taskId = created.taskId!;
  f.command(taskId, 'pause');
  const workspace = f.backend.services.task(taskId).workspace;
  writeFileSync(path.join(workspace, 'AGENTS.md'), 'Wire project directive: coordinate scoped child ownership.');
  mkdirSync(path.join(workspace, 'nested'));
  const nestedInstructions = path.join(workspace, 'nested', 'AGENTS.md');
  writeFileSync(nestedInstructions, 'Nested wire directive: preserve the parent artifact with its exact approved bytes.');
  f.command(taskId, 'send_message', { content: 'Use $late-skill when preserving nested/parent-wire.txt.' });
  const beforeSide = f.backend.services.task(taskId);
  const side = await f.backend.services.sidechat({ taskId, sessionId: 'wire-side', message: 'Explain this saved goal with $wire-skill.' });
  assert.match(side.content, /Read-only side advice/);
  assert.equal(f.backend.services.task(taskId).status, beforeSide.status);
  assert.deepEqual(f.backend.services.task(taskId).goal, beforeSide.goal);
  f.command(taskId, 'resume');
  await f.waitFor(taskId, 'waiting_children');
  const childId = f.backend.services.kernel.delegations(taskId)[0]!.childTaskId;
  const childWaiting = await f.waitFor(childId, 'waiting_approval');
  f.command(childId, 'grant', { intentId: childWaiting.intents.find(intent => intent.name === 'write_file')!.id });
  await f.waitFor(childId, 'completed');
  const parentWaiting = await f.waitFor(taskId, 'waiting_approval');
  assert.equal(f.backend.services.kernel.delegations(taskId)[0]!.state, 'accepted', 'The model must accept the independently verified child, without an operator acceptance command');
  assert.equal(existsSync(path.join(workspace, 'nested/parent-wire.txt')), false, 'Scoped instruction admission and an unapproved proposal must not execute the write');
  assert.match(parentWaiting.messages.find(message => message.toolCallId === 'wire-parent-write')!.content, /No effect was executed/);
  f.command(taskId, 'grant', { intentId: parentWaiting.intents.find(intent => intent.name === 'write_file')!.id });
  const completed = await f.waitFor(taskId, 'completed');
  assert.equal(completed.selectedTask!.result, finalResult, 'finish.result must reach acceptance without another model completion');
  assert.equal(readFileSync(path.join(completed.selectedTask!.workspace, 'nested/parent-wire.txt'), 'utf8'), parentContent);
  assert.equal(readFileSync(path.join(f.backend.services.task(childId).workspace, 'child-wire.txt'), 'utf8'), childContent);
  const coreNames = [...TOOL_DEFINITIONS, ...COORDINATION_TOOLS, ...EXTERNAL_TOOL_DEFINITIONS, ...COLLABORATION_TOOL_DEFINITIONS].map(tool => tool.function.name).sort();
  for (const role of ['MAIN ROLE', 'SIDE ROLE', 'WORKER ROLE', 'REVIEWER ROLE']) {
    assert.ok(trace.some(body => systemText(body).includes(role)), `${role} must reach the actual HTTP provider`);
  }
  for (const body of trace.filter(body => /MAIN ROLE|SIDE ROLE|WORKER ROLE/.test(systemText(body)))) {
    assert.match(systemText(body), /Wire global directive: retain independent source evidence/);
    assert.match(systemText(body), /Wire skill directive: preserve exact Unicode artifact bytes/);
    assert.equal(body.max_tokens, 512);
    assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') <= 131_072);
    if (systemText(body).includes('SIDE ROLE')) assert.equal(body.tools, undefined);
    else assert.deepEqual(body.tools.map((tool: any) => tool.function.name).sort(), coreNames);
  }
  const workerRequest = trace.find(body => systemText(body).includes('WORKER ROLE'));
  assert.match(systemText(workerRequest), /child-wire\.txt/);
  assert.ok(trace.filter(body => systemText(body).includes('MAIN ROLE')).every(body => systemText(body).includes('Latest message skill directive: bind exact bytes to the receipt')),
    'A skill named only in a later main message must reach subsequent model requests');
  assert.ok(trace.some(body => body.messages.some((message: any) => message.content?.includes('Nested wire directive: preserve the parent artifact'))),
    'The nearer target directory instructions must reach the actual HTTP request');
  assert.ok(completed.events.some(event => event.type === 'instruction.scope.loaded' && JSON.stringify(event.payload).includes(JSON.stringify(nestedInstructions).slice(1, -1))),
    'Runtime target instruction admission must retain its source provenance');
  const parentDecisions = f.backend.services.kernel.getDecisions(taskId);
  assert.ok(parentDecisions.some(decision => (decision.record.instructionSources as { kind: string }[]).some(source => source.kind === 'skill')));
  const parentRoleRequests = trace.filter(body => systemText(body).includes('MAIN ROLE'));
  assert.equal(parentRoleRequests.filter(body => hasResult(body, 'wire-parent-write-after-scope')).length, 1, 'The explicit finish proposal must not trigger another main model call');
});

test('a collaborative HTTP model question pauses the task and the user answer resumes the same wire history', { timeout: 35_000 }, async t => {
  const trace: any[] = [];
  const f = await fixture(t, {
    trace: body => trace.push(body),
    responder: body => {
      if (systemText(body).includes('REVIEWER ROLE')) return { content: JSON.stringify({ verdict: 'pass', reason: 'The independent write is present.' }) };
      if (!hasResult(body, 'wire-question')) return proposal('wire-question', 'ask_user', { question: 'Use plain text or Markdown for the artifact?', reason: 'choice' });
      if (!hasResult(body, 'wire-choice-write')) return proposal('wire-choice-write', 'write_file', { path: 'choice-wire.txt', content: 'Plain text selected by the user.\n' });
      return { content: 'The user-selected artifact is ready for verification.' };
    },
  });
  const created = f.backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { goal: {
    objective: 'Clarify the format, then write choice-wire.txt.', constraints: [], acceptance: ['file:choice-wire.txt'], maxModelCalls: 8, mode: 'collaborative',
  } } });
  const taskId = created.taskId!;
  const waiting = await f.waitFor(taskId, 'waiting_input');
  assert.equal(waiting.selectedTask!.waitingReason, 'Use plain text or Markdown for the artifact?');
  assert.equal(waiting.events.filter(event => event.type === 'question.asked').length, 1);
  f.command(taskId, 'answer', { content: 'Use plain text.' });
  const approval = await f.waitFor(taskId, 'waiting_approval');
  f.command(taskId, 'grant', { intentId: approval.intents[0]!.id });
  await f.waitFor(taskId, 'completed');
  assert.ok(trace.some(body => body.messages.some((message: any) => message.role === 'user' && message.content === 'Use plain text.')));
  assert.ok(trace.filter(body => systemText(body).includes('MAIN ROLE')).every(body => systemText(body).includes('COLLABORATIVE MODE')));
});

test('HTTP model discovers and executes an approved original DSH plugin and MCP tool', { timeout: 35_000 }, async t => {
  assertInsideProject(process.execPath, 'Run subprocess fixtures with the project Node runtime');
  const trace: any[] = [], input = '  Wire plugin 中文🙂  ', transformed = 'WIRE: Wire plugin 中文🙂';
  const f = await fixture(t, {
    trace: body => trace.push(body),
    responder: body => {
      if (systemText(body).includes('REVIEWER ROLE')) return { content: JSON.stringify({ verdict: 'pass', reason: 'Independent MCP and file receipts are present.' }) };
      if (!hasResult(body, 'wire-plugins')) return proposal('wire-plugins', 'list_plugins', {});
      if (!hasResult(body, 'wire-transform')) return proposal('wire-transform', 'plugin_transform', { pluginId: 'wire-dsh', operationId: 'wire_prefix', input });
      if (!hasResult(body, 'wire-mcp-catalog')) return proposal('wire-mcp-catalog', 'list_mcp_tools', { serverId: 'wire-mcp' });
      const catalog = JSON.parse(body.messages.find((message: any) => message.tool_call_id === 'wire-mcp-catalog').content);
      if (!hasResult(body, 'wire-mcp-schema')) return proposal('wire-mcp-schema', 'list_mcp_tools', { serverId: catalog.serverId, toolName: catalog.tools[0].name });
      const definition = JSON.parse(body.messages.find((message: any) => message.tool_call_id === 'wire-mcp-schema').content);
      const text = JSON.parse(body.messages.find((message: any) => message.tool_call_id === 'wire-transform').content).output;
      if (!hasResult(body, 'wire-mcp-call')) return proposal('wire-mcp-call', 'mcp_call', { serverId: definition.serverId, toolName: definition.tool.name, arguments: { text } });
      if (!hasResult(body, 'wire-extension-write')) return proposal('wire-extension-write', 'write_file', { path: 'extensions-wire.txt', content: `${text}\n` });
      return proposal('wire-extensions-finish', 'finish', { result: 'Model used the discovered approved plugin and MCP tool.' });
    },
  });
  const pluginPath = path.join(f.owned, 'original-plugin');
  mkdirSync(pluginPath);
  writeFileSync(path.join(pluginPath, 'package.json'), JSON.stringify({
    name: 'wire-dsh', version: '1.0.0', type: 'module', main: 'index.js',
    engines: { dsh: DSH_COMPATIBLE_VERSION }, dsh: { manifestVersion: 1 },
  }));
  writeFileSync(path.join(pluginPath, 'index.js'), `
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'wire-dsh';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'wire_prefix', description: 'Prefix original fixture text.',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }]; } },
    async execute(args) { return 'WIRE: ' + args.text.trim(); },
  }));
}
`);
  const installed = await f.backend.services.plugin('install', { path: pluginPath }) as PluginView;
  assert.equal(installed.enabled, false);
  await f.backend.services.plugin('approve', { id: installed.id, digest: installed.digest });
  const enabled = await f.backend.services.plugin('enable', { id: installed.id }) as PluginView;
  assert.equal(enabled.enabled, true);
  const serverPath = path.join(f.owned, 'original-server.mjs'), callsPath = path.join(f.owned, 'calls.txt');
  writeFileSync(serverPath, `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  if (request.method === 'initialize') return reply({ protocolVersion: '${MCP_PROTOCOL_VERSION}', capabilities: { tools: {} }, serverInfo: { name: 'wire-mcp', version: '1.0.0' } });
  if (request.method === 'tools/list') return reply({ tools: [{ name: 'echo', description: 'Echo original fixture text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
  if (request.method === 'tools/call') {
    writeFileSync('calls.txt', JSON.stringify(request.params.arguments));
    return reply({ content: [{ type: 'text', text: request.params.arguments.text }] });
  }
});
`);
  const runtime = path.join(f.owned, 'node.exe');
  linkSync(process.execPath, runtime);
  const server = { id: 'wire-mcp', name: 'Original wire fixture', command: runtime, args: [serverPath], cwd: f.owned };
  const launch = await f.backend.services.external.connect(server);
  assert.equal(launch.status, 'approval_required');
  assert.equal((await f.backend.services.external.connect({ ...server, approvedDigest: launch.digest })).status, 'connected');
  const created = f.backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { goal: {
    objective: 'Discover the approved wire-dsh plugin, transform the supplied text, echo it using wire-mcp, then save extensions-wire.txt.',
    constraints: ['MCP effects and file writes require exact approval'], acceptance: ['file:extensions-wire.txt', `contains:extensions-wire.txt:${transformed}`],
    maxModelCalls: 12, mode: 'autonomous',
  } } });
  const taskId = created.taskId!;
  const mcpApproval = await f.waitFor(taskId, 'waiting_approval', snapshot => snapshot.intents.some(intent => intent.name === 'mcp_call' && intent.state === 'prepared'));
  assert.equal(existsSync(callsPath), false, 'Model discovery must not execute the MCP call before its independent approval');
  const toolResult = (id: string) => f.backend.services.snapshot(taskId).messages.find(message => message.toolCallId === id)!.content;
  assert.equal(JSON.parse(toolResult('wire-transform')).output, transformed, 'The async DSH output must enter the model wire, rather than a Promise placeholder');
  assert.equal(JSON.parse(toolResult('wire-plugins'))[0].id, 'wire-dsh');
  assert.equal(JSON.parse(toolResult('wire-mcp-catalog')).tools[0].name, 'echo');
  assert.equal('inputSchema' in JSON.parse(toolResult('wire-mcp-catalog')).tools[0], false, 'name discovery does not inline schema');
  assert.deepEqual(JSON.parse(toolResult('wire-mcp-schema')).tool.inputSchema, { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] });
  f.command(taskId, 'grant', { intentId: mcpApproval.intents.find(intent => intent.name === 'mcp_call')!.id });
  const writeApproval = await f.waitFor(taskId, 'waiting_approval', snapshot => snapshot.intents.some(intent => intent.name === 'write_file' && intent.state === 'prepared'));
  assert.equal(JSON.parse(readFileSync(callsPath, 'utf8')).text, transformed);
  assert.equal(existsSync(path.join(writeApproval.selectedTask!.workspace, 'extensions-wire.txt')), false);
  f.command(taskId, 'grant', { intentId: writeApproval.intents.find(intent => intent.name === 'write_file')!.id });
  const completed = await f.waitFor(taskId, 'completed');
  assert.equal(readFileSync(path.join(completed.selectedTask!.workspace, 'extensions-wire.txt'), 'utf8'), `${transformed}\n`);
  assert.equal(completed.intents.filter(intent => intent.state === 'applied').length, 2);
  assert.ok(trace.some(body => body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'wire-transform' && JSON.parse(message.content).output === transformed)));
  assert.ok(trace.some(body => body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'wire-mcp-schema' && JSON.parse(message.content).tool.name === 'echo')));
  assert.ok(trace.some(body => body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'wire-mcp-call' && message.content.includes(transformed))));
});
