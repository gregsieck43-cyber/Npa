/**
 * 模型设置的数据刷新回归（真实动作层 + 假 IPC 路由）。
 *
 * 导入模型只写入后台配置，模型列表应该在再次打开 设置 → 模型 时读到，而不是要求重启整个应用。
 * 同时验证：迟到的列表读取不能覆盖期间已完成的保存/删除，也不能清掉用户草稿。
 * 这里只替换 window.npn 传输边界，不重画组件、不改布局。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelProfile, ModelProfileInput } from '../api/types';

const profile = (id: string, overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  id, name: 'Model ' + id, provider: 'fixture', model: 'fixture/' + id, mode: 'live',
  credentialPresent: true, autoConfig: true, inputTypes: ['text'], capabilities: ['structuredOutput'], reasoningLevels: ['low', 'high'],
  ...overrides,
});

interface Deferred { resolve(value: unknown): void }
const reads: Deferred[] = [];
let listed: ModelProfile[] = [profile('a')];
let deferReads = false;
let modelReads = 0;
const calls: string[] = [];

const npn = {
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    calls.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1/product/models') {
      modelReads += 1;
      if (deferReads) return new Promise(resolve => reads.push({ resolve }));
      return listed;
    }
    if (method === 'POST' && path === '/v1/product/models/save') {
      const input = body as ModelProfileInput;
      const saved = profile(input.id ?? 'saved-' + calls.length, { ...input, mode: input.mode ?? 'live' });
      listed = listed.some(item => item.id === saved.id) ? listed.map(item => (item.id === saved.id ? saved : item)) : [...listed, saved];
      return saved;
    }
    if (method === 'POST' && /^\/v1\/product\/models\/[^/]+\/remove$/.test(path)) {
      const id = decodeURIComponent(path.split('/')[4]);
      listed = listed.filter(item => item.id !== id);
      return undefined;
    }
    const route = path.split('?')[0];
    if (method === 'GET' && route === '/v1/product/connection') return { status: 'online', demo: false };
    if (method === 'GET' && route === '/v1/product/settings') {
      return {
        appearance: { theme: 'light', accent: 'blue', density: 'comfortable', motion: 'full', ambient: 'off', fontScale: 1 },
        defaults: { mode: 'chat' },
      };
    }
    if (method === 'GET' && route === '/v1/product/sessions') return { items: [] };
    if (method === 'GET' && route === '/v1/product/approvals') return [];
    if (method === 'GET' && route === '/v1/product/workspace/projects') return [];
    // 启动订阅会立即拉事件页；这里用永不返回的请求避免测试进程残留轮询定时器。
    if (method === 'GET' && route === '/v1/product/events') return new Promise(() => {});
    throw new Error('unexpected IPC request: ' + method + ' ' + path);
  },
  async desktop(): Promise<unknown> { return undefined; },
};

const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
};
(globalThis as any).window = {
  npn,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
(globalThis as any).document = { documentElement: { dataset: {} as Record<string, string>, style: { setProperty() {} } } };

// 测试包按 bridge 语义构建（scripts/test-frontend.mjs 注入 __NPN_GATEWAY__），
// 但模块在 import 时就会读取 window.npn，因此先装好传输桩再动态加载动作层。
const actions = await import('../app/actions');
const store = await import('../app/store');

async function until(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) assert.fail('timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('再次打开 设置 → 模型 会读取真实列表，不要求重启应用', async () => {
  deferReads = false;
  listed = [profile('a')];
  store.setState({ models: [profile('a')] });
  const before = modelReads;
  listed = [profile('a'), profile('b')];
  actions.openSettings('models');
  await until(() => store.getState().models.length === 2, 'reopening model settings reads the real list');
  assert.ok(modelReads > before, '打开模型设置必须发起真实模型列表读取');
  assert.deepEqual(store.getState().models.map(item => item.id), ['a', 'b']);
});

test('迟到的列表读取不会覆盖期间保存的模型', async () => {
  listed = [profile('a')];
  store.setState({ models: [profile('a')] });
  deferReads = true;
  reads.length = 0;
  actions.openSettings('models');
  await until(() => reads.length === 1, 'a model read is in flight');
  const saved = await actions.saveModel({ name: 'B', provider: 'fixture', model: 'fixture/b', mode: 'live', autoConfig: true, inputTypes: ['text'], capabilities: ['structuredOutput'], reasoningLevels: ['low'] });
  assert.ok(saved, '保存必须成功');
  reads[0].resolve([profile('a')]);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(store.getState().models.map(item => item.id).sort(), ['a', saved!.id], '迟到的旧列表不能删掉刚保存的模型');
  deferReads = false;
});

test('迟到的列表读取不会把期间删除的模型带回来', async () => {
  listed = [profile('a'), profile('b')];
  store.setState({ models: [profile('a'), profile('b')] });
  deferReads = true;
  reads.length = 0;
  actions.openSettings('models');
  await until(() => reads.length === 1, 'a model read is in flight');
  await actions.removeModel('a');
  assert.deepEqual(store.getState().models.map(item => item.id), ['b']);
  reads[0].resolve([profile('a'), profile('b')]);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(store.getState().models.map(item => item.id), ['b'], '迟到的旧列表不能恢复已删除模型');
  deferReads = false;
});

test('并发列表读取只有最新一次可以写入，旧响应不能删掉导入的模型', async () => {
  deferReads = true;
  reads.length = 0;
  listed = [profile('a')];
  store.setState({ models: [profile('a')] });
  const older = actions.refreshModels();
  const newer = actions.refreshModels();
  await until(() => reads.length === 2, 'two model reads are in flight');
  reads[1].resolve([profile('a'), profile('imported')]);
  await newer;
  assert.deepEqual(store.getState().models.map(item => item.id), ['a', 'imported']);
  reads[0].resolve([profile('a')]);
  await older;
  assert.deepEqual(store.getState().models.map(item => item.id), ['a', 'imported'], '较旧的读取不能覆盖较新的列表');
  deferReads = false;
});

test('启动读取的旧模型列表不能覆盖期间更新的刷新', async () => {
  deferReads = true;
  reads.length = 0;
  listed = [profile('a')];
  store.setState({ models: [profile('a')], booted: false, bootError: undefined });
  const booting = actions.boot();
  await until(() => reads.length === 1, 'boot model read is in flight');
  const refreshed = actions.refreshModels();
  await until(() => reads.length === 2, 'newer refresh is in flight');
  reads[1].resolve([profile('a'), profile('imported')]);
  await refreshed;
  assert.deepEqual(store.getState().models.map(item => item.id), ['a', 'imported']);
  reads[0].resolve([profile('a')]);
  await booting;
  assert.deepEqual(store.getState().models.map(item => item.id), ['a', 'imported'], '启动读取不能覆盖较新的刷新');
  assert.equal(store.getState().booted, true);
  deferReads = false;
});

test('列表刷新保留新会话草稿，不改动其他设置', async () => {
  listed = [profile('a'), profile('c', { contextWindow: 200_000 })];
  store.setState({ models: [profile('a')], draftModelId: 'a', draftReasoning: 'high', mode: 'chat' });
  deferReads = false;
  actions.openSettings('models');
  await until(() => store.getState().models.length === 2, 'refresh lands');
  assert.equal(store.getState().draftModelId, 'a');
  assert.equal(store.getState().draftReasoning, 'high');
  assert.equal(store.getState().mode, 'chat');
  assert.equal(store.getState().models[1].contextWindow, 200_000);
});
