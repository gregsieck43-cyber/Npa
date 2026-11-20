import { authHeaders, endpoint, wireSettings, type WireSettings } from './provider-wire.js';

import type { DiscoveredModel } from '../provider-types.js';
export async function discoverModels(baseUrl: string, wire: WireSettings, key?: string): Promise<DiscoveredModel[]> {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('请输入 HTTPS API 基址。');
  const settings = wireSettings(wire);
  const first = endpoint({ baseUrl, wire: settings, mode: 'live', model: '', timeoutMs: 0, maxOutputTokens: 0 }, true);
  const models = new Map<string, DiscoveredModel>(), visited = new Set<string>();
  const signal = AbortSignal.timeout(15000);
  let next: URL | undefined = first, total = 0;
  while (next) {
    if (visited.size >= 100 || visited.has(next.href)) throw new Error('模型目录分页异常。');
    visited.add(next.href);
    const response = await fetch(next, { signal, redirect: 'error', headers: authHeaders(settings, key) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('读取模型目录失败，HTTP ' + response.status); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 8_000_000) throw new Error('模型列表过大。');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const page = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(page.data)) throw new Error('模型目录缺少 data 列表，可手动输入模型 ID。');
    for (const row of page.data) {
      if (!row || typeof row.id !== 'string' || row.id.length > 200 || !row.id.trim()) continue;
      const positive = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
      const inputs = row.architecture?.input_modalities ?? row.input_modalities;
      models.set(row.id, { id: row.id, contextWindow: positive(row.context_length ?? row.context_window ?? row.max_input_tokens),
        maxOutputTokens: positive(row.top_provider?.max_completion_tokens ?? row.max_output_tokens),
        inputTypes: Array.isArray(inputs) ? inputs.filter(v => ['text','image','video','pdf'].includes(v)) : undefined });
    }
    next = undefined;
    if (page.has_more) {
      const cursor = page.last_id ?? page.data.at(-1)?.id;
      if (typeof cursor !== 'string') throw new Error('模型目录缺少下一页游标。');
      next = new URL(first); next.searchParams.set(settings.format === 'messages' || settings.protocol === 'messages' ? 'after_id' : 'after', cursor);
    }
  }
  return [...models.values()];
}
