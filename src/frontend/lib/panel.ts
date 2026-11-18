/** 侧边面板地址栏：像网址的直接打开（缺省补 https://），否则作为搜索词（search: 前缀）。 */
export function toTarget(input: string) {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/\S*)?$/i.test(value)) return `http://${value}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(value)) return `https://${value}`;
  return `search:${value}`;
}

/** 标签标题：网址显示主机名，搜索显示“搜索：词”。 */
export function readableUrl(url: string) {
  try { return decodeURI(url); } catch { return url; }
}

export function hostOf(url: string) {
  if (url.startsWith('search:')) return `搜索：${url.slice(7)}`;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
