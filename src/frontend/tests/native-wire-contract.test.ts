/**
 * 真实 loopback 后台 -> 原生桌面 helper -> BridgeGateway 契约测试。
 *
 * 旧红证（evidence/backend-20261026/native-array-wire-*）证明 BackendGateway 曾把真实
 * JSON 数组包装成 {value: [...]}，导致模型/热力图/项目列表全部错形。本测试不复用任何
 * 传输桩：真实 startBackend 只监听 127.0.0.1，BackendGateway 走真实 HTTP，BridgeGateway
 * 使用同一个原生 request。后台由主树 fresh tsc 产物提供，路径由 NPN_NETWORK_PRODUCT_BUILD
 * 指向；没有构建时明确 skip，不伪造成功。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { BackendGateway } from '../../desktop/backend-connection';
import { BridgeGateway } from '../api/bridge';
import type { ActivityDay, ModelProfile, ProjectView } from '../api/types';

const WORKTREE = process.cwd();
const BUILD_ROOT = path.resolve(process.env.NPN_NETWORK_PRODUCT_BUILD ?? path.join(WORKTREE, 'build'));
const BACKEND_MODULE = path.join(BUILD_ROOT, 'src', 'app', 'backend.js');
const READY = existsSync(BACKEND_MODULE);

interface RunningBackend {
  port: number;
  token: string;
  close(): Promise<void>;
}

test('真实后台的模型、指标与项目列表保持原形穿过原生 helper 和 BridgeGateway',
  { skip: READY ? false : '需要先用主树 fresh tsc 构建真实后台（NPN_NETWORK_PRODUCT_BUILD）', timeout: 120_000 },
  async t => {
    const fixture = mkdtempSync(path.join(WORKTREE, '.tmp', 'native-wire-contract-'));
    const dataDir = path.join(fixture, 'data');
    mkdirSync(dataDir, { recursive: true });
    const backendModule = await import(pathToFileURL(BACKEND_MODULE).href) as { startBackend(options: { dataDir: string; projectRoot: string }): Promise<RunningBackend> };
    const backend = await backendModule.startBackend({ dataDir, projectRoot: WORKTREE });
    t.after(async () => {
      await backend.close().catch(() => undefined);
      rmSync(fixture, { recursive: true, force: true });
    });
    const native = new BackendGateway({ dataDir, launch: async () => ({ port: backend.port, token: backend.token }) });
    await native.ensure();
    const bridge = new BridgeGateway({
      request: (method, route, body) => native.request(method, route, body),
      desktop: async () => undefined,
    });

    const models: ModelProfile[] = await bridge.settings.models();
    assert.ok(Array.isArray(models), '模型列表必须是数组，不能被包装成对象信封');
    assert.ok(models.length > 0, '默认提供方至少产生一个真实模型');
    for (const model of models) {
      assert.equal(typeof model.id, 'string');
      assert.equal(typeof model.name, 'string');
      assert.equal(typeof model.provider, 'string');
      assert.equal(typeof model.model, 'string');
      assert.ok(model.mode === 'mock' || model.mode === 'live');
      assert.equal(typeof model.credentialPresent, 'boolean');
    }

    const activity: ActivityDay[] = await bridge.metrics.activity(7);
    assert.ok(Array.isArray(activity), '活动热力图必须是 7 天数组');
    assert.equal(activity.length, 7);
    for (const day of activity) {
      assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
      for (const field of ['events', 'modelCalls', 'toolEffects', 'tasksCreated', 'tasksCompleted'] as const)
        assert.equal(typeof day[field], 'number', field);
    }

    // 通过真实后台登记一个临时项目，再验证项目列表不是对象信封。
    const workspace = path.join(fixture, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const opened = await native.request('POST', '/v1/workspaces/open', { path: workspace }) as { path?: unknown };
    assert.equal(typeof opened.path, 'string');
    const projects: ProjectView[] = await bridge.workspace.projects();
    assert.ok(Array.isArray(projects), '项目列表必须是数组');
    const project = projects.find(item => typeof item.path === 'string' && item.path.toLowerCase() === workspace.toLowerCase());
    assert.ok(project, '刚登记的项目必须出现在真实项目列表中');
    assert.equal(typeof project.id, 'string');
    assert.equal(typeof project.name, 'string');
    assert.equal(typeof project.lastOpenedAt, 'string');
    assert.equal(typeof project.sessions, 'number');

    // 成功对象保持对象；真实 HTTP 错误仍带准确 httpStatus/error。
    const connection = await bridge.connection();
    assert.equal(typeof connection.status, 'string');
    const missing = await native.request('GET', '/v1/product/definitely-not-a-route') as { httpStatus?: unknown; error?: unknown };
    assert.equal(missing.httpStatus, 404);
    assert.equal(typeof missing.error, 'string');
  });
