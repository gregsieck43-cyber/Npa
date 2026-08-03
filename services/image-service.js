import crypto from "node:crypto";

export const DEFAULT_IMAGE_SETTINGS = {
  provider: "openai",
  model: "gpt-image-1",
  endpoint: "",
  size: "1024x1024",
  quality: "auto",
  style: "natural",
  historyLimit: 80
};

const IMAGE_SIZES = new Set(["256x256", "512x512", "1024x1024", "1024x1536", "1536x1024", "auto"]);
export const IMAGE_PROVIDERS = ["openai", "local", "custom", "anthropic", "mock"];
export const IMAGE_QUALITIES = ["auto", "low", "medium", "high", "standard", "hd"];

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

export function normalizeImageSettings(input = {}) {
  return {
    provider: IMAGE_PROVIDERS.includes(input.provider) ? input.provider : DEFAULT_IMAGE_SETTINGS.provider,
    model: String(input.model || DEFAULT_IMAGE_SETTINGS.model).slice(0, 120),
    endpoint: String(input.endpoint || "").trim().slice(0, 1000),
    size: IMAGE_SIZES.has(input.size) ? input.size : DEFAULT_IMAGE_SETTINGS.size,
    quality: IMAGE_QUALITIES.includes(input.quality) ? input.quality : DEFAULT_IMAGE_SETTINGS.quality,
    style: String(input.style || DEFAULT_IMAGE_SETTINGS.style).slice(0, 120),
    historyLimit: Math.min(200, Math.max(10, Number(input.historyLimit || DEFAULT_IMAGE_SETTINGS.historyLimit)))
  };
}

function generatedMockImage(input, settings) {
  const prompt = String(input.prompt || "Mock image").trim();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="#faf9f6"/>
  <rect x="72" y="72" width="880" height="880" rx="28" fill="#fff" stroke="#dedbd2" stroke-width="3"/>
  <circle cx="256" cy="280" r="92" fill="#d9673f" opacity=".85"/>
  <rect x="392" y="212" width="360" height="136" rx="24" fill="#2f6fed" opacity=".82"/>
  <path d="M168 728 C300 520 430 612 520 488 C640 324 792 452 872 276 L872 824 L168 824 Z" fill="#12715b" opacity=".72"/>
  <text x="112" y="910" font-size="34" font-family="Microsoft YaHei, sans-serif" fill="#1f1f1c">${escapeXml(prompt.slice(0, 36))}</text>
</svg>`;
  return normalizeGeneratedImage({
    provider: "mock",
    model: settings.model || "mock-image",
    prompt,
    size: input.size || settings.size,
    style: input.style || settings.style,
    mimeType: "image/svg+xml",
    data: Buffer.from(svg, "utf8").toString("base64"),
    revisedPrompt: `Mock provider: ${prompt}`
  });
}

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function normalizeGeneratedImage(input = {}) {
  return {
    id: String(input.id || id("img")),
    provider: String(input.provider || "").slice(0, 80),
    model: String(input.model || "").slice(0, 120),
    prompt: String(input.prompt || "").slice(0, 8000),
    negativePrompt: String(input.negativePrompt || "").slice(0, 4000),
    size: String(input.size || "").slice(0, 40),
    style: String(input.style || "").slice(0, 120),
    mimeType: String(input.mimeType || "image/png").slice(0, 80),
    url: String(input.url || "").slice(0, 4000),
    data: String(input.data || "").slice(0, 20 * 1024 * 1024),
    revisedPrompt: String(input.revisedPrompt || "").slice(0, 8000),
    artifactId: input.artifactId || "",
    status: ["completed", "failed"].includes(input.status) ? input.status : "completed",
    error: String(input.error || "").slice(0, 4000),
    createdAt: input.createdAt || now()
  };
}

function tokenFromSecrets(secrets = {}) {
  return secrets.token || secrets.apiKey || secrets.accessToken || "";
}

async function generateOpenAiImage(input, settings, secrets, fetchImpl) {
  const token = tokenFromSecrets(secrets);
  if (!token) throw Object.assign(new Error("OpenAI 图像生成需要在连接器中保存 token 或 apiKey"), { statusCode: 400 });
  const endpoint = settings.endpoint || "https://api.openai.com/v1/images/generations";
  const body = {
    model: input.model || settings.model || "gpt-image-1",
    prompt: input.prompt,
    size: input.size || settings.size,
    quality: input.quality || settings.quality,
    n: 1
  };
  if (input.style || settings.style) body.style = input.style || settings.style;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error?.message || `OpenAI 图像生成失败 (${response.status})`), { statusCode: response.status });
  const first = payload.data?.[0] || {};
  return {
    provider: "openai",
    model: body.model,
    mimeType: "image/png",
    url: first.url || "",
    data: first.b64_json || "",
    revisedPrompt: first.revised_prompt || ""
  };
}

async function generateLocalImage(input, settings, secrets, fetchImpl) {
  const endpoint = input.endpoint || settings.endpoint;
  if (!endpoint) throw Object.assign(new Error("本地图像模型需要配置 endpoint"), { statusCode: 400 });
  const token = tokenFromSecrets(secrets);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      prompt: input.prompt,
      negativePrompt: input.negativePrompt || "",
      size: input.size || settings.size,
      style: input.style || settings.style,
      model: input.model || settings.model
    })
  });
  const contentType = response.headers.get("content-type") || "";
  if (contentType.startsWith("image/")) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      provider: settings.provider,
      model: input.model || settings.model,
      mimeType: contentType.split(";")[0],
      data: buffer.toString("base64"),
      url: ""
    };
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || payload.message || `图像生成失败 (${response.status})`), { statusCode: response.status });
  return {
    provider: settings.provider,
    model: input.model || settings.model,
    mimeType: payload.mimeType || "image/png",
    data: payload.b64_json || payload.data || "",
    url: payload.url || "",
    revisedPrompt: payload.revisedPrompt || payload.revised_prompt || ""
  };
}

export async function generateImage(input = {}, { settings = {}, secrets = {}, fetchImpl = fetch } = {}) {
  const normalized = normalizeImageSettings({ ...settings, ...input });
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw Object.assign(new Error("图像生成提示词不能为空"), { statusCode: 400 });
  if (normalized.provider === "anthropic") {
    throw Object.assign(new Error("当前未检测到 Anthropic 通用图像生成 endpoint；请改用 OpenAI 或配置本地图像模型 endpoint。"), { statusCode: 400 });
  }
  if (normalized.provider === "mock") return generatedMockImage({ ...input, prompt }, normalized);
  let result;
  try {
    result = normalized.provider === "openai"
      ? await generateOpenAiImage({ ...input, prompt }, normalized, secrets, fetchImpl)
      : await generateLocalImage({ ...input, prompt }, normalized, secrets, fetchImpl);
  } catch (error) {
    throw redactImageError(error, secrets);
  }
  return normalizeGeneratedImage({
    ...result,
    prompt,
    negativePrompt: input.negativePrompt || "",
    size: input.size || normalized.size,
    style: input.style || normalized.style
  });
}

export async function testImageProvider({ settings = {}, secrets = {}, fetchImpl = fetch } = {}) {
  const normalized = normalizeImageSettings(settings);
  if (normalized.provider === "mock") return { ok: true, provider: "mock", mode: "offline", model: normalized.model };
  if (normalized.provider === "openai") {
    const token = tokenFromSecrets(secrets);
    return { ok: Boolean(token), provider: "openai", model: normalized.model, error: token ? "" : "缺少 OpenAI 图像 token" };
  }
  if (["local", "custom"].includes(normalized.provider)) {
    if (!normalized.endpoint) return { ok: false, provider: normalized.provider, error: "缺少本地图像 endpoint" };
    try {
      const response = await fetchImpl(normalized.endpoint, { method: "OPTIONS" });
      return { ok: response.ok || response.status < 500, provider: normalized.provider, status: response.status };
    } catch (error) {
      return { ok: false, provider: normalized.provider, error: redactText(error.message, Object.values(secrets)) };
    }
  }
  return { ok: false, provider: normalized.provider, error: "该供应商当前没有通用图像生成 endpoint" };
}

function redactImageError(error, secrets) {
  const sanitized = Object.assign(new Error(redactText(error?.message || error, Object.values(secrets))), {
    statusCode: error?.statusCode,
    code: error?.code
  });
  return sanitized;
}

function redactText(value, secrets) {
  let output = String(value || "");
  for (const secret of secrets.filter(Boolean).map(String)) output = output.split(secret).join("[REDACTED]");
  return output.slice(0, 4000);
}

export function buildBatchImageRequests(input = {}, settings = {}) {
  const prompts = Array.isArray(input.prompts)
    ? input.prompts
    : String(input.prompt || "").split(/\n---+\n|\n\n/);
  const normalizedPrompts = prompts
    .map((prompt) => String(prompt || "").trim())
    .filter(Boolean)
    .slice(0, 12);
  const variants = Math.min(Math.max(Number(input.variants || input.count || 1), 1), 12);
  const expanded = normalizedPrompts.length === 1 && variants > 1
    ? Array.from({ length: variants }, () => normalizedPrompts[0])
    : normalizedPrompts;
  return expanded
    .slice(0, 12)
    .map((prompt, index) => ({
      prompt,
      variantIndex: index + 1,
      negativePrompt: input.negativePrompt || "",
      provider: input.provider || settings.provider,
      model: input.model || settings.model,
      size: input.size || settings.size,
      quality: input.quality || settings.quality,
      style: input.style || settings.style
    }));
}

export function retryImageInput(image = {}) {
  const safe = normalizeGeneratedImage(image);
  return {
    prompt: safe.prompt,
    negativePrompt: safe.negativePrompt,
    provider: safe.provider,
    model: safe.model,
    size: safe.size,
    style: safe.style
  };
}

export function imageHistoryStats(images = []) {
  const rows = images.map(normalizeGeneratedImage);
  const byProvider = {};
  for (const image of rows) byProvider[image.provider || "unknown"] = (byProvider[image.provider || "unknown"] || 0) + 1;
  return {
    total: rows.length,
    completed: rows.filter((image) => image.status === "completed").length,
    failed: rows.filter((image) => image.status === "failed").length,
    byProvider,
    latestAt: rows.map((image) => image.createdAt).sort().at(-1) || ""
  };
}

export function imageArtifactContent(image) {
  const safe = normalizeGeneratedImage(image);
  const src = safe.data ? `data:${safe.mimeType};base64,${safe.data}` : safe.url;
  const alt = safe.prompt.replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>生成图像</title>
  <style>
    body{margin:0;background:#111;color:#f6f6f6;font-family:system-ui,"Microsoft YaHei",sans-serif}
    main{display:grid;gap:16px;min-height:100vh;place-items:center;padding:24px;box-sizing:border-box}
    img{max-width:100%;max-height:78vh;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
    p{max-width:960px;margin:0;color:#d9d9d9;line-height:1.6}
  </style>
</head>
<body>
  <main>
    <img src="${src}" alt="${alt}" />
    <p>${safe.revisedPrompt || safe.prompt}</p>
  </main>
</body>
</html>`;
}
