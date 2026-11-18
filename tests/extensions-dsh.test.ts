import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PluginManager, PluginError, DSH_COMPATIBLE_VERSION } from '../src/extensions/plugins.js';

const example = resolve('examples/plugins/dsh-runtime-formatter');
const originalSource = readFileSync(join(example, 'index.js'), 'utf8');
const sha256 = /^[a-f0-9]{64}$/;
const code = (wanted: string) => (error: unknown): boolean => error instanceof PluginError && error.code === wanted;

type DshDiagnostic = ReturnType<typeof dshDiagnostic>;
const approvedObservers = new WeakMap<PluginManager, DshDiagnostic>();
function dshDiagnostic(t: TestContext, directory: string) {
  const started = performance.now(), delay = monitorEventLoopDelay({ resolution: 20 });
  const phases: Record<string, unknown>[] = [];
  let failed = false, firstError: unknown, activeCase: string | undefined, dropped = 0, diagnosticErrors = 0;
  let workerDirectoryCount: number | undefined;
  const token = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : undefined;
  const errorFields = (error: unknown) => {
    const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined;
    return { name: token(value?.name), code: token(value?.code), causeCode: token(value?.cause?.code) };
  };
  const log = (value: unknown) => { try { t.diagnostic(JSON.stringify(value)); } catch { diagnosticErrors++; } };
  const mark = (phase: string, details: Record<string, unknown> = {}) => {
    if (phases.length === 128) { dropped++; return; }
    phases.push({ phase, case: activeCase, at: new Date().toISOString(), elapsedMs: performance.now() - started, ...details });
  };
  const failure = (error: unknown) => {
    if (!failed) firstError = errorFields(error);
    failed = true; mark('failure', { error: errorFields(error) });
  };
  delay.enable();
  return {
    mark,
    observeError(error: unknown) { mark('approved.error', { error: errorFields(error) }); },
    begin(label: string, expected: string) { activeCase = label; mark('case.begin', { expected }); },
    end() { mark('case.end'); activeCase = undefined; },
    failure,
    retain(workers: string[]) { workerDirectoryCount = workers.length; return failed || workers.length > 0; },
    finish(clean: () => void) {
      if (t.signal.aborted) failure(t.signal.reason);
      const primaryFailed = failed;
      mark('cleanup.begin');
      try { clean(); mark('cleanup.end'); }
      catch (error) { failure(error); if (!primaryFailed) throw error; }
      finally {
        delay.disable();
        let diagnosticWritten = false;
        const metadata = { fixture: directory, failed, firstError, phases, dropped, diagnosticErrors, workerDirectoryCount,
          maxEventLoopDelayMs: delay.max / 1e6, observation: 'Test-level stages only; no worker spawn or timer hook.' };
        if (failed) {
          try {
            const parent = resolve('.tmp');
            if (relative(parent, directory).includes(sep) || !relative(parent, directory).startsWith('extensions-dsh-')
              || lstatSync(parent).isSymbolicLink() || lstatSync(directory).isSymbolicLink()) throw new Error('Diagnostic fixture ownership changed');
            writeFileSync(join(directory, 'dsh-failure.json'), JSON.stringify(metadata, null, 2) + '\n');
            diagnosticWritten = true;
          } catch (error) { diagnosticErrors++; log({ fixture: directory, diagnosticError: errorFields(error) }); }
        }
        if (failed) log({ fixture: directory, fixturePresent: existsSync(directory), diagnosticWritten,
          ...(diagnosticWritten ? { diagnostic: join(directory, 'dsh-failure.json') } : {}), dropped, diagnosticErrors, cleanup: phases.slice(-3) });
      }
    },
  };
}

function temporary(): string {
  const root = resolve('.tmp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'extensions-dsh-'));
}
function cleanup(directory: string, diagnostic?: DshDiagnostic): void {
  const runtime = join(directory, 'data', 'plugins', '.runtime');
  const workerDirectories = existsSync(runtime) ? readdirSync(runtime) : [];
  const root = realpathSync(resolve('.tmp'));
  const target = realpathSync(directory);
  const within = relative(root, target);
  assert.ok(within.startsWith('extensions-dsh-') && !within.includes(sep) && !isAbsolute(within));
  assert.equal(lstatSync(directory).isSymbolicLink(), false);
  if (!diagnostic?.retain(workerDirectories)) {
    rmSync(target, { recursive: true });
    assert.equal(existsSync(directory), false);
  }
  assert.deepEqual(workerDirectories, [], 'each completed or failed worker must remove its own temporary runtime directory');
}
function fixture(root: string, source = originalSource, packageChanges: Record<string, unknown> = {}, label = 'source'): string {
  const directory = join(root, label);
  mkdirSync(directory);
  const manifest = {
    name: `dsh-fixture-${label}`, version: '1.0.0', type: 'module', main: 'index.js',
    engines: { dsh: DSH_COMPATIBLE_VERSION }, dsh: { manifestVersion: 1 }, ...packageChanges,
  };
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'index.js'), source);
  return directory;
}
async function approved(manager: PluginManager, source: string, configuration?: Record<string, unknown>) {
  const diagnostic = approvedObservers.get(manager);
  try {
    diagnostic?.mark('install.begin');
    const installed = manager.install(source, configuration);
    diagnostic?.mark('install.end'); diagnostic?.mark('approve.begin');
    manager.approve(installed.id, installed.digest);
    diagnostic?.mark('approve.end'); diagnostic?.mark('enable.begin');
    return await manager.enable(installed.id);
  } catch (error) { diagnostic?.observeError(error); throw error; }
  finally { diagnostic?.mark('approved.end'); }
}

test('DSH scalar Config distinguishes optional and required fields and accepts camelCase keys', async () => {
  const directory = temporary();
  try {
    const module = `import { defineTool } from '@deepseek-ai/dsh-tools';
      import Schema from '@deepseek-ai/schemastery';
      export const inject = ['tools'];
      export const Config = Schema.object({ camelCase: Schema.string(), count: Schema.number().required(), flag: Schema.boolean().default(false) });
      export function apply(ctx, config) {
        ctx.tools.register(defineTool({ name:'dsh_clean', description:'Scalar config fixture', parameters:{text:{type:'string',required:true}},
          output:{schema:{type:'string'},render(_args,value){return [{type:'text',text:value}]}},
          execute(args){return [config.camelCase ?? 'none',String(config.count),String(config.flag),args.text].join(':')} }));
      }`;
    const manager = new PluginManager(join(directory, 'data'));
    const installed = manager.install(fixture(directory, module)); manager.approve(installed.id, installed.digest);
    await assert.rejects(async () => await manager.enable(installed.id), code('INVALID_CONFIG'));
    const configured = manager.configure(installed.id, { count: 3 }); manager.approve(installed.id, configured.digest); await manager.enable(installed.id);
    assert.equal((await manager.execute(installed.id, 'dsh_clean', 'X')).output, 'none:3:false:X');
    manager.disable(installed.id);
    const updated = manager.configure(installed.id, { count: 4, camelCase: 'value', flag: true }); manager.approve(installed.id, updated.digest); await manager.enable(installed.id);
    assert.equal((await manager.execute(installed.id, 'dsh_clean', 'X')).output, 'value:4:true:X');
  } finally { cleanup(directory); }
});

test('real DSH exports install disabled without an npn bridge, then apply a typed tool and default Config', async () => {
  const directory = temporary();
  try {
    const dataDir = join(directory, 'data');
    const manager = new PluginManager(dataDir);
    const packageJson = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8'));
    assert.equal(Object.hasOwn(packageJson, 'npn'), false);
    const installed = manager.install(example);
    assert.equal(installed.enabled, false);
    assert.equal(installed.approvalValid, false);
    assert.deepEqual(installed.manifest.operations, []);
    assert.equal(installed.runtime?.api, 'dsh-runtime/1');
    assert.match(installed.runtime!.sourceDigest, sha256);
    assert.match(installed.runtime!.configDigest, sha256);
    await assert.rejects(async () => await manager.execute(installed.id, 'dsh_clean', ' hi '), code('PLUGIN_DISABLED'));
    await assert.rejects(async () => await manager.enable(installed.id), code('APPROVAL_REQUIRED'));
    manager.approve(installed.id, installed.digest);
    const enabled = await manager.enable(installed.id);
    assert.equal(enabled.enabled, true);
    assert.deepEqual(enabled.manifest.operations.map(operation => operation.id), ['dsh_clean']);
    const result = await manager.execute(installed.id, 'dsh_clean', ' a\r\nb\rc ');
    assert.equal(result.output, 'a\nb\nc');
    assert.equal(result.digest, installed.digest);
    assert.deepEqual(result.renderedContent, [{ type: 'text', text: 'a\nb\nc' }]);
    assert.equal((await manager.execute(installed.id, 'dsh_clean', ' 中文\r\nx ')).output, '中文\nx');
    assert.deepEqual(result.lifecycle, {
      toolsRegistered: 1, toolsDisposed: 1, effectsRegistered: 2, effectsDisposed: 2, applyDisposed: 1,
      disposalOrder: ['apply', 'effect-b', 'effect-a', 'tool:dsh_clean'],
    });
    const reopened = new PluginManager(dataDir);
    assert.equal((await reopened.execute(installed.id, 'dsh_clean', ' again ')).output, 'again');
    await reopened.disable(installed.id);
    reopened.remove(installed.id);
    assert.deepEqual(reopened.list(), []);
  } finally { cleanup(directory); }
});

test('installation never evaluates a module, and approved enable diagnoses top-level failure', async () => {
  const directory = temporary();
  try {
    const manager = new PluginManager(join(directory, 'data'));
    const installed = manager.install(fixture(directory, "throw new Error('Original fixture: importing this module is forbidden before approval.');\n"));
    assert.equal(installed.enabled, false);
    assert.deepEqual(installed.manifest.operations, []);
    assert.equal(installed.approvalValid, false);
    await assert.rejects(async () => await manager.enable(installed.id), code('APPROVAL_REQUIRED'));
    manager.approve(installed.id, installed.digest);
    await assert.rejects(async () => await manager.enable(installed.id), code('DSH_RUNTIME_FAILURE'));
    assert.equal(manager.list()[0]!.enabled, false);
  } finally { cleanup(directory); }
});

test('Config validation and configuration changes bind approval to the source and configuration artifact', async () => {
  const directory = temporary();
  try {
    const manager = new PluginManager(join(directory, 'data'));
    const enabled = await approved(manager, fixture(directory), { uppercase: true, prefix: '» ' });
    assert.equal((await manager.execute(enabled.id, 'dsh_clean', ' a\r\nb ')).output, '» A\nB');
    assert.throws(() => manager.configure(enabled.id, { uppercase: false }), code('PLUGIN_ENABLED'));
    await manager.disable(enabled.id);
    const configured = manager.configure(enabled.id, { uppercase: false, prefix: 'new: ' });
    assert.notEqual(configured.digest, enabled.digest);
    assert.notEqual(configured.runtime!.configDigest, enabled.runtime!.configDigest);
    assert.equal(configured.runtime!.sourceDigest, enabled.runtime!.sourceDigest);
    assert.equal(configured.approvalValid, false);
    assert.equal(configured.approvedDigest, undefined);
    await assert.rejects(async () => await manager.enable(enabled.id), code('APPROVAL_REQUIRED'));
    manager.approve(configured.id, configured.digest);
    await manager.enable(configured.id);
    assert.equal((await manager.execute(configured.id, 'dsh_clean', ' hello ')).output, 'new: hello');
    await manager.disable(configured.id);
    const invalid = manager.configure(configured.id, { uppercase: 'yes' });
    manager.approve(invalid.id, invalid.digest);
    await assert.rejects(async () => await manager.enable(invalid.id), code('INVALID_CONFIG'));
    assert.equal(manager.list()[0]!.enabled, false);
    const unknown = manager.configure(invalid.id, { extra: true });
    manager.approve(unknown.id, unknown.digest);
    await assert.rejects(async () => await manager.enable(unknown.id), code('INVALID_CONFIG'));
    await assert.rejects(async () => await approved(manager, fixture(directory, originalSource, {}, 'promiseconfig'), { uppercase: Promise.resolve(true) }), code('INVALID_CONFIG'));
  } finally { cleanup(directory); }
});

test('installed source is an independent artifact, and changing that artifact revokes old approval', async () => {
  const directory = temporary();
  try {
    const dataDir = join(directory, 'data');
    const manager = new PluginManager(dataDir);
    const sourceDir = fixture(directory);
    const installed = await approved(manager, sourceDir);
    writeFileSync(join(sourceDir, 'index.js'), "throw new Error('Original fixture changed after installation.');\n");
    assert.equal((await manager.execute(installed.id, 'dsh_clean', ' hello ')).output, 'hello');
    const storedPath = join(dataDir, 'plugins', installed.id, 'plugin.json');
    const stored = JSON.parse(readFileSync(storedPath, 'utf8'));
    stored.dsh.source += '\n// Original test mutates the installed source artifact.\n';
    writeFileSync(storedPath, JSON.stringify(stored));
    assert.equal(manager.list()[0]!.approvalValid, false);
    assert.notEqual(manager.list()[0]!.runtime!.sourceDigest, installed.runtime!.sourceDigest);
    await assert.rejects(async () => await manager.execute(installed.id, 'dsh_clean', ' hello '), code('APPROVAL_REQUIRED'));
    assert.throws(() => manager.approve(installed.id, installed.digest), code('ARTIFACT_CHANGED'));
  } finally { cleanup(directory); }
});

test('effect disposers run once even when explicitly invoked twice before reverse cleanup', async () => {
  const directory = temporary();
  try {
    const source = `
      import { defineTool } from '@deepseek-ai/dsh-tools';
      export const name = 'one-shot-effects';
      export const inject = ['tools'];
      export function apply(ctx) {
        let disposed = 0;
        const early = ctx.effect(() => () => { if (++disposed !== 1) throw new Error('Repeated effect disposal.'); }, 'early');
        early(); early();
        ctx.tools.register(defineTool({
          name: 'dsh_clean', description: 'Return text after an explicitly disposed effect.',
          parameters: { text: { type: 'string', required: true } },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute(args) { if (disposed !== 1) throw new Error('Effect did not dispose.'); return args.text; }
        }));
        return () => { if (disposed !== 1) throw new Error('Effect repeated during final disposal.'); };
      }
    `;
    const manager = new PluginManager(join(directory, 'data'));
    const enabled = await approved(manager, fixture(directory, source));
    const result = await manager.execute(enabled.id, 'dsh_clean', 'same');
    assert.equal(result.output, 'same');
    assert.equal(result.lifecycle!.effectsRegistered, 1);
    assert.equal(result.lifecycle!.effectsDisposed, 1);
    assert.equal(result.lifecycle!.applyDisposed, 1);
    assert.equal(result.lifecycle!.toolsDisposed, 1);
    assert.deepEqual(result.lifecycle!.disposalOrder, ['early', 'apply', 'tool:dsh_clean']);
  } finally { cleanup(directory); }
});

test('unsupported dependencies, service injection, imports and permissions are rejected', async context => {
  const directory = temporary();
  const diagnostic = dshDiagnostic(context, directory);
  let observedManager: PluginManager | undefined;
  try {
    const manager = new PluginManager(join(directory, 'data'));
    observedManager = manager; approvedObservers.set(manager, diagnostic);
    const cases = [
      { label: 'dependencies', source: originalSource, changes: { dependencies: { 'unavailable-own-fixture-package': '1.0.0' } }, expected: 'UNSUPPORTED_DEPENDENCY' },
      { label: 'permission', source: originalSource, changes: { dsh: { manifestVersion: 1, permissions: ['network'] } }, expected: 'DENIED_PERMISSION' },
      { label: 'inject', source: originalSource.replace("['tools']", "['tools', 'fs']"), changes: {}, expected: 'UNSUPPORTED_API' },
      { label: 'fsimport', source: "import fs from 'node:fs';\n" + originalSource, changes: {}, expected: 'UNSUPPORTED_IMPORT' },
      { label: 'netimport', source: "import http from 'node:http';\n" + originalSource, changes: {}, expected: 'UNSUPPORTED_IMPORT' },
      { label: 'relativeimport', source: "import './not-installed.js';\n" + originalSource, changes: {}, expected: 'UNSUPPORTED_IMPORT' },
    ];
    for (const item of cases) {
      const source = fixture(directory, item.source, item.changes, item.label);
      await context.test(item.label, async () => {
        diagnostic.begin(item.label, item.expected);
        try {
          await assert.rejects(async () => await approved(manager, source), code(item.expected));
        } catch (error) { diagnostic.failure(error); throw error; }
        finally { diagnostic.end(); }
      });
    }
  } catch (error) { diagnostic.failure(error); throw error; }
  finally {
    if (observedManager) approvedObservers.delete(observedManager);
    diagnostic.finish(() => cleanup(directory, diagnostic));
  }
});

test('runtime has no process, filesystem or network globals and blocks constructor code generation', async () => {
  const directory = temporary();
  try {
    const manager = new PluginManager(join(directory, 'data'));
    const inspectSource = originalSource.replace(
      "const clean = args.text.replace(/\\r\\n?/g, '\\n').trim();",
      "const clean = [typeof process, typeof require, typeof fetch, typeof WebSocket].join('|');",
    );
    assert.notEqual(inspectSource, originalSource);
    const inspect = await approved(manager, fixture(directory, inspectSource, {}, 'globals'));
    assert.equal((await manager.execute(inspect.id, 'dsh_clean', 'unused')).output, 'undefined|undefined|undefined|undefined');
    const constructorSource = originalSource.replace(
      "const clean = args.text.replace(/\\r\\n?/g, '\\n').trim();",
      "const clean = ({}).constructor.constructor('return process')().platform;",
    );
    assert.notEqual(constructorSource, originalSource);
    const constructor = await approved(manager, fixture(directory, constructorSource, {}, 'constructor'));
    await assert.rejects(async () => await manager.execute(constructor.id, 'dsh_clean', 'unused'), code('DSH_RUNTIME_FAILURE'));
    for (const [label, facade] of [['toolbridge', 'ctx.tools.register'], ['tooldefinition', 'defineTool'], ['configbridge', 'Schema.object']]) {
      const facadeSource = originalSource.replace(
        "const clean = args.text.replace(/\\r\\n?/g, '\\n').trim();",
        `const clean = ${facade}.constructor('return typeof process')();`,
      );
      const bridge = await approved(manager, fixture(directory, facadeSource, {}, label));
      await assert.rejects(async () => await manager.execute(bridge.id, 'dsh_clean', 'unused'), code('DSH_RUNTIME_FAILURE'), label);
    }
    const processSource = originalSource.replace(
      "const clean = args.text.replace(/\\r\\n?/g, '\\n').trim();", "const clean = process.cwd();",
    );
    const process = await approved(manager, fixture(directory, processSource, {}, 'process'));
    await assert.rejects(async () => await manager.execute(process.id, 'dsh_clean', 'unused'), code('DSH_RUNTIME_FAILURE'));
    const fetchSource = originalSource.replace(
      "const clean = args.text.replace(/\\r\\n?/g, '\\n').trim();", "const clean = fetch('https://invalid.localhost/');",
    );
    const network = await approved(manager, fixture(directory, fetchSource, {}, 'network'));
    await assert.rejects(async () => await manager.execute(network.id, 'dsh_clean', 'unused'), code('DSH_RUNTIME_FAILURE'));
  } finally { cleanup(directory); }
});

test('approved own modules and tools with infinite loops fail within a bounded runtime deadline', async () => {
  const directory = temporary();
  try {
    const manager = new PluginManager(join(directory, 'data'));
    const module = manager.install(fixture(directory, 'while (true) {}\n', {}, 'moduleloop'));
    manager.approve(module.id, module.digest);
    let started = Date.now();
    await assert.rejects(async () => await manager.enable(module.id), code('DSH_TIMEOUT'));
    assert.ok(Date.now() - started < 15_000, 'module evaluation deadline must be bounded');
    assert.equal(manager.list().find(item => item.id === module.id)!.enabled, false);
    const toolSource = originalSource.replace(
      "const clean = args.text.replace(/\\r\\n?/g, '\\n').trim();", "while (true) {} const clean = '';",
    );
    const tool = await approved(manager, fixture(directory, toolSource, {}, 'toolloop'));
    started = Date.now();
    await assert.rejects(async () => await manager.execute(tool.id, 'dsh_clean', 'unused'), code('DSH_TIMEOUT'));
    assert.ok(Date.now() - started < 15_000, 'tool execution deadline must be bounded');
  } finally { cleanup(directory); }
});

test('typed tool input and string output limits reject malformed calls', async () => {
  const directory = temporary();
  try {
    const manager = new PluginManager(join(directory, 'data'));
    const enabled = await approved(manager, fixture(directory));
    await assert.rejects(async () => await manager.execute(enabled.id, 'dsh_clean', 123 as unknown as string), code('INVALID_INPUT'));
    await assert.rejects(async () => await manager.execute(enabled.id, 'dsh_clean', 'x'.repeat(1_048_577)), code('INVALID_INPUT'));
    const badOutput = originalSource.replace("return config.prefix + (config.uppercase ? clean.toUpperCase() : clean);", 'return 123;');
    const wrong = await approved(manager, fixture(directory, badOutput, {}, 'wrongoutput'));
    await assert.rejects(async () => await manager.execute(wrong.id, 'dsh_clean', 'hello'), code('INVALID_OUTPUT'));
  } finally { cleanup(directory); }
});
