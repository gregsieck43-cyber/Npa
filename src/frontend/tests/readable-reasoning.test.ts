/**
 * 可读思考（MessagePart reasoning）展示契约 —— 真实组件（features/session/Message）静态渲染回归。
 *
 * 覆盖用户 2026-10-30 明确要求的最小交互语义中的初始状态与文字准确性：
 * 流式默认展开、终态/历史默认收起、缺时长不显示“0 秒”或“—”、思考文本按纯文本安全显示、无 reasoning 不出现区域。
 * 点击折叠/展开、手动选择在流式结束后的保持、正文复制不混入思考，由局部真实 DOM 测试
 * （evidence/backend-20261026/readable-reasoning-ui-20261030/harness，esbuild + Electron + Playwright 实际点击）覆盖。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
// 这里只能用 react-dom 的浏览器构建：tests 由 esbuild 以 ESM 打进单文件后由 Node 执行，
// server.node 构建内部的 require('stream') 在 ESM 单文件里无法解析。
// @ts-expect-error react-dom 官方类型只声明了 server/node 入口，浏览器入口运行时存在。
import { renderToStaticMarkup } from 'react-dom/server.browser';
import type { ChatMessage, MessagePart } from '../api/types';

/**
 * bridge 构建的 api/index 在模块求值时要求 Electron preload 的 window.npn；
 * app 模块还会读取 localStorage 与 matchMedia。这里只提供不会发起请求的桩，绝不伪造后端数据。
 */
const noop = () => {};
const never = async (): Promise<never> => { throw new Error('readable-reasoning.test.ts: 不应发起网关请求'); };
const storage = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    npn: { request: never, desktop: never },
    localStorage: storage,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  },
});

const { Message } = await import('../features/session/Message');

const assistant = (parts: MessagePart[], status: ChatMessage['status'] = 'done'): ChatMessage => ({
  id: 'assistant-1', role: 'assistant', createdAt: '2026-10-30T00:00:00.000Z', status, parts,
});

const html = (message: ChatMessage): string =>
  renderToStaticMarkup(createElement(Message, { message, sessionId: 'session-1', isLast: true }));

test('streaming reasoning 首帧展开，aria-expanded/aria-controls 指向可读正文', () => {
  const markup = html(assistant([{ kind: 'reasoning', text: '先确认 MessagePart 契约，再改 Reasoning 组件。' }], 'streaming'));
  assert.match(markup, /class="reasoning is-open"/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /正在思考…/);
  assert.match(markup, /reasoning__body/);
  assert.ok(markup.includes('先确认 MessagePart 契约，再改 Reasoning 组件。'), '思考正文必须真实可见');
  const controls = /aria-controls="([^"]+)"/.exec(markup)?.[1];
  assert.ok(controls, '展开按钮必须用 aria-controls 指向内容区域');
  assert.ok(markup.includes(`id="${controls}"`), '内容区域 id 必须与 aria-controls 一致');
  assert.doesNotMatch(markup, /已思考/);
});

test('终态缺少时长时显示准确的“思考过程”，不显示已思考/0/—', () => {
  const markup = html(assistant([{ kind: 'reasoning', text: '历史思考内容' }]));
  assert.match(markup, /aria-expanded="false"/, '终态默认收起');
  assert.match(markup, />思考过程</);
  assert.doesNotMatch(markup, /已思考/);
  assert.doesNotMatch(markup, /正在思考/);
  assert.doesNotMatch(markup, /—|0ms|0\.0s/);
  assert.doesNotMatch(markup, /reasoning__body/, '收起时不应渲染正文');
});

test('有 durationMs 时沿用既有“已思考 X”文案，并默认收起', () => {
  const markup = html(assistant([{ kind: 'reasoning', text: '思考', durationMs: 4200 }]));
  assert.match(markup, /已思考 4\.2s/);
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /reasoning__body/);
});

test('被中断的思考不冒充已完成，也不冒充仍在思考', () => {
  const markup = html(assistant([{ kind: 'reasoning', text: '被打断的思考' }], 'cancelled'));
  assert.match(markup, /思考过程/);
  assert.doesNotMatch(markup, /已思考|正在思考/);
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /reasoning__body/);
});

test('思考文本按纯文本安全显示，不当作 HTML', () => {
  const text = '<img src=x onerror="globalThis.__pwned=1"><b>不是粗体</b>\n第二行';
  const markup = html(assistant([{ kind: 'reasoning', text }], 'streaming'));
  assert.ok(markup.includes('&lt;img src=x onerror='), '小于号必须被转义');
  assert.doesNotMatch(markup, /<img|<b>|<script/i, '不得生成真实 HTML 标签');
  assert.ok(markup.includes('&lt;b&gt;不是粗体&lt;/b&gt;'));
  assert.ok(markup.includes('第二行'));
});

test('没有 reasoning part 时不出现思考区域', () => {
  const markup = html(assistant([{ kind: 'text', text: '只有正文' }]));
  assert.doesNotMatch(markup, /reasoning|思考过程|正在思考/);
  assert.ok(markup.includes('只有正文'));
});

test('reasoning 与 notice、正文并存且顺序不变', () => {
  const markup = html(assistant([
    { kind: 'reasoning', text: '内部推理', durationMs: 1200 },
    { kind: 'notice', tone: 'warn', text: '工具提示保持' },
    { kind: 'text', text: '正文答案' },
  ]));
  assert.match(markup, /已思考 1\.2s/);
  assert.match(markup, /notice--warn/);
  assert.ok(markup.includes('工具提示保持'));
  assert.ok(markup.includes('正文答案'));
  assert.doesNotMatch(markup, /reasoning__body/, '历史 reasoning 默认收起，正文不受影响');
  assert.ok(markup.indexOf('已思考 1.2s') < markup.indexOf('工具提示保持'), 'reasoning 保持在正文/提示之前');
});
