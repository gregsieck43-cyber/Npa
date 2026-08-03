const externalBaseUrl = process.env.WORKBENCH_EXTERNAL_API_URL;
const baseUrl = String(externalBaseUrl || "").replace(/\/$/, "");

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} -> ${response.status}: ${body.error || "unknown"}`);
  return { response, body };
}

async function runSmoke() {
  const health = await request("/api/health");
  if (health.body.app !== "local-claude-workbench") throw new Error("health app mismatch");

  const bootstrap = await request("/api/v1/bootstrap");
  const cookie = bootstrap.response.headers.get("set-cookie")?.split(";")[0] || "";
  const csrf = bootstrap.body.csrfToken;
  const headers = { Cookie: cookie, "X-CSRF-Token": csrf, "Content-Type": "application/json" };

  const task = await request("/api/v1/tasks", { method: "POST", headers, body: JSON.stringify({ title: "API smoke", acceptanceCriteria: ["context 可恢复"] }) });
  const run = await request(`/api/v1/tasks/${task.body.task.id}/runs`, { method: "POST", headers: { ...headers, "Idempotency-Key": "api-smoke-run" }, body: "{}" });
  const context = await request(`/api/v1/runs/${run.body.run.id}/context`, { headers: { Cookie: cookie } });
  if (!context.body.context?.blocks?.length) throw new Error("context blocks missing");

  await request(`/api/v1/runs/${run.body.run.id}/pause`, { method: "POST", headers, body: "{}" });
  await request(`/api/v1/runs/${run.body.run.id}/resume`, { method: "POST", headers, body: "{}" });
  await request("/api/v1/diagnostics", { headers: { Cookie: cookie } });
  await request("/api/security/confirmations", { method: "POST", headers, body: JSON.stringify({ action: "api-smoke", detail: { runId: run.body.run.id }, confirmed: true }) });

  process.stdout.write(`API_SMOKE_OK ${run.body.run.id}\n`);
}

if (externalBaseUrl) await runSmoke();
else process.stdout.write("API_SMOKE_SKIPPED external server URL not set\n");
