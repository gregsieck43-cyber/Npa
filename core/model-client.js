import { applyReasoningParameters, resolveModelProfile } from "../services/model-provider-service.js";
import { extractUsage } from "../services/usage-service.js";
import { assertPublicWebUrl } from "../services/web-service.js";

const DEFAULT_TIMEOUT_MS = 120_000;

export function createModelClient({ fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, urlValidator = assertPublicWebUrl } = {}) {
  return {
    async generate({ messages = [], settings = {}, secrets = {}, tools = [] } = {}) {
      const profile = resolveModelProfile(settings);
      const token = String(secrets.token || secrets.apiKey || "").trim();
      if (!token && profile.provider !== "custom") {
        throw publicError("模型接口密钥未配置", 400, "model_token_missing");
      }
      const request = buildModelRequest({ messages, settings, profile, token, tools });
      if (String(settings.apiBaseUrl || "").trim()) {
        await urlValidator(request.url, { allowPrivate: settings.allowPrivateModelEndpoint === true });
      }
      let response;
      try {
        response = await fetchImpl(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          redirect: "manual",
          signal: AbortSignal.timeout(Number(settings.timeoutMs || timeoutMs))
        });
      } catch (error) {
        throw publicError(`模型请求失败: ${redact(String(error?.message || error), [token])}`, 502, "model_network_error");
      }
      if (response.status >= 300 && response.status < 400) {
        throw publicError("模型接口返回重定向；请直接配置最终 HTTPS endpoint", 502, "model_redirect_denied");
      }
      const rawText = await response.text();
      let payload = {};
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch {
        payload = { rawText: rawText.slice(0, 2000) };
      }
      if (!response.ok) {
        const detail = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
        throw publicError(`模型请求失败: ${redact(detail, [token])}`, response.status, "model_http_error");
      }
      return normalizeModelResponse(payload, profile);
    }
  };
}

export function buildModelRequest({ messages = [], settings = {}, profile = resolveModelProfile(settings), token = "", tools = [] } = {}) {
  const model = String(settings.model || "").trim();
  const maxTokens = Math.max(256, Number(settings.maxTokens || 4096));
  const base = providerBaseUrl(profile, settings);
  if (profile.protocol === "anthropic_messages") {
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const body = {
      model,
      max_tokens: maxTokens,
      messages: messages.filter((message) => message.role !== "system").map(normalizeMessage)
    };
    if (system) body.system = system;
    if (tools.length) body.tools = tools;
    applyReasoningParameters(body, settings, profile);
    return {
      url: joinApi(base, "/v1/messages"),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": token,
        "anthropic-version": "2023-06-01"
      },
      body
    };
  }
  if (profile.protocol === "gemini_generate") {
    const body = {
      contents: messages.filter((message) => message.role !== "system").map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: contentText(message.content) }]
      }))
    };
    const systemText = messages.filter((message) => message.role === "system").map((message) => contentText(message.content)).join("\n\n");
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
    body.generationConfig = { maxOutputTokens: maxTokens };
    applyReasoningParameters(body, settings, profile);
    return {
      url: joinApi(base, `/v1beta/models/${encodeURIComponent(model)}:generateContent`),
      headers: { "Content-Type": "application/json", "x-goog-api-key": token },
      body
    };
  }
  if (profile.protocol === "openai_responses") {
    const body = {
      model,
      input: messages.map(normalizeMessage),
      max_output_tokens: maxTokens
    };
    if (tools.length) body.tools = tools;
    applyReasoningParameters(body, settings, profile);
    return {
      url: joinApi(base, "/v1/responses"),
      headers: bearerHeaders(token),
      body
    };
  }
  const body = {
    model,
    messages: messages.map(normalizeMessage),
    max_tokens: maxTokens
  };
  if (tools.length) body.tools = tools;
  applyReasoningParameters(body, settings, profile);
  return {
    url: joinApi(base, "/v1/chat/completions"),
    headers: bearerHeaders(token),
    body
  };
}

export function normalizeModelResponse(payload = {}, profile = {}) {
  let text = "";
  if (profile.protocol === "anthropic_messages") {
    text = (payload.content || []).filter((item) => item?.type === "text").map((item) => item.text || "").join("\n");
  } else if (profile.protocol === "openai_responses") {
    text = payload.output_text || (payload.output || []).flatMap((item) => item?.content || []).filter((item) => item?.type === "output_text").map((item) => item.text || "").join("\n");
  } else if (profile.protocol === "gemini_generate") {
    text = (payload.candidates || []).flatMap((candidate) => candidate?.content?.parts || []).map((part) => part?.text || "").join("\n");
  } else {
    const content = payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text ?? "";
    text = contentText(content);
  }
  return {
    id: String(payload.id || ""),
    model: String(payload.model || ""),
    text: text.trim(),
    usage: extractUsage(payload, profile),
    raw: payload
  };
}

function providerBaseUrl(profile, settings) {
  const custom = String(settings.apiBaseUrl || "").trim().replace(/\/$/, "");
  if (custom) return custom;
  if (profile.provider === "anthropic") return "https://api.anthropic.com";
  if (profile.provider === "gemini") return "https://generativelanguage.googleapis.com";
  if (profile.provider === "deepseek") return "https://api.deepseek.com";
  return "https://api.openai.com";
}

function joinApi(base, suffix) {
  const normalized = String(base || "").replace(/\/$/, "");
  if (normalized.endsWith("/v1") && suffix.startsWith("/v1/")) return `${normalized}${suffix.slice(3)}`;
  return `${normalized}${suffix}`;
}

function bearerHeaders(token) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function normalizeMessage(message = {}) {
  return { role: message.role || "user", content: contentText(message.content) };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item?.text || item?.content || "").join("\n");
  return content == null ? "" : String(content);
}

function redact(value, secrets) {
  let output = String(value || "");
  for (const secret of secrets.filter(Boolean)) output = output.split(secret).join("[REDACTED]");
  return output.slice(0, 2000);
}

function publicError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}
