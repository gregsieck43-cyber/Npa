export const REQUEST_IMPORT_BYTES = 1024 * 1024;

export function requestObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求 Body 必须是 JSON 对象');
  return value as Record<string, unknown>;
}

export async function readRequestFile(file: File): Promise<Record<string, unknown>> {
  if (file.size > REQUEST_IMPORT_BYTES) throw new Error('请求文件不能超过 1 MiB');
  return requestObject(await file.text());
}

/** Every download is one bounded artifact. Export cursors stay on the server. */
export function downloadJson(name: string, value: unknown, maxBytes = 4 * 1024 * 1024) {
  const text = JSON.stringify(value, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  if (blob.size > maxBytes) throw new Error('此页超过导出大小限制，请减小页面后重试');
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
