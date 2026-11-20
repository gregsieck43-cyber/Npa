import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceRoots } from '../src/app/workspace-roots.js';
import { createOfficeFile } from '../src/desktop/office-files.js';
import { officeText } from '../src/product/office-input.js';
import { ModelClient, DEFAULT_PROVIDER } from '../src/runtime/model.js';
import { wireSettings, wireBody, authHeaders, endpoint } from '../src/runtime/provider-wire.js';
import { discoverModels } from '../src/runtime/model-directory.js';
import type { WireSettings } from '../src/provider-types.js';

test('project editing commits all roots together and retains identity across restart', () => {
  const base = mkdtempSync(path.resolve('.tmp','project-076-'));
  try {
    const a = path.join(base, 'a'), b = path.join(base, 'b');
    mkdirSync(a); mkdirSync(b);
    const registry = new WorkspaceRoots(base), original = registry.add(a);
    registry.edit(original.id, '材料', [b,a]);
    const reopened = new WorkspaceRoots(base);
    assert.equal(reopened.get(original.id)?.name, '材料');
    assert.equal(reopened.resolve(original.id), b);
    assert.ok(reopened.contains(path.join(a,'note.txt')));
    assert.throws(() => reopened.edit(original.id, 'wrong', [a,a]));
    assert.equal(reopened.resolve(original.id), b);
    reopened.remove(original.id);
    assert.equal(reopened.contains(a), false);
    assert.equal(reopened.contains(b), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

for (const format of ['docx','xlsx','pptx'] as const) test('office output can be opened as an input document: ' + format, async () => {
  const content = '# 周报\n本周交付\n|项目|数量|\n|---|---|\n|访谈|12|';
  const bytes = await createOfficeFile(format, content);
  const extracted = officeText('result.' + format, bytes);
  assert.match(extracted, /访谈/); assert.match(extracted, /12/);
});

for (const format of ['messages','responses','chat'] as const) test('ModelClient dispatch and incremental completion: ' + format, async t => {
  const sent: any[] = [];
  const frames = format === 'messages' ? [{type:'content_block_delta', index:0, delta:{type:'text_delta',text:'hello'}}, {type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}] :
    format === 'responses' ? [{type:'response.output_text.delta', delta:'hello'}, {type:'response.completed', response:{status:'completed',output:[]}}] :
    [{choices:[{delta:{content:'hello'},finish_reason:'stop'}]}];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)), headers: init.headers });
    const events = frames.map(frame => 'data: '+JSON.stringify(frame)+'\n\n').join('') + (format === 'chat' ? 'data: [DONE]\n\n' : '');
    return new Response(events,{headers:{'content-type':'text/event-stream'}});
  });
  const client = new ModelClient({...DEFAULT_PROVIDER,baseUrl:'https://fixture.invalid/v1',wire:{format}}, () => 'fixture-token');
  const chunks: string[] = [];
  const result = await client.complete([{role:'user',content:'draft'}],[],undefined,d => { if (d.content) chunks.push(d.content); });
  assert.equal(result.content,'hello'); assert.deepEqual(chunks,['hello']); assert.equal(sent.length,1);
  assert.equal(sent[0].url,'https://fixture.invalid/v1/'+({chat:'chat/completions',messages:'messages',responses:'responses'}[format]));
  assert.equal((sent[0].body.input ?? sent[0].body.messages)[0].content,'draft');
  assert.equal(format === 'messages' ? sent[0].headers['x-api-key'] : sent[0].headers.Authorization, format === 'messages' ? 'fixture-token' : 'Bearer fixture-token');
});

test('custom protocol maps endpoint, auth, request, full reply and tool calls', async t => {
  const wire: WireSettings = wireSettings({format:'custom',protocol:'chat',path:'infer',authHeader:'x-token',requestFields:{model:'engine.id'},responseFields:{content:'output.text',tool_calls:'output.tools',finish_reason:'stop'},toolFields:{id:'uid',name:'op',arguments:'params'}});
  assert.equal(endpoint({...DEFAULT_PROVIDER,wire}).pathname,'/provider/v1/infer');
  assert.deepEqual(authHeaders(wire,'test'),{'x-token':'test'});
  assert.deepEqual(wireBody({model:'abc'},wire),{engine:{id:'abc'}});
  t.mock.method(globalThis,'fetch',async () => Response.json({output:{text:'',tools:[{uid:'c1',op:'lookup',params:{id:4}}]},stop:'tool_calls'}));
  const client = new ModelClient({...DEFAULT_PROVIDER,wire},() => 'test');
  const result = await client.complete([{role:'user',content:'find'}]);
  assert.equal(result.toolCalls[0].name,'lookup');
  assert.deepEqual(result.toolCalls[0].arguments,{id:4});
  assert.throws(() => wireSettings({format:'custom',path:'//other.example'}));
});

test('model discovery follows same-endpoint pagination, leaves unknown limits blank',async t => {
  const urls: URL[] = [];
  t.mock.method(globalThis,'fetch',async (url: URL) => {
    urls.push(url);
    return Response.json(urls.length === 1 ? {data:[{id:'first',context_length:12000}],last_id:'first',has_more:true} : {data:[{id:'second'}]});
  });
  const rows = await discoverModels('https://fixture.invalid',{format:'messages'});
  assert.equal(urls[1].searchParams.get('after_id'),'first');
  assert.equal(rows[0].contextWindow,12000); assert.equal(rows[1].contextWindow,undefined);
});
