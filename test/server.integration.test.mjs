import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createWorkbenchServer } from "../server.js";

async function startHarness(name, options = {}) {
  const dataDir = path.resolve(".tmp", "tests", `${name}-${process.pid}-${Date.now()}`);
  await mkdir(dataDir, { recursive: true });
  const app = await createWorkbenchServer({ port: 0, dataDir, startScheduler: false, ...options });
  await app.listen();
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { app, baseUrl, dataDir, async close() { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

async function bootstrap(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/bootstrap`);
  const body = await response.json();
  return { body, cookie: response.headers.get("set-cookie")?.split(";")[0] || "" };
}

test("health、session bootstrap、任务和 VISTA context 形成完整纵向切片", async () => {
  const harness = await startHarness("vertical");
  try {
    const health = await fetch(`${harness.baseUrl}/api/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.app, "local-claude-workbench");

    const session = await bootstrap(harness.baseUrl);
    assert.ok(session.body.csrfToken);
    assert.ok(session.cookie);
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.body.csrfToken, "Content-Type": "application/json" };

    const taskResponse = await fetch(`${harness.baseUrl}/api/v1/tasks`, {
      method: "POST", headers, body: JSON.stringify({ title: "集成任务", acceptanceCriteria: ["可恢复"] })
    });
    assert.equal(taskResponse.status, 201);
    const { task } = await taskResponse.json();

    const idempotencyHeaders = { ...headers, "Idempotency-Key": "start-integration" };
    const firstRun = await fetch(`${harness.baseUrl}/api/v1/tasks/${task.id}/runs`, { method: "POST", headers: idempotencyHeaders, body: "{}" }).then((response) => response.json());
    const secondRun = await fetch(`${harness.baseUrl}/api/v1/tasks/${task.id}/runs`, { method: "POST", headers: idempotencyHeaders, body: "{}" }).then((response) => response.json());
    assert.equal(firstRun.run.id, secondRun.run.id);

    const context = await fetch(`${harness.baseUrl}/api/v1/runs/${firstRun.run.id}/context`, { headers: { Cookie: session.cookie } }).then((response) => response.json());
    assert.ok(context.context.blocks.length >= 3);
    const movable = context.context.blocks.find((block) => !block.pinned) || context.context.blocks[0];
    const contextHeaders = { ...headers, "Idempotency-Key": "pin-context-once" };
    const eventsBefore = harness.app.runner.getEvents(firstRun.run.id).length;
    const pinResult = await fetch(`${harness.baseUrl}/api/v1/runs/${firstRun.run.id}/context/actions`, {
      method: "POST", headers: contextHeaders, body: JSON.stringify({ action: "pin", blockIds: [movable.id] })
    });
    assert.equal(pinResult.status, 200);
    const replayedPin = await fetch(`${harness.baseUrl}/api/v1/runs/${firstRun.run.id}/context/actions`, {
      method: "POST", headers: contextHeaders, body: JSON.stringify({ action: "pin", blockIds: [movable.id] })
    });
    assert.equal(replayedPin.status, 200);
    assert.equal(harness.app.runner.getEvents(firstRun.run.id).length, eventsBefore + 1);

    const paused = await fetch(`${harness.baseUrl}/api/v1/runs/${firstRun.run.id}/pause`, { method: "POST", headers, body: "{}" }).then((response) => response.json());
    assert.equal(paused.run.status, "paused");
    const resumed = await fetch(`${harness.baseUrl}/api/v1/runs/${firstRun.run.id}/resume`, { method: "POST", headers, body: "{}" }).then((response) => response.json());
    assert.equal(resumed.run.status, "queued");

    const allEvents = harness.app.runner.getEvents(firstRun.run.id);
    const expected = allEvents.at(-1);
    const controller = new AbortController();
    const streamResponse = await fetch(`${harness.baseUrl}/api/v1/runs/${firstRun.run.id}/stream`, {
      headers: { Cookie: session.cookie, "Last-Event-ID": String(expected.sequence - 1) },
      signal: controller.signal
    });
    assert.equal(streamResponse.headers.get("content-type").startsWith("text/event-stream"), true);
    const reader = streamResponse.body.getReader();
    let streamText = "";
    while (!streamText.includes(`id: ${expected.sequence}\n`) || !streamText.includes(`event: ${expected.type}\n`)) {
      const { value, done } = await reader.read();
      if (done) break;
      streamText += new TextDecoder().decode(value);
    }
    controller.abort();
    assert.match(streamText, new RegExp(`id: ${expected.sequence}\\n`));
    assert.match(streamText, new RegExp(`event: ${expected.type.replaceAll(".", "\\.")}\\n`));
  } finally {
    await harness.close();
  }
});

test("run-bound web tools record a durable effect and replay its completed result", async () => {
  const harness = await startHarness("tool-ledger");
  try {
    const session = await bootstrap(harness.baseUrl);
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.body.csrfToken, "Content-Type": "application/json" };
    const task = await fetch(`${harness.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "tool ledger" }) }).then((response) => response.json());
    const run = await fetch(`${harness.baseUrl}/api/v1/tasks/${task.task.id}/runs`, { method: "POST", headers, body: "{}" }).then((response) => response.json());
    const body = JSON.stringify({ runId: run.run.id, query: "ledger", settings: { provider: "mock" } });
    const first = await fetch(`${harness.baseUrl}/api/v1/tools/web/search`, { method: "POST", headers, body });
    const second = await fetch(`${harness.baseUrl}/api/v1/tools/web/search`, { method: "POST", headers, body });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), await first.clone().json());
    const effects = harness.app.db.all("SELECT * FROM effects WHERE run_id = ? AND kind = 'web.search'", run.run.id);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].status, "completed");
  } finally {
    await harness.close();
  }
});

test("Run Grant denial creates one visible approval and approval expands only the requested scope", async () => {
  const harness = await startHarness("tool-approval");
  try {
    const session = await bootstrap(harness.baseUrl);
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.body.csrfToken, "Content-Type": "application/json" };
    const task = await fetch(`${harness.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "grant approval" }) }).then((response) => response.json());
    const created = await fetch(`${harness.baseUrl}/api/v1/tasks/${task.task.id}/runs`, { method: "POST", headers, body: "{}" }).then((response) => response.json());
    const narrowBudget = { ...created.run.budget, maxModelCalls: 1 };
    harness.app.db.run("UPDATE grants SET budget_json = ? WHERE run_id = ?", JSON.stringify(narrowBudget), created.run.id);
    const denied = await fetch(`${harness.baseUrl}/api/v1/tools/web/search`, {
      method: "POST", headers, body: JSON.stringify({ runId: created.run.id, query: "scope", settings: { provider: "brave" } })
    });
    assert.equal(denied.status, 428);
    const approval = harness.app.db.get("SELECT * FROM approvals WHERE run_id = ? AND status = 'pending'", created.run.id);
    assert.ok(approval);
    assert.equal(harness.app.runner.getRun(created.run.id).status, "waiting_approval");
    const bootstrapBody = await fetch(`${harness.baseUrl}/api/v1/bootstrap`, { headers: { Cookie: session.cookie } }).then((response) => response.json());
    assert.equal(bootstrapBody.vista.approvals.length, 1);

    const allowed = await fetch(`${harness.baseUrl}/api/v1/runs/${created.run.id}/approvals/${approval.id}`, {
      method: "POST", headers, body: JSON.stringify({ decision: "allow" })
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).run.status, "queued");
    const grant = harness.app.db.get("SELECT network_json, budget_json FROM grants WHERE run_id = ? AND status = 'active'", created.run.id);
    assert.deepEqual(JSON.parse(grant.network_json).sort(), ["api.openai.com", "api.search.brave.com"].sort());
    assert.equal(JSON.parse(grant.budget_json).maxModelCalls, 1);
    assert.ok(harness.app.runner.getEvents(created.run.id).some((event) => event.type === "approval.updated"));

    const invalid = harness.app.runner.requestApproval(created.run.id, { action: "web.search", grant: { hosts: ["127.0.0.1"] } });
    const invalidResponse = await fetch(`${harness.baseUrl}/api/v1/runs/${created.run.id}/approvals/${invalid.id}`, {
      method: "POST", headers, body: JSON.stringify({ decision: "allow" })
    });
    assert.equal(invalidResponse.status, 403);
    assert.equal(harness.app.db.get("SELECT status FROM approvals WHERE id = ?", invalid.id).status, "pending");

    harness.app.repo.saveSettings({ web: { provider: "custom", customEndpoint: "https://search.example.com/api" } });
    const customTask = await fetch(`${harness.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "effective settings" }) }).then((response) => response.json());
    const customRun = await fetch(`${harness.baseUrl}/api/v1/tasks/${customTask.task.id}/runs`, { method: "POST", headers, body: "{}" }).then((response) => response.json());
    const customDenied = await fetch(`${harness.baseUrl}/api/v1/tools/web/search`, {
      method: "POST", headers, body: JSON.stringify({ runId: customRun.run.id, query: "effective" })
    });
    assert.equal(customDenied.status, 428);
    const customApproval = harness.app.db.get("SELECT request_json FROM approvals WHERE run_id = ? AND status = 'pending'", customRun.run.id);
    assert.deepEqual(JSON.parse(customApproval.request_json).grant.hosts, ["search.example.com"]);

    const offlineTask = await fetch(`${harness.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "offline tools" }) }).then((response) => response.json());
    const offlineRun = await fetch(`${harness.baseUrl}/api/v1/tasks/${offlineTask.task.id}/runs`, { method: "POST", headers, body: "{}" }).then((response) => response.json());
    harness.app.db.run("UPDATE grants SET network_json = '[]' WHERE run_id = ?", offlineRun.run.id);
    const imageMock = await fetch(`${harness.baseUrl}/api/v1/images/generate`, {
      method: "POST", headers, body: JSON.stringify({ runId: offlineRun.run.id, prompt: "quiet desk", settings: { provider: "mock" } })
    });
    assert.equal(imageMock.status, 200);
    const localTime = await fetch(`${harness.baseUrl}/api/v1/tools/web/time`, {
      method: "POST", headers, body: JSON.stringify({ runId: offlineRun.run.id, settings: { provider: "mock" } })
    });
    assert.equal(localTime.status, 200);
    for (const [tool, payload] of [
      ["finance", { ticker: "MOCK" }],
      ["weather", { location: "Taipei" }],
      ["sports", { league: "nba", fn: "schedule" }]
    ]) {
      const response = await fetch(`${harness.baseUrl}/api/v1/tools/web/${tool}`, {
        method: "POST", headers, body: JSON.stringify({ runId: offlineRun.run.id, ...payload, settings: { provider: "mock" } })
      });
      assert.equal(response.status, 200);
    }
    assert.equal(harness.app.db.get("SELECT count(*) AS count FROM approvals WHERE run_id = ?", offlineRun.run.id).count, 0);
  } finally {
    await harness.close();
  }
});

test("跨站写请求和无 token CLI 被拒绝，短期本地 token 可工作", async () => {
  const harness = await startHarness("security");
  try {
    const crossSite = await fetch(`${harness.baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "bad" })
    });
    assert.equal(crossSite.status, 403);
    const crossSiteBootstrap = await fetch(`${harness.baseUrl}/api/v1/bootstrap`, {
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }
    });
    assert.equal(crossSiteBootstrap.status, 403);
    const health = await fetch(`${harness.baseUrl}/api/health`).then((response) => response.json());
    assert.equal(Object.hasOwn(health, "root"), false);
    assert.equal(Object.hasOwn(health, "owned"), false);
    const ownedHealth = await fetch(`${harness.baseUrl}/api/health`, {
      headers: { "X-Local-Session-Token": harness.app.session.rootToken }
    }).then((response) => response.json());
    assert.equal(ownedHealth.owned, true);
    assert.equal(Object.hasOwn(ownedHealth, "root"), false);
    const instanceId = crypto.createHash("sha256").update(harness.app.rootDir.replace(/[\\/]+$/, "").toUpperCase()).digest("hex");
    const instanceHealth = await fetch(`${harness.baseUrl}/api/health`, {
      headers: { "X-Workbench-Instance-Id": instanceId }
    }).then((response) => response.json());
    assert.equal(instanceHealth.owned, true);

    const anonymousCli = await fetch(`${harness.baseUrl}/api/v1/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "CLI task" })
    });
    assert.equal(anonymousCli.status, 403);

    const cli = await fetch(`${harness.baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Local-Session-Token": harness.app.session.rootToken },
      body: JSON.stringify({ title: "CLI task" })
    });
    assert.equal(cli.status, 201);
    const cliRun = await fetch(`${harness.baseUrl}/api/v1/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Local-Session-Token": harness.app.session.rootToken },
      body: JSON.stringify({ prompt: "CLI 一步创建并运行" })
    });
    assert.equal(cliRun.status, 201);
    const cliRunBody = await cliRun.json();
    assert.equal(cliRunBody.task.title, "CLI 一步创建并运行");
    assert.equal(cliRunBody.run.status, "queued");
  } finally {
    await harness.close();
  }
});

test("兼容 data API 可导入、清洗和透视数据", async () => {
  const harness = await startHarness("data");
  try {
    const session = await bootstrap(harness.baseUrl);
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.body.csrfToken, "Content-Type": "application/json" };
    const imported = await fetch(`${harness.baseUrl}/api/data/import-upload`, {
      method: "POST", headers, body: JSON.stringify({ file: { name: "sales.json", mimeType: "application/json", content: JSON.stringify([{ group: "A", value: 2 }, { group: "A", value: 3 }, { group: "B", value: 4 }]) } })
    });
    assert.equal(imported.status, 200);
    const dataset = (await imported.json()).datasets[0];
    assert.equal(dataset.rows.length, 3);

    const pivot = await fetch(`${harness.baseUrl}/api/data/pivot`, {
      method: "POST", headers, body: JSON.stringify({ datasetId: dataset.id, groupBy: "group", value: "value", op: "sum" })
    });
    assert.equal(pivot.status, 200);
    const pivotBody = await pivot.json();
    assert.deepEqual(pivotBody.run.table.map((row) => row.sum), [5, 4]);
  } finally {
    await harness.close();
  }
});

test("工具 API 提供离线图像、受限预览、代码与 Git 工作区能力", async () => {
  const harness = await startHarness("tools");
  try {
    const session = await bootstrap(harness.baseUrl);
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.body.csrfToken, "Content-Type": "application/json" };

    const imageResponse = await fetch(`${harness.baseUrl}/api/v1/images/generate`, {
      method: "POST", headers, body: JSON.stringify({ provider: "mock", prompt: "静谧任务台" })
    });
    assert.equal(imageResponse.status, 200);
    const image = (await imageResponse.json()).image;
    assert.equal(image.provider, "mock");
    assert.equal(image.mimeType, "image/svg+xml");
    assert.ok(image.data.length > 100);

    const ssrfImage = await fetch(`${harness.baseUrl}/api/v1/images/generate`, {
      method: "POST", headers, body: JSON.stringify({ provider: "local", endpoint: "http://127.0.0.1:9/private", prompt: "blocked" })
    });
    assert.equal(ssrfImage.status, 403);
    const unapprovedPrivateImage = await fetch(`${harness.baseUrl}/api/v1/images/generate`, {
      method: "POST", headers, body: JSON.stringify({ provider: "local", endpoint: "http://127.0.0.1:9/private", allowPrivate: true, prompt: "blocked" })
    });
    assert.equal(unapprovedPrivateImage.status, 428);

    const previewResponse = await fetch(`${harness.baseUrl}/api/v1/artifacts/preview`, {
      method: "POST", headers, body: JSON.stringify({ kind: "html", content: "<script>top.location='https://evil.example'</script>" })
    });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200);
    assert.match(preview.csp, /default-src 'none'/);
    assert.match(preview.csp, /base-uri 'none'/);

    const codeResponse = await fetch(`${harness.baseUrl}/api/v1/tools/code/read?path=package.json`, {
      headers: { Cookie: session.cookie }
    });
    assert.equal(codeResponse.status, 200);
    assert.match((await codeResponse.json()).content, /local-claude-workbench/);

    const traversal = await fetch(`${harness.baseUrl}/api/v1/tools/code/read?path=..%2Foutside.txt`, {
      headers: { Cookie: session.cookie }
    });
    assert.equal(traversal.status, 403);

    const gitResponse = await fetch(`${harness.baseUrl}/api/v1/tools/git/status`, { headers: { Cookie: session.cookie } });
    assert.equal(gitResponse.status, 200);
    assert.match((await gitResponse.json()).status, /^## /);
  } finally {
    await harness.close();
  }
});

test("旧 JSON store 先备份再在单事务中迁移，损坏数据会保留并拒绝启动", async () => {
  const validDir = path.resolve(".tmp", "tests", `legacy-valid-${process.pid}-${Date.now()}`);
  const invalidDir = path.resolve(".tmp", "tests", `legacy-invalid-${process.pid}-${Date.now()}`);
  await mkdir(validDir, { recursive: true });
  await mkdir(invalidDir, { recursive: true });
  try {
    await writeFile(path.join(validDir, "store.json"), JSON.stringify({ settings: { theme: "dark" }, conversations: [{ id: "old" }] }), "utf8");
    const app = await createWorkbenchServer({ port: 0, dataDir: validDir, startScheduler: false });
    try {
      assert.equal(app.repo.getSettings().theme, "dark");
      assert.equal(app.repo.getValue("legacy_migration_v1").status, "imported");
      assert.ok((await readdir(validDir)).some((name) => /^store\.backup-.*\.json$/.test(name)));
      assert.match(await readFile(path.join(validDir, "store.json"), "utf8"), /conversations/);
    } finally {
      await app.close();
    }

    await writeFile(path.join(invalidDir, "store.json"), "{broken", "utf8");
    await assert.rejects(
      createWorkbenchServer({ port: 0, dataDir: invalidDir, startScheduler: false }),
      /旧数据迁移失败/
    );
    assert.equal(await readFile(path.join(invalidDir, "store.json"), "utf8"), "{broken");
    assert.ok((await readdir(invalidDir)).some((name) => /^store\.backup-.*\.json$/.test(name)));
  } finally {
    await rm(validDir, { recursive: true, force: true });
    await rm(invalidDir, { recursive: true, force: true });
  }
});

test("开发 Agent API 形成 Worktree → Diff → 测试 → 原子提交闭环", async () => {
  const calls = { create: 0, test: 0, commit: 0 };
  const fakeWorktrees = {
    async createWorktree({ runId }) { calls.create += 1; return { runId, path: path.resolve(".worktrees", runId), branch: `codex/run-${runId.replace(/^run_/, "").slice(0, 8)}` }; },
    async status(runId) { return { runId, clean: false, branch: `codex/run-${runId.slice(-8)}`, entries: [{ code: " M", path: "README.md" }] }; },
    async diff(runId) { return { runId, diff: "@@ -1 +1 @@\n-old\n+new" }; },
    async runTest(runId, body) { calls.test += 1; return { id: `test-${calls.test}`, runId, status: "passed", passed: true, command: body.command, stdout: "ok", stderr: "", exitCode: 0 }; },
    async queryCommit(runId) { return { runId, hash: "a".repeat(40), subject: "verified slice" }; },
    async createCommit(runId, body) { calls.commit += 1; return { runId, message: body.message, commit: { hash: "b".repeat(40), subject: body.message } }; }
  };
  const harness = await startHarness("dev-agent", { worktreeService: fakeWorktrees });
  try {
    const session = await bootstrap(harness.baseUrl);
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.body.csrfToken, "Content-Type": "application/json" };
    const task = await fetch(`${harness.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "实现切片" }) }).then((response) => response.json());
    const run = await fetch(`${harness.baseUrl}/api/v1/tasks/${task.task.id}/runs`, { method: "POST", headers, body: "{}" }).then((response) => response.json());
    const runId = run.run.id;

    const worktreeHeaders = { ...headers, "Idempotency-Key": "worktree-once" };
    const created = await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/worktree`, { method: "POST", headers: worktreeHeaders, body: "{}" });
    assert.equal(created.status, 201);
    await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/worktree`, { method: "POST", headers: worktreeHeaders, body: "{}" });
    assert.equal(calls.create, 1);
    const grant = await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/grant`, { headers: { Cookie: session.cookie } }).then((response) => response.json());
    assert.ok(grant.grant.paths[0].includes(runId));

    const denied = await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/tests`, { method: "POST", headers, body: JSON.stringify({ command: "powershell whoami" }) });
    assert.equal(denied.status, 403);
    const tested = await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/tests`, { method: "POST", headers, body: JSON.stringify({ command: "node --test", label: "切片测试" }) });
    assert.equal(tested.status, 200);
    const testedBody = await tested.json();
    assert.equal(testedBody.test.status, "passed");
    assert.equal(testedBody.commit.type, "commit");
    assert.equal(calls.commit, 1);

    const diff = await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/diff`, { headers: { Cookie: session.cookie } }).then((response) => response.json());
    assert.match(diff.diff.diff, /\+new/);

    const commitHeaders = { ...headers, "Idempotency-Key": "commit-once" };
    const committed = await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/commits`, { method: "POST", headers: commitHeaders, body: JSON.stringify({ message: "feat: verified slice" }) });
    assert.equal(committed.status, 201);
    await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/commits`, { method: "POST", headers: commitHeaders, body: JSON.stringify({ message: "feat: verified slice" }) });
    assert.equal(calls.commit, 2);
  } finally {
    await harness.close();
  }
});

test("设置写入与响应都会递归剥离嵌套秘密", async () => {
  const harness = await startHarness("nested-settings");
  try {
    const session = await bootstrap(harness.baseUrl);
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.body.csrfToken, "Content-Type": "application/json" };
    const response = await fetch(`${harness.baseUrl}/api/v1/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ providers: { openai: { apiKey: "sk-secret", nested: { accessToken: "nested-secret", endpoint: "https://api.example" } } } })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(JSON.stringify(payload).includes("sk-secret"), false);
    assert.equal(JSON.stringify(payload).includes("nested-secret"), false);
    assert.equal(payload.settings.providers.openai.nested.endpoint, "https://api.example");
    const stored = harness.app.db.get("SELECT value_json FROM app_settings WHERE key = 'settings'").value_json;
    assert.equal(stored.includes("sk-secret"), false);
    assert.equal(stored.includes("nested-secret"), false);
  } finally {
    await harness.close();
  }
});

test("并发 Idempotency-Key 只有一个写入者，完成后可稳定重放", async () => {
  const harness = await startHarness("idempotency-race");
  try {
    const session = await bootstrap(harness.baseUrl);
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.body.csrfToken, "Content-Type": "application/json", "Idempotency-Key": "same-task-write" };
    const makeRequest = () => fetch(`${harness.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "只创建一次" }) });
    const concurrent = await Promise.all([makeRequest(), makeRequest()]);
    assert.ok(concurrent.every((response) => [201, 409].includes(response.status)));
    assert.ok(concurrent.some((response) => response.status === 201));
    const replay = await makeRequest();
    assert.equal(replay.status, 201);
    const conflict = await fetch(`${harness.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "不同内容" }) });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "idempotency_key_conflict");
    const tasks = harness.app.runner.listTasks().filter((task) => task.title === "只创建一次");
    assert.equal(tasks.length, 1);
  } finally {
    await harness.close();
  }
});

test("代码工具拒绝通过工作区内 junction 读取根目录外文件", async () => {
  const rootDir = path.resolve(".tmp", "tests", `symlink-root-${process.pid}-${Date.now()}`);
  const outsideDir = path.resolve(".tmp", "tests", `symlink-outside-${process.pid}-${Date.now()}`);
  await mkdir(rootDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, "secret.txt"), "must-not-leak", "utf8");
  await symlink(outsideDir, path.join(rootDir, "escape"), "junction");
  const harness = await startHarness("symlink", { rootDir });
  try {
    const session = await bootstrap(harness.baseUrl);
    const response = await fetch(`${harness.baseUrl}/api/v1/tools/code/read?path=escape%2Fsecret.txt`, { headers: { Cookie: session.cookie } });
    assert.equal(response.status, 403);
    assert.equal((await response.text()).includes("must-not-leak"), false);
  } finally {
    await harness.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("配置模型后 scheduler 受 Run Grant 约束并持久化可验证响应", async () => {
  const previous = process.env.WORKBENCH_MODEL_TOKEN;
  process.env.WORKBENCH_MODEL_TOKEN = "test-process-token";
  const seen = [];
  const largeMessage = `完成一个可验证切片 ${"Z".repeat(50_000)}`;
  const harness = await startHarness("runner-model", {
    modelClient: {
      async generate(request) {
        seen.push(request);
        return {
          text: JSON.stringify({ message: largeMessage, progressMade: true, checkpoint: { artifact: "report.md" }, status: "sleeping" }),
          model: "gpt-5.5",
          usage: { inputTokens: 12, outputTokens: 8, estimatedUsd: 0.001 }
        };
      }
    }
  });
  try {
    const session = await bootstrap(harness.baseUrl);
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.body.csrfToken, "Content-Type": "application/json" };
    const task = await fetch(`${harness.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "模型切片" }) }).then((response) => response.json());
    const run = await fetch(`${harness.baseUrl}/api/v1/tasks/${task.task.id}/runs`, { method: "POST", headers, body: "{}" }).then((response) => response.json());
    const advanced = await harness.app.runner.tick();
    assert.equal(advanced.status, "sleeping");
    assert.equal(advanced.metadata.modelCalls, 1);
    assert.equal(advanced.metadata.noProgressCalls, 0);
    assert.equal(seen.length, 1);
    const events = harness.app.runner.getEvents(run.run.id);
    assert.ok(events.some((event) => event.type === "model.response"));
    assert.ok(events.some((event) => event.type === "message.delta"));
    assert.ok(JSON.stringify(events).length < 20_000);
    const modelBlock = harness.app.contextService.listBlocks(advanced.workspaceId, { includeArchived: true }).find((block) => block.type === "model_result");
    assert.equal(modelBlock.offloaded, true);
    assert.ok(modelBlock.payloadRef);
  } finally {
    await harness.close();
    if (previous === undefined) delete process.env.WORKBENCH_MODEL_TOKEN;
    else process.env.WORKBENCH_MODEL_TOKEN = previous;
  }
});

test("扩大或关闭运行硬预算必须消费一次性风险确认", async () => {
  const harness = await startHarness("budget-confirmation");
  try {
    const session = await bootstrap(harness.baseUrl);
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.body.csrfToken, "Content-Type": "application/json" };
    const task = await fetch(`${harness.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "扩展预算" }) }).then((response) => response.json());
    const budget = { durationHours: 96, maxModelCalls: 400, enforced: false };
    const denied = await fetch(`${harness.baseUrl}/api/v1/tasks/${task.task.id}/runs`, { method: "POST", headers, body: JSON.stringify({ budget }) });
    assert.equal(denied.status, 428);
    const detail = { taskId: task.task.id, budget };
    const confirmation = await fetch(`${harness.baseUrl}/api/security/confirmations`, { method: "POST", headers, body: JSON.stringify({ action: "run.budget.expand", detail, confirmed: true }) }).then((response) => response.json());
    const allowed = await fetch(`${harness.baseUrl}/api/v1/tasks/${task.task.id}/runs`, {
      method: "POST", headers, body: JSON.stringify({ budget, confirmationToken: confirmation.confirmation.token })
    });
    assert.equal(allowed.status, 201);
    const run = (await allowed.json()).run;
    assert.equal(run.budget.durationHours, 96);
    assert.equal(run.budget.enforced, false);
    const zeroCostBudget = { maxEstimatedUsd: 0 };
    const zeroCostDenied = await fetch(`${harness.baseUrl}/api/v1/tasks/${task.task.id}/runs`, { method: "POST", headers, body: JSON.stringify({ budget: zeroCostBudget }) });
    assert.equal(zeroCostDenied.status, 428);
  } finally {
    await harness.close();
  }
});
