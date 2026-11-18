import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { _electron } from 'playwright';

// An explicit renderer fixture. It is not the real API or packaged desktop acceptance.
// Generated files are owned by this test under the caller-selected project .tmp directory.
test('Chat and six-page Inspector retain drafts and dispatch explicit actions through the bridge', { skip: process.env.NPN_UI_FIXTURE !== '1', timeout: 150_000 }, async () => {
  const project = process.cwd(), root = path.resolve(process.env.NPN_UI_FIXTURE_DIR ?? '.tmp/ui-final-03/renderer-fixture');
  assert.ok(root.startsWith(path.join(project, '.tmp') + path.sep));
  for (const folder of ['renderer', 'assets', 'profile', 'tmp']) mkdirSync(path.join(root, folder), { recursive: true });
  await build({ entryPoints: ['src/ui/index.ts'], bundle: true, outfile: path.join(root, 'renderer/index.js'), platform: 'browser', target: 'chrome140', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
  for (const name of ['index.html', 'styles.css']) copyFileSync(path.join(project, 'src/ui', name), path.join(root, 'renderer', name));
  copyFileSync(path.join(project, 'assets/logo.png'), path.join(root, 'assets/logo.png'));
  writeFileSync(path.join(root, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('npn',{request:(method,path,body)=>ipcRenderer.invoke('request',method,path,body),desktop:(action,payload)=>ipcRenderer.invoke('desktop',action,payload)});`);
  writeFileSync(path.join(root, 'main.cjs'), `
const {app,BrowserWindow,ipcMain}=require('electron');const path=require('node:path');const fs=require('node:fs');
for(const name of ['userData','sessionData','logs','crashDumps']){const folder=path.join(__dirname,'profile',name);fs.mkdirSync(folder,{recursive:true});app.setPath(name,folder);}
const now='2026-10-08T04:00:00.000Z'; let sequence=1, polls=0; const calls=[];
const capabilities={web:false,tools:false,mcp:false,skills:false,projectInstructions:false};
const sessions=[{id:'chat-one',title:'透明请求工作台',createdAt:now,updatedAt:now,profileId:'default',systemPrompt:'清晰回答。',developerPrompt:'',parameters:{},capabilities,workspace:'F:/Projects/Gamma'},{id:'chat-two',title:'另一个独立会话',createdAt:now,updatedAt:now,profileId:'default',systemPrompt:'',developerPrompt:'',parameters:{},capabilities}];
const messages={'chat-one':[{id:'user-one',sessionId:'chat-one',role:'user',content:'介绍这次请求如何组成。',createdAt:now,requestId:'req-one'},{id:'assistant-one',sessionId:'chat-one',role:'assistant',content:'### 可核对的请求\\n\\n提示词、选中的上下文与工具 Schema 会进入同一个服务商请求。\\n\\n- 在 Prompt 中检查来源\\n- 在 Request 中查看最终 Body\\n- 在 Trace 中查看关联事件',createdAt:now,requestId:'req-one'}],'chat-two':[]};
const body={model:'fixture/model',messages:[{role:'system',content:'清晰回答。'},{role:'user',content:'介绍这次请求如何组成。'}],temperature:0.4,max_tokens:512};
const records=[{id:'req-one',sessionId:'chat-one',kind:'chat',profileId:'default',createdAt:now,updatedAt:now,status:'completed',endpoint:'http://fixture.invalid/chat/completions',body,bodyHash:'fixture-hash',sources:[{id:'chat-mode',label:'Chat mode',role:'system',content:'清晰回答。',source:'harness/chat',scope:'harness',estimatedTokens:4,effective:true},{id:'user-one',label:'用户消息',role:'user',content:'介绍这次请求如何组成。',source:'chat:chat-one:user-one',scope:'session',estimatedTokens:12,effective:true}],recordContent:true,draft:'',response:{content:'已完成',toolCalls:[],finishReason:'stop'},usage:{prompt_tokens:42,completion_tokens:18,total_tokens:60},durationMs:380}];
const task={id:'work-one',title:'长期任务验证',goal:{objective:'验证长任务状态与检查器',constraints:[],acceptance:[],mode:'collaborative',maxModelCalls:100},workspace:'F:/Projects/Gamma',createdAt:now,updatedAt:now,status:'paused',owner:'local',modelCalls:2,revision:1,goalVersion:1,policyEpoch:1,generation:1};
let active, recording=true, noTasks=false; const presets=[];
ipcMain.handle('request',(_event,method,route,input={})=>{calls.push({method,route,input});const url=new URL(route,'http://local');const p=url.pathname;
if(p==='/test/calls')return calls;
if(p==='/test/reset'){sessions.length=0;noTasks=true;return true;}
if(p==='/v1/activity')return {timezone:'Asia/Taipei',startDate:'2026-07-11',endDate:'2026-10-08',days:Array.from({length:90},(_,i)=>({date:new Date(Date.UTC(2026,6,11+i)).toISOString().slice(0,10),events:i===89?12:0,modelCalls:i===89?2:0,toolEffects:0,tasksCreated:i===89?1:0,tasksCompleted:0}))};
if(p==='/v1/snapshot')return {tasks:noTasks?[]:[task],selectedTask:noTasks?undefined:task,messages:[],events:[],intents:[],health:{provider:'mock'},budget:{toolCalls:0,maxToolCalls:100}};
if(p==='/v1/config')return {provider:{mode:'mock',baseUrl:'http://fixture.invalid',model:'fixture/model'},remainingLiveRequests:0,credentialPresent:false,globalPaths:[],skillRoots:[]};
if(p==='/v1/instructions')return {sources:[],skills:[]};
if(p==='/v1/harness/profiles')return {profiles:[{id:'default',name:'Fixture provider',provider:{mode:'mock',baseUrl:'http://fixture.invalid',model:'fixture/model'},supportsDeveloper:false,credentialPresent:false,credentialFile:'',remainingLiveRequests:0,authorizationExpiresAt:null}]};
if(p==='/v1/harness/metrics'){const scopeId=url.searchParams.get('sessionId')??url.searchParams.get('taskId');return {scopeId,rounds:2,requests:4,steps:3,studioRequests:1,failed:0,totalTokens:12600000,reportedRequests:4,unreportedRequests:0,promptTokens:12000000,outputTokens:600000,cachedTokens:11520000,cachePromptTokens:12000000,cacheReportedRequests:4,toolCalls:7,toolsCompleted:7,toolsFailed:0,activeTools:[],latest:{id:'req-one',model:'fixture/model',status:'completed',startedAt:now,durationMs:1000,promptTokens:23000,outputTokens:76,contextWindowTokens:100000},...(scopeId==='work-one'?{task:{status:'paused',children:0}}:{})};}
if(p==='/v1/harness/sessions'){if(method==='GET')return {sessions};const session={id:'draft',title:'新对话',createdAt:now,updatedAt:now,profileId:'default',systemPrompt:'',developerPrompt:'',parameters:{},capabilities,...sessions[0],id:'chat-'+(++sequence),title:input.title??'新对话'};sessions.push(session);messages[session.id]=[];return session;}
if(p==='/v1/harness/chat'){active='req-'+(++sequence);polls=0;const record={...records[0],id:active,sessionId:input.sessionId,status:'running',draft:'',response:undefined,assistantMessageId:undefined};records.push(record);messages[input.sessionId].push({id:'message-'+sequence,sessionId:input.sessionId,role:'user',content:input.content,requestId:active,createdAt:now});return {requestId:active,status:'running'};}
if(/^\\/v1\\/harness\\/sessions\\/[^/]+$/.test(p)){const id=p.split('/').at(-1),session=sessions.find(s=>s.id===id);if(method==='POST'){Object.assign(session,input);return session;}if(active){const r=records.find(r=>r.id===active);if(r.sessionId===id&&++polls>2){r.status='completed';r.draft='已完成流式回复';r.assistantMessageId='reply-'+sequence;messages[id].push({id:r.assistantMessageId,sessionId:id,role:'assistant',content:r.draft,requestId:r.id,createdAt:now});active=undefined;}}return {session,messages:messages[id],activeRequestId:active};}
if(p.endsWith('/branch')&&p.includes('/sessions/')){const parent=p.split('/').at(-2),created={...sessions.find(s=>s.id===parent),id:'chat-branch-'+(++sequence),title:'编辑后的分支',parentSessionId:parent};sessions.push(created);messages[created.id]=[{id:'branch-user',sessionId:created.id,role:'user',content:input.content??'分支消息',createdAt:now}];return created;}
if(p.endsWith('/promote'))return {taskId:'work-one'};
if(p==='/v1/harness/requests')return {requests:records.filter(r=>(!url.searchParams.get('sessionId')||r.sessionId===url.searchParams.get('sessionId'))),nextCursor:null};
if(/^\\/v1\\/harness\\/requests\\/[^/]+$/.test(p))return records.find(r=>r.id===p.split('/').at(-1));
if(p.endsWith('/send')||p.endsWith('/branch')||p==='/v1/harness/preview'){const parent=records.find(r=>r.id===p.split('/').at(-2))??records[0];const record={...parent,id:'req-'+(++sequence),parentId:parent.id,kind:'studio',body:input.body??parent.body,status:p.endsWith('/send')?'completed':'draft',createdAt:new Date().toISOString()};records.push(record);return record;}
if(p==='/v1/harness/tools')return {registered:[{name:'read_file'}],allowed:[{name:'read_file',permission:'read_only'}],exposed:[{type:'function',function:{name:'read_file',description:'Read UTF-8 text',parameters:{type:'object'}}}],calls:[{id:'tool-one',toolCallId:'call-one',name:'read_file',arguments:{path:'README.md'},requestId:'req-one',sessionId:'chat-one',source:'builtin',permission:'read_only',status:'completed',result:'# Gamma',durationMs:5,retries:0,receivedByRequestId:'req-two',schema:{type:'object'}}]};
if(p==='/v1/harness/trace')return {events:[{id:1,sessionId:'chat-one',requestId:'req-one',type:'request.started',timestamp:now,status:'running',payload:{model:'fixture/model'}},{id:2,sessionId:'chat-one',requestId:'req-one',parentId:'req-one',type:'request.completed',timestamp:now,status:'completed',durationMs:380,payload:{tokens:60}}],nextCursor:null};
if(p==='/v1/harness/prompts')return {scope:'session',scopeId:'chat-one',systemPrompt:'',developerPrompt:'',dynamic:'',version:1};
if(p==='/v1/harness/presets'){if(method==='POST'){presets.push({...input,id:'preset-one',version:1,createdAt:now});return presets.at(-1);}return {presets};}
if(p==='/v1/harness/settings'){if(method==='POST')recording=input.recordContent;return {recordContent:recording};}
if(p==='/v1/harness/export')return {session:sessions[0],messages:messages['chat-one']};
return [];
});
ipcMain.handle('desktop',(_event,action,payload)=>{calls.push({desktop:action,payload});if(action==='version')return {version:'0.4.0-source-fixture',packageRoot:__dirname,dataDir:path.join(__dirname,'profile'),workspaceBoundary:'F:'};if(action==='select-file')return 'F:/Projects/Gamma/context.txt';if(action==='save-export')return {path:'F:/fixture/export.json'};return true;});
app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1440,height:980,webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:false,backgroundThrottling:false}});win.loadFile(path.join(__dirname,'renderer/index.html'));});app.on('window-all-closed',()=>app.quit());
`);
  const app = await _electron.launch({ executablePath: path.join(project, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'main.cjs')], cwd: project,
    env: { ...process.env, TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), NODE_DISABLE_COMPILE_CACHE: '1' } });
  const capture = async (name: string) => {
    const current = await app.firstWindow();
    await current.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const encoded = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toDataURL());
    writeFileSync(path.join(root, name), Buffer.from(encoded.split(',')[1]!, 'base64'));
  };
  try {
    let page = await app.firstWindow(); const errors: string[] = [];
    page.setDefaultTimeout(12_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByTestId('chat-message').waitFor();
    assert.deepEqual(await page.locator('.mode-switch button').allTextContents(), ['Chat', 'Cowork', 'Code']);
    assert.equal(await page.getByTestId('open-native-ide').isVisible(), false, 'Chat must not show the IDE entry.');
    await page.getByTestId('mode-code').click();
    await page.getByTestId('open-native-ide').waitFor();
    let modeCalls = await page.evaluate(async () => (window as any).npn.request('GET', '/test/calls'));
    assert.equal(modeCalls.filter((call: any) => call.desktop === 'open-ide').length, 0, 'Selecting Code does not launch an editor or model.');
    await page.getByTestId('mode-cowork').click();
    assert.equal(await page.getByTestId('open-native-ide').isVisible(), false, 'Cowork must not show the IDE entry.');
    await page.getByTestId('mode-chat').click();
    await page.getByTestId('chat-message').waitFor();
    assert.equal(await page.locator('img[src*="logo"]').count(), 0);
    await page.getByTestId('agent-steps').waitFor();
    assert.match(await page.getByTestId('agent-steps').innerText(), /2 轮 3 步.*76 tok\/s/s);
    assert.match(await page.getByTestId('agent-tokens').innerText(), /12.6M tok.*96%/s);
    assert.match(await page.getByTestId('agent-context').innerText(), /23%/);
    await page.getByTestId('agent-tokens').click(); await page.getByText('Agent 运行用量', { exact: true }).waitFor();
    assert.match(await page.locator('.metrics-detail-list').innerText(), /12,600,000/); await page.getByTestId('close-dialog').click();
    await capture('agent-metrics-light.png');
    await page.getByTestId('chat-message').fill('这个草稿应该留在第一个会话');
    await page.getByTestId('chat-session-chat-two').click();
    await page.getByTestId('chat-message').waitFor(); assert.equal(await page.getByTestId('chat-message').inputValue(), '');
    await page.getByTestId('chat-message').fill('第二个会话独立草稿');
    await page.getByTestId('chat-session-chat-one').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="chat-message"]') as HTMLTextAreaElement)?.value === '这个草稿应该留在第一个会话');
    await page.getByTestId('chat-attach').click(); await page.getByText('context.txt', { exact: true }).waitFor();
    await page.getByTestId('chat-settings').click(); await page.getByTestId('chat-system-prompt').fill('保持简洁并给出来源。');
    assert.equal(await page.getByTestId('chat-developer-prompt').isDisabled(), true);
    await page.getByTestId('save-chat-settings').click(); await page.getByTestId('chat-system-prompt').waitFor({ state: 'hidden' });
    assert.equal(await page.getByTestId('chat-message').inputValue(), '这个草稿应该留在第一个会话');
    await page.getByTestId('chat-inspector').click(); await page.getByTestId('harness-inspector').waitFor();
    await page.getByTestId('inspector-request').click(); await page.getByTestId('raw-request-editor').waitFor();
    await capture('chat-request-light.png');
    await page.getByTestId('raw-request-editor').click(); await page.getByTestId('raw-request-editor').press('Control+a'); await page.getByTestId('raw-request-editor').press('Backspace'); await page.keyboard.insertText('invalid request');
    await page.getByTestId('send-studio-request').click(); await page.locator('.toast.error').waitFor();
    let calls = await page.evaluate(async () => (window as any).npn.request('GET', '/test/calls'));
    assert.equal(calls.filter((call: any) => call.route?.endsWith('/send')).length, 0, 'invalid JSON never reaches bridge dispatch');
    await page.getByTestId('inspector-prompt').click(); await page.getByTestId('inspector-request').click(); assert.equal(await page.getByTestId('raw-request-editor').innerText(), 'invalid request');
    const changed = { model: 'fixture/model', messages: [{ role: 'user', content: '编辑后请求' }], temperature: 0.2, max_tokens: 256 };
    await page.getByTestId('raw-request-editor').click(); await page.getByTestId('raw-request-editor').press('Control+a'); await page.getByTestId('raw-request-editor').press('Backspace'); await page.keyboard.insertText(JSON.stringify(changed));
    await page.getByTestId('send-studio-request').click();
    await page.waitForFunction(() => document.querySelector('.request-identity')?.textContent !== 'req-one');
    calls = await page.evaluate(async () => (window as any).npn.request('GET', '/test/calls'));
    assert.deepEqual(calls.find((call: any) => call.route?.endsWith('/send')).input.body, changed);
    for (const name of ['prompt', 'tools', 'trace', 'context', 'diff']) { await page.getByTestId('inspector-' + name).click(); await page.getByTestId('inspector-content').waitFor(); }
    await page.getByTestId('inspector-tools').click(); await page.getByText('实际调用', { exact: true }).waitFor();
    assert.match(await page.getByTestId('inspector-content').innerText(), /read_file/);
    await page.getByTestId('inspector-trace').click(); await page.getByTestId('trace-search').waitFor();
    await capture('chat-trace-light.png');
    await page.getByTestId('toggle-theme').click(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await capture('chat-trace-dark.png');
    await page.getByTestId('toggle-theme').click();
    await page.getByTestId('inspector-resize').focus(); const width = await page.getByTestId('harness-inspector').evaluate(node => node.getBoundingClientRect().width); await page.getByTestId('inspector-resize').press('ArrowLeft'); assert.ok(await page.getByTestId('harness-inspector').evaluate(node => node.getBoundingClientRect().width) > width);
    await page.getByTestId('close-inspector').click();
    await page.getByTestId('chat-send').click(); await page.getByTestId('chat-streaming').waitFor();
    await page.getByText('已完成流式回复', { exact: true }).waitFor({ timeout: 15_000 });
    assert.equal(await page.getByTestId('chat-message').inputValue(), '');
    await page.getByTestId('chat-edit-user-one').click(); await page.getByTestId('edit-chat-message').fill('分支里的新消息'); await page.getByTestId('submit-edit-chat-message').click();
    await page.getByTestId('chat-session-chat-one').waitFor(); assert.ok(await page.getByTestId('chat-session-chat-one').isVisible());
    await page.getByTestId('nav-projects').click(); await page.getByText('项目空间', { exact: true }).waitFor();
    await page.getByTestId('nav-history').click(); await page.getByTestId('history-request-req-one').waitFor();
    await page.getByTestId('nav-work').click(); await page.getByTestId('work-inspector').waitFor();
    await page.getByTestId('nav-settings').click(); await page.getByTestId('record-request-content').waitFor();
    await page.getByTestId('manage-profiles').click(); await page.getByTestId('manage-profile-select').waitFor(); await page.getByTestId('close-dialog').click();
    await page.getByTestId('nav-chat').click(); await page.getByTestId('chat-message').waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(760, 820));
    await page.waitForFunction(() => window.innerWidth === 760);
    await page.getByTestId('chat-toggle-conversations').click();
    await page.getByTestId('chat-close-conversations').click();
    assert.equal(await page.getByTestId('chat-toggle-conversations').getAttribute('aria-expanded'), 'false');
    const statsBounds = await page.getByTestId('agent-telemetry').boundingBox(); assert.ok(statsBounds && statsBounds.y > 0 && statsBounds.y + statsBounds.height <= 821, 'Metrics stay visible in the narrow viewport');
    await capture('chat-narrow.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 960));
    await page.evaluate(() => (window as any).npn.request('POST', '/test/reset'));
    // Start the independent empty-home fixture in a fresh renderer. Destroying
    // this test-only window discards its asserted drafts without a native dialog.
    const freshWindow = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, directory) => {
      const old = BrowserWindow.getAllWindows()[0];
      const next = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { preload: directory + '/preload.cjs', sandbox: false, backgroundThrottling: false } });
      old.destroy(); void next.loadFile(directory + '/renderer/index.html');
    }, root);
    page = await freshWindow; page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    await page.getByTestId('chat-start').waitFor();
    await page.locator('.home-heatmap .heatmap-cell').first().waitFor();
    assert.equal(await page.locator('.home-heatmap .heatmap-cell').count(), 90);
    assert.equal(await page.locator('.chat-workspace > .chat-session-rail').count(), 0, 'Chat shares the main navigation instead of adding a second rail');
    assert.equal(await page.getByText('自由对话', { exact: true }).count(), 0);
    const codeLocation = await page.getByTestId('mode-code').boundingBox(); assert.ok(codeLocation && codeLocation.x < 350 && codeLocation.y < 55, 'Code mode belongs at the top left');
    await page.getByTestId('mode-code').click();
    const ideLocation = await page.getByTestId('open-native-ide').boundingBox();
    assert.ok(ideLocation && ideLocation.x > 1000 && ideLocation.y < 120, 'IDE belongs at the top right of Code only');
    await page.getByTestId('code-goal').fill('Code independent draft');
    await page.getByTestId('mode-cowork').click(); await page.getByTestId('welcome-message').fill('Cowork independent draft');
    await page.getByTestId('mode-code').click(); assert.equal(await page.getByTestId('code-goal').inputValue(), 'Code independent draft');
    await capture('code-light.png');
    await page.getByTestId('mode-cowork').click(); assert.equal(await page.getByTestId('welcome-message').inputValue(), 'Cowork independent draft');
    await page.getByTestId('mode-chat').click();
    await capture('home-light.png');
    await page.getByTestId('toggle-theme').click(); await capture('home-dark.png');
    await page.getByTestId('chat-welcome-message').fill('DSH 首页直接发送验证'); await page.getByTestId('chat-start').click();
    await page.getByText('已完成流式回复', { exact: true }).waitFor({ timeout: 15_000 });
    calls = await page.evaluate(async () => (window as any).npn.request('GET', '/test/calls'));
    assert.ok(calls.some((call: any) => call.route === '/v1/harness/chat' && call.input.content === 'DSH 首页直接发送验证'));
    assert.deepEqual(errors, []);
    writeFileSync(path.join(root, 'results.json'), JSON.stringify({ kind: 'source renderer fixture, not packaged acceptance', passed: true, checks: ['logo absent', 'metrics and exact breakdown', 'independent drafts', 'attachment selection', 'session prompt save', 'developer capability', 'invalid JSON no dispatch', 'raw draft retained across tabs', 'edited body forwarded', 'six inspector views', 'theme', 'resize keyboard', 'streaming', 'message branch preserves original', 'five product destinations'], errors }, null, 2));
  } catch (error) {
    const page = await app.firstWindow();
    writeFileSync(path.join(root, 'failure.txt'), `${String(error)}\n${await page.locator('body').innerText()}`);
    await capture('failure.png');
    throw error;
  } finally { await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.destroy(); }).catch(() => undefined); await app.close(); }
});


