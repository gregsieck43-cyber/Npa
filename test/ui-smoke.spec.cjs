const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

function requirePlaywrightTest() {
  try {
    return require("@playwright/test");
  } catch (error) {
    const cliPath = process.argv.find((arg) => /@playwright[\\/]test[\\/]cli\.js$/i.test(arg));
    if (cliPath) return require(path.dirname(cliPath));
    throw error;
  }
}

const { test, expect, chromium } = requirePlaywrightTest();

const rootDir = path.resolve(__dirname, "..");
const qaDir = path.join(rootDir, ".tmp", "ui-qa");
let serverProcess;
let serverDataDir;
let appUrl = process.env.UI_SMOKE_URL || "";
const capturedServerErrors = [];

async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const port = typeof address === "object" && address ? address.port : 0;
      listener.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function ensureFrontendBuild() {
  // The server prefers frontend/dist over the legacy public fallback.
  // Always rebuilding keeps this smoke test tied to the current source tree.
  const viteBin = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
  const result = spawnSync(process.execPath, [viteBin, "build"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test" },
  });
  if (result.status !== 0) throw new Error(`Vite build failed with status ${result.status}: ${result.error?.message || "unknown spawn error"}`);
}

async function launchBrowser() {
  const attempts = [{}, { channel: "msedge" }, { channel: "chrome" }];
  const failures = [];
  for (const options of attempts) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch (error) {
      failures.push(`${options.channel || "bundled"}: ${String(error.message || error).split("\n")[0]}`);
    }
  }
  throw new Error(failures.join(" | "));
}

function observePage(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function assertNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(dimensions.documentWidth, `${label} document overflow`).toBeLessThanOrEqual(dimensions.innerWidth + 1);
  expect(dimensions.bodyWidth, `${label} body overflow`).toBeLessThanOrEqual(dimensions.innerWidth + 1);
  return dimensions;
}

async function saveScreenshot(page, name) {
  fs.mkdirSync(qaDir, { recursive: true });
  const filePath = path.join(qaDir, name);
  await page.screenshot({ path: filePath, fullPage: false });
  return filePath;
}

async function removeDirectoryWithRetry(directory) {
  if (!directory) return;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!/(EPERM|EACCES|EBUSY)/.test(String(error.code || "")) || attempt === 11) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

async function clickUnique(locator, description) {
  await expect(locator, `${description} should be unique`).toHaveCount(1);
  await locator.click();
}

test.beforeAll(async () => {
  ensureFrontendBuild();
  fs.mkdirSync(qaDir, { recursive: true });

  if (appUrl) {
    await waitForHttp(appUrl);
    return;
  }

  const port = await freePort();
  serverDataDir = path.join(qaDir, "server-data");
  await removeDirectoryWithRetry(serverDataDir);
  fs.mkdirSync(serverDataDir, { recursive: true });
  appUrl = `http://127.0.0.1:${port}/`;
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      WORKBENCH_DATA_DIR: serverDataDir,
      WORKBENCH_SKIP_COMMAND_SMOKE: "1",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess.stderr.on("data", (chunk) => capturedServerErrors.push(String(chunk)));
  await waitForHttp(appUrl);
});

test.afterAll(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
  if (serverProcess && serverProcess.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      serverProcess.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await removeDirectoryWithRetry(serverDataDir);
});

test("静谧任务台多视口 UI smoke 与在线任务创建", async () => {
  const browser = await launchBrowser();
  const pageErrors = [];
  let desktop;
  let tablet;
  let mobile;
  try {
    desktop = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    pageErrors.push(...observePage(desktop));
    await desktop.goto(appUrl, { waitUntil: "networkidle", timeout: 20_000 });
    await expect(desktop).toHaveTitle("NPA · 本地智能工作台");
    const desktopBrand = desktop.locator('[data-testid="npa-brand-mark"] img').first();
    await expect(desktopBrand).toBeVisible();
    await expect.poll(() => desktopBrand.evaluate((image) => image.complete && image.naturalWidth >= 64)).toBe(true);
    const favicon = await desktop.evaluate(async () => {
      const response = await fetch("/favicon.ico");
      return { ok: response.ok, type: response.headers.get("content-type"), bytes: (await response.arrayBuffer()).byteLength };
    });
    expect(favicon.ok).toBe(true);
    expect(favicon.type).toContain("image/x-icon");
    expect(favicon.bytes).toBeGreaterThan(1000);
    await expect(desktop.locator(".timeline-panel")).toBeVisible();
    await expect(desktop.locator("aside[aria-label=\"主导航\"]")).toHaveCount(1);
    await expect(desktop.locator("aside[aria-label=\"VISTA 检查器\"]")).toHaveCount(1);
    await expect(desktop.locator('[role="progressbar"]')).toHaveCount(2);
    await assertNoOverflow(desktop, "1440px");
    await saveScreenshot(desktop, "desktop-today.png");

    const nav = desktop.locator(".primary-nav .nav-item");
    await expect(nav).toHaveCount(6);
    for (const label of ["今天", "项目", "任务", "知识库", "自动化", "设置"]) {
      await clickUnique(nav.filter({ hasText: label }), `navigation item ${label}`);
    }

    await clickUnique(nav.filter({ hasText: "项目" }), "projects navigation");
    const workspaceTabs = desktop.locator('[role="tablist"][aria-label="项目工作区"] .workspace-tab');
    for (const label of ["Data", "Canvas", "Code", "Terminal", "Git"]) {
      await clickUnique(workspaceTabs.filter({ hasText: label }), `workspace tab ${label}`);
    }

    await clickUnique(workspaceTabs.filter({ hasText: "Data" }), "data workspace");
    const dataPanel = desktop.locator('[data-testid="data-import-panel"]');
    await expect(dataPanel).toHaveCount(1);
    const dataTextarea = dataPanel.locator("textarea");
    await expect(dataTextarea).toHaveCount(1);
    await dataTextarea.fill("name,value\nalpha,10\nbeta,20");
    const importButton = dataPanel.locator(".feature-toolbar .primary-button");
    await clickUnique(importButton, "data import");
    await expect(dataPanel.locator(".dataset-row")).toHaveCount(1, { timeout: 10_000 });
    await clickUnique(dataPanel.locator(".dataset-row"), "imported dataset");
    await expect(dataPanel.locator(".analysis-card")).toBeVisible();
    await clickUnique(dataPanel.locator(".analysis-card .primary-button"), "data pivot");
    await expect(dataPanel.locator(".data-table-card").last()).toBeVisible({ timeout: 10_000 });

    await clickUnique(workspaceTabs.filter({ hasText: "Code" }), "code workspace");
    const codePanel = desktop.locator('[data-testid="code-panel"]');
    await expect(codePanel).toHaveCount(1);
    await expect.poll(async () => codePanel.locator(".tree-entry").count(), { timeout: 10_000 }).toBeGreaterThan(0);
    const codeSearch = codePanel.locator(".code-toolbar input");
    await expect(codeSearch).toHaveCount(1);
    await codeSearch.fill("export");
    await clickUnique(codePanel.locator(".code-toolbar .ghost-button"), "code search");
    await expect(codePanel.locator(".search-results")).toBeVisible({ timeout: 10_000 });

    await clickUnique(workspaceTabs.filter({ hasText: "Terminal" }), "terminal workspace");
    const terminalPanel = desktop.locator('[data-testid="terminal-panel"]');
    await expect(terminalPanel).toHaveCount(1);
    await terminalPanel.locator(".feature-field input").fill("node --test test/cli.test.mjs");
    await clickUnique(terminalPanel.locator(".terminal-actions .ghost-button"), "terminal approval");
    await expect(terminalPanel.locator(".approval-state.state-requested")).toBeVisible({ timeout: 10_000 });
    await clickUnique(terminalPanel.locator(".terminal-actions .primary-button"), "terminal run");
    await expect(terminalPanel.locator(".terminal-output")).toContainText("exitCode", { timeout: 10_000 });

    await clickUnique(workspaceTabs.filter({ hasText: "Git" }), "git workspace");
    const gitPanel = desktop.locator('[data-testid="git-panel"]');
    await expect(gitPanel).toHaveCount(1);
    await expect(gitPanel.locator(".segmented-control button")).toHaveCount(3);
    await expect(gitPanel.locator(".git-output")).toBeVisible();

    await clickUnique(nav.filter({ hasText: "知识库" }), "knowledge navigation");
    const knowledgeTabs = desktop.locator('[role="tablist"][aria-label="知识区"] .workspace-tab');
    for (const label of ["Web", "Research", "Memory"]) {
      await clickUnique(knowledgeTabs.filter({ hasText: label }), `knowledge tab ${label}`);
    }

    await clickUnique(knowledgeTabs.filter({ hasText: "Web" }), "web knowledge");
    const webKnowledge = desktop.locator('[data-testid="knowledge-web-panel"]');
    await expect(webKnowledge).toHaveCount(1);
    await webKnowledge.locator(".knowledge-search input").fill("local workbench");
    await clickUnique(webKnowledge.locator(".knowledge-search .primary-button"), "web knowledge search");
    await expect.poll(async () => webKnowledge.locator(".knowledge-result").count(), { timeout: 10_000 }).toBeGreaterThan(0);
    await clickUnique(knowledgeTabs.filter({ hasText: "Research" }), "research knowledge");
    const researchKnowledge = desktop.locator('[data-testid="knowledge-research-panel"]');
    await researchKnowledge.locator(".knowledge-compose input").fill("Smoke notes");
    await researchKnowledge.locator(".knowledge-compose textarea").fill("A durable note from the UI smoke flow.");
    await clickUnique(researchKnowledge.locator(".knowledge-compose .ghost-button"), "save research note");
    await expect(researchKnowledge.locator(".knowledge-result.document")).toHaveCount(1, { timeout: 10_000 });

    await clickUnique(nav.filter({ hasText: "设置" }), "settings navigation");
    const settingsTabs = desktop.locator('[role="tablist"][aria-label="设置区"] .workspace-tab');
    for (const label of ["模型", "连接器", "安全", "诊断"]) {
      await clickUnique(settingsTabs.filter({ hasText: label }), `settings tab ${label}`);
    }

    await clickUnique(settingsTabs.filter({ hasText: "模型" }), "model settings");
    const modelSettings = desktop.locator(".settings-panel");
    await expect(modelSettings).toHaveCount(1);
    await expect(modelSettings.locator(".settings-form")).toBeVisible();
    await clickUnique(modelSettings.locator(".settings-form .primary-button"), "save model settings");
    await clickUnique(settingsTabs.filter({ hasText: "安全" }), "security settings");
    await expect(desktop.locator(".settings-panel .security-summary")).toBeVisible();
    await clickUnique(settingsTabs.filter({ hasText: "诊断" }), "diagnostics settings");
    await expect(desktop.locator(".settings-panel .diagnostic-output")).toBeVisible();

    await desktop.keyboard.press("Control+KeyK");
    const commandDialog = desktop.locator(".command-backdrop");
    await expect(commandDialog).toHaveCount(1);
    await expect(commandDialog).toHaveAttribute("aria-modal", "true");
    const commandInput = desktop.locator('input[aria-label="搜索命令"]');
    await expect(commandInput).toHaveCount(1);
    await expect(commandInput).toBeFocused();
    await desktop.keyboard.press("Escape");
    await expect(commandDialog).toHaveCount(0);

    const unnamedButtons = await desktop.locator("button").evaluateAll((buttons) => buttons
      .filter((button) => !String(button.getAttribute("aria-label") || button.textContent || "").trim())
      .slice(0, 10)
      .map((button) => button.outerHTML.slice(0, 120)));
    expect(unnamedButtons, "all visible controls should have an accessible name").toEqual([]);

    const themeToggle = desktop.locator(".footer-control");
    await clickUnique(themeToggle, "theme toggle");
    await expect(desktop.locator("html")).toHaveAttribute("data-theme", "dark");
    await saveScreenshot(desktop, "desktop-dark.png");
    await clickUnique(themeToggle, "theme toggle back");
    await expect(desktop.locator("html")).toHaveAttribute("data-theme", "light");

    await desktop.emulateMedia({ reducedMotion: "reduce" });
    expect(await desktop.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await clickUnique(nav.filter({ hasText: "今天" }), "today navigation");
    await expect(desktop.locator("#timeline-title")).toHaveText("今天");
    await expect(nav.filter({ hasText: "今天" })).toHaveAttribute("aria-current", "page");

    const taskTitle = `UI smoke ${Date.now()}`;
    const quickTask = desktop.locator("#quick-task");
    await expect(quickTask).toHaveCount(1);
    await quickTask.fill(taskTitle);
    await quickTask.press("Enter");
    await expect(desktop.locator(".task-board")).toBeVisible({ timeout: 10_000 });
    const taskRow = desktop.locator(".task-list-row").filter({ hasText: taskTitle });
    await expect(taskRow).toHaveCount(1);
    const startRunButton = taskRow.locator(".task-row-actions .ghost-button");
    await clickUnique(startRunButton, "start task run");
    await expect(taskRow.locator(".status-chip")).not.toHaveClass(/status-todo/, { timeout: 10_000 });
    const pauseRunButton = taskRow.locator('[data-run-action="pause"]');
    if (await pauseRunButton.count()) {
      await clickUnique(pauseRunButton, "pause task run");
      await expect(taskRow.locator(".status-chip")).toHaveClass(/status-paused/, { timeout: 10_000 });
    }
    await saveScreenshot(desktop, "desktop-task-created.png");

    tablet = await browser.newPage({ viewport: { width: 980, height: 920 } });
    pageErrors.push(...observePage(tablet));
    await tablet.goto(appUrl, { waitUntil: "networkidle", timeout: 20_000 });
    await expect(tablet.locator(".mobile-topbar")).toBeVisible();
    await assertNoOverflow(tablet, "980px");
    const tabletMenu = tablet.locator('button[aria-label="打开导航"]');
    await clickUnique(tabletMenu, "tablet menu");
    const tabletSidebar = tablet.locator(".sidebar.is-open");
    await expect(tabletSidebar).toHaveCount(1);
    await expect(tablet.locator(".sidebar-scrim")).toHaveCount(1);
    // Capture the settled drawer, not its 180ms entrance frame.
    await tablet.waitForTimeout(220);
    const tabletSidebarBox = await tabletSidebar.boundingBox();
    expect(tabletSidebarBox).not.toBeNull();
    expect(tabletSidebarBox.x).toBeLessThanOrEqual(1);
    expect(tabletSidebarBox.width).toBeGreaterThan(250);
    await saveScreenshot(tablet, "tablet-drawer.png");
    await clickUnique(tablet.locator(".sidebar-scrim"), "tablet drawer scrim");
    await expect(tablet.locator(".sidebar.is-open")).toHaveCount(0);
    await tablet.emulateMedia({ reducedMotion: "reduce" });
    expect(await tablet.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    pageErrors.push(...observePage(mobile));
    await mobile.goto(appUrl, { waitUntil: "networkidle", timeout: 20_000 });
    await expect(mobile.locator(".timeline-panel")).toBeVisible();
    const mobileBrand = mobile.locator(".mobile-title img");
    await expect(mobileBrand).toBeVisible();
    await expect.poll(() => mobileBrand.evaluate((image) => image.complete && image.naturalWidth >= 64)).toBe(true);
    await assertNoOverflow(mobile, "390px");
    const mobileGrid = await mobile.locator(".main-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns);
    expect(mobileGrid.split(" ")).toHaveLength(1);
    await clickUnique(mobile.locator('button[aria-label="打开导航"]'), "mobile menu");
    const mobileSidebar = mobile.locator(".sidebar.is-open");
    await expect(mobileSidebar).toHaveCount(1);
    await clickUnique(mobileSidebar.locator(".nav-item").filter({ hasText: "项目" }), "mobile projects navigation");
    await expect(mobile.locator(".workspace-main")).toBeVisible();
    await expect(mobile.locator(".sidebar.is-open")).toHaveCount(0);
    // The drawer has a documented 180ms close transition; wait for its final frame before evidence.
    await mobile.waitForTimeout(220);
    await assertNoOverflow(mobile, "390px project workspace");
    await saveScreenshot(mobile, "mobile-projects.png");

    expect(pageErrors, "browser page errors and console errors").toEqual([]);
    expect(capturedServerErrors, "local server stderr").toEqual([]);
  } finally {
    await desktop?.close();
    await tablet?.close();
    await mobile?.close();
    await browser.close();
  }
});
