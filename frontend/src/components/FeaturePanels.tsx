import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { apiRequest, importDataset, loadConnectors, loadDiagnostics, loadGitState, loadKnowledgeDocuments, loadSettings, readCodeFile, readCodeTree, requestRiskConfirmation, runDataAnalysis, saveConnector, saveKnowledgeDocument, saveSettings, searchCode, searchKnowledge, searchWeb, testProvider } from "../lib/api";
import type { CodeEntry, DataAnalysisRun, DataSet, GitState, KnowledgeDocument, WorkbenchSettings } from "../lib/types";
import { Icon } from "./Icon";

type Notify = (message: string) => void;

interface PanelProps {
  online: boolean;
  projectId?: string | null;
  notify?: Notify;
}

function PanelHeader({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="feature-panel-heading"><div><p className="eyebrow">Tool surface</p><h3>{title}</h3><p>{detail}</p></div>{action ? <div className="feature-panel-actions">{action}</div> : null}</div>;
}

function OfflinePanel({ online, message = "连接本地服务后启用此工具。" }: { online: boolean; message?: string }) {
  return <div className="feature-offline"><Icon name={online ? "refresh" : "lock"} size={18} /><span>{online ? "正在等待数据" : message}</span></div>;
}

export function DataPanel({ online, notify }: PanelProps) {
  const [draft, setDraft] = useState("");
  const [name, setName] = useState("pasted-dataset.csv");
  const [datasets, setDatasets] = useState<DataSet[]>([]);
  const [selected, setSelected] = useState<DataSet>();
  const [analysis, setAnalysis] = useState<DataAnalysisRun>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const preview = useMemo(() => parseDataPreview(draft), [draft]);

  const importText = async () => {
    if (!draft.trim()) return;
    setBusy(true); setError(undefined);
    try {
      const result = await importDataset({ name: name || "pasted-dataset.csv", content: draft, mimeType: name.endsWith(".json") ? "application/json" : "text/csv" });
      const imported = result.datasets || [];
      setDatasets((current) => [...imported, ...current.filter((item) => !imported.some((next) => next.id === item.id))]);
      setSelected(imported[0]);
      setDraft("");
      notify?.(`已导入 ${imported.length} 个数据集`);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "数据导入失败"); }
    finally { setBusy(false); }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setName(file.name);
    setDraft(await file.text());
    event.target.value = "";
  };

  const analyze = async (language: "pivot" | "clean") => {
    if (!selected) return;
    setBusy(true); setError(undefined);
    try {
      const result = await runDataAnalysis(selected.id, language, language === "pivot" ? { groupBy: selected.columns[0] } : {});
      setAnalysis(result.run);
      notify?.(language === "pivot" ? "透视结果已生成" : "清洗结果已生成");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "分析失败"); }
    finally { setBusy(false); }
  };

  return <div className="feature-panel data-panel" data-testid="data-import-panel">
    <PanelHeader title="Data 工作区" detail="粘贴或导入 JSON / CSV，随后执行清洗与透视。" action={<span className="tool-safety"><Icon name="shield" size={13} />本地沙盒</span>} />
    {!online ? <OfflinePanel online={online} message="服务未连接；导入不会写入本地状态。" /> : null}
    <div className="data-import-grid"><label className="feature-field"><span>数据集名称</span><input onChange={(event) => setName(event.target.value)} value={name} /></label><label className="file-picker"><span>选择文件</span><input accept=".json,.csv,.tsv,application/json,text/csv" onChange={importFile} type="file" /><span className="ghost-button compact"><Icon name="folder" size={14} />浏览</span></label></div>
    <label className="feature-field"><span>粘贴内容</span><textarea aria-label="粘贴 JSON 或 CSV" onChange={(event) => setDraft(event.target.value)} placeholder={'name,value\nalpha,10\nbeta,20'} rows={6} value={draft} /></label>
    <div className="feature-toolbar"><span className="subtle">预览 {preview.rows.length} 行 · {preview.columns.length} 列</span><button className="primary-button" disabled={!online || !draft.trim() || busy} onClick={() => void importText()} type="button"><Icon name="plus" size={15} />导入数据集</button></div>
    {error ? <p className="feature-error" role="alert">{error}</p> : null}
    {preview.rows.length ? <DataTable columns={preview.columns} rows={preview.rows.slice(0, 4)} title="本地预览" /> : null}
    <div className="feature-divider" />
    <div className="dataset-heading"><strong>数据集</strong><span className="subtle">{datasets.length}</span></div>
    {datasets.length ? datasets.map((dataset) => <button className={`dataset-row ${selected?.id === dataset.id ? "is-selected" : ""}`} key={dataset.id} onClick={() => { setSelected(dataset); setAnalysis(undefined); }} type="button"><Icon name="database" size={16} /><span><strong>{dataset.name}</strong><small>{dataset.rows.length} 行 · {dataset.columns.length} 列</small></span><Icon name="chevron" size={14} /></button>) : <p className="feature-empty">导入后数据集会显示在这里。</p>}
    {selected ? <div className="analysis-card"><div className="dataset-heading"><div><strong>{selected.name}</strong><small>{selected.columns.join(" · ")}</small></div><div className="feature-toolbar inline"><button className="ghost-button compact" disabled={busy} onClick={() => void analyze("clean")} type="button">清洗</button><button className="primary-button compact" disabled={busy} onClick={() => void analyze("pivot")} type="button">透视</button></div></div>{analysis?.table?.length ? <DataTable columns={Object.keys(analysis.table[0] || {})} rows={analysis.table.slice(0, 12)} title={`${analysis.language} 结果`} /> : <p className="feature-empty">选择清洗或透视生成可检查结果。</p>}</div> : null}
  </div>;
}

export function CodePanel({ online, notify }: PanelProps) {
  const [entries, setEntries] = useState<CodeEntry[]>([]);
  const [path, setPath] = useState(".");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Array<{ path: string; line: number; preview: string }>>([]);
  const [error, setError] = useState<string>();

  const loadTree = async (nextPath = path) => {
    try { const result = await readCodeTree(nextPath); setPath(result.root || nextPath); setEntries(result.entries || []); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "文件树读取失败"); }
  };
  useEffect(() => { if (online) void loadTree("."); }, [online]);
  const open = async (entry: CodeEntry) => {
    if (entry.type === "directory") { await loadTree(entry.path); return; }
    try { const result = await readCodeFile(entry.path); setSelectedPath(result.path); setContent(result.content); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "文件读取失败"); }
  };
  const search = async () => {
    if (!query.trim()) return;
    try { const result = await searchCode(query, "."); setMatches(result.matches || []); notify?.(`找到 ${result.matches?.length || 0} 处匹配`); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "代码搜索失败"); }
  };
  return <div className="feature-panel code-panel" data-testid="code-panel"><PanelHeader title="Code 工作区" detail="浏览文件、读取内容并搜索当前项目。" action={<button className="ghost-button compact" disabled={!online} onClick={() => void loadTree(path)} type="button"><Icon name="refresh" size={14} />刷新</button>} />{!online ? <OfflinePanel online={online} message="服务未连接；文件读取保持关闭。" /> : null}<div className="code-toolbar"><span className="path-chip"><Icon name="folder" size={13} />{path}</span><input aria-label="搜索代码" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="搜索代码…" value={query} /><button className="ghost-button compact" disabled={!online || !query.trim()} onClick={() => void search()} type="button"><Icon name="search" size={14} />搜索</button></div>{error ? <p className="feature-error" role="alert">{error}</p> : null}<div className="code-layout-inner"><div className="code-tree" aria-label="文件树">{entries.length ? entries.slice(0, 120).map((entry) => <button className={`tree-entry type-${entry.type}`} key={entry.path} onClick={() => void open(entry)} type="button"><Icon name={entry.type === "directory" ? "folder" : "code"} size={14} /><span>{entry.name}</span></button>) : <p className="feature-empty">暂无文件树。</p>}</div><div className="code-editor"><div className="code-editor-heading"><strong>{selectedPath || "选择文件"}</strong><span className="subtle">只读</span></div><pre>{content || "选择文件查看内容"}</pre></div></div>{matches.length ? <div className="search-results"><div className="dataset-heading"><strong>搜索结果</strong><span className="subtle">{matches.length}</span></div>{matches.slice(0, 30).map((match) => <button className="search-result-row" key={`${match.path}:${match.line}`} onClick={() => void open({ path: match.path, name: match.path.split("/").pop() || match.path, type: "file" })} type="button"><span>{match.path}:{match.line}</span><small>{match.preview}</small></button>)}</div> : null}</div>;
}

export function GitPanel({ online }: PanelProps) {
  const [state, setState] = useState<GitState>({ status: "", diff: "", log: "" });
  const [tab, setTab] = useState<keyof GitState>("status");
  const [error, setError] = useState<string>();
  const refresh = async () => { try { setState(await loadGitState()); setError(undefined); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Git 信息读取失败"); } };
  useEffect(() => { if (online) void refresh(); }, [online]);
  return <div className="feature-panel git-panel" data-testid="git-panel"><PanelHeader title="Git 工作区" detail="查看状态、diff 和最近提交；不会自动写入或提交。" action={<button className="ghost-button compact" disabled={!online} onClick={() => void refresh()} type="button"><Icon name="refresh" size={14} />刷新</button>} />{error ? <p className="feature-error" role="alert">{error}</p> : null}<div className="segmented-control" role="tablist" aria-label="Git 视图">{(["status", "diff", "log"] as const).map((key) => <button aria-selected={tab === key} className={tab === key ? "is-active" : ""} key={key} onClick={() => setTab(key)} role="tab" type="button">{key === "status" ? "Status" : key === "diff" ? "Diff" : "Log"}</button>)}</div><pre className="git-output">{online ? state[tab] || "没有记录" : "服务未连接"}</pre></div>;
}

export function TerminalPanel({ online, notify }: PanelProps) {
  const [command, setCommand] = useState("node --test test/cli.test.mjs");
  const [token, setToken] = useState("");
  const [approval, setApproval] = useState<"idle" | "requested" | "running">("idle");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string>();
  const requestApproval = async () => { if (!isSafeTerminalCommand(command)) { setError("命令不在允许的测试白名单中"); return; } try { const nextToken = await requestRiskConfirmation("terminal.run", { command }); setToken(nextToken); setApproval("requested"); setError(undefined); notify?.("一次性终端审批已签发，请再次确认运行"); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "审批请求失败"); } };
  const run = async () => { if (!token) { setError("请先申请一次性审批"); return; } setApproval("running"); try { const result = await apiRequest<{ stdout?: string; stderr?: string; exitCode?: number }>("/tools/terminal/run", { method: "POST", body: { command, confirmationToken: token } }); setOutput(`${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}\nexitCode: ${result.exitCode ?? 0}`); setToken(""); setApproval("idle"); notify?.("终端命令完成"); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "终端执行失败"); setToken(""); setApproval("idle"); } };
  return <div className="feature-panel terminal-panel" data-testid="terminal-panel"><PanelHeader title="Terminal 工作区" detail="白名单命令必须经过一次性审批，执行结果会保留在当前面板。" action={<span className="tool-safety risk"><Icon name="shield" size={13} />需审批</span>} />{!online ? <OfflinePanel online={online} message="服务未连接；终端执行保持关闭。" /> : null}<label className="feature-field"><span>允许的本地命令</span><input aria-label="终端命令" onChange={(event) => { setCommand(event.target.value); setToken(""); setApproval("idle"); }} value={command} /><small>示例：npm test、node --test test/foo.test.mjs</small></label><div className="terminal-actions"><button className="ghost-button" disabled={!online || !command.trim() || approval === "running"} onClick={() => void requestApproval()} type="button"><Icon name="shield" size={15} />申请一次性审批</button><button className="primary-button" disabled={!online || !token || approval === "running"} onClick={() => void run()} type="button"><Icon name={approval === "running" ? "loader" : "play"} size={15} />{approval === "running" ? "运行中" : "确认并运行"}</button><span className={`approval-state state-${approval}`}>{approval === "requested" ? "已审批，等待运行" : approval === "running" ? "正在运行" : "尚未审批"}</span></div>{error ? <p className="feature-error" role="alert">{error}</p> : null}<pre className="terminal-output">{output || "命令输出会显示在这里。"}</pre></div>;
}

export function KnowledgePanel({ online, projectId, mode, notify }: PanelProps & { mode: "Web" | "Research" | "Memory" }) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [results, setResults] = useState<Array<{ title?: string; snippet?: string; url?: string; source?: string }>>([]);
  const [error, setError] = useState<string>();
  useEffect(() => { if (online) void loadKnowledgeDocuments(projectId || "").then((result) => setDocuments(result.documents || [])).catch((requestError) => setError(requestError instanceof Error ? requestError.message : "知识文档加载失败")); }, [online, projectId]);
  const add = async () => { if (!title.trim() || !content.trim()) return; try { const result = await saveKnowledgeDocument({ title, content, projectId: projectId || undefined, source: mode }); setDocuments((current) => [result.document, ...current]); setTitle(""); setContent(""); notify?.("知识文档已保存"); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "知识文档保存失败"); } };
  const search = async () => { if (!query.trim()) return; try { const result = mode === "Web" ? await searchWeb(query) : await searchKnowledge(query, projectId || ""); setResults(result.results || []); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "知识搜索失败"); } };
  return <div className="feature-panel knowledge-panel" data-testid={`knowledge-${mode.toLowerCase()}-panel`}><PanelHeader title={`${mode} 知识区`} detail={mode === "Web" ? "使用本地 mock / 配置 provider 搜索并保留来源。" : mode === "Research" ? "从知识文档检索可审计的研究片段。" : "管理可复用的项目记忆。"} action={<span className="tool-safety"><Icon name={mode === "Web" ? "globe" : mode === "Research" ? "research" : "memory"} size={13} />{mode === "Web" ? "可配置 provider" : "本地索引"}</span>} />{!online ? <OfflinePanel online={online} message="服务未连接；知识内容不会写入。" /> : null}<div className="knowledge-search"><input aria-label={`${mode} 搜索`} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder={mode === "Web" ? "搜索 Web…" : "搜索知识库…"} value={query} /><button className="primary-button compact" disabled={!online || !query.trim()} onClick={() => void search()} type="button"><Icon name="search" size={14} />搜索</button></div>{error ? <p className="feature-error" role="alert">{error}</p> : null}<div className="knowledge-compose"><input aria-label="文档标题" onChange={(event) => setTitle(event.target.value)} placeholder="文档标题" value={title} /><textarea aria-label="文档内容" onChange={(event) => setContent(event.target.value)} placeholder="粘贴可复用的上下文、来源或结论…" rows={3} value={content} /><button className="ghost-button compact" disabled={!online || !title.trim() || !content.trim()} onClick={() => void add()} type="button"><Icon name="plus" size={14} />新增文档</button></div><div className="knowledge-results">{results.map((result, index) => <article className="knowledge-result" key={`${result.url || result.title || "result"}-${index}`}><strong>{result.title || result.source || "结果"}</strong><p>{result.snippet || "无摘要"}</p>{result.url ? <small>{result.url}</small> : null}</article>)}{documents.map((document) => <article className="knowledge-result document" key={document.id || `${document.title}-${document.updatedAt}`}><div><strong>{document.title}</strong><span className="subtle">文档</span></div><p>{document.content.slice(0, 220)}</p><small>{document.source || "local"}</small></article>)}{!documents.length && !results.length ? <p className="feature-empty">暂无内容。添加文档或执行搜索开始。</p> : null}</div></div>;
}

export function SettingsPanel({ online, tab, initialSettings, notify }: PanelProps & { tab: string; initialSettings?: WorkbenchSettings }) {
  const [settings, setSettings] = useState<WorkbenchSettings>(initialSettings || {});
  const [token, setToken] = useState("");
  const [providerResult, setProviderResult] = useState<string>();
  const [connectors, setConnectors] = useState<Array<Record<string, unknown>>>([]);
  const [connector, setConnector] = useState({ id: "local", name: "Local", url: "", token: "" });
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown>>();
  const [approvals, setApprovals] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string>();
  useEffect(() => { if (!online) return; void loadSettings().then((result) => setSettings(result.settings || {})).catch(() => undefined); void loadConnectors().then((result) => setConnectors(result.connectors || [])).catch(() => undefined); void loadDiagnostics().then(setDiagnostics).catch(() => undefined); void apiRequest<{ approvals: Array<Record<string, unknown>> }>("/approvals").then((result) => setApprovals(result.approvals || [])).catch(() => undefined); }, [online]);
  const saveModel = async () => { try { await saveSettings({ modelProvider: settings.modelProvider, apiProtocol: settings.apiProtocol, model: settings.model, effort: settings.effort, apiBaseUrl: settings.apiBaseUrl }); notify?.("模型设置已保存"); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "设置保存失败"); } };
  const providerTest = async () => { if (!token) { setError("请输入临时 token 后测试；token 不会保存"); return; } try { const result = await testProvider(settings, token); setProviderResult(`${result.provider || settings.modelProvider || "provider"} · ${result.model || settings.model || "model"} 可用`); setToken(""); notify?.("临时 token 测试完成，token 已清除"); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "模型测试失败"); setToken(""); } };
  const saveConnectorValue = async () => { try { const result = await saveConnector(connector); setConnectors((current) => [result.connector, ...current.filter((item) => item.id !== result.connector.id)]); setConnector((current) => ({ ...current, token: "" })); notify?.("连接器已保存，token 不会回显"); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "连接器保存失败"); } };
  return <div className="feature-panel settings-panel" data-testid={`settings-${tab}`}><PanelHeader title={tab} detail={tab === "模型" ? "供应商设置可保存；临时 token 只用于本次测试。" : tab === "连接器" ? "连接器 token 仅写入受保护引用，不在 UI 回显。" : tab === "安全" ? "高风险动作使用一次性确认，默认权限保持本地审阅。" : "查看数据库、调度器和运行时诊断。"} />{!online ? <OfflinePanel online={online} message="服务未连接；设置只显示安全默认值。" /> : null}{tab === "模型" ? <div className="settings-form"><label className="feature-field"><span>供应商</span><select onChange={(event) => setSettings((current) => ({ ...current, modelProvider: event.target.value }))} value={settings.modelProvider || "openai"}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option><option value="deepseek">DeepSeek</option><option value="custom">Custom</option></select></label><label className="feature-field"><span>模型</span><input onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))} value={settings.model || ""} /></label><label className="feature-field"><span>Effort</span><select onChange={(event) => setSettings((current) => ({ ...current, effort: event.target.value }))} value={settings.effort || "xhigh"}><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label><label className="feature-field"><span>API base URL</span><input onChange={(event) => setSettings((current) => ({ ...current, apiBaseUrl: event.target.value }))} value={settings.apiBaseUrl || ""} /></label><label className="feature-field"><span>临时 token（不保存）</span><input onChange={(event) => setToken(event.target.value)} type="password" value={token} /></label><div className="feature-toolbar"><button className="ghost-button" disabled={!online || !token} onClick={() => void providerTest()} type="button"><Icon name="activity" size={15} />测试供应商</button><button className="primary-button" disabled={!online} onClick={() => void saveModel()} type="button"><Icon name="check" size={15} />保存模型设置</button></div>{providerResult ? <p className="feature-success">{providerResult}</p> : null}</div> : null}{tab === "连接器" ? <div className="settings-form"><label className="feature-field"><span>名称</span><input onChange={(event) => setConnector((current) => ({ ...current, name: event.target.value }))} value={connector.name} /></label><label className="feature-field"><span>URL</span><input onChange={(event) => setConnector((current) => ({ ...current, url: event.target.value }))} value={connector.url} /></label><label className="feature-field"><span>临时 token</span><input onChange={(event) => setConnector((current) => ({ ...current, token: event.target.value }))} type="password" value={connector.token} /></label><button className="primary-button" disabled={!online || !connector.name} onClick={() => void saveConnectorValue()} type="button"><Icon name="check" size={15} />保存连接器</button><div className="connector-list">{connectors.map((item) => <div className="connector-row" key={String(item.id)}><Icon name="bolt" size={15} /><span><strong>{String(item.name || item.id)}</strong><small>{item.tokenConfigured ? "token 已配置" : "无 token"}</small></span></div>)}</div></div> : null}{tab === "安全" ? <div className="security-summary"><div className="permission-badge"><Icon name="lock" size={14} />本地审阅</div><p>终端、外部网络和高风险写操作均需一次性确认；确认 token 不会进入持久化设置。</p><div className="dataset-heading"><strong>待审批</strong><span className="subtle">{approvals.length}</span></div>{approvals.length ? approvals.map((item) => <div className="connector-row" key={String(item.id)}><Icon name="shield" size={15} /><span><strong>{String(item.id)}</strong><small>{String(item.status || "pending")}</small></span></div>) : <p className="feature-empty">暂无待审批项。</p>}</div> : null}{tab === "诊断" ? <pre className="diagnostic-output">{JSON.stringify(diagnostics || { status: online ? "connected" : "offline" }, null, 2)}</pre> : null}{error ? <p className="feature-error" role="alert">{error}</p> : null}</div>;
}

function DataTable({ columns, rows, title }: { columns: string[]; rows: Array<Record<string, unknown>>; title: string }) {
  return <div className="data-table-card"><div className="dataset-heading"><strong>{title}</strong><span className="subtle">{rows.length} 行</span></div><div className="data-table-wrap"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}>{formatCell(row[column])}</td>)}</tr>)}</tbody></table></div></div>;
}

function formatCell(value: unknown) { return value === null || value === undefined ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value); }

export function parseDataPreview(input: string): { columns: string[]; rows: Array<Record<string, unknown>> } {
  const text = input.trim();
  if (!text) return { columns: [], rows: [] };
  try {
    const value = JSON.parse(text);
    const rows = (Array.isArray(value) ? value : Array.isArray(value.rows) ? value.rows : [value]) as Array<Record<string, unknown>>;
    const columns = [...new Set(rows.flatMap((row: Record<string, unknown>) => Object.keys(row || {})))];
    return { columns, rows: rows.filter((row: Record<string, unknown>) => Boolean(row && typeof row === "object")) };
  } catch { /* CSV preview below. */ }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const columns = (lines.shift() || "").split(",").map((column, index) => column.trim() || `column_${index + 1}`);
  const rows: Array<Record<string, unknown>> = lines.slice(0, 100).map((line) => Object.fromEntries(columns.map((column, index) => [column, line.split(",")[index]?.trim() || null])));
  return { columns, rows };
}

export function isSafeTerminalCommand(command: string) {
  return /^npm\s+(?:test|run\s+(?:test(?::[\w.-]+)?|build))(?:\s+[\w./:-]+)*$|^node\s+--test(?:\s+[\w./:-]+)*$/i.test(command.trim());
}
