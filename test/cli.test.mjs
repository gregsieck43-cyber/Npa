import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliPath = fileURLToPath(new URL("../code-cli.js", import.meta.url));

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function jsonOutput(resultPromise) {
  const result = await resultPromise;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test("--self-test prints a stable readiness marker", async () => {
  const result = await runCli(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SELF_TEST_OK/);
});

test("REST commands use the session token and expected run endpoints", async (t) => {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    calls.push({ method: request.method, url: request.url, token: request.headers["x-local-session-token"], body });

    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/health") {
      response.end(JSON.stringify({ ok: true, app: "local-claude-workbench" }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/runs") {
      response.end(JSON.stringify({ runs: [{ id: "run-1", status: "running" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/runs") {
      response.end(JSON.stringify({ run: { id: "run-2", ...body } }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/runs/run-1/pause") {
      response.end(JSON.stringify({ ok: true, action: "pause", id: "run-1" }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/runs/pause-all") {
      response.end(JSON.stringify({ ok: true, action: "pause-all" }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/runs/resume-all") {
      response.end(JSON.stringify({ ok: true, action: "resume-all" }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/runs/checkpoint-all") {
      response.end(JSON.stringify({ ok: true, action: "checkpoint-all" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const env = { WORKBENCH_SESSION_TOKEN: "test-short-lived-token" };

  const health = await jsonOutput(runCli(["health", "--url", url], env));
  assert.equal(health.ok, true);
  const list = await jsonOutput(runCli(["list", "--url", url], env));
  assert.equal(list.runs[0].id, "run-1");
  const run = await jsonOutput(runCli(["run", "--url", url, "--prompt", "hello", "--project", "demo"], env));
  assert.equal(run.run.prompt, "hello");
  assert.equal(run.run.project, "demo");
  const paused = await jsonOutput(runCli(["pause", "run-1", "--url", url], env));
  assert.equal(paused.action, "pause");
  const pausedAll = await jsonOutput(runCli(["pause", "--all", "--url", url], env));
  assert.equal(pausedAll.action, "pause-all");
  const resumedAll = await jsonOutput(runCli(["resume", "--all", "--url", url], env));
  assert.equal(resumedAll.action, "resume-all");
  const checkpointed = await jsonOutput(runCli(["checkpoint", "--url", url], env));
  assert.equal(checkpointed.action, "checkpoint-all");

  assert.ok(calls.length >= 7);
  assert.ok(calls.every((call) => call.token === "test-short-lived-token"));
});
