import test from "node:test";
import assert from "node:assert/strict";

import { resolveModelProfile } from "../services/model-provider-service.js";

test("模型能力矩阵不会把未知 custom/deepseek 模型误判为视觉模型", () => {
  assert.equal(resolveModelProfile({ modelProvider: "custom", model: "private-text-model" }).supportsVision, false);
  assert.equal(resolveModelProfile({ modelProvider: "deepseek", model: "deepseek-chat" }).supportsVision, false);
  assert.equal(resolveModelProfile({ modelProvider: "gemini", model: "gemini-3-pro" }).supportsVision, true);
});

test("Gemini 与主流消息协议公开工具能力", () => {
  assert.equal(resolveModelProfile({ modelProvider: "gemini", model: "gemini-3-pro" }).supportsTools, true);
  assert.equal(resolveModelProfile({ modelProvider: "custom", model: "private", supportsTools: false }).supportsTools, false);
});
