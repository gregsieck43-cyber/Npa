/** 模型配置与推理强度相关的纯函数（界面、演示网关与测试共用）。 */

/** 智能配置：按模型 ID 推断上下文窗口与最大输出；未知模型返回 undefined，由用户手填。 */
const limits: [RegExp, { contextWindow: number; maxOutputTokens: number }][] = [
  [/glm-5/i, { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  [/deepseek/i, { contextWindow: 128_000, maxOutputTokens: 8_192 }],
  [/claude/i, { contextWindow: 200_000, maxOutputTokens: 64_000 }],
  [/gemini/i, { contextWindow: 1_000_000, maxOutputTokens: 65_536 }],
  [/gpt-|o\d/i, { contextWindow: 400_000, maxOutputTokens: 128_000 }],
  [/qwen/i, { contextWindow: 256_000, maxOutputTokens: 32_768 }],
];

export function inferModelLimits(modelId: string) {
  return limits.find(([pattern]) => pattern.test(modelId))?.[1];
}

const levelNames: Record<string, string> = {
  none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '极限',
};

export const reasoningLabel = (level: string) => levelNames[level.toLowerCase()] ?? level;

/** 暖色同色系色阶（参照 Claude 陶土橙）：石灰 → 浅陶土 → 陶土橙 → 深陶土 → 赭红；fraction 为 0–1。 */
const stops: [number, number, number][] = [[168, 162, 150], [214, 168, 140], [215, 119, 87], [190, 94, 64], [160, 68, 46]];

export function levelColor(fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), t = f - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(', ')})`;
}

/** 截取到当前位置的渐变，用作滑轨填充。 */
export function levelGradient(fraction: number): string {
  const count = Math.max(2, Math.round(fraction * 4) + 1);
  return `linear-gradient(90deg, ${Array.from({ length: count }, (_, i) => levelColor((i / (count - 1)) * fraction)).join(', ')})`;
}

/** 把推理参数映射模板中的 {{level}} 替换为所选等级。 */
export function applyReasoningMapping(mapping: unknown, level: string): unknown {
  if (typeof mapping === 'string') return mapping.replaceAll('{{level}}', level);
  if (Array.isArray(mapping)) return mapping.map(item => applyReasoningMapping(item, level));
  if (mapping && typeof mapping === 'object') return Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, applyReasoningMapping(v, level)]));
  return mapping;
}

/** 等级的默认选择：缺省取次高档，只有一档时取该档。 */
export function defaultLevel(levels: string[]): string | undefined {
  return levels.length ? levels[Math.max(0, levels.length - 2)] : undefined;
}
