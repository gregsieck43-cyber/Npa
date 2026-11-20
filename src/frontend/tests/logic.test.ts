import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, decideForMode, permissionModes, reviewEscalates } from '../api/policy';
import { applyReasoningMapping, defaultLevel, inferModelLimits, levelColor, reasoningLabel } from '../lib/models';
import { lineDiff, diffStats } from '../lib/diff';
import { dateGroup, duration, relativeTime } from '../lib/format';
import { fuzzy } from '../lib/fuzzy';
import { highlight } from '../lib/highlight';
import { parseInline, parseMarkdown } from '../lib/markdown';
import { hostOf, toTarget } from '../lib/panel';
import { idleCompressor } from '../lib/trace';

test('权限模式：读取始终放行，只读拒绝一切副作用', () => {
  for (const mode of permissionModes) assert.equal(decide(mode.id, 'read', 'high'), 'allow');
  for (const cap of ['write', 'exec', 'network', 'mcp'] as const) assert.equal(decide('read-only', cap, 'low'), 'deny');
  assert.equal(decide('read-only', 'exec', 'critical'), 'deny');
});

test('权限模式：询问 / 自动审查 / 完全访问 的分支', () => {
  assert.equal(decide('ask', 'write', 'low'), 'ask');
  assert.equal(decide('auto-review', 'write', 'low'), 'allow');
  assert.equal(decide('auto-review', 'write', 'medium'), 'review');
  assert.equal(decide('full-access', 'exec', 'high'), 'allow');
  assert.equal(decide('full-access', 'exec', 'critical'), 'ask', '关键操作在完全访问下也需要确认');
  assert.equal(decide('auto-review', 'exec', 'critical'), 'review', '自动审查下关键操作交给审查器');
  assert.equal(reviewEscalates('high', 'high'), true);
  assert.equal(reviewEscalates('medium', 'high'), false);
});

test('Chat 模式与权限模式无关：只放行读取与联网检索', () => {
  for (const mode of permissionModes) {
    assert.equal(decideForMode('chat', mode.id, 'network', 'low'), 'allow');
    assert.equal(decideForMode('chat', mode.id, 'read', 'low'), 'allow');
    for (const cap of ['write', 'exec'] as const) assert.equal(decideForMode('chat', mode.id, cap, 'low'), 'deny');
    assert.equal(decideForMode('chat', mode.id, 'mcp', 'low'), 'allow');
    assert.equal(decideForMode('chat', mode.id, 'mcp', 'high'), 'deny');
  }
  assert.equal(decideForMode('code', 'ask', 'write', 'low'), decide('ask', 'write', 'low'));
});

test('模型配置：智能推断、推理等级名称、渐变与参数映射', () => {
  assert.deepEqual(inferModelLimits('z-ai/glm-5.3-flash'), { contextWindow: 1_000_000, maxOutputTokens: 131_072 });
  assert.equal(inferModelLimits('unknown/model-x'), undefined);
  assert.equal(reasoningLabel('high'), '高');
  assert.equal(reasoningLabel('max'), '极限');
  assert.equal(reasoningLabel('turbo'), 'turbo');
  assert.equal(levelColor(0), 'rgb(168, 162, 150)');
  assert.equal(levelColor(0.5), 'rgb(215, 119, 87)', '中档为 Claude 陶土橙');
  assert.equal(levelColor(1), 'rgb(160, 68, 46)');
  assert.deepEqual(applyReasoningMapping({ thinking: { type: 'enabled', effort: '{{level}}' }, list: ['{{level}}', 3] }, 'max'), { thinking: { type: 'enabled', effort: 'max' }, list: ['max', 3] });
  assert.equal(defaultLevel(['low', 'high', 'max']), 'high');
  assert.equal(defaultLevel(['only']), 'only');
  assert.equal(defaultLevel([]), undefined);
});

test('侧边面板地址栏：网址补全协议，其余作为搜索', () => {
  assert.equal(toTarget('https://example.com/a'), 'https://example.com/a');
  assert.equal(toTarget('docs.example.com/guide'), 'https://docs.example.com/guide');
  assert.equal(toTarget('localhost:5199'), 'http://localhost:5199', '本地开发地址直接打开');
  assert.equal(toTarget('readme'), 'search:readme');
  assert.equal(toTarget('  electron 安全实践 '), 'search:electron 安全实践');
  assert.equal(hostOf('https://www.example.com/x'), 'example.com');
  assert.equal(hostOf('search:react'), '搜索：react');
});

test('行级 Diff 保留上下文并正确计数', () => {
  const lines = lineDiff('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(lines.map(l => `${l.kind}:${l.text}`), ['ctx:a', 'del:b', 'add:B', 'ctx:c', 'add:d']);
  assert.deepEqual(diffStats(lines), { additions: 2, deletions: 1 });
  assert.deepEqual(lineDiff('same', 'same').map(l => l.kind), ['ctx']);
});

test('模糊匹配：子序列命中、词首加分、不命中返回 undefined', () => {
  assert.equal(fuzzy('xyz', 'open settings'), undefined);
  const hit = fuzzy('ops', 'open settings')!;
  assert.deepEqual(hit.hits, [0, 1, 5]);
  assert.ok(fuzzy('set', 'settings')!.score > fuzzy('set', 'reset items')!.score);
});

test('Markdown：块级结构与行内格式，不信任非 http 链接', () => {
  const blocks = parseMarkdown('### 标题\n\n- a\n- **b**\n\n```ts\nconst x = 1;\n```\n\n| h1 | h2 |\n| --- | --- |\n| 1 | 2 |\n\n> 引用');
  assert.deepEqual(blocks.map(b => b.t), ['heading', 'list', 'code', 'table', 'quote']);
  const code = blocks[2] as Extract<(typeof blocks)[number], { t: 'code' }>;
  assert.equal(code.lang, 'ts');
  assert.equal(code.open, false);
  assert.equal((parseMarkdown('```js\nlet a')[0] as { open: boolean }).open, true, '流式中未闭合的代码块标记为 open');
  const unsafe = parseInline('[x](javascript:alert(1))');
  assert.ok(unsafe.every(node => node.t === 'text'), '非 http 链接不生成可点击链接');
  assert.equal(unsafe.map(node => (node.t === 'text' ? node.v : '')).join(''), '[x](javascript:alert(1))');
  assert.equal(parseInline('[文档](https://example.com)')[0].t, 'link');
});

test('语法着色：Rust 生命周期不被当作字符串', () => {
  const tokens = highlight("fn f<'a>(x: &'a str) -> char { 'z' }", 'rust');
  assert.ok(!tokens.some(t => t.k === 'str' && t.v.includes('a>')));
  assert.ok(tokens.some(t => t.k === 'str' && t.v === "'z'"));
  assert.ok(highlight("const s = 'hi';", 'ts').some(t => t.k === 'str' && t.v === "'hi'"));
});

test('格式化：相对时间、时长与日期分组', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  assert.equal(relativeTime('2026-10-19T11:59:40Z', now), '刚刚');
  assert.equal(relativeTime('2026-10-19T11:30:00Z', now), '30 分钟前');
  assert.equal(duration(950), '950ms');
  assert.equal(duration(4200), '4.2s');
  assert.equal(duration(125_000), '2m 5s');
  const today = new Date(2026, 9, 19, 15);
  assert.equal(dateGroup(new Date(2026, 9, 19, 9).toISOString(), today), '今天');
  assert.equal(dateGroup(new Date(2026, 9, 18, 9).toISOString(), today), '昨天');
});

test('Trace 空闲压缩：长空闲折叠，回合内部时间不变', () => {
  const spans = [
    { id: 'a', type: 'turn' as const, label: 'a', status: 'ok' as const, startMs: 120_000, durationMs: 10_000 },
    { id: 'a1', parentId: 'a', type: 'tool' as const, label: 'a1', status: 'ok' as const, startMs: 121_000, durationMs: 2_000 },
    { id: 'b', type: 'turn' as const, label: 'b', status: 'ok' as const, startMs: 3_000_000, durationMs: 8_000 },
  ];
  const { map, folded } = idleCompressor(spans, true);
  assert.equal(folded, 1);
  assert.equal(map(121_000) - map(120_000), 1_000);
  assert.ok(map(3_000_000) - map(130_000) < 2_000, '空闲被折叠为短间隔');
  assert.equal(idleCompressor(spans, false).map(3_000_000), 3_000_000);
});
