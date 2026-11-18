/** 子序列模糊匹配：返回得分与命中下标；连续命中与词首命中加分。未命中返回 undefined。 */
export function fuzzy(query: string, text: string): { score: number; hits: number[] } | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const t = text.toLowerCase(), hits: number[] = [];
  let score = 0, from = 0, streak = 0;
  for (const char of q) {
    if (char === ' ') continue;
    const index = t.indexOf(char, from);
    if (index < 0) return undefined;
    streak = hits.length && index === hits[hits.length - 1] + 1 ? streak + 1 : 0;
    const wordStart = index === 0 || /[\s/_\-.·]/.test(t[index - 1]);
    score += 1 + streak * 2 + (wordStart ? 3 : 0) - Math.min(index - from, 6) * 0.15;
    hits.push(index);
    from = index + 1;
  }
  if (t.startsWith(q)) score += 6;
  return { score, hits };
}
