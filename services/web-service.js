import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { sanitizeSensitiveText, sanitizeSensitiveValue } from "../core/http.js";

export const DEFAULT_WEB_SETTINGS = {
  provider: "duckduckgo",
  fallbackProviders: ["duckduckgo"],
  searchMode: "local",
  providerStrategy: "api_first_fallback_duckduckgo",
  searchContextSize: "medium",
  fetchRenderFallback: true,
  providerPriority: ["custom", "tavily", "brave", "bing", "duckduckgo"],
  maxUses: 5,
  fetchTopResults: 2,
  cacheTtlSeconds: 1800,
  rateLimitPerMinute: 30,
  requestTimeoutMs: 15000,
  maxBytes: 2 * 1024 * 1024,
  maxTextChars: 60000,
  maxResults: 10,
  allowedDomains: [],
  blockedDomains: [],
  validateCitations: true,
  credibilityRanking: true,
  allowPrivateNetwork: false
};

export const WEB_PROVIDERS = ["duckduckgo", "brave", "bing", "tavily", "custom", "mock"];
export const WEB_SEARCH_MODES = ["local", "anthropic_native", "auto"];
export const WEB_PROVIDER_STRATEGIES = ["single", "api_first_fallback_duckduckgo"];
export const WEB_SEARCH_CONTEXT_SIZES = ["low", "medium", "high"];

export const SEARCH_CONTEXT_CONFIG = {
  low: {
    maxResults: 3,
    fetchTopResults: 0,
    snippetChars: 700,
    textChars: 0,
    description: "search snippets only"
  },
  medium: {
    maxResults: 8,
    fetchTopResults: 2,
    snippetChars: 1200,
    textChars: 6000,
    description: "search results plus short page extracts"
  },
  high: {
    maxResults: 12,
    fetchTopResults: 5,
    snippetChars: 1800,
    textChars: 12000,
    description: "more results plus longer page extracts"
  }
};

export const DEFAULT_PROVIDER_PRIORITY = ["custom", "tavily", "brave", "bing", "duckduckgo"];

const SOCIAL_OR_LOW_SIGNAL = [
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "pinterest.com",
  "quora.com",
  "reddit.com"
];

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeWebSettings(input = {}) {
  const provider = WEB_PROVIDERS.includes(input.provider) ? input.provider : DEFAULT_WEB_SETTINGS.provider;
  const searchMode = WEB_SEARCH_MODES.includes(input.searchMode) ? input.searchMode : DEFAULT_WEB_SETTINGS.searchMode;
  const providerStrategy = WEB_PROVIDER_STRATEGIES.includes(input.providerStrategy)
    ? input.providerStrategy
    : DEFAULT_WEB_SETTINGS.providerStrategy;
  const searchContextSize = WEB_SEARCH_CONTEXT_SIZES.includes(input.searchContextSize)
    ? input.searchContextSize
    : DEFAULT_WEB_SETTINGS.searchContextSize;
  return {
    provider,
    searchMode,
    providerStrategy,
    searchContextSize,
    fetchRenderFallback: input.fetchRenderFallback !== false,
    providerPriority: normalizeProviderPriority(input.providerPriority),
    fallbackProviders: Array.isArray(input.fallbackProviders)
      ? input.fallbackProviders.filter((item) => WEB_PROVIDERS.includes(item)).slice(0, 5)
      : DEFAULT_WEB_SETTINGS.fallbackProviders,
    maxUses: clampNumber(input.maxUses, 1, 20, DEFAULT_WEB_SETTINGS.maxUses),
    fetchTopResults: clampNumber(input.fetchTopResults, 0, 10, DEFAULT_WEB_SETTINGS.fetchTopResults),
    cacheTtlSeconds: clampNumber(input.cacheTtlSeconds, 0, 86400, DEFAULT_WEB_SETTINGS.cacheTtlSeconds),
    rateLimitPerMinute: clampNumber(input.rateLimitPerMinute, 1, 300, DEFAULT_WEB_SETTINGS.rateLimitPerMinute),
    requestTimeoutMs: clampNumber(input.requestTimeoutMs, 3000, 60000, DEFAULT_WEB_SETTINGS.requestTimeoutMs),
    maxBytes: clampNumber(input.maxBytes, 64 * 1024, 8 * 1024 * 1024, DEFAULT_WEB_SETTINGS.maxBytes),
    maxTextChars: clampNumber(input.maxTextChars, 4000, 200000, DEFAULT_WEB_SETTINGS.maxTextChars),
    maxResults: clampNumber(input.maxResults, 1, 30, DEFAULT_WEB_SETTINGS.maxResults),
    allowedDomains: normalizeDomainList(input.allowedDomains),
    blockedDomains: normalizeDomainList(input.blockedDomains),
    validateCitations: input.validateCitations !== false,
    credibilityRanking: input.credibilityRanking !== false,
    allowPrivateNetwork: input.allowPrivateNetwork === true || input.allowPrivate === true
  };
}

export function normalizeProviderPriority(input = []) {
  const raw = Array.isArray(input)
    ? input
    : String(input || "")
        .split(/[\s,;]+/g);
  const cleaned = raw
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => WEB_PROVIDERS.includes(item))
    .filter((item) => item !== "mock");
  const merged = [...cleaned, ...DEFAULT_PROVIDER_PRIORITY];
  return [...new Set(merged)].filter((item) => WEB_PROVIDERS.includes(item) && item !== "mock").slice(0, 5);
}

export function searchContextConfig(settings = {}) {
  const normalized = normalizeWebSettings(settings);
  const base = SEARCH_CONTEXT_CONFIG[normalized.searchContextSize] || SEARCH_CONTEXT_CONFIG.medium;
  return {
    size: normalized.searchContextSize,
    maxResults: Math.min(normalized.maxResults, base.maxResults),
    fetchTopResults: Math.min(normalized.fetchTopResults, base.fetchTopResults),
    snippetChars: base.snippetChars,
    textChars: base.textChars,
    description: base.description
  };
}

export function normalizeDomainList(input = []) {
  const list = Array.isArray(input)
    ? input
    : String(input || "")
        .split(/[\s,;]+/g);
  return [...new Set(list
    .map((item) => String(item || "").trim().toLowerCase())
    .map((item) => item.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/:?#]/)[0])
    .filter((item) => /^[a-z0-9.-]+$/i.test(item) && item.includes(".")))]
    .slice(0, 100);
}

export function hostMatchesDomain(hostname = "", domain = "") {
  const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
  const normalized = String(domain || "").toLowerCase().replace(/^www\./, "");
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function resultAllowedByDomainFilters(result = {}, settings = {}) {
  const normalized = normalizeWebSettings(settings);
  if (!normalized.allowedDomains.length && !normalized.blockedDomains.length) return true;
  let hostname = "";
  try {
    hostname = new URL(String(result.url || "")).hostname;
  } catch {
    return false;
  }
  if (normalized.blockedDomains.some((domain) => hostMatchesDomain(hostname, domain))) return false;
  if (normalized.allowedDomains.length && !normalized.allowedDomains.some((domain) => hostMatchesDomain(hostname, domain))) return false;
  return true;
}

export function webCacheStats(cache = {}) {
  const normalized = normalizeWebCache(cache);
  const nowMs = Date.now();
  const active = normalized.entries.filter((entry) => !entry.expiresAt || new Date(entry.expiresAt).getTime() > nowMs);
  return {
    entries: normalized.entries.length,
    active: active.length,
    expired: normalized.entries.length - active.length,
    bytes: Buffer.byteLength(JSON.stringify(normalized.entries || [])),
    updatedAt: normalized.updatedAt || ""
  };
}

export function clearWebCache(cache = {}, { expiredOnly = false } = {}) {
  const normalized = normalizeWebCache(cache);
  if (!expiredOnly) return { entries: [], updatedAt: new Date().toISOString() };
  const nowMs = Date.now();
  return {
    entries: normalized.entries.filter((entry) => !entry.expiresAt || new Date(entry.expiresAt).getTime() > nowMs),
    updatedAt: new Date().toISOString()
  };
}

export function normalizeWebCache(cache = {}) {
  const entries = Array.isArray(cache.entries) ? cache.entries : [];
  return {
    entries: entries
      .filter((entry) => entry && typeof entry.key === "string")
      .slice(-200)
      .map((entry) => ({
        key: String(entry.key),
        value: entry.value,
        expiresAt: entry.expiresAt || "",
        createdAt: entry.createdAt || new Date().toISOString()
      })),
    updatedAt: cache.updatedAt || ""
  };
}

export function makeCacheKey(kind, payload = {}) {
  return crypto.createHash("sha256").update(`${kind}:${JSON.stringify(payload)}`, "utf8").digest("hex");
}

export function getCached(cache, key, nowMs = Date.now()) {
  const entry = normalizeWebCache(cache).entries.find((item) => item.key === key);
  if (!entry) return null;
  if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= nowMs) return null;
  return entry.value ?? null;
}

export function putCached(cache, key, value, ttlSeconds, nowDate = new Date()) {
  const normalized = normalizeWebCache(cache);
  normalized.entries = normalized.entries.filter((entry) => entry.key !== key);
  if (ttlSeconds > 0) {
    normalized.entries.push({
      key,
      value,
      createdAt: nowDate.toISOString(),
      expiresAt: new Date(nowDate.getTime() + ttlSeconds * 1000).toISOString()
    });
  }
  normalized.entries = normalized.entries.slice(-200);
  normalized.updatedAt = nowDate.toISOString();
  return normalized;
}

export function createRateLimiter() {
  const buckets = new Map();
  return function checkRateLimit(scope, limitPerMinute = DEFAULT_WEB_SETTINGS.rateLimitPerMinute) {
    const nowMs = Date.now();
    const windowMs = 60_000;
    const key = String(scope || "web");
    const bucket = buckets.get(key) || [];
    const recent = bucket.filter((time) => nowMs - time < windowMs);
    if (recent.length >= limitPerMinute) {
      const retryAfterMs = windowMs - (nowMs - recent[0]);
      const error = new Error(`联网请求过于频繁，请 ${Math.ceil(retryAfterMs / 1000)} 秒后再试`);
      error.statusCode = 429;
      error.retryAfterMs = retryAfterMs;
      throw error;
    }
    recent.push(nowMs);
    buckets.set(key, recent);
  };
}

const IPV4_SPECIAL_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];

const IPV6_SPECIAL_CIDRS = [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
];

function stripIpBrackets(address = "") {
  const trimmed = String(address || "").trim().toLowerCase();
  const withoutBrackets = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return withoutBrackets.split("%")[0];
}

function ipv4ToInt(address = "") {
  const parts = String(address).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    value = (value * 256 + byte) >>> 0;
  }
  return value >>> 0;
}

function ipv4FromInt(value) {
  const safe = Number(value) >>> 0;
  return [safe >>> 24, (safe >>> 16) & 255, (safe >>> 8) & 255, safe & 255].join(".");
}

function ipv4InCidr(value, base, prefix) {
  const baseValue = ipv4ToInt(base);
  if (baseValue === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
}

function parseIpv6ToBigInt(address = "") {
  let normalized = stripIpBrackets(address);
  if (!normalized) return null;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4Value = ipv4ToInt(normalized.slice(lastColon + 1));
    if (lastColon < 0 || ipv4Value === null) return null;
    const high = ((ipv4Value >>> 16) & 0xffff).toString(16);
    const low = (ipv4Value & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  if (left.length + right.length > 8) return null;
  const zeros = halves.length === 2 ? Array(8 - left.length - right.length).fill("0") : [];
  const groups = halves.length === 2 ? [...left, ...zeros, ...right] : left;
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return value;
}

function ipv6InCidr(value, base, prefix) {
  const baseValue = parseIpv6ToBigInt(base);
  if (baseValue === null) return false;
  const shift = 128n - BigInt(prefix);
  return (value >> shift) === (baseValue >> shift);
}

function mappedIpv4FromIpv6(value) {
  if ((value >> 32n) !== 0xffffn) return "";
  return ipv4FromInt(Number(value & 0xffffffffn));
}

function isPrivateIp(address) {
  const normalized = stripIpBrackets(address);
  const ipVersion = net.isIP(normalized);
  if (!ipVersion) return true;
  if (ipVersion === 4) {
    const value = ipv4ToInt(normalized);
    return value === null || IPV4_SPECIAL_CIDRS.some(([base, prefix]) => ipv4InCidr(value, base, prefix));
  }
  const value = parseIpv6ToBigInt(normalized);
  if (value === null) return true;
  const mappedIpv4 = mappedIpv4FromIpv6(value);
  if (mappedIpv4 && isPrivateIp(mappedIpv4)) return true;
  return IPV6_SPECIAL_CIDRS.some(([base, prefix]) => ipv6InCidr(value, base, prefix));
}

async function resolvePublicAddress(url, settings = {}, options = {}) {
  const normalized = normalizeWebSettings(settings);
  const lookup = options.lookup || dns.lookup;
  const hostname = stripIpBrackets(url.hostname);
  if (!normalized.allowPrivateNetwork && (["localhost", "127.0.0.1", "::1"].includes(hostname) || hostname.endsWith(".local"))) {
    throw Object.assign(new Error("SSRF 防护：拒绝访问本机或局域网地址"), { statusCode: 403 });
  }
  if (normalized.allowPrivateNetwork) return null;
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw Object.assign(new Error("SSRF 防护：拒绝访问私有 IP 地址"), { statusCode: 403 });
    return { address: hostname, family: net.isIP(hostname) };
  }
  let records = [];
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error("域名解析失败"), { statusCode: 400, code: "dns_resolution_failed" });
  }
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw Object.assign(new Error("SSRF 防护：域名解析到本机或私有网络地址"), { statusCode: 403 });
  }
  const selected = records.find((record) => record && record.address && !isPrivateIp(record.address));
  return selected ? { address: stripIpBrackets(selected.address), family: Number(selected.family) || net.isIP(selected.address) } : null;
}

export async function assertPublicWebUrl(rawUrl, settings = {}, options = {}) {
  let url = null;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw Object.assign(new Error("URL 格式无效"), { statusCode: 400 });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(new Error("联网浏览只允许 http/https URL"), { statusCode: 400 });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error("URL 不允许携带内嵌凭据"), { statusCode: 400, code: "url_credentials_not_allowed" });
  }
  await resolvePublicAddress(url, settings, options);
  return url;
}

export async function fetchPublicUrl(rawUrl, fetchOptions = {}, settings = {}, options = {}) {
  const normalized = normalizeWebSettings(settings);
  const fetchImpl = options.fetchImpl;
  const maxRedirects = Math.min(10, Math.max(0, Number(options.maxRedirects ?? 5)));
  const redirects = [];
  let currentUrl = await assertPublicWebUrl(rawUrl, normalized, options);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Resolve immediately before connecting and pass that exact address to
    // the socket lookup callback. This closes the validate-then-resolve DNS
    // rebinding window for the production path. Injected fetches remain
    // available for deterministic tests and caller-owned transports.
    const resolvedAddress = await resolvePublicAddress(currentUrl, normalized, options);
    const response = fetchImpl
      ? await fetchImpl(currentUrl, { ...fetchOptions, redirect: "manual" })
      : await fetchPinnedUrl(currentUrl, fetchOptions, resolvedAddress, options.requestImpl);
    const status = Number(response.status || 0);
    if (![301, 302, 303, 307, 308].includes(status)) {
      return { response, finalUrl: currentUrl.toString(), redirects };
    }
    const location = response.headers?.get?.("location") || "";
    if (!location) return { response, finalUrl: currentUrl.toString(), redirects };
    const nextUrl = new URL(location, currentUrl);
    const validatedNext = await assertPublicWebUrl(nextUrl.toString(), normalized, options);
    redirects.push({ from: currentUrl.toString(), to: validatedNext.toString(), status });
    currentUrl = validatedNext;
  }

  throw Object.assign(new Error(`SSRF 防护：重定向超过 ${maxRedirects} 次`), { statusCode: 310 });
}

async function fetchPinnedUrl(url, fetchOptions = {}, resolvedAddress = null, requestImpl = null) {
  if (!resolvedAddress) {
    return fetch(url, { ...fetchOptions, redirect: "manual" });
  }
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const requestFactory = requestImpl || transport;
  const headers = new Headers(fetchOptions.headers || {});
  if (!headers.has("host")) headers.set("host", url.host);
  const requestHeaders = Object.fromEntries(headers.entries());
  const body = fetchOptions.body;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = requestFactory(url, {
      method: fetchOptions.method || "GET",
      headers: requestHeaders,
      signal: fetchOptions.signal,
      lookup: (_hostname, _lookupOptions, callback) => callback(null, resolvedAddress.address, resolvedAddress.family)
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("error", finishError);
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers || {})) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : String(value));
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode || 0,
          statusText: response.statusMessage || "",
          headers: responseHeaders
        }));
      });
    });
    request.on("error", finishError);
    if (fetchOptions.signal && !fetchOptions.signal.aborted) {
      fetchOptions.signal.addEventListener("abort", () => request.destroy(fetchOptions.signal.reason), { once: true });
    }
    if (body === undefined || body === null) request.end();
    else if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) request.end(body);
    else if (typeof body.pipe === "function") body.pipe(request);
    else request.end(String(body));
  });
}

export function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

export function htmlToText(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, done: () => clearTimeout(timer) };
}

export async function fetchWebPage(rawUrl, { settings = {}, cache = null, rateLimit = null } = {}) {
  const normalized = normalizeWebSettings(settings);
  const url = await assertPublicWebUrl(rawUrl, normalized);
  if (!resultAllowedByDomainFilters({ url: url.toString() }, normalized)) {
    throw Object.assign(new Error("URL blocked by web domain filters"), { statusCode: 403 });
  }
  rateLimit?.(`fetch:${url.hostname}`, normalized.rateLimitPerMinute);
  const cacheKey = makeCacheKey("fetch", { url: url.toString(), settings: { maxBytes: normalized.maxBytes, maxTextChars: normalized.maxTextChars } });
  const cached = cache ? getCached(cache, cacheKey) : null;
  if (cached) return { ...cached, cached: true, cacheKey };

  const { controller, done } = timeoutSignal(normalized.requestTimeoutMs);
  try {
    const { response, finalUrl, redirects } = await fetchPublicUrl(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "LocalClaudeWorkbench/0.2 (+local user approved web fetch)",
        Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.5"
      }
    }, normalized);
    if (!resultAllowedByDomainFilters({ url: finalUrl }, normalized)) {
      throw Object.assign(new Error("Redirect target blocked by web domain filters"), { statusCode: 403 });
    }
    const contentType = response.headers.get("content-type") || "";
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer).slice(0, normalized.maxBytes);
    const raw = buffer.toString("utf8");
    const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || finalUrl;
    const text = contentType.includes("html") ? htmlToText(raw) : raw.replace(/\u0000/g, "");
    return {
      ok: response.ok,
      status: response.status,
      url: finalUrl,
      title: decodeHtmlEntities(title),
      contentType,
      bytes: Number(response.headers.get("content-length") || buffer.byteLength),
      text: text.slice(0, normalized.maxTextChars),
      cached: false,
      cacheKey,
      redirects
    };
  } finally {
    done();
  }
}

export function shouldUseRenderFallback(page = {}, settings = {}) {
  const normalized = normalizeWebSettings(settings);
  if (!normalized.fetchRenderFallback) return false;
  const contentType = String(page.contentType || "").toLowerCase();
  if (contentType && !contentType.includes("html") && !contentType.includes("xhtml")) return false;
  const text = String(page.text || "").trim();
  if (!text) return true;
  if (text.length < 900) return true;
  return /\b(enable|requires?)\s+javascript\b|turn on javascript|app-root|__next|__nuxt|webpack|vite/i.test(text);
}

function credibilityScore(result, query = "") {
  let score = 0.5;
  const url = String(result.url || "");
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    return score;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "https:") score += 0.08;
  if (host.endsWith(".gov") || host.endsWith(".edu")) score += 0.18;
  if (/(^|\.)docs\.|(^|\.)developer\.|(^|\.)support\.|(^|\.)learn\./.test(host)) score += 0.1;
  if (SOCIAL_OR_LOW_SIGNAL.some((domain) => host === domain || host.endsWith(`.${domain}`))) score -= 0.18;
  const terms = String(query || "").toLowerCase().split(/\s+/).filter((term) => term.length > 3);
  if (terms.some((term) => host.includes(term.replace(/[^a-z0-9-]/g, "")))) score += 0.08;
  if (/\b(official|docs|documentation|api|reference)\b/i.test(`${result.title} ${result.snippet}`)) score += 0.06;
  return Math.max(0, Math.min(1, score));
}

function rankResults(results, query, settings) {
  const normalized = normalizeWebSettings(settings);
  const mapped = (results || [])
    .filter((result) => resultAllowedByDomainFilters(result, normalized))
    .map((result) => ({
      ...result,
      credibility: Number(credibilityScore(result, query).toFixed(3))
    }));
  if (!normalized.credibilityRanking) return mapped;
  return mapped.sort((a, b) => b.credibility - a.credibility);
}

function parseDuckDuckGoResults(rawPage, limit, query, settings) {
  const results = [];
  const seen = new Set();
  const pushResult = (item) => {
    const url = String(item.url || "").trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    results.push(item);
  };
  for (const match of rawPage.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let resultUrl = decodeHtmlEntities(match[1]);
    try {
      const parsed = new URL(resultUrl, "https://duckduckgo.com");
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) resultUrl = uddg;
    } catch {
    }
    pushResult({
      provider: "duckduckgo",
      title: htmlToText(match[2]).slice(0, 180),
      url: resultUrl,
      snippet: htmlToText(match[3]).slice(0, 600)
    });
    if (results.length >= limit) break;
  }
  if (results.length < limit) {
    for (const match of rawPage.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      let resultUrl = decodeHtmlEntities(match[1]);
      try {
        const parsed = new URL(resultUrl, "https://duckduckgo.com");
        const uddg = parsed.searchParams.get("uddg");
        if (uddg) resultUrl = uddg;
      } catch {
      }
      pushResult({
        provider: "duckduckgo",
        title: htmlToText(match[2]).slice(0, 180),
        url: resultUrl,
        snippet: ""
      });
      if (results.length >= limit) break;
    }
  }
  return rankResults(results, query, settings);
}

export function parseBingHtmlResults(rawPage, limit, query, settings) {
  const results = [];
  const seen = new Set();
  for (const match of String(rawPage || "").matchAll(/<li[^>]+class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)(?=<li[^>]+class="[^"]*\bb_algo\b|<\/ol>)/gi)) {
    const block = match[1] || "";
    const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const resultUrl = decodeHtmlEntities(link[1]);
    if (!/^https?:\/\//i.test(resultUrl) || seen.has(resultUrl)) continue;
    seen.add(resultUrl);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
    results.push({
      provider: "bing_html",
      title: htmlToText(link[2]).slice(0, 180),
      url: resultUrl,
      snippet: htmlToText(snippet).slice(0, 600)
    });
    if (results.length >= limit) break;
  }
  return rankResults(results, query, settings);
}

async function searchBingHtml(query, limit, options) {
  const settings = normalizeWebSettings(options.settings || {});
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  const { controller, done } = timeoutSignal(settings.requestTimeoutMs);
  try {
    const { response } = await fetchPublicUrl(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 LocalClaudeWorkbench/0.2 (+local user approved web search)",
        Accept: "text/html,application/xhtml+xml"
      }
    }, settings, { maxRedirects: 2, fetchImpl: options.fetchImpl });
    const rawPage = await response.text();
    const results = parseBingHtmlResults(rawPage, limit, query, settings);
    return {
      query,
      provider: "bing_html",
      results,
      rawText: results.length ? "" : htmlToText(rawPage).slice(0, 4000)
    };
  } finally {
    done();
  }
}

async function searchDuckDuckGo(query, limit, options) {
  const settings = normalizeWebSettings(options.settings || {});
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  let duckError = null;
  try {
    const { controller, done } = timeoutSignal(settings.requestTimeoutMs);
    try {
    const { response } = await fetchPublicUrl(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "LocalClaudeWorkbench/0.2 (+local user approved web search)",
        Accept: "text/html"
      }
    }, settings, { maxRedirects: 2, fetchImpl: options.fetchImpl });
    const rawPage = await response.text();
    const results = parseDuckDuckGoResults(rawPage, limit, query, settings);
    if (results.length) {
      return {
        query,
        provider: "duckduckgo",
        results,
        rawText: ""
      };
    }
    duckError = new Error("DuckDuckGo returned no parseable results");
    } finally {
      done();
    }
  } catch (error) {
    duckError = error;
  }
  try {
    const fallback = await searchBingHtml(query, limit, options);
    return {
      ...fallback,
      fallbackFrom: "duckduckgo",
      errors: [{ provider: "duckduckgo", error: safeProviderMessage(duckError?.message) }]
    };
  } catch (bingError) {
    throw Object.assign(new Error(`DuckDuckGo failed: ${safeProviderMessage(duckError?.message)}; Bing HTML fallback failed: ${safeProviderMessage(bingError?.message)}`), {
      statusCode: 502
    });
  }
}

async function searchBrave(query, limit, token, options) {
  if (!token) throw Object.assign(new Error("Brave 搜索缺少 API token"), { statusCode: 400 });
  const settings = normalizeWebSettings(options.settings || {});
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(20, limit)));
  const { controller, done } = timeoutSignal(settings.requestTimeoutMs);
  try {
    const { response } = await fetchPublicUrl(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": token
      }
    }, settings, { maxRedirects: 2, fetchImpl: options.fetchImpl });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(safeProviderMessage(payload?.error?.message || `Brave 搜索失败 (${response.status})`, [token])), { statusCode: response.status });
    const results = (payload.web?.results || []).slice(0, limit).map((item) => ({
      provider: "brave",
      title: item.title || item.url,
      url: item.url || "",
      snippet: htmlToText(item.description || item.extra_snippets?.join(" ") || "").slice(0, 600)
    }));
    return { query, provider: "brave", results: rankResults(results, query, settings) };
  } finally {
    done();
  }
}

async function searchBing(query, limit, token, options) {
  if (!token) throw Object.assign(new Error("Bing 搜索缺少 API token"), { statusCode: 400 });
  const settings = normalizeWebSettings(options.settings || {});
  const url = new URL("https://api.bing.microsoft.com/v7.0/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(20, limit)));
  const { controller, done } = timeoutSignal(settings.requestTimeoutMs);
  try {
    const { response } = await fetchPublicUrl(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Ocp-Apim-Subscription-Key": token
      }
    }, settings, { maxRedirects: 2, fetchImpl: options.fetchImpl });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(safeProviderMessage(payload?.error?.message || `Bing 搜索失败 (${response.status})`, [token])), { statusCode: response.status });
    const results = (payload.webPages?.value || []).slice(0, limit).map((item) => ({
      provider: "bing",
      title: item.name || item.url,
      url: item.url || "",
      snippet: htmlToText(item.snippet || "").slice(0, 600)
    }));
    return { query, provider: "bing", results: rankResults(results, query, settings) };
  } finally {
    done();
  }
}

async function searchTavily(query, limit, token, options) {
  if (!token) throw Object.assign(new Error("Tavily 搜索缺少 API token"), { statusCode: 400 });
  const settings = normalizeWebSettings(options.settings || {});
  const endpoint = options.endpoint || "https://api.tavily.com/search";
  const endpointUrl = await assertPublicWebUrl(endpoint, settings);
  const { controller, done } = timeoutSignal(settings.requestTimeoutMs);
  try {
    const { response } = await fetchPublicUrl(endpointUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ query, max_results: Math.min(20, limit), include_answer: false })
    }, settings, { maxRedirects: 2, fetchImpl: options.fetchImpl });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(safeProviderMessage(payload?.error || `Tavily 搜索失败 (${response.status})`, [token])), { statusCode: response.status });
    const results = (payload.results || []).slice(0, limit).map((item) => ({
      provider: "tavily",
      title: item.title || item.url,
      url: item.url || "",
      snippet: htmlToText(item.content || item.snippet || "").slice(0, 600)
    }));
    return { query, provider: "tavily", results: rankResults(results, query, settings) };
  } finally {
    done();
  }
}

async function searchCustom(query, limit, token, options) {
  const settings = normalizeWebSettings(options.settings || {});
  const endpoint = options.endpoint || "";
  if (!endpoint) throw Object.assign(new Error("自定义搜索缺少 endpoint"), { statusCode: 400 });
  const endpointUrl = await assertPublicWebUrl(endpoint, settings);
  const { controller, done } = timeoutSignal(settings.requestTimeoutMs);
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const { response } = await fetchPublicUrl(endpointUrl, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({ query, q: query, max_results: Math.min(30, limit), limit: Math.min(30, limit) })
    }, settings, { maxRedirects: 2, fetchImpl: options.fetchImpl });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(safeProviderMessage(payload?.error?.message || payload?.error || `自定义搜索失败 (${response.status})`, [token])), {
        statusCode: response.status
      });
    }
    const rows = Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload.web?.results)
        ? payload.web.results
        : Array.isArray(payload.items)
          ? payload.items
          : [];
    const results = rows.slice(0, limit).map((item) => ({
      provider: "custom",
      title: item.title || item.name || item.url || item.link || "",
      url: item.url || item.link || item.href || "",
      snippet: htmlToText(item.snippet || item.description || item.content || item.text || "").slice(0, 600)
    }));
    return { query, provider: "custom", results: rankResults(results, query, settings) };
  } finally {
    done();
  }
}

function searchMock(query, limit, options = {}) {
  const settings = normalizeWebSettings(options.settings || {});
  const q = String(query || "mock").trim();
  const base = [
    {
      provider: "mock",
      title: `${q} 官方文档`,
      url: `https://example.com/docs/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, "-"))}`,
      snippet: `这是 Web provider mock 返回的官方文档样例，用于离线测试搜索、引用校验、可信度排序和缓存。关键词：${q}。`
    },
    {
      provider: "mock",
      title: `${q} 研究报告`,
      url: `https://example.org/research/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, "-"))}`,
      snippet: `这是第二个 mock 来源，模拟研究报告、摘要片段和来源链接。可用于 Research 模式离线综合。`
    },
    {
      provider: "mock",
      title: `${q} API 参考`,
      url: `https://developer.example.net/reference/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, "-"))}`,
      snippet: `这是第三个 mock 来源，模拟 developer/reference 页面，用于来源可信度排序测试。`
    }
  ];
  return {
    query: q,
    provider: "mock",
    results: rankResults(base.slice(0, limit), q, settings)
  };
}

export async function testWebProvider({ settings = {}, providerToken = "", customEndpoint = "", fetchImpl = fetch } = {}) {
  const normalized = normalizeWebSettings(settings);
  if (normalized.provider === "mock") {
    const result = searchMock("provider health", 2, { settings: normalized });
    return { ok: true, provider: "mock", mode: "offline", results: result.results.length };
  }
  if (["brave", "bing", "tavily"].includes(normalized.provider) && !providerToken) {
    return { ok: false, provider: normalized.provider, error: "缺少搜索供应商 token" };
  }
  if (normalized.provider === "custom" && !customEndpoint) {
    return { ok: false, provider: "custom", error: "缺少自定义搜索 endpoint" };
  }
  try {
    const testSettings = { ...normalized, maxResults: 1, fallbackProviders: [] };
    const result = await webSearch("provider health", {
      settings: testSettings,
      providerToken,
      customEndpoint,
      cache: null,
      rateLimit: null,
      fetchImpl
    });
    return { ok: true, provider: result.provider || normalized.provider, results: result.results?.length || 0 };
  } catch (error) {
    return { ok: false, provider: normalized.provider, error: safeProviderMessage(error?.message, [providerToken]), providerErrors: sanitizeSensitiveValue(error?.providerErrors || [], [providerToken]) };
  }
}

export async function webSearch(query, { settings = {}, cache = null, rateLimit = null, providerToken = "", customEndpoint = "", fetchImpl = null } = {}) {
  const normalized = normalizeWebSettings(settings);
  const q = String(query || "").trim();
  if (!q) throw Object.assign(new Error("搜索关键词不能为空"), { statusCode: 400 });
  const limit = normalized.maxResults;
  rateLimit?.(`search:${normalized.provider}`, normalized.rateLimitPerMinute);
  const cacheKey = makeCacheKey("search", {
    provider: normalized.provider,
    query: q,
    limit,
    allowedDomains: normalized.allowedDomains,
    blockedDomains: normalized.blockedDomains
  });
  const cached = cache ? getCached(cache, cacheKey) : null;
  if (cached) return { ...cached, cached: true, cacheKey };

  const providers = [...new Set([normalized.provider, ...(normalized.fallbackProviders || [])])];
  const errors = [];
  for (const provider of providers) {
    try {
      let result = null;
      if (provider === "mock") result = searchMock(q, limit, { settings: normalized });
      else if (provider === "brave") result = await searchBrave(q, limit, providerToken, { settings: normalized, fetchImpl });
      else if (provider === "bing") result = await searchBing(q, limit, providerToken, { settings: normalized, fetchImpl });
      else if (provider === "tavily") result = await searchTavily(q, limit, providerToken, { settings: normalized, endpoint: customEndpoint, fetchImpl });
      else if (provider === "custom") result = await searchCustom(q, limit, providerToken, { settings: normalized, endpoint: customEndpoint, fetchImpl });
      else result = await searchDuckDuckGo(q, limit, { settings: normalized, fetchImpl });
      return { ...result, cached: false, cacheKey, errors };
    } catch (error) {
      errors.push({ provider, error: safeProviderMessage(error?.message, [providerToken]) });
      if (provider === "duckduckgo") continue;
    }
  }
  const first = errors[0]?.error || "搜索失败";
  throw Object.assign(new Error(safeProviderMessage(first, [providerToken])), { statusCode: 502, providerErrors: sanitizeSensitiveValue(errors, [providerToken]) });
}

function cacheSettingsFingerprint(settings = {}) {
  const normalized = normalizeWebSettings(settings);
  return {
    provider: normalized.provider,
    providerStrategy: normalized.providerStrategy,
    searchContextSize: normalized.searchContextSize,
    allowedDomains: normalized.allowedDomains,
    blockedDomains: normalized.blockedDomains,
    maxResults: normalized.maxResults
  };
}

function domainAllowedUrl(url = "", settings = {}) {
  return /^https?:\/\//i.test(String(url || "")) && resultAllowedByDomainFilters({ url }, settings);
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function parseBingImageResults(rawPage = "", limit = 10, query = "", settings = {}) {
  const normalized = normalizeWebSettings(settings);
  const results = [];
  const seen = new Set();
  const pushResult = (item = {}) => {
    const imageUrl = String(item.imageUrl || item.url || "").trim();
    const sourceUrl = String(item.sourceUrl || item.url || "").trim();
    if (!imageUrl || seen.has(imageUrl)) return;
    if (!domainAllowedUrl(sourceUrl || imageUrl, normalized)) return;
    seen.add(imageUrl);
    results.push({
      provider: item.provider || "bing_images_html",
      title: String(item.title || query || sourceUrl || imageUrl).slice(0, 180),
      url: sourceUrl || imageUrl,
      sourceUrl: sourceUrl || imageUrl,
      imageUrl,
      thumbnailUrl: item.thumbnailUrl || imageUrl,
      snippet: String(item.snippet || "").slice(0, 600)
    });
  };

  for (const match of String(rawPage || "").matchAll(/<a[^>]+class="[^"]*\biusc\b[^"]*"[^>]+m="([^"]+)"[^>]*>/gi)) {
    const metadata = safeJsonParse(decodeHtmlEntities(match[1]), null);
    if (!metadata) continue;
    pushResult({
      title: htmlToText(metadata.t || metadata.desc || ""),
      imageUrl: metadata.murl || metadata.imgurl || metadata.url || "",
      thumbnailUrl: metadata.turl || metadata.thurl || "",
      sourceUrl: metadata.purl || metadata.surl || metadata.hostPageUrl || "",
      snippet: metadata.desc || ""
    });
    if (results.length >= limit) break;
  }

  if (results.length < limit) {
    for (const match of String(rawPage || "").matchAll(/<img[^>]+(?:data-src|src)="([^"]+)"[^>]*(?:alt="([^"]*)")?[^>]*>/gi)) {
      const imageUrl = decodeHtmlEntities(match[1] || "");
      if (!/^https?:\/\//i.test(imageUrl)) continue;
      pushResult({
        title: htmlToText(match[2] || query || "Image result"),
        imageUrl,
        thumbnailUrl: imageUrl,
        sourceUrl: imageUrl
      });
      if (results.length >= limit) break;
    }
  }

  return results.slice(0, limit);
}

async function imageSearchBingHtml(query, limit, options = {}) {
  const settings = normalizeWebSettings(options.settings || {});
  const url = new URL("https://www.bing.com/images/search");
  url.searchParams.set("q", query);
  url.searchParams.set("form", "HDRSC2");
  const { controller, done } = timeoutSignal(settings.requestTimeoutMs);
  try {
    const { response } = await fetchPublicUrl(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 LocalClaudeWorkbench/0.2 (+local user approved image search)",
        Accept: "text/html,application/xhtml+xml"
      }
    }, settings, { maxRedirects: 2 });
    const rawPage = await response.text();
    return {
      query,
      provider: "bing_images_html",
      results: parseBingImageResults(rawPage, limit, query, settings),
      rawText: ""
    };
  } finally {
    done();
  }
}

function imageSearchMock(query, limit, options = {}) {
  const settings = normalizeWebSettings(options.settings || {});
  const q = String(query || "mock image").trim();
  const rows = [
    {
      provider: "mock",
      title: `${q} image reference`,
      url: `https://example.com/images/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, "-"))}`,
      sourceUrl: `https://example.com/images/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, "-"))}`,
      imageUrl: `https://example.com/assets/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, "-"))}.jpg`,
      thumbnailUrl: `https://example.com/assets/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, "-"))}-thumb.jpg`,
      snippet: "Offline mock image result for UI and model-tool smoke tests."
    }
  ].filter((item) => domainAllowedUrl(item.sourceUrl, settings));
  return { query: q, provider: "mock", results: rows.slice(0, limit) };
}

export async function webImageSearch(query, { settings = {}, cache = null, rateLimit = null, limit = null } = {}) {
  const normalized = normalizeWebSettings(settings);
  const q = String(query || "").trim();
  if (!q) throw Object.assign(new Error("Image search query cannot be empty"), { statusCode: 400 });
  const resultLimit = Math.min(30, Math.max(1, Number(limit || normalized.maxResults || 10)));
  rateLimit?.(`image:${normalized.provider}`, normalized.rateLimitPerMinute);
  const cacheKey = makeCacheKey("image_search", {
    query: q,
    limit: resultLimit,
    settings: cacheSettingsFingerprint(normalized)
  });
  const cached = cache ? getCached(cache, cacheKey) : null;
  if (cached) return { ...cached, cached: true, cacheKey };
  const result = normalized.provider === "mock"
    ? imageSearchMock(q, resultLimit, { settings: normalized })
    : await imageSearchBingHtml(q, resultLimit, { settings: normalized });
  return {
    ...result,
    kind: "image_search",
    cached: false,
    cacheKey,
    providerPlan: {
      kind: "image_search",
      order: normalized.provider === "mock" ? ["mock"] : ["bing_images_html"],
      selectedProvider: result.provider,
      degraded: false,
      errors: []
    },
    diagnostics: { noTokenPath: result.provider !== "mock" }
  };
}

export function normalizeFinanceSymbol(ticker = "", type = "equity", market = "") {
  const raw = String(ticker || "").trim().toUpperCase().replace(/[^A-Z0-9.^=-]/g, "");
  if (!raw) return "";
  if (String(type || "").toLowerCase() === "crypto" && !raw.includes("-")) return `${raw}-USD`;
  if (String(market || "").toUpperCase() === "USA") return raw;
  return raw;
}

export function parseYahooFinanceChart(payload = {}, symbol = "") {
  const chart = payload?.chart?.result?.[0] || null;
  const meta = chart?.meta || {};
  const quote = chart?.indicators?.quote?.[0] || {};
  const closes = Array.isArray(quote.close) ? quote.close.filter((value) => Number.isFinite(Number(value))) : [];
  const price = finiteNumber(meta.regularMarketPrice, finiteNumber(closes.at(-1), null));
  const previousClose = finiteNumber(meta.previousClose, finiteNumber(meta.chartPreviousClose, null));
  const change = price !== null && previousClose !== null ? Number((price - previousClose).toFixed(4)) : null;
  const changePercent = change !== null && previousClose ? Number(((change / previousClose) * 100).toFixed(3)) : null;
  return {
    provider: "yahoo_finance",
    symbol: meta.symbol || symbol,
    title: `${meta.symbol || symbol} quote`,
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(meta.symbol || symbol)}`,
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(meta.symbol || symbol)}`,
    price,
    previousClose,
    change,
    changePercent,
    currency: meta.currency || "",
    exchangeName: meta.exchangeName || meta.fullExchangeName || "",
    marketState: meta.marketState || "",
    regularMarketTime: meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : "",
    snippet: price === null ? "No quote price returned." : `${meta.symbol || symbol}: ${price} ${meta.currency || ""}`.trim()
  };
}

export function parseStooqQuote(csvText = "", symbol = "") {
  const lines = String(csvText || "").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  let headers = lines[0].split(",").map((item) => item.trim().toLowerCase());
  let values = (lines[1] || "").split(",").map((item) => item.trim());
  if (lines.length === 1 || !headers.includes("close")) {
    headers = ["symbol", "date", "time", "open", "high", "low", "close", "volume"];
    values = lines[0].split(",").map((item) => item.trim());
  }
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  const close = finiteNumber(row.close, null);
  const open = finiteNumber(row.open, null);
  const previousClose = finiteNumber(row.close, null);
  const change = close !== null && open !== null ? Number((close - open).toFixed(4)) : null;
  return {
    provider: "stooq",
    symbol: row.symbol || symbol,
    title: `${row.symbol || symbol} quote`,
    url: `https://stooq.com/q/?s=${encodeURIComponent((row.symbol || symbol).toLowerCase())}`,
    sourceUrl: `https://stooq.com/q/?s=${encodeURIComponent((row.symbol || symbol).toLowerCase())}`,
    price: close,
    previousClose,
    change,
    changePercent: close !== null && previousClose ? Number((((close - previousClose) / previousClose) * 100).toFixed(3)) : null,
    currency: "",
    exchangeName: "Stooq",
    marketState: "",
    regularMarketTime: row.date && row.time ? new Date(`${row.date}T${row.time}Z`).toISOString() : "",
    snippet: close === null ? "No quote price returned." : `${row.symbol || symbol}: ${close}`
  };
}

const COINGECKO_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  DOGE: "dogecoin",
  ADA: "cardano",
  XRP: "ripple",
  LTC: "litecoin",
  BNB: "binancecoin",
  AVAX: "avalanche-2",
  DOT: "polkadot"
};

async function fetchCoinGeckoQuote(symbol, settings) {
  const base = String(symbol || "").replace(/-USD$/i, "");
  const id = COINGECKO_IDS[base];
  if (!id) throw new Error(`No CoinGecko mapping for ${base}`);
  const url = new URL("https://api.coingecko.com/api/v3/simple/price");
  url.searchParams.set("ids", id);
  url.searchParams.set("vs_currencies", "usd");
  url.searchParams.set("include_24hr_change", "true");
  const { controller, done } = timeoutSignal(settings.requestTimeoutMs);
  try {
    const { response } = await fetchPublicUrl(url, {
      signal: controller.signal,
      headers: { "User-Agent": "LocalClaudeWorkbench/0.2 (+local user approved finance lookup)", Accept: "application/json" }
    }, settings, { maxRedirects: 2 });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`CoinGecko failed (${response.status})`), { statusCode: response.status });
    const data = payload[id] || {};
    const price = finiteNumber(data.usd, null);
    const changePercent = finiteNumber(data.usd_24h_change, null);
    return {
      provider: "coingecko",
      symbol: base,
      title: `${base} quote`,
      url: `https://www.coingecko.com/en/coins/${id}`,
      sourceUrl: `https://www.coingecko.com/en/coins/${id}`,
      price,
      previousClose: changePercent !== null && price !== null ? Number((price / (1 + changePercent / 100)).toFixed(6)) : null,
      change: null,
      changePercent: changePercent !== null ? Number(changePercent.toFixed(3)) : null,
      currency: "USD",
      exchangeName: "CoinGecko",
      marketState: "",
      regularMarketTime: new Date().toISOString(),
      snippet: price === null ? `${base}: no price` : `${base}: ${price} USD`
    };
  } finally {
    done();
  }
}

function financeMock(symbol = "AAPL") {
  const normalizedSymbol = normalizeFinanceSymbol(symbol) || "AAPL";
  return {
    provider: "mock",
    symbol: normalizedSymbol,
    title: `${normalizedSymbol} mock quote`,
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(normalizedSymbol)}`,
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(normalizedSymbol)}`,
    price: 123.45,
    previousClose: 120,
    change: 3.45,
    changePercent: 2.875,
    currency: "USD",
    exchangeName: "Mock Exchange",
    marketState: "MOCK",
    regularMarketTime: new Date().toISOString(),
    snippet: `${normalizedSymbol}: 123.45 USD`
  };
}

export async function webFinanceQuote({ ticker = "", type = "equity", market = "" } = {}, { settings = {}, cache = null, rateLimit = null } = {}) {
  const normalized = normalizeWebSettings(settings);
  const symbol = normalizeFinanceSymbol(ticker, type, market);
  if (!symbol) throw Object.assign(new Error("Finance ticker cannot be empty"), { statusCode: 400 });
  rateLimit?.(`finance:${symbol}`, normalized.rateLimitPerMinute);
  const cacheKey = makeCacheKey("finance", { symbol, type, market, settings: cacheSettingsFingerprint(normalized) });
  const cached = cache ? getCached(cache, cacheKey) : null;
  if (cached) return { ...cached, cached: true, cacheKey };
  if (normalized.provider === "mock") {
    const quote = financeMock(symbol);
    return { kind: "finance", provider: "mock", results: [quote], quote, cached: false, cacheKey, providerPlan: { kind: "finance", order: ["mock"], selectedProvider: "mock", degraded: false, errors: [] }, diagnostics: { noTokenPath: true } };
  }
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", "1d");
  url.searchParams.set("interval", "1m");
  const { controller, done } = timeoutSignal(normalized.requestTimeoutMs);
  try {
    let quote = null;
    try {
      const { response } = await fetchPublicUrl(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "LocalClaudeWorkbench/0.2 (+local user approved finance lookup)",
          Accept: "application/json"
        }
      }, normalized, { maxRedirects: 2 });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(safeProviderMessage(payload?.chart?.error?.description || `Yahoo Finance failed (${response.status})`)), { statusCode: response.status });
      quote = parseYahooFinanceChart(payload, symbol);
      if (quote.price === null && String(type || "").toLowerCase() !== "crypto") {
        throw new Error("Yahoo Finance returned no price");
      }
    } catch (yahooError) {
      if (String(type || "").toLowerCase() === "crypto") {
        quote = await fetchCoinGeckoQuote(symbol, normalized);
      } else {
        const stooqSymbol = `${String(symbol || "").toLowerCase().replace(/^([a-z0-9^.-]+)$/i, "$1")}${String(market || "").toUpperCase() === "USA" || !market ? ".us" : ""}`;
        const stooqUrl = new URL("https://stooq.com/q/l/");
        stooqUrl.searchParams.set("s", stooqSymbol);
        stooqUrl.searchParams.set("i", "d");
        stooqUrl.searchParams.set("f", "sd2t2ohlcv");
        stooqUrl.searchParams.set("h", "");
        stooqUrl.searchParams.set("e", "csv");
        const { response } = await fetchPublicUrl(stooqUrl, {
          signal: controller.signal,
          headers: {
            "User-Agent": "LocalClaudeWorkbench/0.2 (+local user approved finance lookup)",
            Accept: "text/csv,text/plain,*/*"
          }
        }, normalized, { maxRedirects: 2 });
        const csvText = await response.text().catch(() => "");
        if (!response.ok) throw Object.assign(new Error(safeProviderMessage(csvText || yahooError.message || `Finance lookup failed (${response.status})`)), { statusCode: response.status });
        quote = parseStooqQuote(csvText, symbol);
        if (!quote?.price && !quote?.change && !quote?.symbol) throw new Error("Stooq returned no quote");
      }
    }
    return {
      kind: "finance",
      provider: quote.provider || "yahoo_finance",
      results: [quote],
      quote,
      cached: false,
      cacheKey,
      providerPlan: { kind: "finance", order: [quote.provider || "yahoo_finance"], selectedProvider: quote.provider || "yahoo_finance", degraded: false, errors: [] },
      diagnostics: { noTokenPath: true }
    };
  } finally {
    done();
  }
}

export function parseOpenMeteoWeather(geocodePayload = {}, forecastPayload = {}, duration = 3) {
  const place = geocodePayload?.results?.[0] || {};
  const daily = forecastPayload?.daily || {};
  const times = Array.isArray(daily.time) ? daily.time : [];
  const rows = times.slice(0, Math.max(1, Number(duration || 3))).map((date, index) => ({
    provider: "open_meteo",
    date,
    title: `${place.name || "Weather"} ${date}`,
    url: "https://open-meteo.com/",
    sourceUrl: "https://open-meteo.com/",
    temperatureMax: finiteNumber(daily.temperature_2m_max?.[index], null),
    temperatureMin: finiteNumber(daily.temperature_2m_min?.[index], null),
    precipitationProbabilityMax: finiteNumber(daily.precipitation_probability_max?.[index], null),
    windSpeedMax: finiteNumber(daily.wind_speed_10m_max?.[index], null),
    snippet: [
      daily.temperature_2m_max?.[index] !== undefined ? `high ${daily.temperature_2m_max[index]}` : "",
      daily.temperature_2m_min?.[index] !== undefined ? `low ${daily.temperature_2m_min[index]}` : "",
      daily.precipitation_probability_max?.[index] !== undefined ? `rain ${daily.precipitation_probability_max[index]}%` : ""
    ].filter(Boolean).join(", ")
  }));
  return {
    location: {
      name: place.name || "",
      country: place.country || "",
      admin1: place.admin1 || "",
      latitude: finiteNumber(place.latitude, null),
      longitude: finiteNumber(place.longitude, null),
      timezone: place.timezone || forecastPayload.timezone || ""
    },
    results: rows
  };
}

function weatherMock(location = "Taipei", duration = 3) {
  const days = Math.max(1, Math.min(10, Number(duration || 3)));
  const start = new Date();
  return {
    location: { name: location || "Mock City", country: "Mockland", latitude: 0, longitude: 0, timezone: "UTC" },
    results: Array.from({ length: days }, (_, index) => {
      const date = new Date(start.getTime() + index * 86400000).toISOString().slice(0, 10);
      return {
        provider: "mock",
        date,
        title: `${location || "Mock City"} ${date}`,
        url: "https://open-meteo.com/",
        sourceUrl: "https://open-meteo.com/",
        temperatureMax: 24 + index,
        temperatureMin: 16 + index,
        precipitationProbabilityMax: 20,
        windSpeedMax: 12,
        snippet: `high ${24 + index}, low ${16 + index}, rain 20%`
      };
    })
  };
}

export async function webWeatherForecast({ location = "", duration = 3, start = "" } = {}, { settings = {}, cache = null, rateLimit = null } = {}) {
  const normalized = normalizeWebSettings(settings);
  const q = String(location || "").trim();
  if (!q) throw Object.assign(new Error("Weather location cannot be empty"), { statusCode: 400 });
  const days = Math.max(1, Math.min(10, Number(duration || 3)));
  rateLimit?.(`weather:${q.toLowerCase()}`, normalized.rateLimitPerMinute);
  const cacheKey = makeCacheKey("weather", { location: q, duration: days, start, settings: cacheSettingsFingerprint(normalized) });
  const cached = cache ? getCached(cache, cacheKey) : null;
  if (cached) return { ...cached, cached: true, cacheKey };
  if (normalized.provider === "mock") {
    const mock = weatherMock(q, days);
    return { kind: "weather", provider: "mock", ...mock, cached: false, cacheKey, providerPlan: { kind: "weather", order: ["mock"], selectedProvider: "mock", degraded: false, errors: [] }, diagnostics: { noTokenPath: true } };
  }
  const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geocodeUrl.searchParams.set("name", q);
  geocodeUrl.searchParams.set("count", "1");
  geocodeUrl.searchParams.set("language", "en");
  geocodeUrl.searchParams.set("format", "json");
  const { controller, done } = timeoutSignal(normalized.requestTimeoutMs);
  try {
    const { response: geocodeResponse } = await fetchPublicUrl(geocodeUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "LocalClaudeWorkbench/0.2 (+local user approved weather lookup)", Accept: "application/json" }
    }, normalized, { maxRedirects: 2 });
    const geocode = await geocodeResponse.json().catch(() => ({}));
    if (!geocodeResponse.ok || !geocode.results?.length) throw Object.assign(new Error(`Open-Meteo geocoding failed for ${q}`), { statusCode: geocodeResponse.status || 404 });
    const place = geocode.results[0];
    const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
    forecastUrl.searchParams.set("latitude", String(place.latitude));
    forecastUrl.searchParams.set("longitude", String(place.longitude));
    forecastUrl.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max");
    forecastUrl.searchParams.set("timezone", "auto");
    forecastUrl.searchParams.set("forecast_days", String(days));
    if (start) forecastUrl.searchParams.set("start_date", String(start).slice(0, 10));
    const { response: forecastResponse } = await fetchPublicUrl(forecastUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "LocalClaudeWorkbench/0.2 (+local user approved weather lookup)", Accept: "application/json" }
    }, normalized, { maxRedirects: 2 });
    const forecast = await forecastResponse.json().catch(() => ({}));
    if (!forecastResponse.ok) throw Object.assign(new Error(`Open-Meteo forecast failed (${forecastResponse.status})`), { statusCode: forecastResponse.status });
    const parsed = parseOpenMeteoWeather(geocode, forecast, days);
    return {
      kind: "weather",
      provider: "open_meteo",
      ...parsed,
      cached: false,
      cacheKey,
      providerPlan: { kind: "weather", order: ["open_meteo"], selectedProvider: "open_meteo", degraded: false, errors: [] },
      diagnostics: { noTokenPath: true }
    };
  } finally {
    done();
  }
}

const ESPN_LEAGUES = {
  nba: "basketball/nba",
  wnba: "basketball/wnba",
  nfl: "football/nfl",
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
  epl: "soccer/eng.1",
  ncaamb: "basketball/mens-college-basketball",
  ncaawb: "basketball/womens-college-basketball"
};

export function parseEspnScoreboard(payload = {}, league = "", team = "") {
  const needle = String(team || "").trim().toLowerCase();
  return (payload.events || [])
    .map((event) => {
      const competitors = event.competitions?.[0]?.competitors || [];
      const teams = competitors.map((competitor) => ({
        name: competitor.team?.displayName || competitor.team?.shortDisplayName || "",
        abbreviation: competitor.team?.abbreviation || "",
        score: competitor.score || ""
      }));
      return {
        provider: "espn",
        league,
        title: event.name || event.shortName || teams.map((item) => item.name).filter(Boolean).join(" vs "),
        url: event.links?.[0]?.href || "https://www.espn.com/",
        sourceUrl: event.links?.[0]?.href || "https://www.espn.com/",
        date: event.date || "",
        status: event.status?.type?.description || event.status?.type?.state || "",
        teams,
        snippet: `${event.shortName || event.name || "Game"} ${event.status?.type?.description || ""}`.trim()
      };
    })
    .filter((event) => !needle || event.teams.some((row) => row.name.toLowerCase().includes(needle) || row.abbreviation.toLowerCase() === needle));
}

export function parseEspnStandings(payload = {}, league = "", team = "") {
  const groups = payload.children || payload.standings || payload.groups || [];
  const rows = [];
  const visit = (node) => {
    const entries = node?.standings?.entries || node?.entries || [];
    for (const entry of entries) {
      const stats = Object.fromEntries((entry.stats || []).map((stat) => [stat.name || stat.shortName, stat.displayValue || stat.value]));
      rows.push({
        provider: "espn",
        league,
        title: entry.team?.displayName || entry.team?.name || "Team",
        url: entry.team?.links?.[0]?.href || "https://www.espn.com/",
        sourceUrl: entry.team?.links?.[0]?.href || "https://www.espn.com/",
        team: entry.team?.displayName || entry.team?.name || "",
        stats,
        snippet: Object.entries(stats).slice(0, 4).map(([key, value]) => `${key}: ${value}`).join(", ")
      });
    }
    for (const child of node?.children || []) visit(child);
  };
  for (const group of groups) visit(group);
  const needle = String(team || "").trim().toLowerCase();
  return rows.filter((row) => !needle || row.team.toLowerCase().includes(needle));
}

function sportsMock(input = {}) {
  const league = String(input.league || "nba").toLowerCase();
  return {
    provider: "mock",
    league,
    fn: input.fn || "schedule",
    results: [
      {
        provider: "mock",
        league,
        title: `${league.toUpperCase()} mock game`,
        url: "https://www.espn.com/",
        sourceUrl: "https://www.espn.com/",
        date: input.date_from || new Date().toISOString(),
        status: "Mock scheduled",
        teams: [{ name: "Home", abbreviation: "HOM", score: "" }, { name: "Away", abbreviation: "AWY", score: "" }],
        snippet: "Mock sports result for offline smoke tests."
      }
    ]
  };
}

export async function webSportsLookup(input = {}, { settings = {}, cache = null, rateLimit = null } = {}) {
  const normalized = normalizeWebSettings(settings);
  const league = String(input.league || "nba").toLowerCase();
  const fn = String(input.fn || "schedule").toLowerCase() === "standings" ? "standings" : "schedule";
  const path = ESPN_LEAGUES[league];
  if (!path) throw Object.assign(new Error(`Unsupported sports league: ${league}`), { statusCode: 400 });
  rateLimit?.(`sports:${league}:${fn}`, normalized.rateLimitPerMinute);
  const cacheKey = makeCacheKey("sports", { league, fn, team: input.team || "", date_from: input.date_from || "", date_to: input.date_to || "", settings: cacheSettingsFingerprint(normalized) });
  const cached = cache ? getCached(cache, cacheKey) : null;
  if (cached) return { ...cached, cached: true, cacheKey };
  if (normalized.provider === "mock") {
    const mock = sportsMock({ ...input, league, fn });
    return { kind: "sports", ...mock, cached: false, cacheKey, providerPlan: { kind: "sports", order: ["mock"], selectedProvider: "mock", degraded: false, errors: [] }, diagnostics: { noTokenPath: true } };
  }
  const url = fn === "standings"
    ? new URL(`https://site.web.api.espn.com/apis/v2/sports/${path}/standings`)
    : new URL(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
  if (fn === "schedule" && input.date_from) url.searchParams.set("dates", String(input.date_from).replaceAll("-", ""));
  const { controller, done } = timeoutSignal(normalized.requestTimeoutMs);
  try {
    const { response } = await fetchPublicUrl(url, {
      signal: controller.signal,
      headers: { "User-Agent": "LocalClaudeWorkbench/0.2 (+local user approved sports lookup)", Accept: "application/json" }
    }, normalized, { maxRedirects: 2 });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`ESPN ${fn} failed (${response.status})`), { statusCode: response.status });
    const results = fn === "standings"
      ? parseEspnStandings(payload, league, input.team)
      : parseEspnScoreboard(payload, league, input.team);
    return {
      kind: "sports",
      provider: "espn",
      league,
      fn,
      results,
      cached: false,
      cacheKey,
      providerPlan: { kind: "sports", order: ["espn"], selectedProvider: "espn", degraded: false, errors: [] },
      diagnostics: { noTokenPath: true, emptyAllowed: true }
    };
  } finally {
    done();
  }
}

function parseUtcOffset(value = "") {
  const text = String(value || "").trim();
  const match = text.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] || 0);
  if (hours > 14 || minutes > 59) return null;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (hours * 60 + minutes);
}

function isoWithOffset(date = new Date(), offsetMinutes = 0) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${shifted.toISOString().replace("Z", "")}${sign}${hh}:${mm}`;
}

export async function webTimeLookup({ location = "", utc_offset = "" } = {}, { settings = {}, cache = null, rateLimit = null } = {}) {
  const normalized = normalizeWebSettings(settings);
  const loc = String(location || "").trim();
  const offsetText = String(utc_offset || "").trim();
  const cacheKey = makeCacheKey("time", { location: loc, utc_offset: offsetText });
  const cached = cache ? getCached(cache, cacheKey) : null;
  if (cached) return { ...cached, cached: true, cacheKey };
  const offset = parseUtcOffset(offsetText);
  if (offset !== null || !loc || normalized.provider === "mock") {
    const minutes = offset !== null ? offset : 0;
    const result = {
      provider: normalized.provider === "mock" ? "mock" : "local_time",
      title: offsetText ? `UTC${offsetText}` : (loc || "UTC"),
      url: "https://www.timeanddate.com/worldclock/",
      sourceUrl: "https://www.timeanddate.com/worldclock/",
      location: loc || (offsetText ? `UTC${offsetText}` : "UTC"),
      utcOffsetMinutes: minutes,
      currentTime: isoWithOffset(new Date(), minutes),
      snippet: `Current time: ${isoWithOffset(new Date(), minutes)}`
    };
    return { kind: "time", provider: result.provider, results: [result], cached: false, cacheKey, providerPlan: { kind: "time", order: [result.provider], selectedProvider: result.provider, degraded: false, errors: [] }, diagnostics: { localOnly: true } };
  }
  rateLimit?.(`time:${loc.toLowerCase()}`, normalized.rateLimitPerMinute);
  const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geocodeUrl.searchParams.set("name", loc);
  geocodeUrl.searchParams.set("count", "1");
  geocodeUrl.searchParams.set("language", "en");
  geocodeUrl.searchParams.set("format", "json");
  const { controller, done } = timeoutSignal(normalized.requestTimeoutMs);
  try {
    const { response } = await fetchPublicUrl(geocodeUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "LocalClaudeWorkbench/0.2 (+local user approved time lookup)", Accept: "application/json" }
    }, normalized, { maxRedirects: 2 });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.results?.length) throw Object.assign(new Error(`Timezone lookup failed for ${loc}`), { statusCode: response.status || 404 });
    const place = payload.results[0];
    const timezone = place.timezone || "UTC";
    const currentTime = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date()).replace(" ", "T");
    const result = {
      provider: "open_meteo_geocoding",
      title: `${place.name || loc} time`,
      url: "https://www.timeanddate.com/worldclock/",
      sourceUrl: "https://www.timeanddate.com/worldclock/",
      location: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
      timezone,
      currentTime,
      snippet: `${place.name || loc}: ${currentTime} (${timezone})`
    };
    return { kind: "time", provider: "open_meteo_geocoding", results: [result], cached: false, cacheKey, providerPlan: { kind: "time", order: ["open_meteo_geocoding"], selectedProvider: "open_meteo_geocoding", degraded: false, errors: [] }, diagnostics: { noTokenPath: true } };
  } finally {
    done();
  }
}

export function validateCitations(markdown = "", sources = []) {
  const available = new Set((sources || []).map((source) => String(source.sourceId || "").trim()).filter(Boolean));
  const refs = [...String(markdown || "").matchAll(/\[([WK]\d+)\]/g)].map((match) => match[1]);
  const uniqueRefs = [...new Set(refs)];
  const missing = uniqueRefs.filter((ref) => !available.has(ref));
  const used = uniqueRefs.filter((ref) => available.has(ref));
  const sourceCount = available.size;
  return {
    ok: missing.length === 0 && (sourceCount === 0 || used.length > 0),
    used,
    missing,
    available: [...available],
    coverage: sourceCount ? Number((used.length / sourceCount).toFixed(3)) : 1
  };
}

function safeProviderMessage(value, secrets = []) {
  return sanitizeSensitiveText(value || "外部供应商请求失败", secrets);
}
