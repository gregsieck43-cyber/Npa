export async function tryHandleDataApi(ctx) {
  const {
    req,
    res,
    pathname,
    store,
    getRequestBody,
    normalizeCapabilities,
    parseDatasetsFromUpload,
    addDataset,
    audit,
    saveStore,
    sendJson,
    publicDataset,
    runDataAnalysis,
    publicAnalysisRun,
    DataAnalysisService,
    hydrate
  } = ctx;

  if (req.method === "POST" && pathname === "/api/data/import-upload") {
    if (!normalizeCapabilities(store.settings.capabilities || {}).dataAnalysis) {
      throw Object.assign(new Error("数据分析开关已关闭"), { statusCode: 403 });
    }
    const body = await getRequestBody(req);
    const files = Array.isArray(body.files) ? body.files : [body.file || body].filter(Boolean);
    if (!files.length) throw Object.assign(new Error("没有收到数据文件"), { statusCode: 400 });
    const imported = [];
    for (const file of files.slice(0, 6)) {
      const tables = parseDatasetsFromUpload(file);
      for (const table of tables) imported.push(addDataset(table, { sourceName: file.name, mimeType: file.mimeType || "" }));
    }
    audit("data.imported", { count: imported.length, names: imported.map((dataset) => dataset.name) });
    await saveStore();
    sendJson(res, 200, { datasets: imported.map(publicDataset), state: hydrate() });
    return true;
  }

  const datasetMatch = pathname.match(/^\/api\/data\/datasets\/([^/]+)$/);
  if (req.method === "DELETE" && datasetMatch) {
    const index = (store.datasets || []).findIndex((dataset) => dataset.id === datasetMatch[1]);
    if (index < 0) throw Object.assign(new Error("数据集不存在"), { statusCode: 404 });
    const [dataset] = store.datasets.splice(index, 1);
    store.analysisRuns = (store.analysisRuns || []).filter((run) => run.datasetId !== dataset.id);
    audit("data.deleted", { datasetId: dataset.id, name: dataset.name });
    await saveStore();
    sendJson(res, 200, { dataset: publicDataset(dataset), state: hydrate() });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/data/run") {
    const body = await getRequestBody(req);
    const run = await runDataAnalysis(body);
    sendJson(res, 200, { run: publicAnalysisRun(run), state: hydrate() });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/data/clean") {
    const body = await getRequestBody(req);
    const run = await runDataAnalysis({ ...body, language: "clean" });
    sendJson(res, 200, { run: publicAnalysisRun(run), state: hydrate() });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/data/pivot") {
    const body = await getRequestBody(req);
    const run = await runDataAnalysis({ ...body, language: "pivot" });
    sendJson(res, 200, { run: publicAnalysisRun(run), state: hydrate() });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/data/chart/export") {
    const body = await getRequestBody(req);
    const run = (store.analysisRuns || []).find((item) => item.id === body.runId);
    const chart = body.chart || run?.chart;
    if (!chart) throw Object.assign(new Error("没有可导出的图表"), { statusCode: 400 });
    const svg = DataAnalysisService.chartToSvg(chart, { title: body.title || run?.id || "数据图表" });
    sendJson(res, 200, { mimeType: "image/svg+xml", data: Buffer.from(svg, "utf8").toString("base64"), svg });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/data/packages") {
    const body = await getRequestBody(req);
    store.packageEnvironments ||= {};
    const envId = body.envId || "default";
    const environment = DataAnalysisService.normalizePackageEnvironment(body);
    store.packageEnvironments[envId] = environment;
    audit("data.package_environment_saved", { envId, manager: environment.manager, packages: environment.packages.length });
    await saveStore();
    sendJson(res, 200, { environment, state: hydrate() });
    return true;
  }

  return false;
}
