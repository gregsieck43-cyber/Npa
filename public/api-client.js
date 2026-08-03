import { state } from "./state.js";

export async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.sessionToken) headers["X-Local-Session-Token"] = state.sessionToken;
  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败: ${response.status}`);
  return payload;
}

export async function sha256Text(value = "") {
  if (!window.crypto?.subtle || !window.TextEncoder) return `len:${String(value).length}`;
  const data = new TextEncoder().encode(String(value));
  const digest = await window.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function requestRiskConfirmation(action, detail = {}) {
  const payload = await api("/api/security/confirmations", {
    method: "POST",
    body: { action, detail, confirmed: true }
  });
  return { token: payload.confirmation?.token || "" };
}
