import test from "node:test";
import assert from "node:assert/strict";

import { createRiskConfirmationStore, riskHash } from "../services/risk-confirmation-service.js";

test("风险详情哈希不受对象键顺序影响，并保持一次性消费", () => {
  assert.equal(riskHash({ b: 2, a: { y: 2, x: 1 } }), riskHash({ a: { x: 1, y: 2 }, b: 2 }));
  const store = createRiskConfirmationStore();
  const issued = store.issue({ action: "write", detail: { path: "a", mode: "replace" } });
  assert.equal(store.consume({ token: issued.token, action: "write", detail: { mode: "replace", path: "a" } }).ok, true);
  assert.throws(() => store.consume({ token: issued.token, action: "write", detail: { path: "a", mode: "replace" } }), /missing|expired|used/i);
});
