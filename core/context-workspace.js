import { createHash, randomUUID } from 'node:crypto';
import { decodeJson, encodeJson } from './database.js';

const DEFAULT_TOKEN_LIMIT = 200_000;
const DEFAULT_THRESHOLDS = Object.freeze({ notice: 0.8, manage: 0.92, hardPreflight: 0.98 });
const SINGLE_RESULT_EXTERNALIZE = 12_000;
const ROUND_EXTERNALIZE = 50_000;

function asBoolean(value) {
  return value === true || value === 1 || value === '1';
}

function stableBlockId(workspaceId, stableKey) {
  const digest = createHash('sha256').update(`${workspaceId}\0${stableKey}`, 'utf8').digest('hex').slice(0, 32);
  return `block_${digest}`;
}

function normalizeNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.toISOString() : new Date(value || Date.now()).toISOString();
}

function thresholdRatio(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number > 1 ? number / 100 : number;
}

function mapWorkspace(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.id,
    runId: row.run_id,
    goal: row.goal || '',
    tokenLimit: Number(row.token_limit || DEFAULT_TOKEN_LIMIT),
    pressureThresholds: decodeJson(row.pressure_json, { ...DEFAULT_THRESHOLDS }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapBlock(row) {
  if (!row) return null;
  const metadata = sanitizeBlockMetadata(decodeJson(row.metadata_json, {}));
  const pinned = asBoolean(row.pinned);
  const visible = asBoolean(row.visible);
  const archived = asBoolean(row.archived);
  const offloaded = asBoolean(row.offloaded);
  const lifecycleStatus = archived ? 'archived' : pinned ? 'pinned' : offloaded ? 'offloaded' : 'visible';
  return {
    id: row.id,
    blockId: row.id,
    stableId: row.id,
    workspaceId: row.workspace_id,
    stableKey: row.stable_key,
    type: row.type,
    parentId: row.parent_id,
    parent: row.parent_id,
    depth: Number(row.depth || 0),
    level: Number(row.depth || 0),
    status: lifecycleStatus,
    state: lifecycleStatus,
    tokenEstimate: Number(row.token_estimate || 0),
    summary: row.summary || '',
    source: row.source || '',
    payloadHash: row.payload_hash || null,
    payloadId: row.payload_hash || null,
    payloadRef: row.payload_hash || null,
    payloadReference: row.payload_hash || null,
    checksum: row.checksum || null,
    integrity: row.integrity || 'unchecked',
    completeness: metadata.completeness || (row.checksum ? 'complete' : 'summary_only'),
    pinned,
    visible,
    archived,
    offloaded,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at
  };
}

function sanitizeBlockMetadata(input) {
  if (Array.isArray(input)) return input.map(sanitizeBlockMetadata);
  if (!input || typeof input !== 'object') return input;
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['apikey', 'token', 'accesstoken', 'refreshtoken', 'secret', 'secrets', 'password', 'authorization', 'privatekey'].includes(normalized)) continue;
    output[key] = sanitizeBlockMetadata(value);
  }
  return output;
}

function workspaceIdFrom(input) {
  if (typeof input === 'string') return input;
  return input?.workspaceId || input?.contextWorkspaceId || input?.id || null;
}

function blockIdFrom(input) {
  if (typeof input === 'string') return input;
  return input?.blockId || input?.stableId || input?.id || null;
}

function actionArgs(workspaceIdOrOptions, blockId, options = {}) {
  if (workspaceIdOrOptions && typeof workspaceIdOrOptions === 'object') {
    const input = workspaceIdOrOptions;
    return {
      workspaceId: workspaceIdFrom(input),
      blockId: blockIdFrom(blockId) || blockIdFrom(input),
      options: { ...input, ...options }
    };
  }
  return { workspaceId: workspaceIdFrom(workspaceIdOrOptions), blockId: blockIdFrom(blockId), options };
}

/**
 * Clean-room Context Workspace implementation.  SQLite remains the source of
 * truth for block metadata while PayloadStore keeps original large values
 * encrypted and content-addressed.
 */
export class ContextWorkspaceStore {
  constructor(options = {}) {
    this.db = options.db || options.database;
    if (!this.db) throw new TypeError('context workspace requires a database');
    this.payloadStore = options.payloadStore || options.payloads || null;
    this.now = options.now || (() => new Date());
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    this.defaultTokenLimit = Math.max(1, Number(options.tokenLimit || DEFAULT_TOKEN_LIMIT));
  }

  _now() {
    return normalizeNow(this.now);
  }

  _audit(action, payload, workspace, entityType = 'context_workspace', entityId = null) {
    if (typeof this.db.recordAudit !== 'function') return;
    this.db.recordAudit(action, payload, {
      runId: workspace?.runId || workspace?.run_id || null,
      entityType,
      entityId: entityId || workspace?.id || workspace?.workspaceId || null
    });
  }

  _ensureRun(runId, workspaceId = null) {
    if (!runId) return;
    const existing = this.db.get('SELECT id FROM runs WHERE id = ?', runId);
    if (existing) {
      if (workspaceId) this.db.run('UPDATE runs SET workspace_id = coalesce(workspace_id, ?) WHERE id = ?', workspaceId, runId);
      return;
    }
    const timestamp = this._now();
    this.db.run(`INSERT INTO runs (id, status, workspace_id, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?)`, runId, workspaceId, timestamp, timestamp);
  }

  createWorkspace(input = {}) {
    const options = typeof input === 'string' ? { runId: input } : input;
    const runId = options.runId || options.run_id || null;
    const id = String(options.workspaceId || options.id || (runId ? `workspace_${runId}` : `workspace_${randomUUID()}`));
    this._ensureRun(runId, id);
    const existing = this.db.get('SELECT * FROM context_workspaces WHERE id = ?', id);
    if (existing) return mapWorkspace(existing);
    const timestamp = this._now();
    const tokenLimit = Math.max(1, Number(options.tokenLimit || options.contextWindow || options.windowTokens || this.defaultTokenLimit));
    const thresholds = { ...this.thresholds, ...(options.pressureThresholds || {}) };
    this.db.transaction(() => {
      this.db.run(`INSERT INTO context_workspaces
        (id, run_id, goal, token_limit, pressure_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, id, runId, String(options.goal || ''), tokenLimit,
      encodeJson(thresholds), timestamp, timestamp);
    });
    const workspace = mapWorkspace(this.db.get('SELECT * FROM context_workspaces WHERE id = ?', id));
    const acceptanceInput = options.acceptanceCriteria ?? options.acceptance ?? options.criteria;
    const acceptance = Array.isArray(acceptanceInput) ? acceptanceInput : acceptanceInput ? [acceptanceInput] : [];
    const constraints = Array.isArray(options.constraints) ? options.constraints : options.constraints ? [options.constraints] : [];
    if (!options.skipAutoBlocks) {
      if (options.goal) this.registerBlock(id, { type: 'goal', key: 'goal', summary: String(options.goal), status: 'pinned', pinned: true, visible: true, metadata: { permanentPinned: true } });
      acceptance.forEach((criterion, index) => this.registerBlock(id, {
        type: 'acceptance', key: `acceptance:${index}:${String(criterion)}`, summary: String(criterion), status: 'pinned', pinned: true, visible: true, metadata: { permanentPinned: true }
      }));
      constraints.forEach((constraint, index) => this.registerBlock(id, {
        type: 'constraint', key: `constraint:${index}:${String(constraint)}`, summary: String(constraint), status: 'pinned', pinned: true, visible: true, metadata: { permanentPinned: true }
      }));
      if (Array.isArray(options.pinnedBlocks)) {
        options.pinnedBlocks.forEach((block, index) => this.registerBlock(id, {
          ...(block || {}), type: block?.type || 'context', key: block?.key || `pinned:${index}`,
          pinned: true, visible: block?.visible !== false
        }));
      }
    }
    this._audit('context.workspace_created', { workspaceId: id, runId }, workspace);
    return workspace;
  }

  getWorkspace(workspaceId) {
    const id = workspaceIdFrom(workspaceId);
    return mapWorkspace(this.db.get('SELECT * FROM context_workspaces WHERE id = ?', id));
  }

  listWorkspaces(options = {}) {
    if (typeof options === 'string') options = { runId: options };
    if (options.runId) return this.db.all('SELECT * FROM context_workspaces WHERE run_id = ? ORDER BY updated_at DESC', String(options.runId)).map(mapWorkspace);
    return this.db.all('SELECT * FROM context_workspaces ORDER BY updated_at DESC').map(mapWorkspace);
  }

  _normaliseBlockArgs(workspaceIdOrOptions, blockInput = {}) {
    if (workspaceIdOrOptions && typeof workspaceIdOrOptions === 'object') {
      const options = { ...workspaceIdOrOptions };
      const id = workspaceIdFrom(options);
      delete options.workspaceId;
      delete options.contextWorkspaceId;
      return { workspaceId: id, input: options };
    }
    return { workspaceId: workspaceIdFrom(workspaceIdOrOptions), input: { ...blockInput } };
  }

  registerBlock(workspaceIdOrOptions, blockInput = {}) {
    const { workspaceId, input } = this._normaliseBlockArgs(workspaceIdOrOptions, blockInput);
    if (!workspaceId) throw new TypeError('workspaceId is required');
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Context workspace ${workspaceId} not found`);
    const type = String(input.type || 'note');
    const summary = String(input.summary ?? input.title ?? input.content ?? '');
    const source = String(input.source || input.origin || '');
    const parentId = input.parentId || input.parent || null;
    const depth = Math.max(0, Number(input.depth ?? (parentId ? 1 : 0)));
    let tokenEstimate = Math.max(0, Number(input.tokenEstimate ?? input.tokens ?? 0));
    const hasExplicitTokenEstimate = input.tokenEstimate !== undefined || input.tokens !== undefined;
    const timestamp = this._now();
    let payloadHash = input.payloadHash || input.payloadRef || null;
    let checksum = input.checksum || null;
    let integrity = String(input.integrity || (payloadHash ? 'referenced' : 'unchecked'));
    let offloaded = Boolean(input.offloaded || input.offload || input.externalized || this.shouldOffload({ tokenEstimate, resultTokens: input.resultTokens, roundTokens: input.roundTokens }));
    let payloadEncoding = input.payloadEncoding || null;
    if (input.payload !== undefined && this.payloadStore) {
      let descriptor;
      if (typeof this.payloadStore.putSync === 'function') descriptor = this.payloadStore.putSync(input.payload, { mimeType: input.mimeType });
      else if (typeof this.payloadStore.put === 'function') {
        descriptor = this.payloadStore.put(input.payload, { mimeType: input.mimeType });
        if (descriptor?.then) throw new Error('Context workspace requires a synchronous payload store; use PayloadStore');
      }
      payloadHash = descriptor?.hash || descriptor?.sha256 || payloadHash;
      checksum = descriptor?.checksum || payloadHash || checksum;
      payloadEncoding = descriptor?.encoding || payloadEncoding;
      if (!hasExplicitTokenEstimate && descriptor?.size) tokenEstimate = Math.max(1, Math.ceil(Number(descriptor.size) / 4));
      integrity = 'verified';
      if (descriptor) offloaded = offloaded || tokenEstimate >= SINGLE_RESULT_EXTERNALIZE;
    }
    if (offloaded && !payloadHash) {
      throw Object.assign(new Error('Lossless offload requires a payload store or an existing payloadRef'), { statusCode: 409, code: 'lossless_payload_required' });
    }
    const stableKey = String(input.stableKey || input.key || (input.id ? `id:${input.id}` : `${type}:${source}:${summary}:${payloadHash || ''}`));
    const id = String(input.blockId || input.stableId || input.id || stableBlockId(workspaceId, stableKey));
    const metadata = { ...(input.metadata || input.meta || {}) };
    const isPinned = Boolean(input.pinned || input.status === 'pinned' || input.state === 'pinned');
    const row = {
      id, workspaceId, stableKey, type, parentId, depth, status: String(input.status || 'active'), tokenEstimate,
      summary, source, payloadHash, checksum, integrity,
      pinned: isPinned, visible: input.visible !== false && input.status !== 'archived', archived: Boolean(input.archived || input.status === 'archived'), offloaded,
      metadata
    };
    if (payloadHash && payloadEncoding) metadata.payloadEncoding = payloadEncoding;
    this.db.run(`INSERT INTO context_blocks
      (id, workspace_id, stable_key, type, parent_id, depth, status, token_estimate, summary, source,
       payload_hash, checksum, integrity, pinned, visible, archived, offloaded, metadata_json,
       created_at, updated_at, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, stable_key) DO UPDATE SET
        type = excluded.type, parent_id = excluded.parent_id, depth = excluded.depth, status = excluded.status,
        token_estimate = excluded.token_estimate, summary = excluded.summary, source = excluded.source,
        payload_hash = excluded.payload_hash, checksum = excluded.checksum, integrity = excluded.integrity,
        pinned = excluded.pinned, visible = excluded.visible, archived = excluded.archived,
        offloaded = excluded.offloaded, metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at, accessed_at = excluded.accessed_at`,
    row.id, row.workspaceId, row.stableKey, row.type, row.parentId, row.depth, row.status, row.tokenEstimate,
    row.summary, row.source, row.payloadHash, row.checksum, row.integrity, row.pinned ? 1 : 0, row.visible ? 1 : 0,
    row.archived ? 1 : 0, row.offloaded ? 1 : 0, encodeJson(row.metadata), timestamp, timestamp, timestamp);
    const block = mapBlock(this.db.get('SELECT * FROM context_blocks WHERE workspace_id = ? AND stable_key = ?', workspaceId, stableKey));
    this._audit('context.block_registered', { workspaceId, blockId: block.id, type: block.type }, workspace, 'context_block', block.id);
    return block;
  }

  addBlock(workspaceIdOrOptions, blockInput = {}) {
    return this.registerBlock(workspaceIdOrOptions, blockInput);
  }

  createBlock(workspaceIdOrOptions, blockInput = {}) {
    return this.registerBlock(workspaceIdOrOptions, blockInput);
  }

  getBlock(workspaceId, blockId) {
    const args = actionArgs(workspaceId, blockId);
    const workspace = args.workspaceId;
    const block = args.blockId;
    return mapBlock(this.db.get('SELECT * FROM context_blocks WHERE workspace_id = ? AND id = ?', workspace, block));
  }

  listBlocks(workspaceId, options = {}) {
    if (workspaceId && typeof workspaceId === 'object') options = workspaceId;
    const id = workspaceIdFrom(workspaceId);
    const clauses = ['workspace_id = ?'];
    const params = [id];
    if (options.pinned !== undefined) { clauses.push('pinned = ?'); params.push(options.pinned ? 1 : 0); }
    if (options.visible !== undefined) { clauses.push('visible = ?'); params.push(options.visible ? 1 : 0); }
    else if (!options.includeHidden && !options.includeArchived && options.archived === undefined) clauses.push('visible = 1');
    if (options.archived === undefined && !options.includeArchived) clauses.push('archived = 0');
    else if (options.archived !== undefined) { clauses.push('archived = ?'); params.push(options.archived ? 1 : 0); }
    if (options.type) { clauses.push('type = ?'); params.push(String(options.type)); }
    if (options.parentId !== undefined) { clauses.push('parent_id IS ?'); params.push(options.parentId); }
    let sql = `SELECT * FROM context_blocks WHERE ${clauses.join(' AND ')} ORDER BY pinned DESC, depth ASC, created_at ASC`;
    if (options.limit !== undefined) { sql += ' LIMIT ?'; params.push(Math.max(1, Math.min(5000, Number(options.limit)))); }
    if (options.offset !== undefined) { if (options.limit === undefined) { sql += ' LIMIT -1'; } sql += ' OFFSET ?'; params.push(Math.max(0, Number(options.offset))); }
    return this.db.all(sql, params).map(mapBlock);
  }

  getBlocks(workspaceId, options = {}) {
    return this.listBlocks(workspaceId, options);
  }

  _setBlockFlag(workspaceId, blockId, field, value, action) {
    const args = actionArgs(workspaceId, blockId);
    workspaceId = args.workspaceId;
    blockId = args.blockId;
    const workspace = this.getWorkspace(workspaceId);
    const block = this.getBlock(workspaceId, blockId);
    if (!workspace || !block) return null;
    const timestamp = this._now();
    const statusUpdate = field === 'pinned' ? ", status = CASE WHEN ? = 1 THEN 'pinned' WHEN status = 'pinned' THEN 'active' ELSE status END" : '';
    const params = field === 'pinned'
      ? [value ? 1 : 0, value ? 1 : 0, timestamp, timestamp, workspaceId, block.id]
      : [value ? 1 : 0, timestamp, timestamp, workspaceId, block.id];
    this.db.run(`UPDATE context_blocks SET ${field} = ?${statusUpdate}, updated_at = ?, accessed_at = ? WHERE workspace_id = ? AND id = ?`, ...params);
    const updated = this.getBlock(workspaceId, block.id);
    this._audit(action, { workspaceId, blockId: block.id }, workspace, 'context_block', block.id);
    return updated;
  }

  pin(workspaceId, blockId) { return this._setBlockFlag(workspaceId, blockId, 'pinned', true, 'context.block_pinned'); }
  unpin(workspaceId, blockId) {
    const args = actionArgs(workspaceId, blockId);
    const block = this.getBlock(args.workspaceId, args.blockId);
    if (block?.metadata?.permanentPinned) throw Object.assign(new Error('Initial goal, acceptance, and constraint blocks are permanently pinned'), { statusCode: 409, code: 'context_permanent_pin' });
    return this._setBlockFlag(args.workspaceId, args.blockId, 'pinned', false, 'context.block_unpinned');
  }
  pinBlock(workspaceId, blockId) { return this.pin(workspaceId, blockId); }
  unpinBlock(workspaceId, blockId) { return this.unpin(workspaceId, blockId); }

  archive(workspaceId, blockId) {
    const args = actionArgs(workspaceId, blockId);
    workspaceId = args.workspaceId;
    blockId = args.blockId;
    const workspace = this.getWorkspace(workspaceId);
    const block = this.getBlock(workspaceId, blockId);
    if (!workspace || !block) return null;
    if (block.metadata?.permanentPinned) throw Object.assign(new Error('Permanently pinned context blocks cannot be archived'), { statusCode: 409, code: 'context_permanent_pin' });
    const timestamp = this._now();
    this.db.run("UPDATE context_blocks SET archived = 1, visible = 0, status = 'archived', updated_at = ?, accessed_at = ? WHERE workspace_id = ? AND id = ?", timestamp, timestamp, workspaceId, block.id);
    const updated = this.getBlock(workspaceId, block.id);
    this._audit('context.block_archived', { workspaceId, blockId: block.id }, workspace, 'context_block', block.id);
    return updated;
  }

  recover(workspaceId, blockId) {
    const args = actionArgs(workspaceId, blockId);
    workspaceId = args.workspaceId;
    blockId = args.blockId;
    const workspace = this.getWorkspace(workspaceId);
    const block = this.getBlock(workspaceId, blockId);
    if (!workspace || !block) return null;
    if (block.archived) {
      const visibleTokens = Number(this.db.get('SELECT coalesce(sum(token_estimate), 0) AS tokens FROM context_blocks WHERE workspace_id = ? AND archived = 0 AND visible = 1', workspaceId)?.tokens || 0);
      const projected = this.pressure(workspaceId, { usedTokens: visibleTokens + block.tokenEstimate });
      if (projected.hardPreflight) {
        throw Object.assign(new Error('恢复该上下文块会触发 98% 硬预算门禁；请先归档其他块或使用范围读取'), {
          statusCode: 409,
          code: 'context_budget_exceeded',
          pressure: projected
        });
      }
    }
    const timestamp = this._now();
    this.db.run("UPDATE context_blocks SET archived = 0, visible = 1, status = CASE WHEN pinned = 1 THEN 'pinned' WHEN status = 'archived' THEN 'active' ELSE status END, updated_at = ?, accessed_at = ? WHERE workspace_id = ? AND id = ?", timestamp, timestamp, workspaceId, block.id);
    const updated = this.getBlock(workspaceId, block.id);
    this._audit('context.block_recovered', { workspaceId, blockId: block.id }, workspace, 'context_block', block.id);
    if (args.options?.withPayload || args.options?.restore || args.options?.range) return this.restoreBlock(workspaceId, block.id, args.options);
    return updated;
  }

  archiveBlock(workspaceId, blockId) { return this.archive(workspaceId, blockId); }
  recoverBlock(workspaceId, blockId) { return this.recover(workspaceId, blockId); }

  delete(workspaceId, blockId, options = {}) {
    const args = actionArgs(workspaceId, blockId, options);
    workspaceId = args.workspaceId;
    blockId = args.blockId;
    options = args.options;
    if (typeof options === 'boolean') options = { confirm: options };
    if (!(options?.confirm === true || options?.confirmPermanent === true || options?.permanent === true)) {
      throw new Error('Permanent block deletion requires confirm: true');
    }
    const workspace = this.getWorkspace(workspaceId);
    const block = this.getBlock(workspaceId, blockId);
    if (!workspace || !block) return false;
    this.db.run('DELETE FROM context_blocks WHERE workspace_id = ? AND id = ?', workspaceId, block.id);
    const remainingReferences = block.payloadHash
      ? Number(this.db.get('SELECT count(*) AS count FROM context_blocks WHERE payload_hash = ?', block.payloadHash)?.count || 0)
      : 0;
    if (block.payloadHash && remainingReferences === 0 && this.payloadStore?.removeSync) {
      try { this.payloadStore.removeSync(block.payloadHash); } catch { /* orphan cleanup is best effort */ }
    }
    this._audit('context.block_deleted', { workspaceId, blockId: block.id }, workspace, 'context_block', block.id);
    return true;
  }

  deleteBlock(workspaceId, blockId, options) { return this.delete(workspaceId, blockId, options); }

  restoreBlock(workspaceId, blockId, options = {}) {
    const args = actionArgs(workspaceId, blockId, options);
    workspaceId = args.workspaceId;
    blockId = args.blockId;
    options = args.options;
    const block = this.getBlock(workspaceId, blockId);
    if (!block) return null;
    let payload;
    if (block.payloadHash && this.payloadStore) {
      const hasRange = options.range !== undefined || options.start !== undefined || options.end !== undefined;
      const readOptions = options.range !== undefined ? { range: options.range } : hasRange ? { start: options.start, end: options.end } : {};
      if ((!hasRange && block.metadata?.payloadEncoding === 'json') || options.as === 'json') readOptions.as = 'json';
      if (typeof this.payloadStore.getSync === 'function') payload = this.payloadStore.getSync(block.payloadHash, readOptions);
      else if (typeof this.payloadStore.get === 'function') {
        payload = this.payloadStore.get(block.payloadHash, readOptions);
        if (payload?.then) throw new Error('Context workspace requires a synchronous payload store; use PayloadStore');
      }
      if (block.checksum && this.payloadStore.verifySync && !this.payloadStore.verifySync(block.payloadHash, block.checksum)) throw new Error(`Block ${block.id} payload checksum mismatch`);
    }
    const timestamp = this._now();
    this.db.run('UPDATE context_blocks SET accessed_at = ? WHERE workspace_id = ? AND id = ?', timestamp, workspaceId, block.id);
    return { ...block, payload };
  }

  assemble(workspaceId, options = {}) {
    if (workspaceId && typeof workspaceId === 'object') {
      options = workspaceId;
      workspaceId = workspaceIdFrom(workspaceId);
    }
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) return null;
    const blocks = this.listBlocks(workspaceId, {
      includeArchived: Boolean(options.includeArchived),
      visible: options.visible,
      pinned: options.pinnedOnly ? true : undefined
    });
    const assembledBlocks = options.loadPayloads || options.includePayloads
      ? blocks.map((block) => this.restoreBlock(workspaceId, block.id, options))
      : blocks;
    const pinned = assembledBlocks.filter((block) => block.pinned);
    const tokenEstimate = assembledBlocks.reduce((sum, block) => sum + block.tokenEstimate, 0);
    const pressure = this.pressure(workspaceId, { usedTokens: tokenEstimate });
    if (pressure.hardPreflight && options.allowOverBudget !== true) {
      throw Object.assign(new Error('模型输入已达到 98% 上下文硬门禁；当前只允许归档、范围读取与恢复管理'), {
        statusCode: 409,
        code: 'context_hard_preflight',
        pressure
      });
    }
    return { workspace, blocks: assembledBlocks, pinned, tokenEstimate, pressure };
  }

  shouldOffload(input = {}, maybeRoundTokens = undefined) {
    if (typeof input === 'number') return input >= SINGLE_RESULT_EXTERNALIZE || Number(maybeRoundTokens || 0) >= ROUND_EXTERNALIZE;
    return Number(input.resultTokens ?? input.resultTokenCount ?? input.singleResultTokens ?? input.tokenEstimate ?? input.tokens ?? 0) >= SINGLE_RESULT_EXTERNALIZE
      || Number(input.roundTokens ?? input.cumulativeRoundTokens ?? input.cumulativeTokens ?? 0) >= ROUND_EXTERNALIZE;
  }

  pressure(workspaceId, input = {}) {
    if (workspaceId && typeof workspaceId === 'object') {
      input = workspaceId;
      workspaceId = workspaceIdFrom(workspaceId);
    }
    const workspace = this.getWorkspace(workspaceId);
    const hasTokenInput = input.usedTokens !== undefined || input.currentTokens !== undefined || input.totalTokens !== undefined || input.tokens !== undefined;
    const inferredTokens = !hasTokenInput && workspace
      ? Number(this.db.get('SELECT coalesce(sum(token_estimate), 0) AS tokens FROM context_blocks WHERE workspace_id = ? AND archived = 0 AND visible = 1', workspace.id)?.tokens || 0)
      : 0;
    const usedTokens = Math.max(0, Number(hasTokenInput ? (input.usedTokens ?? input.currentTokens ?? input.totalTokens ?? input.tokens) : inferredTokens));
    const tokenLimit = Math.max(1, Number(input.tokenLimit || input.windowTokens || workspace?.tokenLimit || this.defaultTokenLimit));
    const ratio = usedTokens / tokenLimit;
    const thresholds = workspace?.pressureThresholds || this.thresholds;
    const noticeThreshold = thresholdRatio(thresholds.notice, DEFAULT_THRESHOLDS.notice);
    const manageThreshold = thresholdRatio(thresholds.manage, DEFAULT_THRESHOLDS.manage);
    const hardThreshold = thresholdRatio(thresholds.hardPreflight, DEFAULT_THRESHOLDS.hardPreflight);
    const level = ratio >= hardThreshold ? 'hard_preflight'
      : ratio >= manageThreshold ? 'manage'
        : ratio >= noticeThreshold ? 'notice' : 'normal';
    return {
      usedTokens,
      tokenLimit,
      ratio,
      percent: ratio * 100,
      level,
      mode: level,
      status: level,
      notice: ratio >= noticeThreshold,
      manage: ratio >= manageThreshold,
      hardPreflight: ratio >= hardThreshold,
      externalize: this.shouldOffload(input),
      offloadRequired: this.shouldOffload(input),
      thresholds: { ...thresholds, notice: noticeThreshold, manage: manageThreshold, hardPreflight: hardThreshold, singleResultTokens: SINGLE_RESULT_EXTERNALIZE, roundTokens: ROUND_EXTERNALIZE }
    };
  }

  getDashboard(workspaceId, options = {}) {
    if (workspaceId && typeof workspaceId === 'object') {
      options = workspaceId;
      workspaceId = workspaceIdFrom(workspaceId);
    }
    workspaceId = workspaceIdFrom(workspaceId);
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) return null;
    const all = this.listBlocks(workspaceId, { includeArchived: true });
    const visible = all.filter((block) => block.visible && !block.archived);
    const pinned = visible.filter((block) => block.pinned);
    const offloaded = all.filter((block) => block.offloaded);
    const tokenEstimate = visible.reduce((sum, block) => sum + block.tokenEstimate, 0);
    const pressureInput = (options.usedTokens !== undefined || options.currentTokens !== undefined || options.tokens !== undefined)
      ? options
      : { ...options, usedTokens: tokenEstimate };
    return {
      workspace,
      counts: { total: all.length, visible: visible.length, pinned: pinned.length, archived: all.filter((block) => block.archived).length, offloaded: offloaded.length },
      blocks: visible,
      pinned,
      recent: [...visible].sort((a, b) => String(b.accessedAt || b.updatedAt).localeCompare(String(a.accessedAt || a.updatedAt))).slice(0, 20),
      archived: all.filter((block) => block.archived),
      pressure: this.pressure(workspaceId, options.pressure || pressureInput),
      tokenEstimate
    };
  }

  dashboard(workspaceId, options) { return this.getDashboard(workspaceId, options); }
}

export function createContextWorkspace(options = {}) {
  return new ContextWorkspaceStore(options);
}

export function createContextWorkspaceService(options = {}) {
  return new ContextWorkspaceStore(options);
}

export const ContextWorkspaceService = ContextWorkspaceStore;
