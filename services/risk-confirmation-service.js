import crypto from "node:crypto";

export const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export function riskHash(value = {}) {
  return crypto.createHash("sha256").update(stableStringify(value || {}), "utf8").digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function createRiskConfirmationStore({ now = () => Date.now(), ttlMs = DEFAULT_CONFIRMATION_TTL_MS } = {}) {
  const records = new Map();

  function purgeExpired() {
    const current = now();
    for (const [token, record] of records.entries()) {
      if (record.expiresAt <= current || record.usedAt) records.delete(token);
    }
  }

  function issue({ action, detail = {}, actor = "local-session" } = {}) {
    purgeExpired();
    const token = crypto.randomBytes(24).toString("hex");
    const createdAt = now();
    const record = {
      token,
      action: String(action || ""),
      detailHash: riskHash(detail),
      actor,
      createdAt,
      expiresAt: createdAt + ttlMs,
      usedAt: 0
    };
    records.set(token, record);
    return { token, action: record.action, detailHash: record.detailHash, expiresAt: new Date(record.expiresAt).toISOString() };
  }

  function consume({ token, action, detail = {} } = {}) {
    purgeExpired();
    const record = records.get(String(token || ""));
    if (!record) {
      throw Object.assign(new Error("Risk confirmation token is missing, expired, or already used."), { statusCode: 428, code: "confirmation_required" });
    }
    if (record.action !== String(action || "")) {
      throw Object.assign(new Error("Risk confirmation action mismatch."), { statusCode: 428, code: "confirmation_mismatch" });
    }
    if (record.detailHash !== riskHash(detail)) {
      throw Object.assign(new Error("Risk confirmation payload changed after confirmation."), { statusCode: 428, code: "confirmation_payload_changed" });
    }
    record.usedAt = now();
    records.delete(record.token);
    return { ok: true, action: record.action, detailHash: record.detailHash };
  }

  function size() {
    purgeExpired();
    return records.size;
  }

  return { issue, consume, size };
}
