import test from "node:test";
import assert from "node:assert/strict";

import { redactGitHubPayload } from "../services/github-workflow-service.js";

test("GitHub payload 会递归清除嵌套 token 与 secret", () => {
  const redacted = redactGitHubPayload({
    token: "top",
    installation: { access_token: "nested", account: { webhookSecret: "deep", login: "bot" } },
    items: [{ authorization: "Bearer x" }]
  });
  assert.equal(redacted.token, "[redacted]");
  assert.equal(redacted.installation.access_token, "[redacted]");
  assert.equal(redacted.installation.account.webhookSecret, "[redacted]");
  assert.equal(redacted.installation.account.login, "bot");
  assert.equal(redacted.items[0].authorization, "[redacted]");
});
