import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import crypto from "node:crypto";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

export async function readJsonBody(req, { maxBytes = 4 * 1024 * 1024 } = {}) {
  if (Object.hasOwn(req, "__workbenchJsonBody")) return req.__workbenchJsonBody;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("请求体过大"), { statusCode: 413, code: "body_too_large" });
    chunks.push(chunk);
  }
  if (!chunks.length) {
    req.__workbenchJsonBody = {};
    req.__workbenchBodyHash = crypto.createHash("sha256").update("").digest("hex");
    return req.__workbenchJsonBody;
  }
  try {
    const bytes = Buffer.concat(chunks);
    req.__workbenchJsonBody = JSON.parse(bytes.toString("utf8"));
    req.__workbenchBodyHash = crypto.createHash("sha256").update(bytes).digest("hex");
    return req.__workbenchJsonBody;
  } catch {
    throw Object.assign(new Error("请求体不是有效 JSON"), { statusCode: 400, code: "invalid_json" });
  }
}

export function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

export function sendError(res, error) {
  const statusCode = Number(error?.statusCode || 500);
  sendJson(res, statusCode, {
    ok: false,
    error: statusCode >= 500 ? "本地服务处理请求失败" : sanitizeSensitiveText(error?.message || "请求失败"),
    code: String(error?.code || (statusCode >= 500 ? "internal_error" : "request_error"))
  });
}

/**
 * Redact credential-shaped values before an error or provider payload reaches
 * the HTTP boundary. Provider error bodies are untrusted input and commonly
 * echo request headers or query-string credentials.
 */
export function sanitizeSensitiveText(value, secrets = []) {
  let output = String(value ?? "");
  for (const secret of secrets.map((item) => String(item || "")).filter((item) => item.length >= 4)) {
    output = output.split(secret).join("[REDACTED]");
  }
  output = output
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, (match) => `${match.split(/\s+/, 1)[0]} [REDACTED]`)
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|session(?:[_-]?token)?|private[_-]?key)\s*[:=]\s*)(["']?)(?!(?:Bearer|Basic)\b)[^\s,;&"']+/gi, "$1$2[REDACTED]")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[REDACTED]");
  return output.slice(0, 4000);
}

/** Recursively redact credential-shaped object keys and string values. */
export function sanitizeSensitiveValue(value, secrets = [], seen = new WeakSet()) {
  if (typeof value === "string") return sanitizeSensitiveText(value, secrets);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED_CYCLE]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeSensitiveValue(item, secrets, seen));
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["apikey", "accesstoken", "refreshtoken", "token", "secret", "secrets", "password", "authorization", "cookie", "session", "sessiontoken", "privatekey"].includes(normalized)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = sanitizeSensitiveValue(nested, secrets, seen);
    }
  }
  seen.delete(value);
  return output;
}

export function setBaseSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  // React uses a small number of dynamic style attributes for meters and
  // project colors. Keep those narrowly allowed while disallowing inline
  // <style> elements and preserving the separate artifact-preview policy.
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; style-src-elem 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

export function createSessionGuard({ cookieName = "workbench_session", rootToken = process.env.WORKBENCH_SESSION_TOKEN || crypto.randomBytes(32).toString("hex"), sessionTtlMs = 86_400_000 } = {}) {
  const sessions = new Map();
  function createSession(res) {
    const sessionId = crypto.randomBytes(24).toString("base64url");
    const csrfToken = crypto.randomBytes(24).toString("base64url");
    sessions.set(sessionId, { csrfToken, createdAt: Date.now(), accessedAt: Date.now() });
    res.setHeader("Set-Cookie", `${cookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    return { sessionId, csrfToken };
  }
  function getSession(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    const sessionId = cookies[cookieName] || "";
    const session = sessions.get(sessionId);
    if (session && Date.now() - session.createdAt > sessionTtlMs) {
      sessions.delete(sessionId);
      return null;
    }
    if (session) session.accessedAt = Date.now();
    return session ? { sessionId, ...session } : null;
  }
  function bootstrap(req, res) {
    if (!isLoopback(req.socket?.remoteAddress)) throw forbidden("仅允许本机访问", "loopback_required");
    const origin = String(req.headers.origin || "");
    if (String(req.headers["sec-fetch-site"] || "") === "cross-site" || (origin && !originMatchesHost(origin, req.headers.host))) {
      throw forbidden("拒绝跨站会话初始化", "cross_site_denied");
    }
    return getSession(req) || createSession(res);
  }
  function authorize(req, { write = false } = {}) {
    if (!isLoopback(req.socket?.remoteAddress)) throw forbidden("仅允许本机访问", "loopback_required");
    const origin = String(req.headers.origin || "");
    const fetchSite = String(req.headers["sec-fetch-site"] || "");
    if (fetchSite === "cross-site") throw forbidden("拒绝跨站请求", "cross_site_denied");
    if (origin && !originMatchesHost(origin, req.headers.host)) throw forbidden("请求来源不匹配", "origin_mismatch");
    const legacyToken = String(req.headers["x-local-session-token"] || "");
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if ((legacyToken && timingEqual(legacyToken, rootToken)) || (bearer && timingEqual(bearer, rootToken))) return { mode: "token" };
    const session = getSession(req);
    if (session) {
      if (write && !timingEqual(String(req.headers["x-csrf-token"] || ""), session.csrfToken)) throw forbidden("CSRF token 无效", "csrf_invalid");
      return { mode: "cookie", session };
    }
    // CLI and tray callers must present the process-scoped local token. Merely
    // reaching loopback is not sufficient authority for API reads or writes.
    if (!origin && !fetchSite) throw forbidden("CLI 需要短期本地会话 token", "local_token_required");
    throw forbidden("本地会话无效", "session_required");
  }
  return { rootToken, bootstrap, authorize, getSession };
}

export function serveStatic(req, res, { roots = [] } = {}) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/")) return false;
  const relative = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, ""));
  if (relative.includes("\0") || relative.split(/[\\/]/).includes("..")) throw Object.assign(new Error("非法静态资源路径"), { statusCode: 400 });
  let selected = null;
  for (const root of roots.filter(Boolean)) {
    const base = resolve(root);
    const candidate = resolve(base, normalize(relative));
    if (candidate !== base && !candidate.startsWith(base + sep)) continue;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const realBase = realpathSync(base);
      const realCandidate = realpathSync(candidate);
      if (realCandidate !== realBase && !realCandidate.startsWith(realBase + sep)) continue;
      selected = realCandidate; break;
    }
  }
  if (!selected && !extname(relative)) {
    for (const root of roots.filter(Boolean)) {
      const fallback = join(resolve(root), "index.html");
      if (existsSync(fallback)) {
        const realBase = realpathSync(resolve(root));
        const realFallback = realpathSync(fallback);
        if (realFallback === realBase || realFallback.startsWith(realBase + sep)) { selected = realFallback; break; }
      }
    }
  }
  if (!selected) return false;
  const stat = statSync(selected);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(selected).toLowerCase()] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": extname(selected) === ".html" ? "no-store" : "public, max-age=31536000, immutable"
  });
  if (req.method === "HEAD") res.end(); else createReadStream(selected).pipe(res);
  return true;
}

export function openEventStream(req, res, { initialEvents = [], getInitialEvents = null, subscribe }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");
  const writeEvent = (event) => {
    const eventName = String(event.rawType || event.type || "message").replace(/[^A-Za-z0-9_.-]/g, "_");
    res.write(`id: ${event.sequence || event.id}\n`);
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  let replaying = true;
  const pending = [];
  const unsubscribe = subscribe((event) => {
    if (replaying) pending.push(event);
    else writeEvent(event);
  });
  const replay = typeof getInitialEvents === "function" ? getInitialEvents() : initialEvents;
  replay.forEach(writeEvent);
  const replayMax = replay.reduce((max, event) => Math.max(max, Number(event.sequence || 0)), 0);
  replaying = false;
  pending.filter((event) => Number(event.sequence || 0) > replayMax).forEach(writeEvent);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref?.();
  const close = () => { clearInterval(heartbeat); unsubscribe?.(); };
  req.on("close", close);
  res.on("close", close);
  return true;
}

function parseCookies(header) {
  return String(header).split(";").reduce((out, pair) => {
    const index = pair.indexOf("=");
    if (index > 0) out[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    return out;
  }, {});
}
function isLoopback(value = "") { return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1"; }
function originMatchesHost(origin, host = "") {
  try { const parsed = new URL(origin); return parsed.host === host && ["http:", "https:"].includes(parsed.protocol); } catch { return false; }
}
function timingEqual(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}
function forbidden(message, code) { return Object.assign(new Error(message), { statusCode: 403, code }); }
