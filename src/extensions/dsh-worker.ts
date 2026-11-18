/** Original DSH text API adapter. This file runs only as a permission-restricted child. */
import { createContext, Script, SourceTextModule } from 'node:vm';

const messages: Record<string, string> = {
  UNSUPPORTED_IMPORT: 'Only the declared virtual DSH tools and Schemastery modules are available.',
  UNSUPPORTED_API: 'This DSH plugin uses an API outside the supported stateless text subset.',
  DENIED_PERMISSION: 'DSH plugins cannot access files, network, processes, credentials, approval or kernel services.',
  INVALID_CONFIG: 'DSH configuration does not satisfy the supported Config schema.',
  INVALID_INPUT: 'DSH tool input must be text within the supported schema and size limit.',
  INVALID_OUTPUT: 'DSH tool output and rendered content must be bounded strings.',
  DSH_RUNTIME_FAILURE: 'DSH plugin apply, execution or teardown failed.',
  DSH_TIMEOUT: 'DSH plugin module evaluation exceeded its worker deadline.',
};

// Every function, schema and Context object exposed to plugin code is created in its own realm.
// There are no host callbacks, Buffer/process objects, timers, filesystem or network globals.
const prelude = `(() => {
  const objects = Object; const arrays = Array; const parse = JSON.parse; const stringify = JSON.stringify;
  objects.defineProperty(globalThis,'console',{value:undefined,writable:false,configurable:false});
  const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
  const onlyKeys = (value, allowed, code = 'UNSUPPORTED_API') => {
    if (!value || typeof value !== 'object' || arrays.isArray(value)) fail(code);
    if (objects.keys(value).some(key => !allowed.includes(key))) fail(code);
  };
  const id = /^[a-z][a-z0-9_-]{0,63}$/;
  const tools = new Map(); const disposers = [];
  const lifecycle = {toolsRegistered:0,toolsDisposed:0,effectsRegistered:0,effectsDisposed:0,applyDisposed:0,disposalOrder:[]};
  const once = (callback, label) => { let disposed = false; return async () => {
    if (disposed) return; disposed = true;
    await callback(); lifecycle.disposalOrder.push(label);
  }; };
  const collect = (callback, label) => { const dispose = once(callback, label); disposers.push(dispose); return dispose; };
  const kindValid = (kind, value) => kind === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === kind;
  const schemaNode = (spec) => objects.freeze({
    ...spec,
    required() { return schemaNode({...spec,isRequired:true}); },
    default(value) { if (!kindValid(spec.kind,value)) fail('INVALID_CONFIG'); return schemaNode({...spec,defaultValue:value,hasDefault:true}); },
  });
  const Schema = objects.freeze({
    string: () => schemaNode({kind:'string'}), boolean: () => schemaNode({kind:'boolean'}), number: () => schemaNode({kind:'number'}),
    object(shape) {
      onlyKeys(shape,objects.keys(shape),'INVALID_CONFIG');
      if (objects.keys(shape).length > 32) fail('INVALID_CONFIG');
      for (const [key,node] of objects.entries(shape)) if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !node || !['string','boolean','number'].includes(node.kind)) fail('INVALID_CONFIG');
      return objects.freeze({kind:'object',shape:objects.freeze({...shape})});
    },
  });
  const toolMarker = Symbol('defined DSH text tool');
  const defineTool = (options) => {
    onlyKeys(options,['name','description','parameters','output','execute']);
    if (!id.test(options.name) || options.name === 'run_code' || typeof options.description !== 'string' || options.description.length > 2000 || typeof options.execute !== 'function') fail('UNSUPPORTED_API');
    onlyKeys(options.parameters,['text']);
    onlyKeys(options.parameters.text,['type','required','description','enum','const']);
    const text = options.parameters.text;
    if (text.type !== 'string' || text.required !== true || (text.enum !== undefined && (!arrays.isArray(text.enum) || text.enum.some(value => typeof value !== 'string'))) || (text.const !== undefined && typeof text.const !== 'string')) fail('UNSUPPORTED_API');
    onlyKeys(options.output,['schema','render']); onlyKeys(options.output.schema,['type']);
    if (options.output.schema.type !== 'string' || typeof options.output.render !== 'function') fail('UNSUPPORTED_API');
    return objects.freeze({...options,[toolMarker]:true});
  };
  const register = (definition) => {
    if (!definition || definition[toolMarker] !== true || tools.size >= 32 || tools.has(definition.name)) fail('UNSUPPORTED_API');
    tools.set(definition.name,definition); lifecycle.toolsRegistered++;
    return collect(() => { tools.delete(definition.name); lifecycle.toolsDisposed++; },'tool:'+definition.name);
  };
  const toolsApi = objects.freeze({register});
  const contextBase = objects.freeze({
    tools:toolsApi,
    get(name) { if (name !== 'tools') fail('DENIED_PERMISSION'); return toolsApi; },
    effect(callback,label='anonymous') {
      if (typeof callback !== 'function' || typeof label !== 'string' || label.length > 200) fail('UNSUPPORTED_API');
      const disposer = callback(); if (typeof disposer !== 'function') fail('UNSUPPORTED_API');
      lifecycle.effectsRegistered++;
      return collect(async () => { await disposer(); lifecycle.effectsDisposed++; },label);
    },
  });
  const ctx = new Proxy(contextBase,{get(target,key) { if (!(key in target)) fail('DENIED_PERMISSION'); return Reflect.get(target,key); }});
  objects.defineProperty(globalThis,'__dshApi',{value:objects.freeze({Schema,defineTool}),writable:false,configurable:false});
  const resolveConfig = (schema, encoded) => {
    const input = parse(encoded); onlyKeys(input,objects.keys(input),'INVALID_CONFIG');
    if (schema === undefined) { if (objects.keys(input).length) fail('INVALID_CONFIG'); return objects.freeze({}); }
    if (!schema || schema.kind !== 'object') fail('INVALID_CONFIG');
    onlyKeys(input,objects.keys(schema.shape),'INVALID_CONFIG'); const result = {};
    for (const [key,node] of objects.entries(schema.shape)) {
      if (objects.hasOwn(input,key)) { if (!kindValid(node.kind,input[key])) fail('INVALID_CONFIG'); result[key]=input[key]; }
      else if (node.hasDefault) result[key]=node.defaultValue;
      else if (node.isRequired) fail('INVALID_CONFIG');
    }
    return objects.freeze(result);
  };
  return objects.freeze({
    async mount(plugin,configuration) {
      const target = plugin.default ?? plugin;
      if (target.inject !== undefined && (!arrays.isArray(target.inject) || target.inject.some(name => name !== 'tools'))) fail('UNSUPPORTED_API');
      const apply = typeof target === 'function' ? target : target.apply;
      if (typeof apply !== 'function') fail('UNSUPPORTED_API');
      const config = resolveConfig(target.Config,configuration);
      const disposer = await apply(ctx,config);
      if (disposer !== undefined) {
        if (typeof disposer !== 'function') fail('UNSUPPORTED_API');
        collect(async () => { await disposer(); lifecycle.applyDisposed++; },'apply');
      }
      if (tools.size === 0) fail('UNSUPPORTED_API');
      return [...tools.values()].map(tool => ({name:tool.name,description:tool.description}));
    },
    async execute(name,input) {
      const tool=tools.get(name); if (!tool) fail('UNSUPPORTED_API');
      const args=objects.freeze({text:input}); const rule=tool.parameters.text;
      if (typeof input !== 'string' || (rule.enum && !rule.enum.includes(input)) || (rule.const !== undefined && rule.const !== input)) fail('INVALID_INPUT');
      const exec=objects.freeze({name:tool.name,arguments:args,signal:objects.freeze({aborted:false})});
      const value=await tool.execute(args,exec); if (typeof value !== 'string') fail('INVALID_OUTPUT');
      const content=await tool.output.render(args,value);
      if (!arrays.isArray(content) || content.length > 16 || content.some(block => !block || block.type !== 'text' || typeof block.text !== 'string' || objects.keys(block).some(key => !['type','text'].includes(key)))) fail('INVALID_OUTPUT');
      return {output:value,renderedContent:content};
    },
    async dispose() {
      let failure; for (const dispose of disposers.reverse()) { try { await dispose(); } catch (error) { failure ??= error; } }
      if (failure) throw failure; return parse(stringify(lifecycle));
    },
  });
})()`;

interface Driver {
  mount(plugin: unknown, configuration: string): Promise<{ name: string; description: string }[]>;
  execute(name: string, input: string): Promise<{ output: string; renderedContent: { type: 'text'; text: string }[] }>;
  dispose(): Promise<unknown>;
}

async function main(): Promise<unknown> {
  if (!process.permission || ['fs.read', 'fs.write', 'child', 'worker', 'addons'].some(scope => process.permission.has(scope))) throw Object.assign(new Error(), { code: 'DENIED_PERMISSION' });
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 2_097_152) throw Object.assign(new Error(), { code: 'INVALID_INPUT' }); }
  const request = JSON.parse(input);
  if (!request.artifact || typeof request.artifact.source !== 'string' || Buffer.byteLength(request.artifact.source) > 131072) throw Object.assign(new Error(), { code: 'UNSUPPORTED_API' });
  const realm = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const driver = new Script(prelude).runInContext(realm, { timeout: 500 }) as Driver;
  const virtual = new Map([
    ['@deepseek-ai/dsh-tools', new SourceTextModule('export const defineTool = globalThis.__dshApi.defineTool;', { context: realm })],
    ['@deepseek-ai/schemastery', new SourceTextModule('export default globalThis.__dshApi.Schema; export const Schema = globalThis.__dshApi.Schema;', { context: realm })],
    ['@deepseek-ai/cordis', new SourceTextModule('export {};', { context: realm })],
  ]);
  const module = new SourceTextModule(request.artifact.source, {
    context: realm,
    identifier: 'approved-dsh-entry',
    importModuleDynamically: async () => { throw Object.assign(new Error(), { code: 'UNSUPPORTED_IMPORT' }); },
  });
  let catalog: { name: string; description: string }[] = [];
  let output: { output: string; renderedContent: { type: 'text'; text: string }[] } | undefined;
  let lifecycle: unknown;
  try {
    await module.link(specifier => {
      const provided = virtual.get(specifier);
      if (!provided) throw Object.assign(new Error(), { code: 'UNSUPPORTED_IMPORT' });
      return provided;
    });
    await module.evaluate({ timeout: 500 });
    catalog = await driver.mount(module.namespace, JSON.stringify(request.artifact.configuration));
    if (request.operation) {
      if (typeof request.operation.input !== 'string' || Buffer.byteLength(request.operation.input) > 1_048_576) throw Object.assign(new Error(), { code: 'INVALID_INPUT' });
      output = await driver.execute(request.operation.name, request.operation.input);
      if (Buffer.byteLength(output.output) > 1_048_576 || Buffer.byteLength(JSON.stringify(output.renderedContent)) > 1_048_576) throw Object.assign(new Error(), { code: 'INVALID_OUTPUT' });
    }
  } finally { lifecycle = await driver.dispose(); }
  return { catalog, lifecycle, ...output };
}

try { process.stdout.write(JSON.stringify({ ok: true, result: await main() })); }
catch (error) {
  const reported = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'DSH_RUNTIME_FAILURE';
  const code = reported === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'DSH_TIMEOUT' : Object.hasOwn(messages, reported) ? reported : 'DSH_RUNTIME_FAILURE';
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message: messages[code] } }));
}
