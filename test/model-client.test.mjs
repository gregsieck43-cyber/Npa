import test from "node:test";
import assert from "node:assert/strict";

import { buildModelRequest, createModelClient, normalizeModelResponse } from "../core/model-client.js";

test("OpenAI Responses 请求使用 Bearer token 并归一化文本", async () => {
  const seen = [];
  const client = createModelClient({
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return new Response(JSON.stringify({
        id: "resp_1",
        model: "gpt-5.5",
        output: [{ type: "message", content: [{ type: "output_text", text: "完成一步" }] }],
        usage: { input_tokens: 120, output_tokens: 30 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });

  const result = await client.generate({
    settings: { modelProvider: "openai", apiProtocol: "openai_responses", model: "gpt-5.5", maxTokens: 2048 },
    secrets: { token: "test-token" },
    messages: [{ role: "user", content: "继续任务" }]
  });

  assert.equal(result.text, "完成一步");
  assert.equal(result.usage.inputTokens, 120);
  assert.match(seen[0].url, /\/v1\/responses$/);
  assert.equal(seen[0].options.headers.Authorization, "Bearer test-token");
});

test("Anthropic 错误不泄漏响应体中的 secret", async () => {
  const client = createModelClient({
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "bad sk-secret-value" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    })
  });

  await assert.rejects(
    client.generate({
      settings: { modelProvider: "anthropic", model: "claude-sonnet-4-6" },
      secrets: { token: "sk-secret-value" },
      messages: [{ role: "user", content: "hello" }]
    }),
    (error) => error.statusCode === 401 && !error.message.includes("sk-secret-value")
  );
});

test("normalizeModelResponse 支持 OpenAI chat 与 Gemini", () => {
  assert.equal(normalizeModelResponse({ choices: [{ message: { content: "chat" } }] }, { protocol: "openai_chat" }).text, "chat");
  assert.equal(normalizeModelResponse({ candidates: [{ content: { parts: [{ text: "gemini" }] } }] }, { protocol: "gemini_generate" }).text, "gemini");
});

test("自定义模型 endpoint 经过 SSRF 校验且禁止重定向，Gemini key 不进入 URL", async () => {
  const checked = [];
  const client = createModelClient({
    urlValidator: async (url) => checked.push(url),
    fetchImpl: async () => new Response("", { status: 302, headers: { Location: "http://127.0.0.1/private" } })
  });
  await assert.rejects(
    client.generate({ settings: { modelProvider: "custom", apiProtocol: "openai_chat", model: "custom", apiBaseUrl: "https://models.example" }, messages: [{ role: "user", content: "hi" }] }),
    (error) => error.code === "model_redirect_denied"
  );
  assert.equal(checked.length, 1);

  const request = buildModelRequest({
    settings: { modelProvider: "gemini", apiProtocol: "gemini_generate", model: "gemini-test" },
    profile: { provider: "gemini", protocol: "gemini_generate" },
    token: "private-gemini-key",
    messages: [{ role: "user", content: "hi" }]
  });
  assert.equal(request.url.includes("private-gemini-key"), false);
  assert.equal(request.headers["x-goog-api-key"], "private-gemini-key");
});
