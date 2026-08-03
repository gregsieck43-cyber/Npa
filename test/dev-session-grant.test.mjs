import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { issueSessionGrant, validateSessionGrant } from "../services/dev-session-service.js";

test("session grant 实际校验允许写入 glob 与工作区边界", () => {
  const workspace = path.resolve(".tmp", "grant-workspace");
  const grant = issueSessionGrant({ sessionId: "s1", workspacePath: workspace, allowedWriteGlobs: ["src/**", "*.md"] });
  assert.equal(validateSessionGrant(grant, { sessionId: "s1", workspacePath: workspace, filePath: path.join(workspace, "src", "a.js") }).ok, true);
  assert.equal(validateSessionGrant(grant, { sessionId: "s1", workspacePath: workspace, filePath: path.join(workspace, "secret.txt") }).reason, "write_path_not_allowed");
  assert.equal(validateSessionGrant(grant, { sessionId: "s1", workspacePath: workspace, filePath: path.resolve(workspace, "..", "escape.md") }).reason, "write_path_outside_workspace");
});
