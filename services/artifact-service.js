export const ARTIFACT_KINDS = ["markdown", "html", "svg", "code", "react", "vue", "svelte", "chart", "text", "json", "image", "bundle"];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function normalizeArtifactKind(kind) {
  const value = String(kind || "").toLowerCase();
  return ARTIFACT_KINDS.includes(value) ? value : "markdown";
}

export function buildArtifactDiff(before = "", after = "") {
  const oldLines = String(before || "").split(/\r?\n/);
  const newLines = String(after || "").split(/\r?\n/);
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      rows.push(` ${oldLines[i] ?? ""}`);
      i += 1;
      j += 1;
      continue;
    }
    const nextOld = oldLines.slice(i + 1, i + 6).indexOf(newLines[j]);
    const nextNew = newLines.slice(j + 1, j + 6).indexOf(oldLines[i]);
    if (nextOld >= 0) {
      for (let k = 0; k <= nextOld; k += 1) rows.push(`-${oldLines[i + k] ?? ""}`);
      i += nextOld + 1;
      continue;
    }
    if (nextNew >= 0) {
      for (let k = 0; k <= nextNew; k += 1) rows.push(`+${newLines[j + k] ?? ""}`);
      j += nextNew + 1;
      continue;
    }
    if (i < oldLines.length) {
      rows.push(`-${oldLines[i]}`);
      i += 1;
    }
    if (j < newLines.length) {
      rows.push(`+${newLines[j]}`);
      j += 1;
    }
  }
  return rows.join("\n").slice(0, 120000);
}

function previewShell(body, { title = "Artifact Preview", scripts = "", style = "" } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;font-family:Inter,system-ui,"Microsoft YaHei",sans-serif;background:#fff;color:#1f1f1c}
    #root{min-height:100vh}
    .preview-error{white-space:pre-wrap;background:#fff3f3;color:#8a1f1f;border:1px solid #f0b4b4;border-radius:8px;margin:16px;padding:12px;font:13px/1.5 ui-monospace,Consolas,monospace}
    ${style}
  </style>
</head>
<body>
  ${body}
  <script>
    window.addEventListener("error", function(event) {
      var box = document.createElement("pre");
      box.className = "preview-error";
      box.textContent = "运行错误：\\n" + (event.message || "") + "\\n" + (event.filename || "") + ":" + (event.lineno || "");
      document.body.prepend(box);
    });
    window.addEventListener("unhandledrejection", function(event) {
      var box = document.createElement("pre");
      box.className = "preview-error";
      box.textContent = "异步错误：\\n" + ((event.reason && (event.reason.stack || event.reason.message)) || event.reason || "");
      document.body.prepend(box);
    });
  </script>
  ${scripts}
</body>
</html>`;
}

function reactPreview(content = "", title = "React 预览") {
  return previewShell(`<div id="root"></div><script type="text/babel" data-type="module">
${content}
const Component = typeof ArtifactCard !== "undefined" ? ArtifactCard : (typeof App !== "undefined" ? App : (typeof exports !== "undefined" ? exports.default : null));
if (!Component) throw new Error("请导出默认组件，或定义 App / ArtifactCard。");
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Component));
</script>`, {
    title,
    scripts: `
  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>`
  });
}

function vuePreview(content = "", title = "Vue 预览") {
  const escaped = JSON.stringify(content);
  return previewShell(`<div id="root"></div>`, {
    title,
    scripts: `
  <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
  <script>
    const source = ${escaped};
    let component = null;
    if (/^\\s*</.test(source)) component = { template: source };
    else {
      const exports = {};
      const module = { exports };
      Function("exports", "module", "Vue", source)(exports, module, Vue);
      component = module.exports.default || exports.default || module.exports;
    }
    Vue.createApp(component || { template: "<pre>没有可预览的 Vue 组件</pre>" }).mount("#root");
  </script>`
  });
}

function sveltePreview(content = "", title = "Svelte 预览") {
  return previewShell(`<main style="padding:16px">
  <div class="preview-error">Svelte 单文件组件需要构建步骤。这里保留源码预览；点击“构建预览”会在沙箱中记录依赖与错误。</div>
  <pre>${escapeHtml(content)}</pre>
</main>`, { title });
}

export function artifactPreviewHtml(artifact = {}) {
  const kind = normalizeArtifactKind(artifact.kind);
  const content = String(artifact.content || "");
  const title = artifact.title || "Artifact";
  if (kind === "html") return content;
  if (kind === "svg") return previewShell(content, { title });
  if (kind === "react") return reactPreview(content, title);
  if (kind === "vue") return vuePreview(content, title);
  if (kind === "svelte") return sveltePreview(content, title);
  if (kind === "image") return previewShell(`<main style="display:grid;min-height:100vh;place-items:center;background:#111"><img style="max-width:100%;max-height:96vh" src="${escapeHtml(content)}" alt="${escapeHtml(title)}" /></main>`, { title });
  return previewShell(`<pre style="white-space:pre-wrap;padding:16px">${escapeHtml(content)}</pre>`, { title });
}

export function previewCsp() {
  return [
    "default-src 'none'",
    "img-src data: https: http:",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.jsdelivr.net",
    "connect-src https://unpkg.com https://cdn.jsdelivr.net",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
}

export function sharePolicy(input = {}) {
  return {
    visibility: ["private", "local-link", "public"].includes(input.visibility) ? input.visibility : "local-link",
    allowRemix: input.allowRemix !== false,
    expiresAt: input.expiresAt || "",
    requireLocalSession: input.requireLocalSession !== false,
    allowDownload: input.allowDownload === true,
    passwordHint: String(input.passwordHint || "").slice(0, 120)
  };
}

export function isShareExpired(policy = {}, nowMs = Date.now()) {
  return Boolean(policy.expiresAt && new Date(policy.expiresAt).getTime() <= nowMs);
}

export function normalizeArtifactFiles(input = []) {
  const files = Array.isArray(input) ? input : [];
  return files
    .map((file, index) => ({
      id: String(file.id || `file_${index + 1}`),
      path: String(file.path || file.name || `file-${index + 1}.txt`).replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 240),
      language: String(file.language || "").slice(0, 60),
      content: String(file.content || "").slice(0, 500000)
    }))
    .filter((file) => file.path && !file.path.includes(".."))
    .slice(0, 80);
}

export function artifactBundleContent(files = []) {
  const normalized = normalizeArtifactFiles(files);
  return JSON.stringify({ schema: "local-claude-workbench.artifact-bundle.v1", files: normalized }, null, 2);
}

export function parseArtifactBundle(content = "") {
  try {
    const parsed = JSON.parse(content || "{}");
    return normalizeArtifactFiles(parsed.files || []);
  } catch {
    return [];
  }
}

export function buildPreviewPlan(artifact = {}) {
  const kind = normalizeArtifactKind(artifact.kind);
  const files = kind === "bundle" ? parseArtifactBundle(artifact.content || "") : [];
  const dependencies = new Set();
  const source = kind === "bundle" ? files.map((file) => file.content).join("\n") : String(artifact.content || "");
  if (/\bReact\b|from\s+["']react["']/.test(source)) dependencies.add("react");
  if (/\bVue\b|from\s+["']vue["']/.test(source)) dependencies.add("vue");
  if (/\bsvelte\b/i.test(source)) dependencies.add("svelte");
  return {
    kind,
    files: files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8"), language: file.language })),
    dependencies: [...dependencies],
    offlineReady: !dependencies.size || ["html", "svg", "markdown", "chart", "text", "json", "code"].includes(kind),
    warnings: dependencies.size ? ["真实构建需要在依赖沙箱中安装 npm 包；当前预览使用受限 iframe / CDN fallback。"] : []
  };
}

export function buildLog(artifact = {}, options = {}) {
  const plan = buildPreviewPlan(artifact);
  const startedAt = new Date().toISOString();
  return {
    id: options.id || `build_${Math.random().toString(16).slice(2, 10)}`,
    artifactId: artifact.id || "",
    status: plan.warnings.length ? "warning" : "ok",
    startedAt,
    finishedAt: startedAt,
    plan,
    output: [
      `构建目标: ${artifact.title || artifact.id || "artifact"}`,
      `类型: ${plan.kind}`,
      `文件数: ${plan.files.length || 1}`,
      `依赖: ${plan.dependencies.join(", ") || "无"}`,
      plan.offlineReady ? "离线预览可用" : "需要依赖沙箱或 CDN fallback"
    ].join("\n")
  };
}

export function previewScreenshotSvg(artifact = {}) {
  const title = escapeHtml(artifact.title || "Artifact");
  const kind = escapeHtml(normalizeArtifactKind(artifact.kind));
  const text = escapeHtml(String(artifact.content || "").replace(/\s+/g, " ").slice(0, 220));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760">
  <rect width="1200" height="760" fill="#faf9f6"/>
  <rect x="48" y="48" width="1104" height="664" rx="8" fill="#fff" stroke="#dedbd2"/>
  <text x="84" y="118" font-size="34" font-family="Microsoft YaHei, sans-serif" fill="#1f1f1c">${title}</text>
  <text x="84" y="164" font-size="18" font-family="Consolas, monospace" fill="#74706a">kind: ${kind}</text>
  <rect x="84" y="210" width="1032" height="420" rx="8" fill="#f1efe9"/>
  <text x="112" y="268" font-size="22" font-family="Microsoft YaHei, sans-serif" fill="#34322e">${text || "空白预览"}</text>
  <text x="84" y="678" font-size="16" font-family="Microsoft YaHei, sans-serif" fill="#74706a">本截图由本地预览服务生成，用于测试与发布前检查。</text>
</svg>`;
  return {
    mimeType: "image/svg+xml",
    data: Buffer.from(svg, "utf8").toString("base64"),
    svg
  };
}
