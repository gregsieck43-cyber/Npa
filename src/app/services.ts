import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Command, Task } from '../contracts.js';
import { Kernel } from '../kernel/index.js';
import { PluginManager } from '../extensions/plugins.js';
import { CandidateManager } from '../adaptation/index.js';
import { buildContext } from '../runtime/context.js';
import { resolveProjectPath, isForbiddenRelative } from '../tools/policy.js';
import { Configuration } from './configuration.js';
import { Runner } from './runner.js';
import { WorkspacePresence, type PresencePublication } from './workspace-presence.js';
import { inspectEffects } from './verification.js';
import { loadInstructions } from '../runtime/instructions.js';
import { InstructionSettings } from '../runtime/instruction-settings.js';
import { ExternalTools, type WebConfiguration } from './external-tools.js';
import type { CrawlResult, SearchResponse, WebPage } from '../network/index.js';
import type { Harness } from '../harness/service.js';
import { workSources } from '../harness/work-trace.js';
import { IdeEditors } from '../ide/editors.js';
import { assertLocalPath } from './local-paths.js';
import { initializeDataDirectory, type DataDirectoryAccess } from './data-directory.js';
import { WorkspaceRoots, pathWithin } from './workspace-roots.js';
import { IntegrationService } from '../integrations/index.js';
import type { ProductApi } from '../product/api.js';
import { resourceBudget } from './resource-budget.js';
import type { ModelObserver } from '../runtime/model.js';
export class Services {
    harness?: Harness;
    product?: ProductApi;
    readonly kernel: Kernel;
    readonly configuration: Configuration;
    readonly plugins: PluginManager;
    readonly candidates: CandidateManager;
    readonly runner: Runner;
    readonly workspacePresence: WorkspacePresence;
    private readonly observedWorkspaces = new Set<string>();
    workspacePresenceIssue?: string;
    private presenceSync?: Promise<void>;
    readonly external: ExternalTools;
    readonly integrations: IntegrationService;
    readonly editors = new IdeEditors();
    readonly recovery;
    /** Persistent skill visibility shared by Settings, Chat and Work loaders. */
    readonly instructionSettings: InstructionSettings;
    private readonly sideRequests = new Map<string, AbortController>();
    /** Operator-initiated network reads are bounded, cancellable and removed in finally; they never enter the task ledger. */
    private readonly webRequests = new Set<{ controller: AbortController; settled: Promise<unknown> }>();
    private readonly workspaceRoots: WorkspaceRoots;
    constructor(readonly dataDir: string, readonly projectRoot: string, mockUrl: string, readonly productRoot = projectRoot,
        readonly dataDirectoryAccess: DataDirectoryAccess = initializeDataDirectory(dataDir)) {
        this.workspaceRoots = new WorkspaceRoots(dataDir);
        this.configuration = new Configuration(mockUrl, dataDir);
        this.plugins = new PluginManager(dataDir);
        this.candidates = new CandidateManager(dataDir);
        this.external = new ExternalTools({ dataDir, projectRoot });
        this.instructionSettings = new InstructionSettings({ dataDir });
        this.kernel = new Kernel(dataDir);
        this.workspacePresence = new WorkspacePresence(workspace => this.assertWorkspacePath(workspace));
        this.kernel.coordination.externalSnapshot = workspace => this.workspacePresence.snapshot(workspace);
        this.integrations = new IntegrationService({ dataDir: path.join(dataDir, 'integrations'), projectRoot, kernel: this.kernel,
            ...(existsSync(path.join(productRoot, 'resources', 'app', 'package.json')) ? { dependencyRoot: path.join(productRoot, 'resources', 'integrations', 'rea-6.4.0') } : {}) });
        this.runner = new Runner(this.kernel, this.configuration, this.candidates, dataDir, this.external, this.plugins, this.editors);
        this.runner.skillSettings = this.instructionSettings;
        this.runner.integrations = this.integrations.tools;
        this.runner.collaboration = this.integrations;
        this.runner.maintainPresence = async () => { try { await this.syncWorkspacePresence(); } catch (error) { this.workspacePresenceIssue = this.configuration.redact(String(error)); } };
        this.recovery = this.kernel.recover();
    }
    health() {
        return { status: 'ready', storage: 'ready', storageInfo: this.kernel.storageInfo(), dataDirectoryAccess: this.dataDirectoryAccess, provider: this.configuration.provider.mode, paidApiTested: false, twentyDayReliability: 'not tested', recovery: this.recovery, runtime: process.version, workspaceBoundary: this.projectRoot, productRoot: this.productRoot, resources: resourceBudget.status(), projection: this.harness?.store.getSetting('workTraceError', null) ?? null };
    }
    task(id: unknown): Task {
        const task = this.kernel.getTask(String(id));
        if (!task)
            throw new Error('Task not found.');
        return task;
    }
    instructions(taskId: string) {
        const task = this.task(taskId);
        const recentUser = this.kernel.tailMessages(task.id, 3, 'main', 'user');
        const targetPath = this.kernel.latestEvent(task.id, 'instruction.scope.loaded')?.payload.path as string | undefined;
        return loadInstructions({ workspace: task.workspace, targetPath, globalPaths: this.configuration.globalPaths, skillRoots: this.configuration.skillRoots, disabledSkillIds: this.instructionSettings.disabledSkillIds(), query: `${task.goal.objective}\n${recentUser.map(message => message.content).join('\n')}` });
    }
    config() {
        return { ...this.configuration.view(), ...this.external.webConfiguration() };
    }
    /** Registered project id -> absolute root; the product API reads it for project-scoped sends. */
    projectSourcePath(id: string, folder: string): string | undefined {
        const record = this.workspaceRoots.get(id);
        return record && (record.sourceFolders ?? [record.path]).find(p => path.relative(p, folder) === '');
    }
    projectPath(id: string): string | undefined {
        try { return this.workspaceRoots.resolve(id); }
        catch { return undefined; }
    }
    configure(input: Record<string, unknown>) {
        // Network switches and the proxy belong to ExternalTools; the HTTP layer must not store a
        // value that the actual transport will ignore, so every supported switch is forwarded.
        const network = {
            ...(typeof input.searchProvider === 'string' ? { searchProvider: input.searchProvider as WebConfiguration['searchProvider'] } : {}),
            ...(typeof input.searxUrl === 'string' ? { searxUrl: input.searxUrl } : {}),
            ...(typeof input.webSearch === 'boolean' ? { webSearch: input.webSearch } : {}),
            ...(typeof input.fetch === 'boolean' ? { fetch: input.fetch } : {}),
            ...(typeof input.proxy === 'string' ? { proxy: input.proxy } : {}),
            ...(input.network && typeof input.network === 'object' && !Array.isArray(input.network) ? { network: input.network as { webSearch?: boolean; fetch?: boolean; proxy?: string } } : {}),
        };
        if (Object.keys(network).length)
            this.external.configureWeb(network);
        this.configuration.set(input);
        this.product?.publishConnectionChanged();
        return this.config();
    }
    snapshot(taskId?: string, compact = false) {
        const tasks = this.kernel.recentTasks(100);
        const task = taskId ? this.task(taskId) : tasks.at(-1);
        return { tasks, selectedTask: task, ...(task ? this.kernel.presentation(task.id) : { messages: [], events: [], intents: [], runs: [], checkpoints: [], verifications: [], decisions: [], memories: [], nextCursor: null, totalMessages: 0 }),
            budget: task ? this.kernel.getBudgets(task.id) : undefined, sideBudgets: task ? this.kernel.getSideBudgets(task.id, 20) : [],
            sideSessions: task ? this.kernel.recentSideSessions(task.id) : [], delegations: task ? this.kernel.recentDelegations(task.id) : [],
            plugins: this.plugins.list(), candidates: this.candidates.list(task?.id), health: this.health(), compact, historyWindow: true };
    }
    assertProjectPath(value: string): string {
        const target = path.resolve(value);
        const relative = path.relative(this.projectRoot, target);
        if (relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('This installation permits project paths inside its own project only.');
        let cursor = this.projectRoot;
        for (const part of relative.split(path.sep).filter(Boolean)) {
            cursor = path.join(cursor, part);
            if (existsSync(cursor) && (lstatSync(cursor).isSymbolicLink() || !realpathSync(cursor).toLowerCase().startsWith(`${realpathSync(this.projectRoot).toLowerCase()}${path.sep}`)))
                throw new Error('Workspace junctions and symbolic links are not supported.');
        }
        return target;
    }
    assertWorkspacePath(value: string) { return this.workspacePath(value, true); }
    async observeWorkspace(workspace: string): Promise<void> {
        const allowed = this.assertWorkspacePath(workspace);
        if (this.observedWorkspaces.size < 64) this.observedWorkspaces.add(allowed);
        await this.syncWorkspacePresence();
    }
    private syncWorkspacePresence(): Promise<void> {
        if (!this.presenceSync) this.presenceSync = this.performPresenceSync().finally(() => { this.presenceSync = undefined; });
        return this.presenceSync;
    }
    private async performPresenceSync(): Promise<void> {
        const active = this.kernel.coordination.workspaces();
        const unique = new Map([...active.items, ...this.observedWorkspaces].map(workspace => [process.platform === 'win32' ? path.resolve(workspace).toLowerCase() : path.resolve(workspace), workspace] as const));
        const workspaces = [...unique.values()].slice(0, 64);
        const clean = (text: string, max: number) => text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);
        const publications: PresencePublication[] = workspaces.map(workspace => {
            const peers = this.kernel.coordination.presence(workspace, '', 8).items;
            return { workspace, label: 'NPN-Gamma', objective: peers.length ? '同工作区任务协作' : '只读工作区观察', participants: peers.map(peer => ({ label: clean(peer.title, 160) || 'Work', objective: clean(peer.objective, 240), status: peer.status })),
                claims: [...new Set(peers.flatMap(peer => peer.claims?.paths ?? []).map(target => path.relative(workspace, target).replaceAll('\\', '/')).filter(target => !!target && !target.startsWith('..') && target.length <= 240))].slice(0, 32) };
        });
        const result = await this.workspacePresence.sync(publications);
        this.workspacePresenceIssue = result.errors.length ? result.errors.map(error => error.code).join(', ') : active.truncated || unique.size > 64 ? '最多同步 64 个活跃工作区，部分工作区未发布外部在场。' : undefined;
        for (const change of result.changes) {
            for (const peer of change.joined) this.kernel.coordination.externalChanged(change.workspace, 'joined', peer);
            for (const peer of change.changed) this.kernel.coordination.externalChanged(change.workspace, 'changed', peer);
            for (const id of change.left) this.kernel.coordination.externalChanged(change.workspace, 'left', { id });
        }
    }
    workspacePath(value: string, requireAuthorization: boolean) {
        const target = path.resolve(value);
        assertLocalPath(target, 'Workspace');
        if (target === path.parse(target).root) throw new Error('Select a specific project folder, not a drive root.');
        if (isForbiddenRelative(path.basename(target)) || /(?:^|[\\/])(?:\.git|\.aws|\.codex|\.agents|node_modules)(?:[\\/]|$)/i.test(target)) throw new Error('Credential and protected runtime folders cannot be workspace roots.');
        if (requireAuthorization && !pathWithin(this.projectRoot, target) && !this.workspaceRoots.contains(target))
            throw new Error('This project is not authorized. 请通过 Code 的选择项目或 IDE 入口选择具体项目文件夹。');
        const containingData = path.relative(target, this.dataDir);
        const insideData = path.relative(this.dataDir, target);
        const namedWorkspace = /^workspaces[\\/][^\\/]+/.test(insideData);
        if ((!containingData.startsWith('..') && !path.isAbsolute(containingData)) || (!insideData.startsWith('..') && !path.isAbsolute(insideData) && !/^workspaces[\\/][^\\/]+/.test(insideData)))
            throw new Error('The running audit, approval and task data cannot be used as a mutable workspace.');
        const containingProduct = path.relative(target, this.productRoot);
        if (!containingProduct.startsWith('..') && !path.isAbsolute(containingProduct)) throw new Error('Choose a specific project folder that does not contain the running product.');
        const insideProduct = path.relative(this.productRoot, target);
        if (!namedWorkspace && !insideProduct.startsWith('..') && !path.isAbsolute(insideProduct) && /^(?:src|scripts|resources|node_modules|build|release|\.git|\.deps|\.tools|\.cache)(?:[\\/]|$)/i.test(insideProduct))
            throw new Error('The running product and its safety kernel cannot be used as a mutable task workspace.');
        return target;
    }
    command(input: Command) {
        input = this.configuration.sanitize(input);
        const command = { ...input, parameters: { ...input.parameters } };
        if (command.type === 'submit')
            command.type = 'create_task';
        if (command.parameters.workspace)
            command.parameters.workspace = this.assertWorkspacePath(String(command.parameters.workspace));
        if (command.type === 'send_message')
            command.parameters.content = this.configuration.redact(String(command.parameters.content ?? command.parameters.message ?? ''));
        const ack = this.kernel.command(command);
        if (ack.taskId) {
            mkdirSync(this.task(ack.taskId).workspace, { recursive: true });
            if (ack.status === 'accepted' && ['pause', 'retry', 'cancel', 'revoke', 'answer', 'revise_goal', 'renew_budget', 'set_permission', 'enter_plan'].includes(command.type)) {
                this.runner.interrupt(ack.taskId);
            }
            if (ack.status === 'accepted' && command.type === 'send_message' && (command.parameters.sessionId ?? 'main') === 'main') this.runner.interrupt(ack.taskId, false);
            if (command.type === 'approve_plan') this.integrations.activateApprovedPlan(ack.taskId);
        }
        return ack;
    }
    async sidechat(input: Record<string, unknown>) {
        const task = this.task(input.taskId), sessionId = String(input.sessionId ?? `side-${randomUUID()}`);
        if (sessionId === 'main')
            throw new Error('Side chat requires a separate session.');
        const requestKey = `${task.id}:${sessionId}`;
        if (this.sideRequests.has(requestKey)) throw new Error('This side session already has an active answer.');
        const controller = new AbortController();
        this.sideRequests.set(requestKey, controller);
        try {
            this.kernel.addMessage(task.id, 'user', this.configuration.redact(String(input.message ?? '')), sessionId);
            return await resourceBudget.withLease(controller.signal, async () => {
                const instructions = await loadInstructions({ workspace: task.workspace, globalPaths: this.configuration.globalPaths, skillRoots: this.configuration.skillRoots, disabledSkillIds: this.instructionSettings.disabledSkillIds(), query: `${task.goal.objective}\n${String(input.message ?? '')}` });
                const messages = this.kernel.tailMessages(task.id, 160, sessionId);
                const runtimeMessages = [{ role: 'user' as const, content: `Read-only main task snapshot: ${JSON.stringify({ id: task.id, revision: task.revision, status: task.status, waitingReason: task.waitingReason, recentMainMessages: this.kernel.tailMessages(task.id, 8).map(message => ({ role: message.role, content: message.content.slice(0, 1600) })) })}` }];
                const context = buildContext({ messages, archivedCount: this.kernel.messageCount(task.id, sessionId) - messages.length,
                    memory: this.kernel.memory(task.id, sessionId).context(String(input.message ?? '')), beforeHistoryMessages: runtimeMessages, goal: task.goal, role: 'side', instructions });
                const requestId = `side-${randomUUID()}`;
                const standalone: ModelObserver | undefined = this.configuration.modelObserver ? undefined : {
                    prepare: body => ({ body, requestId }),
                    dispatching: () => this.kernel.sideRequests.dispatch(requestId, task.id, sessionId),
                    responseObserved: () => this.kernel.sideRequests.settle(requestId, 'response_observed'),
                    completed: result => this.kernel.sideRequests.settle(requestId, 'completed', result.usage),
                    failed: () => this.kernel.sideRequests.settle(requestId, controller.signal.aborted ? 'cancelled' : 'failed'),
                };
                const result = await this.configuration.client({ sessionId: `${task.id}:${sessionId}`, sideBudgetSessionId: sessionId, taskId: task.id, kind: 'side', sources: workSources(context, instructions) }, {}, standalone).complete(context.messages, [], controller.signal);
                const content = this.configuration.redact(result.content);
                this.kernel.addMessage(task.id, 'assistant', content, sessionId);
                return { sessionId, content, messages: this.kernel.tailMessages(task.id, 160, sessionId) };
            });
        } catch (error) {
            this.kernel.appendEvent(task.id, 'side.diagnostic', { sessionId, cancelled: controller.signal.aborted, message: this.configuration.redact(error instanceof Error ? error.message : String(error)) });
            throw error;
        } finally { this.sideRequests.delete(requestKey); }
    }
    cancelSidechat(input: Record<string, unknown>) {
        const task = this.task(input.taskId), sessionId = String(input.sessionId ?? '');
        if (!sessionId || sessionId === 'main') throw new Error('Select the separate side session to stop.');
        const controller = this.sideRequests.get(`${task.id}:${sessionId}`);
        controller?.abort();
        return { taskId: task.id, sessionId, cancelled: Boolean(controller) };
    }
    async openWorkspace(value: string) {
        if (!value || !path.isAbsolute(value)) throw new Error('Select an explicit absolute project folder.');
        const workspace = this.workspacePath(value, false);
        if (!(await stat(workspace)).isDirectory()) throw new Error('Workspace must be an existing directory.');
        const canonical = realpathSync(workspace);
        this.workspacePath(canonical, false);
        this.workspaceRoots.add(canonical);
        return this.ideWorkspace(canonical);
    }
    async ideWorkspace(value: string) {
        if (!value || !path.isAbsolute(value)) throw new Error('Select an explicit absolute IDE workspace.');
        const workspace = this.assertWorkspacePath(value);
        if (!(await stat(workspace)).isDirectory()) throw new Error('IDE workspace must be an existing directory.');
        return { id: this.workspaceRoots.list().find(r => r.path.toLowerCase() === workspace.toLowerCase())?.id ?? createHash('sha256').update(workspace.toLowerCase()).digest('hex').slice(0, 24), path: workspace };
    }
    async files(input: URLSearchParams) {
        const task = this.task(input.get('taskId'));
        const requested = input.get('path') ?? '.';
        const allowMissing = input.get('allowMissing') === 'true';
        const full = await resolveProjectPath(task.workspace, requested, allowMissing);
        const entries = await readdir(full, { withFileTypes: true }).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOTDIR' || (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT'))
                return undefined;
            throw error;
        });
        if (!entries) {
            const info = await stat(full).catch(error => { if (allowMissing && error.code === 'ENOENT') return undefined; throw error; });
            if (!info) return { path: requested, exists: false, content: '' };
            if (info.size > 1048576) throw new Error('Editor reads are limited to 1 MiB per file.');
            const bytes = await readFile(full);
            if (bytes.includes(0)) throw new Error('Binary files are not editable as UTF-8 text.');
            try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('This file is not valid UTF-8 text.'); }
            return { path: requested, exists: true, content: bytes.toString('utf8') };
        }
        return { path: requested, entries: entries.filter(entry => !entry.isSymbolicLink() && !isForbiddenRelative(path.posix.join(requested, entry.name))).map(entry => ({ name: entry.name, path: path.posix.join(requested.replaceAll('\\', '/'), entry.name), type: entry.isDirectory() ? 'directory' : 'file' })) };
    }
    async fileSearch(input: URLSearchParams) {
        const task = this.task(input.get('taskId')), query = (input.get('q') ?? '').trim().toLowerCase();
        if (!query || query.length > 200) throw new Error('Search needs between 1 and 200 characters.');
        const matches: { path: string; line: number; text: string }[] = [];
        let visited = 0, truncated = false;
        const visit = async (directory: string, depth: number): Promise<void> => {
            if (depth > 8 || visited >= 500 || matches.length >= 100) { truncated = true; return; }
            const full = await resolveProjectPath(task.workspace, directory || '.');
            for (const entry of await readdir(full, { withFileTypes: true })) {
                const relative = path.posix.join(directory, entry.name);
                if (entry.isSymbolicLink() || isForbiddenRelative(relative)) continue;
                if (++visited > 500 || matches.length >= 100) { truncated = true; break; }
                if (entry.isDirectory()) { await visit(relative, depth + 1); continue; }
                if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?|json|md|txt|css|html|py|rs|go|cs|ya?ml|toml)$/i.test(entry.name)) continue;
                const filename = await resolveProjectPath(task.workspace, relative);
                if ((await stat(filename)).size > 262144) { truncated = true; continue; }
                const contents = await readFile(filename, 'utf8');
                contents.split(/\r?\n/).some((line, index) => { if (line.toLowerCase().includes(query)) matches.push({ path: relative, line: index + 1, text: line.trim().slice(0, 180) }); return matches.length >= 100; });
            }
        };
        await visit('', 0); return { matches, truncated, visited, query };
    }
    async proposeTool(input: Record<string, unknown>, name: string) {
        const task = this.task(input.taskId);
        const parameters = name === 'write_file' ? { path: String(input.path), content: String(input.content) } : name === 'mcp_call' ? { serverId: input.id ?? input.serverId, toolName: input.name ?? input.toolName, arguments: input.arguments ?? {} } : name === 'run_shell' ? { command: String(input.command), timeoutMs: Number(input.timeoutMs ?? 120000) } : input.args ? { executable: 'node', args: input.args } : { command: String(input.command) };
        const requestId = String(input.requestId ?? randomUUID());
        this.command({ commandId: requestId, type: 'propose_tool', taskId: task.id, parameters: { name, arguments: parameters } });
        const proposal = this.kernel.commandEvent(task.id, 'tool.proposal_owned', requestId);
        return { status: 'queued', taskId: task.id, requestId, toolCallId: proposal?.payload.toolCallId, message: 'Exact tool approval will appear in the task.' };
    }
    async web(action: string, input: Record<string, unknown>, signal?: AbortSignal) {
        input = this.configuration.sanitize(input);
        if (action === 'search')
            return this.operatorSearch(input.query, signal);
        if (action === 'fetch')
            return this.operatorFetch(input.url, signal);
        if (action === 'crawl')
            return this.operatorCrawl(input, signal);
        throw new Error('Unknown web operation.');
    }

    /**
     * Manual operator browsing. The explicit request is executed directly: no Agent task, run,
     * intent, approval, model request or receipt is created for it. The caller's signal is
     * combined with the registry controller so shutdown can abort and await these operations.
     */
    operatorSearch(query: unknown, signal?: AbortSignal): Promise<SearchResponse> {
        return this.operatorNetwork(inner => this.external.operatorWeb('search', { query: String(query ?? '') }, inner), signal);
    }

    operatorFetch(url: unknown, signal?: AbortSignal): Promise<WebPage> {
        return this.operatorNetwork(inner => this.external.operatorWeb('fetch', { url: String(url ?? '') }, inner), signal);
    }

    operatorCrawl(input: Record<string, unknown>, signal?: AbortSignal): Promise<CrawlResult> {
        const args: { url: string; maxPages?: number; maxDepth?: number } = { url: String(input.url ?? '') };
        if (typeof input.maxPages === 'number')
            args.maxPages = input.maxPages;
        if (typeof input.maxDepth === 'number')
            args.maxDepth = input.maxDepth;
        return this.operatorNetwork(inner => this.external.operatorWeb('crawl', args, inner), signal);
    }

    private operatorNetwork<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
        const controller = new AbortController();
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const entry: { controller: AbortController; settled: Promise<unknown> } = { controller, settled: Promise.resolve() };
        const settled = run(combined);
        // Track a settled copy so shutdown never observes an unhandled rejection or a dangling entry.
        entry.settled = settled.catch(() => undefined);
        this.webRequests.add(entry);
        return settled.finally(() => { this.webRequests.delete(entry); });
    }

    async stop() {
        // Manual browsing has no kernel owner; abort it first and let the transport settle before
        // any other subsystem closes, but never block shutdown on a stuck socket.
        const manual = [...this.webRequests];
        for (const entry of manual)
            entry.controller.abort();
        if (manual.length)
            await Promise.race([Promise.allSettled(manual.map(entry => entry.settled)), new Promise<void>(resolve => { setTimeout(resolve, 3000).unref(); })]);
        await this.harness?.stop();
        // A request accepted while shutdown began is still aborted, not left dangling.
        const late = [...this.webRequests];
        for (const entry of late)
            entry.controller.abort();
        if (late.length)
            await Promise.race([Promise.allSettled(late.map(entry => entry.settled)), new Promise<void>(resolve => { setTimeout(resolve, 1000).unref(); })]);
        for (const controller of this.sideRequests.values()) controller.abort();
        const deadline = Date.now() + 2000;
        while (this.sideRequests.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        await this.runner.stop();
        try { await this.presenceSync; }
        catch (error) { this.workspacePresenceIssue = this.configuration.redact(`External presence synchronization failed during shutdown: ${String(error)}`); }
        try { await this.workspacePresence.close(); }
        catch (error) { this.workspacePresenceIssue = this.configuration.redact(`External presence cleanup incomplete; retained files expire naturally. ${String(error)}`); }
    }
    async acceptResult(input: Record<string, unknown>, signal?: AbortSignal) {
        return resourceBudget.withLease(signal, async () => {
            const task = this.task(input.taskId);
            if (task.status !== 'waiting_input' || task.revision !== input.expectedRevision)
                throw new Error('Result changed or task is not awaiting acceptance. Refresh before accepting.');
            if (input.accepted !== true) {
                this.kernel.appendEvent(task.id, 'verification.operator_rejected', { evidence: String(input.evidence ?? '') });
                return { accepted: false };
            }
            const result = this.kernel.latestAssistantResult(task.id)?.content;
            if (!result)
                throw new Error('No proposed result exists to accept.');
            const evidence = await inspectEffects(task, {
                page: (after, limit) => this.kernel.intentPage(task.id, after, limit),
                isLatestWrite: intent => this.kernel.isLatestAppliedWrite(task.id, intent.id, String(intent.arguments.path)),
                relatedPage: (after, limit) => this.kernel.delegationReviewPage(task.id, after, limit),
            }, this.runner.gateway(task), this.external, path.join(this.dataDir, 'artifacts'), this.integrations.tools, signal);
            const hardFindings = evidence.findings.filter(finding => !finding.startsWith('Manual acceptance needed') && !finding.startsWith('No independently observed output'));
            if (evidence.hardFindingCount)
                throw new Error(hardFindings.join('; ') || `${evidence.hardFindingCount} verification failures; read the persisted evidence for details.`);
            const run = this.kernel.currentRunningRun(task.id);
            if (!run)
                throw new Error('Current result has no active run provenance.');
            this.kernel.verify(task.id, run.id, { passed: true, reviewer: 'local-operator', expectedRevision: task.revision, evidence, humanEvidence: this.configuration.redact(String(input.evidence ?? 'Explicitly accepted current result.')) });
            this.kernel.transition(task.id, 'completed', { result });
            this.kernel.finishRun(run.id, 'completed');
            return { accepted: true, taskId: task.id };
        });
    }
    async plugin(action: string, input: Record<string, unknown>) {
        const id = String(input.id ?? input.pluginId ?? '');
        switch (action) {
            case 'install': return this.plugins.install(this.assertProjectPath(String(input.path ?? input.sourceDir)), (input.configuration ?? input.config) as Record<string, unknown> | undefined);
            case 'configure': return this.plugins.configure(id, (input.configuration ?? input.config) as Record<string, unknown>);
            case 'approve': return this.plugins.approve(id, String(input.digest));
            case 'enable': return this.plugins.enable(id);
            case 'disable': return this.plugins.disable(id);
            case 'remove':
                this.plugins.remove(id);
                return { removed: true, id };
            case 'execute': return this.plugins.execute(id, String(input.operation ?? 'format'), String(input.input ?? ''));
            default: throw new Error('Unknown plugin action.');
        }
    }
    candidate(action: string, input: Record<string, unknown>) {
        input = this.configuration.sanitize(input);
        const id = String(input.id ?? input.candidateId ?? '');
        switch (action) {
            case 'create':
                this.task(input.taskId);
                return this.candidates.create(input as any);
            case 'test': return this.candidates.testAsync(id);
            case 'approve': return this.candidates.approve(id, { artifactDigest: String(input.artifactDigest ?? input.digest), taskId: String(input.taskId), expectedVersion: Number(input.expectedVersion ?? 0), capabilityDiff: input.capabilityDiff as string[] ?? [], principal: 'local-operator' });
            case 'activate': {
                const candidate = this.candidates.get(id);
                if (['running', 'queued', 'waiting_approval', 'reconciling'].includes(this.task(candidate.taskId).status))
                    throw new Error('Pause the task before activating its adaptation.');
                return this.candidates.activate(id, { taskStatus: this.task(candidate.taskId).status });
            }
            case 'rollback': {
                if (['running', 'queued', 'waiting_approval', 'reconciling'].includes(this.task(input.taskId).status))
                    throw new Error('Pause the task before rolling back its adaptation.');
                return this.candidates.rollback(String(input.taskId), input.expectedVersion === undefined ? undefined : Number(input.expectedVersion));
            }
            default: throw new Error('Unknown candidate action.');
        }
    }
}
