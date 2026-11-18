import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { _electron } from 'playwright';
const own=path.resolve(import.meta.dirname,'../../../..'), main=path.resolve(process.argv[2] ?? own), label=process.argv[3] ?? 'dom';
const work=path.join(own,'.tmp/message-window-20261104',label), out=path.join(own,'evidence/backend-20261026/message-window-20261104');
fs.mkdirSync(work,{recursive:true}); fs.mkdirSync(out,{recursive:true});
for(const name of ['TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA'])process.env[name]=work;
const paths=['src/frontend/app/actions.ts','src/frontend/app/store.ts','src/frontend/app/message-window.ts','src/frontend/features/session/SessionView.tsx','src/frontend/features/session/MessageHistory.tsx','src/frontend/features/ide/IdeAgent.tsx','src/frontend/api/types.ts','src/frontend/tests/message-window-dom/entry.tsx'];
const overrides=new Map(paths.map(file=>[path.join(main,file).toLowerCase(),path.join(own,file)])), inputs=new Map(), sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const checks=[], pageErrors=[]; let app, stable=false, closed=false;
try {
  await build({absWorkingDir:main,entryPoints:[path.join(main,'src/frontend/tests/message-window-dom/entry.tsx')],outdir:work,entryNames:'bundle',bundle:true,platform:'browser',format:'iife',jsx:'automatic',define:{__NPN_GATEWAY__:'"bridge"','process.env.NODE_ENV':'"production"'},logLevel:'warning',plugins:[{name:'candidate',setup(b){
    b.onResolve({filter:/.*/},args=>{const entry=args.importer.endsWith('message-window-dom/entry.tsx')||args.importer.endsWith('message-window-dom\\entry.tsx');if(!args.path.startsWith('.')&&!path.isAbsolute(args.path))return entry?b.resolve(args.path,{resolveDir:main,kind:args.kind}):undefined;const base=path.isAbsolute(args.path)?args.path:path.resolve(args.resolveDir,args.path);for(const candidate of [base,base+'.ts',base+'.tsx'])if(overrides.has(candidate.toLowerCase()))return{path:candidate};return entry?b.resolve(base,{resolveDir:main,kind:args.kind}):undefined;});
    b.onLoad({filter:/\.(tsx?|css)$/},args=>{const file=overrides.get(args.path.toLowerCase())??args.path;inputs.set(file,sha(file));return{contents:fs.readFileSync(file,'utf8'),loader:args.path.endsWith('.css')?'css':args.path.endsWith('.tsx')?'tsx':'ts',resolveDir:path.dirname(args.path)};});
  }}]});
  fs.writeFileSync(path.join(work,'index.html'),'<!doctype html><html data-theme="light" data-accent="ember"><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>#root{height:650px;width:900px}.session{height:100%}.ide-agent{height:650px;width:460px}</style><div id="root"></div><script src="bundle.js"></script></html>');
  const env={...process.env,NPN_LAYOUT_USER:path.join(work,'profile'),NPN_LAYOUT_PAGE:path.join(work,'index.html')};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  app=await _electron.launch({executablePath:path.join(own,'node_modules/electron/dist/electron.exe'),args:[path.join(main,'src/frontend/tests/narrow-layout-dom/app.cjs')],cwd:work,env});
  const page=await app.firstWindow();page.on('pageerror',e=>pageErrors.push(String(e)));page.setDefaultTimeout(10000);await page.waitForFunction(()=>Boolean(window.__window));
  const check=async(name,run)=>{try{await run();checks.push({name,passed:true});console.log('PASS '+name);}catch(e){checks.push({name,passed:false,error:String(e.stack)});console.log('FAIL '+name+': '+e.message);}};
  const state=()=>page.evaluate(()=>window.__window.state());
  await check('real SessionView history replaces pages and remains fixed while live stream completes',async()=>{
    await page.evaluate(()=>window.__window.setup('session'));await page.getByRole('button',{name:'查看更早消息',exact:true}).click();await page.getByText('正在查看历史',{exact:true}).waitFor();
    const before=(await state()).ids;await page.evaluate(()=>{window.__window.burst(241,2240);window.__window.emit('a',2241,'streaming','正在生成的完整内容');});
    assert.deepEqual((await state()).ids,before);assert.equal(await page.locator('.msg').count(),before.length);assert.ok(before.length>0&&before.length<=200);
    await page.getByRole('button',{name:'返回最新',exact:true}).click();await page.getByText('正在生成的完整内容',{exact:true}).waitFor();
    await page.evaluate(()=>window.__window.emit('a',2241,'done','终态完整内容'));await page.getByText('终态完整内容',{exact:true}).waitFor();assert.equal((await state()).last.status,'done');assert.equal((await state()).drafts.a,'未发送草稿');
    assert.ok((await state()).count<=200);assert.equal((await state()).calls.filter(url=>url.startsWith('/v1/product/sessions/a')).length,3);
  });
  await check('long history pages stay bounded and every complete stored message is reachable through buttons',async()=>{
    await page.evaluate(()=>window.__window.setup('session',80000));const seen=new Set();let iterations=0;
    for(;;){const s=await state();s.ids.forEach(id=>seen.add(id));assert.ok(s.chars<=2*1024*1024);assert.equal(s.last.parts[0].text.length,80000);if(!s.hasMoreBefore)break;assert.ok(++iterations<20);const ids=s.ids.join(',');await page.getByRole('button',{name:'查看更早消息',exact:true}).click();await page.waitForFunction(ids=>window.__window.state().ids.join(',')!==ids,ids);}
    assert.equal(seen.size,240);
  });
  await check('IDE selection and close release body and metrics caches without retaining inactive events',async()=>{
    await page.evaluate(()=>window.__window.setup('ide'));await page.getByRole('button',{name:'查看更早消息',exact:true}).click();await page.getByText('正在查看历史',{exact:true}).waitFor();
    await page.getByRole('button',{name:'返回最新',exact:true}).click();await page.evaluate(()=>window.__window.emit('code-a',241,'streaming','IDE 流式消息'));await page.getByText('IDE 流式消息',{exact:true}).waitFor();
    await page.getByRole('button',{name:'关闭 Agent 面板',exact:true}).click();await page.getByText('Agent 已关闭',{exact:true}).waitFor();await page.evaluate(()=>window.__window.emit('code-a',242));
    assert.deepEqual((await state()).details,[]);assert.deepEqual((await state()).metrics,[]);assert.equal((await state()).drafts['code-a'],'未发送草稿');
  });
  await check('closing a new IDE Composer during deferred send prevents late onSent and focus resurrection',async()=>{
    await page.evaluate(()=>window.__window.setup('ide-new'));
    await page.getByRole('textbox').fill('new embedded delayed message');await page.getByRole('textbox').press('Enter');
    await page.waitForFunction(()=>window.__window.state().pendingSend);
    await page.getByRole('button',{name:'关闭 Agent 面板',exact:true}).click();await page.getByText('Agent 已关闭',{exact:true}).waitFor();
    await page.evaluate(async()=>{window.__window.finishSend();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    const s=await state();assert.equal(s.id,undefined);assert.deepEqual(s.details,[]);assert.deepEqual(s.selections,[]);assert.equal(s.calls.some(url=>url.includes('/sessions/code-late')),false);
    await page.evaluate(()=>window.__window.setup('ide-new'));await page.getByRole('textbox').fill('new embedded delayed detail');await page.getByRole('textbox').press('Enter');
    await page.waitForFunction(()=>window.__window.state().pendingSend);await page.evaluate(()=>window.__window.finishSend(true));await page.waitForFunction(()=>window.__window.state().pendingDetail);
    await page.getByRole('button',{name:'关闭 Agent 面板',exact:true}).click();await page.getByText('Agent 已关闭',{exact:true}).waitFor();
    await page.evaluate(async()=>{window.__window.finishDetail();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    const after=await state();assert.equal(after.id,undefined);assert.deepEqual(after.details,[]);assert.deepEqual(after.selections,[]);
  });
  for(const[file,hash]of inputs)assert.equal(sha(file),hash);stable=true;
}catch(e){checks.push({name:'harness',passed:false,error:String(e.stack)});}finally{
  if(app){await app.close();closed=true;}const passed=checks.length===4&&checks.every(c=>c.passed)&&!pageErrors.length&&stable&&closed;
  fs.writeFileSync(path.join(out,label+'.json'),JSON.stringify({passed,checks,pageErrors,inputsStable:stable,closed,inputs:[...inputs].map(([path,sha256])=>({path,sha256})),work,boundary:'Actual React SessionView/IdeAgent and production Bridge/actions in isolated Electron. IPC fixture only; backend pagination has separate HTTP evidence. Not packaged EXE acceptance.'},null,2));process.exitCode=passed?0:1;
}
