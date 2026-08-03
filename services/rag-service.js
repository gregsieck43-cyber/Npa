import crypto from "node:crypto";

export const DEFAULT_RAG_SETTINGS = {
  embeddingProvider: "local",
  embeddingModel: "local-hash-v1",
  embeddingEndpoint: "",
  vectorStore: "memory",
  chunkChars: 1800,
  chunkOverlap: 220,
  maxChunks: 8,
  searchResults: 30,
  similarityThreshold: 0.08,
  sparseWeight: 0.44,
  embeddingWeight: 0.46,
  keywordWeight: 0.1,
  titleBoost: 0.12,
  vectorDimensions: 384,
  retryAttempts: 2,
  incrementalIndex: true
};

export const EMBEDDING_PROVIDERS = ["local", "openai", "custom"];
export const VECTOR_STORES = ["memory", "json", "sqlite"];

export function normalizeRagSettings(input = {}) {
  const dimensions = Number(input.vectorDimensions || DEFAULT_RAG_SETTINGS.vectorDimensions);
  return {
    embeddingProvider: EMBEDDING_PROVIDERS.includes(input.embeddingProvider) ? input.embeddingProvider : DEFAULT_RAG_SETTINGS.embeddingProvider,
    embeddingModel: String(input.embeddingModel || DEFAULT_RAG_SETTINGS.embeddingModel).slice(0, 160),
    embeddingEndpoint: String(input.embeddingEndpoint || "").trim().slice(0, 1000),
    vectorStore: VECTOR_STORES.includes(input.vectorStore) ? input.vectorStore : DEFAULT_RAG_SETTINGS.vectorStore,
    chunkChars: clampNumber(input.chunkChars, 600, 6000, DEFAULT_RAG_SETTINGS.chunkChars),
    chunkOverlap: clampNumber(input.chunkOverlap, 0, 1200, DEFAULT_RAG_SETTINGS.chunkOverlap),
    maxChunks: clampNumber(input.maxChunks, 1, 30, DEFAULT_RAG_SETTINGS.maxChunks),
    searchResults: clampNumber(input.searchResults, 1, 80, DEFAULT_RAG_SETTINGS.searchResults),
    similarityThreshold: clampNumber(input.similarityThreshold, 0, 1, DEFAULT_RAG_SETTINGS.similarityThreshold),
    sparseWeight: clampNumber(input.sparseWeight, 0, 1, DEFAULT_RAG_SETTINGS.sparseWeight),
    embeddingWeight: clampNumber(input.embeddingWeight, 0, 1, DEFAULT_RAG_SETTINGS.embeddingWeight),
    keywordWeight: clampNumber(input.keywordWeight, 0, 1, DEFAULT_RAG_SETTINGS.keywordWeight),
    titleBoost: clampNumber(input.titleBoost, 0, 1, DEFAULT_RAG_SETTINGS.titleBoost),
    vectorDimensions: [128, 256, 384, 512, 768].includes(dimensions) ? dimensions : DEFAULT_RAG_SETTINGS.vectorDimensions,
    retryAttempts: clampNumber(input.retryAttempts, 0, 5, DEFAULT_RAG_SETTINGS.retryAttempts),
    incrementalIndex: input.incrementalIndex !== false
  };
}

export function createIndexJob(input = {}) {
  const id = input.id || `ragjob_${contentHash(`${Date.now()}:${Math.random()}`).slice(0, 18)}`;
  return {
    id,
    status: ["queued", "running", "completed", "failed"].includes(input.status) ? input.status : "queued",
    scope: input.scope || "local",
    projectId: input.projectId || null,
    total: Number(input.total || 0),
    processed: Number(input.processed || 0),
    failed: Number(input.failed || 0),
    error: String(input.error || "").slice(0, 2000),
    attempts: Number(input.attempts || 0),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

export function updateIndexJob(job = {}, patch = {}) {
  const next = createIndexJob({ ...job, ...patch, id: job.id || patch.id });
  next.updatedAt = new Date().toISOString();
  if (next.total > 0 && next.processed >= next.total && next.failed === 0) next.status = "completed";
  if (next.failed > 0 && next.processed >= next.total) next.status = "failed";
  return next;
}

export function normalizeIndexQueue(queue = []) {
  return (Array.isArray(queue) ? queue : []).map(createIndexJob).slice(-200);
}

export function embeddingProviderStatus(settings = {}, secrets = {}) {
  const normalized = normalizeRagSettings(settings);
  if (normalized.embeddingProvider === "local") {
    return { ok: true, provider: "local", model: normalized.embeddingModel, mode: "offline-hash", dimensions: normalized.vectorDimensions };
  }
  if (normalized.embeddingProvider === "openai") {
    const hasToken = Boolean(secrets.token || secrets.apiKey || secrets.accessToken);
    return {
      ok: hasToken,
      provider: "openai",
      model: normalized.embeddingModel || "text-embedding-3-small",
      mode: "remote",
      error: hasToken ? "" : "缺少 OpenAI embedding token"
    };
  }
  const ok = Boolean(normalized.embeddingEndpoint);
  return {
    ok,
    provider: "custom",
    model: normalized.embeddingModel,
    mode: "remote",
    endpoint: normalized.embeddingEndpoint,
    error: ok ? "" : "缺少自定义 embedding endpoint"
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function contentHash(content) {
  return crypto.createHash("sha256").update(String(content || ""), "utf8").digest("hex");
}

export function shortSummary(value, limit = 360) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

export function lineNumberAt(content, offset) {
  if (offset <= 0) return 1;
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function pageAt(content, offset) {
  const full = String(content || "");
  const prefix = offset <= 0 ? full.slice(0, 240) : full.slice(0, Math.max(0, offset));
  const markers = [...prefix.matchAll(/\[\[(?:page|slide):\s*(\d+)\]\]|(?:^|\n)\s*(?:##\s*)?(?:page|slide|第)\s*(\d+)\s*(?:页|張|张)?/gi)];
  const last = offset <= 0 ? markers[0] : markers.at(-1);
  if (!last) return null;
  return Number(last[1] || last[2] || 0) || null;
}

export function chunkDocument(doc, inputSettings = {}) {
  const settings = normalizeRagSettings(inputSettings);
  const content = String(doc.content || "");
  if (!content.trim()) return [];
  const chunks = [];
  let start = 0;
  while (start < content.length && chunks.length < 800) {
    let end = Math.min(content.length, start + settings.chunkChars);
    const boundary = content.lastIndexOf("\n\n", end);
    if (boundary > start + Math.min(500, settings.chunkChars / 3)) end = boundary;
    const text = content.slice(start, end).trim();
    if (text) {
      const page = pageAt(content, start);
      chunks.push({
        doc,
        chunkId: `${doc.id}#${chunks.length + 1}`,
        index: chunks.length + 1,
        start,
        end,
        startLine: lineNumberAt(content, start),
        endLine: lineNumberAt(content, end),
        page,
        text
      });
    }
    if (end >= content.length) break;
    start = Math.max(end - settings.chunkOverlap, start + 1);
  }
  return chunks;
}

export function tokenize(value) {
  const text = String(value || "").toLowerCase();
  const tokens = text.match(/[\p{L}\p{N}_-]+/gu) || [];
  const expanded = [];
  for (const token of tokens) {
    expanded.push(token);
    if (/[\u4e00-\u9fff]/.test(token) && token.length > 1) {
      for (let i = 0; i < token.length - 1; i += 1) expanded.push(token.slice(i, i + 2));
    }
  }
  return expanded.filter((token) => token.length > 1).slice(0, 8000);
}

export function sparseVector(value) {
  const vector = new Map();
  for (const token of tokenize(value)) vector.set(token, (vector.get(token) || 0) + 1);
  return vector;
}

export function cosineSparse(a, b) {
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (const value of a.values()) an += value * value;
  for (const value of b.values()) bn += value * value;
  for (const [key, value] of a) dot += value * (b.get(key) || 0);
  return dot && an && bn ? dot / Math.sqrt(an * bn) : 0;
}

function hashToUnit(value) {
  const digest = crypto.createHash("sha256").update(String(value)).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

export function embeddingVector(value, inputSettings = {}) {
  const settings = normalizeRagSettings(inputSettings);
  const vector = new Float32Array(settings.vectorDimensions);
  const tokens = tokenize(value);
  for (const token of tokens) {
    const index = Math.floor(hashToUnit(`i:${token}`) * settings.vectorDimensions) % settings.vectorDimensions;
    const sign = hashToUnit(`s:${token}`) > 0.5 ? 1 : -1;
    vector[index] += sign;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  const sparse = [];
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] / norm;
    if (Math.abs(value) > 0.0001) sparse.push([index, Number(value.toFixed(6))]);
  }
  return sparse;
}

export function embeddingCosine(a = [], b = []) {
  let i = 0;
  let j = 0;
  let dot = 0;
  while (i < a.length && j < b.length) {
    const [ai, av] = a[i];
    const [bi, bv] = b[j];
    if (ai === bi) {
      dot += av * bv;
      i += 1;
      j += 1;
    } else if (ai < bi) i += 1;
    else j += 1;
  }
  return dot;
}

export function prepareDocument(doc, { settings = {}, now = () => new Date().toISOString(), summarizeDocumentContent } = {}) {
  const normalized = normalizeRagSettings(settings);
  const content = String(doc.content || "");
  doc.contentHash = contentHash(content);
  if (summarizeDocumentContent) doc.summary = doc.summary || summarizeDocumentContent(content, doc.name);
  doc.chunkCount = chunkDocument(doc, normalized).length;
  doc.indexStatus = "ready";
  doc.indexError = "";
  doc.indexedAt = now();
  return doc;
}

function chunkToIndexRecord(chunk, settings) {
  const text = `${chunk.doc.name}\n${chunk.text}`;
  return {
    chunkId: chunk.chunkId,
    docId: chunk.doc.id,
    index: chunk.index,
    start: chunk.start,
    end: chunk.end,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    page: chunk.page,
    preview: shortSummary(chunk.text, 420),
    sparse: [...sparseVector(text).entries()],
    embedding: embeddingVector(text, settings)
  };
}

export function rebuildKnowledgeIndex({
  docs = [],
  existingIndex = {},
  settings = {},
  now = () => new Date().toISOString(),
  incremental = true,
  retryFailed = false,
  summarizeDocumentContent
} = {}) {
  const normalized = normalizeRagSettings(settings);
  const index = {
    updatedAt: "",
    version: 2,
    kind: `${normalized.vectorStore}-${normalized.embeddingProvider}-embedding`,
    embeddingProvider: normalized.embeddingProvider,
    embeddingModel: normalized.embeddingModel,
    vectorStore: normalized.vectorStore,
    settings: normalized,
    docs: { ...(existingIndex.docs || {}) },
    failed: retryFailed ? [] : [...(existingIndex.failed || [])],
    stats: { docs: 0, chunks: 0, indexed: 0, skipped: 0, failed: 0, retried: retryFailed ? (existingIndex.failed || []).length : 0 }
  };
  const docIds = new Set(docs.map((doc) => doc.id));
  for (const docId of Object.keys(index.docs)) {
    if (!docIds.has(docId)) delete index.docs[docId];
  }
  const previousFailed = new Set((existingIndex.failed || []).map((item) => item.docId));
  for (const doc of docs) {
    index.stats.docs += 1;
    try {
      const hash = contentHash(doc.content || "");
      const previous = index.docs[doc.id];
      const canSkip =
        incremental &&
        !retryFailed &&
        previous &&
        previous.contentHash === hash &&
        previous.settingsHash === settingsHash(normalized) &&
        !previousFailed.has(doc.id);
      if (canSkip) {
        index.stats.skipped += 1;
        index.stats.chunks += previous.chunkCount || 0;
        continue;
      }
      const attempts = retryFailed ? Math.max(1, normalized.retryAttempts + 1) : 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          prepareDocument(doc, { settings: normalized, now, summarizeDocumentContent });
          const chunks = chunkDocument(doc, normalized).map((chunk) => chunkToIndexRecord(chunk, normalized));
          index.docs[doc.id] = {
            id: doc.id,
            name: doc.name,
            path: doc.path,
            scope: doc.scope,
            ext: doc.ext || "",
            contentHash: hash,
            settingsHash: settingsHash(normalized),
            chunkCount: chunks.length,
            chunks,
            updatedAt: now()
          };
          index.stats.indexed += 1;
          index.stats.chunks += chunks.length;
          doc.indexStatus = "ready";
          doc.indexError = "";
          doc.indexAttempts = attempt;
          index.failed = index.failed.filter((failure) => failure.docId !== doc.id);
          break;
        } catch (error) {
          doc.indexAttempts = attempt;
          if (attempt >= attempts) throw error;
        }
      }
    } catch (error) {
      doc.indexStatus = "failed";
      doc.indexError = error.message;
      index.failed.push({ docId: doc.id, name: doc.name, path: doc.path, error: error.message, attempts: doc.indexAttempts || 1, failedAt: now() });
      index.stats.failed += 1;
    }
  }
  index.failed = index.failed.filter((failure) => docIds.has(failure.docId)).slice(-100);
  index.updatedAt = now();
  return { index, docs };
}

function settingsHash(settings) {
  return crypto.createHash("sha1").update(JSON.stringify(normalizeRagSettings(settings))).digest("hex").slice(0, 16);
}

function docChunkText(doc, record) {
  const content = String(doc.content || "");
  return content.slice(record.start || 0, record.end || 0).trim() || record.preview || "";
}

function scoreChunk({ queryText, querySparse, queryEmbedding, terms, doc, record, settings }) {
  const sparse = cosineSparse(querySparse, new Map(record.sparse || []));
  const embedding = embeddingCosine(queryEmbedding, record.embedding || []);
  const lower = `${doc.name}\n${record.preview || ""}`.toLowerCase();
  let keyword = 0;
  for (const term of terms) {
    if (lower.includes(term)) keyword += doc.name.toLowerCase().includes(term) ? settings.titleBoost : 0.04;
  }
  if (!queryText) keyword += 0.01 / Math.max(1, record.index || 1);
  return sparse * settings.sparseWeight + embedding * settings.embeddingWeight + keyword * settings.keywordWeight;
}

export function retrieveKnowledge({ query = "", docs = [], index = {}, settings = {}, maxChunks } = {}) {
  const normalized = normalizeRagSettings({ ...settings, maxChunks: maxChunks || settings.maxChunks });
  const queryText = String(query || "").trim();
  const querySource = queryText || docs.map((doc) => doc.name).join(" ");
  const querySparse = sparseVector(querySource);
  const queryEmbedding = embeddingVector(querySource, normalized);
  const terms = tokenize(queryText);
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const scored = [];
  const indexedDocs = index.docs || {};
  for (const doc of docs) {
    const indexed = indexedDocs[doc.id];
    const records = indexed?.chunks?.length
      ? indexed.chunks
      : chunkDocument(doc, normalized).map((chunk) => chunkToIndexRecord(chunk, normalized));
    for (const record of records) {
      const sourceDoc = byId.get(record.docId || doc.id) || doc;
      const score = scoreChunk({ queryText, querySparse, queryEmbedding, terms, doc: sourceDoc, record, settings: normalized });
      if (score >= normalized.similarityThreshold || !queryText) {
        const text = docChunkText(sourceDoc, record);
        scored.push({
          doc: sourceDoc,
          chunkId: record.chunkId,
          index: record.index,
          startLine: record.startLine,
          endLine: record.endLine,
          page: record.page || null,
          text,
          score,
          snippet: shortSummary(text || record.preview, 700)
        });
      }
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name) || a.index - b.index)
    .slice(0, maxChunks || normalized.maxChunks)
    .map((chunk, index) => ({ ...chunk, sourceId: `S${index + 1}` }));
}

export function searchKnowledge({ query = "", docs = [], index = {}, settings = {}, maxChunks } = {}) {
  return retrieveKnowledge({ query, docs, index, settings, maxChunks: maxChunks || normalizeRagSettings(settings).searchResults });
}

export function buildKnowledgeSource(chunk) {
  return {
    sourceId: chunk.sourceId,
    docId: chunk.doc.id,
    chunkId: chunk.chunkId,
    name: chunk.doc.name,
    path: chunk.doc.path,
    scope: chunk.doc.scope,
    score: Number(chunk.score.toFixed(4)),
    lines: [chunk.startLine, chunk.endLine],
    page: chunk.page || null,
    snippet: chunk.snippet
  };
}

export function indexOccupancy(index = {}) {
  const docs = Object.values(index.docs || {});
  const chunks = docs.flatMap((doc) => doc.chunks || []);
  const embeddingValues = chunks.reduce((sum, chunk) => sum + (chunk.embedding?.length || 0), 0);
  const sparseValues = chunks.reduce((sum, chunk) => sum + (chunk.sparse?.length || 0), 0);
  const bytes = Buffer.byteLength(JSON.stringify(index || {}), "utf8");
  return {
    docs: docs.length,
    chunks: chunks.length,
    embeddingValues,
    sparseValues,
    bytes,
    avgChunksPerDoc: docs.length ? Number((chunks.length / docs.length).toFixed(2)) : 0,
    failed: (index.failed || []).length,
    updatedAt: index.updatedAt || ""
  };
}

export function indexStatus(index = {}, docs = []) {
  const occupancy = indexOccupancy(index);
  const indexedIds = new Set(Object.keys(index.docs || {}));
  const failedIds = new Set((index.failed || []).map((item) => item.docId));
  const pending = docs.filter((doc) => !indexedIds.has(doc.id) && !failedIds.has(doc.id)).length;
  return {
    kind: index.kind || "local-hash-embedding",
    embeddingProvider: index.embeddingProvider || index.settings?.embeddingProvider || "local",
    vectorStore: index.vectorStore || index.settings?.vectorStore || "memory",
    updatedAt: index.updatedAt || "",
    pending,
    indexed: indexedIds.size,
    failed: failedIds.size,
    occupancy
  };
}

export function citationCoverage({ report = "", sources = [] } = {}) {
  const available = new Set((sources || []).map((source) => String(source.sourceId || "").trim()).filter(Boolean));
  const refs = [...String(report || "").matchAll(/\[([A-Z]\d+)\]/g)].map((match) => match[1]);
  const used = [...new Set(refs)].filter((ref) => available.has(ref));
  const missing = [...new Set(refs)].filter((ref) => !available.has(ref));
  return {
    available: available.size,
    referenced: refs.length,
    used: used.length,
    missing,
    coverage: available.size ? Number((used.length / available.size).toFixed(3)) : 1
  };
}

export function knowledgeDuplicates(docs = []) {
  const groups = new Map();
  for (const doc of docs) {
    const hash = doc.contentHash || contentHash(doc.content || "");
    if (!hash || hash === contentHash("")) continue;
    const group = groups.get(hash) || [];
    group.push(doc);
    groups.set(hash, group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

export function publicDocDetail(doc, { settings = {}, maxContentChars = 120000 } = {}) {
  const chunks = chunkDocument(doc, settings).slice(0, 120);
  const { content, ...safe } = doc;
  return {
    ...safe,
    content: String(content || "").slice(0, maxContentChars),
    chunks: chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      index: chunk.index,
      lines: [chunk.startLine, chunk.endLine],
      page: chunk.page || null,
      preview: shortSummary(chunk.text, 500)
    }))
  };
}

export function exportKnowledgeBackup({ docs = [], index = {}, settings = {}, project = null, createdAt = new Date().toISOString() } = {}) {
  return {
    schema: "local-claude-workbench.knowledge-backup.v1",
    createdAt,
    project: project ? { id: project.id, name: project.name } : null,
    rag: {
      settings: normalizeRagSettings(settings),
      indexStats: index.stats || {},
      updatedAt: index.updatedAt || ""
    },
    docs: docs.map((doc) => ({
      id: doc.id,
      name: doc.name,
      path: doc.path,
      ext: doc.ext || "",
      size: doc.size || 0,
      scope: doc.scope,
      lines: doc.lines || 0,
      chars: doc.chars || 0,
      contentHash: doc.contentHash || contentHash(doc.content || ""),
      summary: doc.summary || null,
      content: doc.content || "",
      createdAt: doc.createdAt || "",
      updatedAt: doc.updatedAt || ""
    }))
  };
}
