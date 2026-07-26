import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import type { Model } from "@oh-my-pi/pi-ai";
import { escapeXmlText, isBunTestRuntime, isEnoent, logger, prompt, stringifyJson } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import projectDocumentsTemplate from "../prompts/context-manager/project-documents.md" with { type: "text" };
import type { SessionManager } from "../session/session-manager";
import { enforceInlineByteCap } from "../session/streaming-output";
import type { ContextAgentRunner } from "./agent-runner";
import { planAutomaticCleanup, shouldScheduleAutomaticCleanup } from "./automatic-cleanup";
import { ContextDreamer } from "./dreamer";
import type { ContextDreamTaskName } from "./dreamer-registry";
import { ContextDreamTaskExecutor } from "./dreamer-tasks";
import { applyContextDrops } from "./drop-materialization";
import { HistorianCoordinator } from "./historian";
import { injectTieredHistory, renderTieredHistory } from "./history";
import { decideContextMaterialization, resolveContextCachePolicy } from "./materialization-policy";
import { type ContextMemoryAdapter, latestContextMemoryQuery, renderContextMemory } from "./memory";
import { getContextMessageRef, MessageIdentityManager } from "./message-identity";
import { OnWireTokenCounter } from "./on-wire-stats";
import { resolveContextProjectIdentity } from "./project";
import { buildReductionUnits, planReductionTargets } from "./reduction-units";
import { ContextSearchService, injectAutoSearchHint } from "./search";
import { ContextSidekick } from "./sidekick";
import { ContextStore } from "./storage";
import type {
	ContextDreamerStatus,
	ContextDreamRunResult,
	ContextEmbeddingStatus,
	ContextExpandResult,
	ContextFlushResult,
	ContextHistorianRunResult,
	ContextManagerDiagnostics,
	ContextManagerMode,
	ContextManagerStatus,
	ContextNoteInput,
	ContextNoteOperation,
	ContextNoteRecord,
	ContextNoteResult,
	ContextPromptAugmentResult,
	ContextReduceResult,
	ContextSearchOptions,
	ContextSearchResult,
	ContextSessionRecord,
	ContextSessionRuntimeRecord,
	ContextStatusLineState,
	SessionContextManager,
} from "./types";

const MANAGED_DOC_MAX_BYTES = 16 * 1024;
const MANAGED_DOC_CACHE_TTL_MS = 5_000;
const MANAGED_DOC_NAMES = ["ARCHITECTURE.md", "STRUCTURE.md"] as const;

const USER_PROFILE_MEMORY_TYPES = new Set(["preference", "instruction", "relationship"]);

function normalizePromotableFact(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}
export interface ContextManagerControllerOptions {
	readonly mode: ContextManagerMode;
	readonly settings: Settings;
	readonly sessionManager: SessionManager;
	readonly storePath?: string | ":memory:";
}

/** Session-scoped facade that owns derived context state and fails open to legacy compaction. */
export class ContextManagerController implements SessionContextManager {
	readonly mode: ContextManagerMode;
	readonly #settings: Settings;
	readonly #sessionManager: SessionManager;
	#store: ContextStore | undefined;
	#identity: MessageIdentityManager | undefined;
	readonly #onWireTokenCounter = new OnWireTokenCounter();
	#historian: HistorianCoordinator | undefined;
	#dreamer: ContextDreamer | undefined;
	#sidekick: ContextSidekick | undefined;
	#agentRunner: ContextAgentRunner | undefined;
	readonly #maintenanceOwnerId = `ctx:${process.pid}:${Bun.randomUUIDv7()}`;
	#noticeSink: (level: "info" | "warning", message: string) => void = () => {};
	#search: ContextSearchService | undefined;
	#active = false;
	#disposing = false;
	#failure: string | undefined;
	#legacyFallbackRequired = false;
	#warningEmitted = false;
	#boundCwd: string | undefined;
	#boundProjectId: string | undefined;
	#boundSessionId: string | undefined;
	#boundSessionFile: string | undefined;
	#bindingKey: string | undefined;
	#memoryAdapter: ContextMemoryAdapter | undefined;
	#memoryBlock: string | undefined;
	#lastMemoryQuery: string | undefined;
	#loadedMemoryQuery: string | undefined;
	#statusLineStateCache:
		| { readonly expiresAt: number; readonly value: ContextStatusLineState | undefined }
		| undefined;
	#docsCache: { readonly cwd: string; readonly expiresAt: number; readonly block: string | undefined } | undefined;

	private constructor(options: ContextManagerControllerOptions) {
		this.mode = options.mode;
		this.#settings = options.settings;
		this.#sessionManager = options.sessionManager;
	}

	static async create(options: ContextManagerControllerOptions): Promise<ContextManagerController> {
		const controller = new ContextManagerController(options);
		const requested =
			options.mode === "primary" &&
			options.settings.get("contextManager.enabled") &&
			options.settings.get("compaction.strategy") === "managed" &&
			(options.storePath !== undefined || !isBunTestRuntime());
		if (!requested) return controller;

		try {
			controller.#store = await ContextStore.open({
				path: options.storePath,
				cacheSizeMb: options.settings.get("contextManager.sqlite.cacheSizeMb"),
				mmapSizeMb: options.settings.get("contextManager.sqlite.mmapSizeMb"),
			});
			controller.#identity = new MessageIdentityManager(controller.#store, options.sessionManager);
			controller.#historian = new HistorianCoordinator({
				settings: options.settings,
				store: controller.#store,
				sessionManager: options.sessionManager,
			});
			controller.#search = new ContextSearchService({
				settings: options.settings,
				store: controller.#store,
			});
			controller.#active = true;
			await controller.rebind();
		} catch (error) {
			controller.#disable(error);
		}
		return controller;
	}

	get active(): boolean {
		return this.#active;
	}

	get store(): ContextStore | undefined {
		return this.#store;
	}

	setAgentRunner(runner: ContextAgentRunner): void {
		this.#historian?.setRunner(runner);
		if (this.#agentRunner === runner) return;
		this.#agentRunner = runner;
		const previousDreamer = this.#dreamer;
		previousDreamer?.beginDispose();
		if (previousDreamer) void previousDreamer.dispose(1_000);
		this.#dreamer = undefined;
		this.#sidekick = undefined;
		const store = this.#store;
		if (!this.#active || !store || this.#disposing) return;
		const executor = new ContextDreamTaskExecutor({
			store,
			settings: this.#settings,
			runner,
			sessionManager: this.#sessionManager,
			getMemoryAdapter: () => this.#memoryAdapter,
			getProjectId: () => this.#boundProjectId,
			getSessionId: () => this.#boundSessionId,
			getCwd: () => this.#sessionManager.getCwd(),
		});
		this.#dreamer = new ContextDreamer({
			store,
			settings: this.#settings,
			executor,
			sessionManager: this.#sessionManager,
			getMemoryAdapter: () => this.#memoryAdapter,
			ownerId: this.#maintenanceOwnerId,
			getProjectId: () => this.#boundProjectId,
			getSessionId: () => this.#boundSessionId,
			getCwd: () => this.#sessionManager.getCwd(),
			notify: (level, message) => this.#noticeSink(level, message),
		});
		this.#sidekick = new ContextSidekick(this.#settings, runner);
	}

	setNoticeSink(sink: (level: "info" | "warning", message: string) => void): void {
		this.#noticeSink = sink;
	}

	startBackgroundMaintenance(): void {
		this.#dreamer?.start();
	}

	setMemoryAdapter(adapter: ContextMemoryAdapter | undefined): void {
		this.#memoryAdapter = adapter;
		this.#memoryBlock = undefined;
		this.#loadedMemoryQuery = undefined;
		this.#search?.setMemoryAdapter(adapter);
	}

	#setMemoryQuery(query: string | undefined): void {
		const normalized = query?.trim() || undefined;
		if (normalized === this.#lastMemoryQuery) return;
		this.#lastMemoryQuery = normalized;
		this.#memoryBlock = undefined;
		this.#loadedMemoryQuery = undefined;
	}

	getMemoryAdapter(): ContextMemoryAdapter | undefined {
		return this.#memoryAdapter;
	}
	async runDreamTasks(
		tasks: readonly ContextDreamTaskName[],
		options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
	): Promise<readonly ContextDreamRunResult[]> {
		await this.rebind();
		const dreamer = this.#dreamer;
		if (!this.#active || !dreamer) {
			return tasks.map(task => ({
				task,
				status: "skipped",
				changed: 0,
				summary: `${task}: managed context unavailable`,
			}));
		}
		return dreamer.runNow(tasks, options);
	}

	dreamerStatus(): ContextDreamerStatus {
		return (
			this.#dreamer?.status() ?? {
				active: false,
				running: [],
				scheduleSummary: "disabled",
				recentJobs: [],
			}
		);
	}

	async augmentPrompt(userPrompt: string, signal?: AbortSignal): Promise<ContextPromptAugmentResult> {
		await this.rebind();
		const sidekick = this.#sidekick;
		if (!this.#active || !sidekick) {
			return {
				status: this.#settings.get("contextManager.sidekick.enabled") ? "failed" : "disabled",
				prompt: userPrompt,
				...(this.#settings.get("contextManager.sidekick.enabled")
					? { warning: "Managed-context sidekick is unavailable" }
					: {}),
			};
		}
		return sidekick.augment(userPrompt, signal);
	}

	async searchContext(query: string, options: ContextSearchOptions = {}): Promise<ContextSearchResult> {
		await this.rebind();
		const search = this.#search;
		if (!this.#active || !search) {
			return {
				query,
				hits: [],
				unavailableSources: options.sources ?? ["memory", "session_fact", "compartment", "note", "git_commit"],
				generation: 0,
			};
		}
		return search.search(query, { ...options, sessionId: options.sessionId ?? this.#boundSessionId });
	}

	embeddingStatus(): ContextEmbeddingStatus {
		return (
			this.#search?.embeddingStatus() ?? {
				state: "unavailable",
				pending: 0,
				completed: 0,
				progress: 0,
			}
		);
	}

	startEmbedding(signal?: AbortSignal): Promise<ContextEmbeddingStatus> {
		return this.#search?.startEmbeddingDrain(signal) ?? Promise.resolve(this.embeddingStatus());
	}

	pauseEmbedding(): ContextEmbeddingStatus {
		return this.#search?.pauseEmbedding() ?? this.embeddingStatus();
	}

	async diagnostics(): Promise<ContextManagerDiagnostics> {
		await this.rebind();
		const adapter = this.#memoryAdapter;
		const embedding = this.embeddingStatus();
		const memory = {
			enabled: this.#settings.get("memory.backend") === "mnemopi",
			available: adapter?.available === true,
			autoRecall: adapter?.autoRecall === true,
			...(adapter?.projectBank ? { projectBank: adapter.projectBank } : {}),
			...(adapter?.userBank ? { userBank: adapter.userBank } : {}),
		};
		const empty = (errors: readonly string[]): ContextManagerDiagnostics => ({
			status: this.status(),
			tags: { total: 0, active: 0, superseded: 0, dropped: 0, protected: 0 },
			drops: { queued: 0, active: 0, superseded: 0 },
			compartments: { total: 0, p1Tokens: 0, p2Tokens: 0, p3Tokens: 0, budgetTokens: 0 },
			facts: 0,
			notes: 0,
			historian: { running: false, pendingPublication: false },
			embedding,
			dreamer: this.dreamerStatus(),
			jobs: [],
			memory,
			errors,
		});
		const store = this.#store;
		const projectId = this.#boundProjectId;
		const sessionId = this.#boundSessionId;
		if (!this.#active || !store || !projectId || !sessionId) {
			return empty(this.#failure ? [this.#failure] : []);
		}
		try {
			const session = store.getSession(sessionId);
			if (!session) return empty([`Context session ${sessionId} is unavailable`]);
			const visibleEntryIds = new Set(this.#sessionManager.getBranch().map(entry => entry.id));
			const tags = store.listMessageTags(sessionId);
			const currentTags = tags.filter(tag => tag.supersededAt === undefined);
			const drops = store.listDrops(sessionId, session.activeGeneration);
			const activeDrops = store.listActiveDrops(sessionId, session.activeGeneration, visibleEntryIds);
			const droppedOrdinals = new Set(
				activeDrops.filter(drop => drop.replacementText === undefined).flatMap(drop => drop.expandedTags),
			);
			const protectedOrdinals = new Set(
				currentTags.slice(-this.#settings.get("contextManager.protectedTags")).map(tag => tag.tagOrdinal),
			);
			const compartments = store.listActiveCompartments(sessionId, session.activeGeneration, visibleEntryIds);
			const runtime = store.getSessionRuntime(sessionId);
			const jobs = store.listJobs(projectId).slice(-20);
			const errors = [
				this.#failure,
				embedding.error,
				...jobs.filter(job => job.status === "failed").map(job => job.lastError),
			].filter((error): error is string => Boolean(error));
			return {
				status: this.status(),
				store: store.diagnostics(),
				...(runtime ? { runtime } : {}),
				tags: {
					total: tags.length,
					active: currentTags.filter(tag => !droppedOrdinals.has(tag.tagOrdinal)).length,
					superseded: tags.length - currentTags.length,
					dropped: droppedOrdinals.size,
					protected: currentTags.filter(
						tag => protectedOrdinals.has(tag.tagOrdinal) && !droppedOrdinals.has(tag.tagOrdinal),
					).length,
				},
				drops: {
					queued: drops.filter(drop => drop.status === "queued").length,
					active: drops.filter(drop => drop.status === "active").length,
					superseded: drops.filter(drop => drop.status === "superseded").length,
				},
				compartments: {
					total: compartments.length,
					p1Tokens: compartments.reduce((sum, compartment) => sum + compartment.p1Tokens, 0),
					p2Tokens: compartments.reduce((sum, compartment) => sum + compartment.p2Tokens, 0),
					p3Tokens: compartments.reduce((sum, compartment) => sum + compartment.p3Tokens, 0),
					budgetTokens: Math.floor(
						(runtime?.executeThresholdTokens ?? 0) * this.#settings.get("contextManager.historyBudgetPercent"),
					),
				},
				facts: store.listSessionFacts(sessionId, session.activeGeneration).length,
				notes: store.listNotes(projectId, sessionId).filter(note => note.status === "active").length,
				historian: {
					running: this.#historian?.running(sessionId) === true,
					pendingPublication: store.hasPendingHistorianPublication(sessionId, session.activeGeneration),
				},
				embedding,
				dreamer: this.dreamerStatus(),
				jobs,
				memory,
				errors: [...new Set(errors)],
			};
		} catch (error) {
			this.#disable(error);
			return empty([error instanceof Error ? error.message : String(error)]);
		}
	}
	statusLineState(): ContextStatusLineState | undefined {
		if (!this.#active) return this.#failure ? "error" : undefined;
		const now = Date.now();
		if (this.#statusLineStateCache && this.#statusLineStateCache.expiresAt > now) {
			return this.#statusLineStateCache.value;
		}
		let value: ContextStatusLineState | undefined;
		try {
			const store = this.#store;
			const sessionId = this.#boundSessionId;
			const projectId = this.#boundProjectId;
			if (this.#failure || this.#legacyFallbackRequired) {
				value = "error";
			} else if (sessionId && this.#historian?.running(sessionId)) {
				value = "historian";
			} else if (store && sessionId && projectId) {
				const runtime = store.getSessionRuntime(sessionId);
				const session = store.getSession(sessionId);
				const jobs = store.listJobs(projectId).slice(-20);
				const hasRecentFailure = jobs.some(job => job.status === "failed" && now - job.updatedAt <= 5 * 60 * 1000);
				if (this.embeddingStatus().state === "failed" || hasRecentFailure) {
					value = "error";
				} else if (
					runtime?.pendingSince !== undefined ||
					jobs.some(job => job.status === "running") ||
					(session !== undefined && store.hasPendingHistorianPublication(sessionId, session.activeGeneration))
				) {
					value = "pending";
				}
			}
		} catch {
			value = "error";
		}
		this.#statusLineStateCache = { expiresAt: now + 1_000, value };
		return value;
	}

	async indexGit(signal?: AbortSignal): Promise<number> {
		await this.rebind();
		return (await this.#search?.indexGit(signal)) ?? 0;
	}

	async manageNote(operation: ContextNoteOperation): Promise<ContextNoteResult> {
		await this.rebind();
		const store = this.#store;
		const projectId = this.#boundProjectId;
		const sessionId = this.#boundSessionId;
		if (!this.#active || !store || !projectId || !sessionId) {
			return { action: operation.action, status: "unavailable", notes: [] };
		}

		try {
			const notes = store.listNotes(projectId, sessionId);
			const visibleNotes = (): ContextNoteRecord[] =>
				notes
					.filter(note => operation.id === undefined || note.id === operation.id)
					.filter(note => operation.category === undefined || note.category === operation.category)
					.filter(note => operation.scope === undefined || note.scope === operation.scope)
					.filter(note => operation.status === undefined || note.status === operation.status);

			if (operation.action === "read" || operation.action === "filter") {
				return { action: operation.action, status: "ok", notes: visibleNotes() };
			}

			if (operation.action === "write") {
				if (!operation.category?.trim() || !operation.content?.trim()) {
					throw new Error("ctx_note write requires non-empty category and content");
				}
				const scope = operation.scope ?? "session";
				const input: ContextNoteInput = {
					projectId,
					scope,
					category: operation.category.trim(),
					content: operation.content.trim(),
					status: operation.status ?? "active",
					...(scope === "session" ? { sessionId } : {}),
					...(operation.surfaceCondition?.trim() ? { surfaceCondition: operation.surfaceCondition.trim() } : {}),
				};
				return { action: operation.action, status: "ok", notes: [store.upsertNote(input)] };
			}

			if (!operation.id) throw new Error(`ctx_note ${operation.action} requires id`);
			const existing = notes.find(note => note.id === operation.id);
			if (!existing) return { action: operation.action, status: "not_found", notes: [] };
			if (
				operation.action === "update" &&
				operation.category === undefined &&
				operation.content === undefined &&
				operation.surfaceCondition === undefined &&
				operation.scope === undefined &&
				operation.status === undefined
			) {
				throw new Error("ctx_note update requires at least one changed field");
			}

			const scope = operation.scope ?? existing.scope;
			const updated = store.upsertNote({
				id: existing.id,
				projectId,
				scope,
				category: operation.category?.trim() || existing.category,
				content: operation.content?.trim() || existing.content,
				status: operation.action === "dismiss" ? "dismissed" : (operation.status ?? existing.status),
				...(scope === "session" ? { sessionId } : {}),
				...(operation.surfaceCondition !== undefined
					? operation.surfaceCondition.trim()
						? { surfaceCondition: operation.surfaceCondition.trim() }
						: {}
					: existing.surfaceCondition !== undefined
						? { surfaceCondition: existing.surfaceCondition }
						: {}),
			});
			return { action: operation.action, status: "ok", notes: [updated] };
		} catch (error) {
			if (error instanceof Error && (error.message.startsWith("ctx_note ") || error.message.includes("requires"))) {
				throw error;
			}
			this.#disable(error);
			return { action: operation.action, status: "unavailable", notes: [] };
		}
	}

	beginDispose(): void {
		this.#disposing = true;
		this.#historian?.beginDispose();
		this.#search?.beginDispose();
		this.#dreamer?.beginDispose();
	}

	async prepareCanonicalMessages(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		if (!this.#active || this.#disposing) return messages;
		signal?.throwIfAborted();
		await this.rebind();
		try {
			if (this.#boundSessionId) this.#identity?.prepareCanonicalMessages(this.#boundSessionId, messages);
		} catch (error) {
			this.#disable(error);
			return messages;
		}
		this.#setMemoryQuery(latestContextMemoryQuery(messages));
		return messages;
	}

	prepareOutgoingMessages(messages: AgentMessage[]): void {
		if (!this.#active || this.#disposing || !this.#boundSessionId) return;
		try {
			this.#identity?.prepareOutgoingMessages(this.#boundSessionId, messages);
		} catch (error) {
			this.#disable(error);
		}
	}

	bindPersistedMessage(message: AgentMessage, entryId: string): void {
		if (!this.#active || this.#disposing || !this.#boundSessionId) return;
		try {
			this.#identity?.bindPersistedMessage(this.#boundSessionId, message, entryId);
			this.#bindingKey = undefined;
		} catch (error) {
			this.#disable(error);
		}
	}

	async reduceTags(requestedTags: readonly number[], reason?: string): Promise<ContextReduceResult> {
		if (!this.#active || this.#disposing) {
			return { status: "unavailable", requestedTags: [...requestedTags], expandedTags: [], rejected: [] };
		}
		await this.rebind();
		const sessionId = this.#boundSessionId;
		const store = this.#store;
		const scopeLeafEntryId = this.#sessionManager.getLeafId();
		if (!this.#active || !sessionId || !store || !scopeLeafEntryId) {
			return { status: "unavailable", requestedTags: [...requestedTags], expandedTags: [], rejected: [] };
		}
		try {
			const branch = this.#sessionManager.getBranch();
			const session = store.getSession(sessionId);
			if (!session) throw new Error(`Context session ${sessionId} is unavailable`);
			const tags = store.listMessageTags(sessionId);
			const units = buildReductionUnits(branch, tags, this.#settings.get("contextManager.protectedTags"));
			const plan = planReductionTargets(units, requestedTags);
			if (plan.expandedTags.length === 0) {
				return {
					status: "rejected",
					requestedTags: plan.requestedTags,
					expandedTags: [],
					rejected: plan.rejected,
				};
			}

			const now = Date.now();
			let eligibleAt = now;
			store.transaction(() => {
				let runtime = store.getSessionRuntime(sessionId);
				if (!runtime) {
					const policy = resolveContextCachePolicy(this.#settings, undefined);
					runtime = store.updateSessionRuntime(
						{
							sessionId,
							modelKey: policy.modelKey,
							contextLimit: policy.contextLimit,
							conversationTokens: 0,
							toolCallTokens: 0,
							nonMessageTokens: 0,
							totalTokens: 0,
							pressurePercent: 0,
							executeThresholdTokens: policy.executeThresholdTokens,
							cacheTtlMs: policy.cacheTtlMs,
						},
						now,
					);
				}
				store.markSessionMaterializationPending(sessionId, now);
				runtime = store.getSessionRuntime(sessionId) ?? runtime;
				const decision = decideContextMaterialization(runtime, true, now);
				eligibleAt = decision.action === "defer" ? (decision.eligibleAt ?? now) : now;

				const tagsByOrdinal = new Map(tags.map(tag => [tag.tagOrdinal, tag]));
				for (const tagOrdinal of plan.expandedTags) {
					const tag = tagsByOrdinal.get(tagOrdinal);
					if (tag) store.recordSourceContent(tag, tag.entryId, undefined, now);
				}
				const alreadyRemoved = new Set(
					store
						.listDrops(sessionId, session.activeGeneration)
						.filter(drop => drop.replacementText === undefined)
						.flatMap(drop => drop.expandedTags),
				);
				for (const unit of plan.units) {
					if (unit.tagOrdinals.every(tag => alreadyRemoved.has(tag))) continue;
					const targetTag = plan.requestedTags.find(tag => unit.tagOrdinals.includes(tag)) ?? unit.tagOrdinals[0];
					store.insertDrop(
						{
							sessionId,
							targetTag,
							expandedTags: unit.tagOrdinals,
							reason,
							source: "explicit",
							scopeLeafEntryId,
							status: "queued",
							eligibleAt,
							generation: session.activeGeneration,
						},
						now,
					);
				}
			});
			return {
				status: "queued",
				requestedTags: plan.requestedTags,
				expandedTags: plan.expandedTags,
				rejected: plan.rejected,
				eligibleAt,
			};
		} catch (error) {
			this.#disable(error);
			return { status: "unavailable", requestedTags: [...requestedTags], expandedTags: [], rejected: [] };
		}
	}

	async expandTags(requestedTags: readonly number[], cancelDrops = false): Promise<ContextExpandResult> {
		if (!this.#active || this.#disposing) {
			return {
				status: "unavailable",
				requestedTags: [...requestedTags],
				foundTags: [],
				missingTags: [...requestedTags],
				content: "",
				cancelledDrops: 0,
			};
		}
		await this.rebind();
		const sessionId = this.#boundSessionId;
		const store = this.#store;
		if (!this.#active || !sessionId || !store) {
			return {
				status: "unavailable",
				requestedTags: [...requestedTags],
				foundTags: [],
				missingTags: [...requestedTags],
				content: "",
				cancelledDrops: 0,
			};
		}
		try {
			const normalizedTags = [...new Set(requestedTags.filter(Number.isSafeInteger))];
			const foundTags: number[] = [];
			const missingTags: number[] = [];
			const sources: Array<{ tagOrdinal: number; entryId: string; message: AgentMessage }> = [];
			for (const tagOrdinal of normalizedTags) {
				const tag = store.getMessageTag(sessionId, tagOrdinal);
				const source = tag ? store.getSourceContent(sessionId, tagOrdinal, tag.contentHash) : undefined;
				const entryId = tag?.entryId ?? source?.sessionEntryId;
				const entry = entryId ? this.#sessionManager.getEntry(entryId) : undefined;
				if (!entryId || entry?.type !== "message") {
					missingTags.push(tagOrdinal);
					continue;
				}
				foundTags.push(tagOrdinal);
				sources.push({ tagOrdinal, entryId, message: entry.message });
			}
			const fullContent = stringifyJson(sources) ?? "[]";
			let artifactId: string | undefined;
			const content = await enforceInlineByteCap(fullContent, {
				saveArtifact: async text => {
					artifactId = await this.#sessionManager.saveArtifact(text, "ctx-expand");
					return artifactId;
				},
			});
			const cancelledDrops = cancelDrops ? store.cancelDropsForTags(sessionId, new Set(normalizedTags)) : 0;
			return {
				status: "ok",
				requestedTags: normalizedTags,
				foundTags,
				missingTags,
				content,
				artifactId,
				cancelledDrops,
			};
		} catch (error) {
			this.#disable(error);
			return {
				status: "unavailable",
				requestedTags: [...requestedTags],
				foundTags: [],
				missingTags: [...requestedTags],
				content: "",
				cancelledDrops: 0,
			};
		}
	}

	async wrapup(messagesToKeep = 20, signal?: AbortSignal): Promise<ContextHistorianRunResult> {
		if (!this.#active || this.#disposing || !this.#historian) {
			return { status: "unavailable", compartments: 0, facts: 0 };
		}
		if (!Number.isSafeInteger(messagesToKeep) || messagesToKeep < 1) {
			return { status: "failed", compartments: 0, facts: 0, error: "messagesToKeep must be a positive integer" };
		}
		await this.rebind();
		const store = this.#store;
		const sessionId = this.#boundSessionId;
		if (!store || !sessionId) return { status: "unavailable", compartments: 0, facts: 0 };
		try {
			const session = store.getSession(sessionId);
			if (!session) return { status: "unavailable", compartments: 0, facts: 0 };
			const branch = this.#managedBranch();
			const visibleEntryIds = new Set(this.#sessionManager.getBranch().map(entry => entry.id));
			const runtime = this.#ensureManualRuntime(store, sessionId, branch);
			this.#forceHistorianMaterialization(store, session, visibleEntryIds);
			this.#search?.syncSession(session, visibleEntryIds);
			let compartments = 0;
			let facts = 0;
			while (true) {
				signal?.throwIfAborted();
				const tags = store.listMessageTags(sessionId);
				const coveredTags = new Set(
					store
						.listActiveCompartments(sessionId, session.activeGeneration, visibleEntryIds)
						.flatMap(compartment => compartment.tagOrdinals),
				);
				const branchEntryIds = new Set(branch.map(entry => entry.id));
				const uncovered = tags.filter(
					tag =>
						tag.supersededAt === undefined &&
						tag.entryId !== undefined &&
						branchEntryIds.has(tag.entryId) &&
						!coveredTags.has(tag.tagOrdinal),
				);
				if (uncovered.length <= messagesToKeep) break;
				const plan = this.#historian.plan(session, runtime, branch, tags, visibleEntryIds, true, messagesToKeep);
				if (!plan.shouldRun || !plan.chunk) break;
				const result = await this.#historian.run(session, runtime, visibleEntryIds, plan.chunk, signal);
				if (result.status !== "published") {
					return { ...result, compartments: compartments + result.compartments, facts: facts + result.facts };
				}
				const materialized = this.#forceHistorianMaterialization(store, session, visibleEntryIds);
				if (materialized === 0) {
					return {
						status: "failed",
						compartments,
						facts,
						error: "Historian wrapup published no materializable compartments",
					};
				}
				compartments += result.compartments;
				await this.#promoteEligibleFacts(session);
				this.#search?.syncSession(session, visibleEntryIds);
				facts += result.facts;
			}
			if (compartments > 0) this.#legacyFallbackRequired = false;
			return { status: compartments > 0 ? "published" : "noop", compartments, facts };
		} catch (error) {
			return {
				status: "failed",
				compartments: 0,
				facts: 0,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async recomp(
		range?: { readonly startTag: number; readonly endTag: number },
		signal?: AbortSignal,
	): Promise<ContextHistorianRunResult> {
		if (!this.#active || this.#disposing || !this.#historian) {
			return { status: "unavailable", compartments: 0, facts: 0 };
		}
		await this.rebind();
		const store = this.#store;
		const sessionId = this.#boundSessionId;
		if (!store || !sessionId) return { status: "unavailable", compartments: 0, facts: 0 };
		try {
			const session = store.getSession(sessionId);
			if (!session) return { status: "unavailable", compartments: 0, facts: 0 };
			if (store.hasPendingHistorianPublication(sessionId, session.activeGeneration)) {
				return { status: "busy", compartments: 0, facts: 0, error: "A historian publication is pending" };
			}
			const branch = this.#managedBranch();
			const visibleEntryIds = new Set(this.#sessionManager.getBranch().map(entry => entry.id));
			const runtime = this.#ensureManualRuntime(store, sessionId, branch);
			const result = await this.#historian.recomp(
				session,
				runtime,
				branch,
				store.listMessageTags(sessionId),
				visibleEntryIds,
				range,
				signal,
			);
			if (result.status === "published") {
				if (this.#forceHistorianMaterialization(store, session, visibleEntryIds) === 0) {
					return { ...result, status: "failed", error: "Recomp publication could not be materialized" };
				}
				await this.#promoteEligibleFacts(session);
				this.#search?.syncSession(session, visibleEntryIds);
				this.#legacyFallbackRequired = false;
			}
			return result;
		} catch (error) {
			return {
				status: "failed",
				compartments: 0,
				facts: 0,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	#managedBranch(): SessionEntry[] {
		const branch = this.#sessionManager.getBranch();
		const cutoff = branch.findLastIndex(entry => entry.type === "compaction");
		return cutoff >= 0 ? branch.slice(cutoff + 1) : branch;
	}

	#ensureManualRuntime(
		store: ContextStore,
		sessionId: string,
		branch: readonly SessionEntry[],
	): ContextSessionRuntimeRecord {
		const existing = store.getSessionRuntime(sessionId);
		if (existing) return existing;
		const policy = resolveContextCachePolicy(this.#settings, undefined);
		const stats = this.#onWireTokenCounter.measure(
			branch.filter(entry => entry.type === "message").map(entry => entry.message),
		);
		return store.updateSessionRuntime({
			sessionId,
			modelKey: policy.modelKey,
			contextLimit: policy.contextLimit,
			pressurePercent: policy.contextLimit > 0 ? (stats.totalTokens / policy.contextLimit) * 100 : 0,
			executeThresholdTokens: policy.executeThresholdTokens,
			cacheTtlMs: policy.cacheTtlMs,
			...stats,
		});
	}

	#forceHistorianMaterialization(
		store: ContextStore,
		session: ContextSessionRecord,
		visibleEntryIds: ReadonlySet<string>,
	): number {
		const now = Date.now();
		const activated = store.activateEligibleDrops(session.id, session.activeGeneration, visibleEntryIds, now, true);
		const materialized = store.materializePendingCompartments(
			session.id,
			session.activeGeneration,
			visibleEntryIds,
			now,
		);
		if (activated > 0 || materialized.compartments > 0) {
			const queuedRemain = store
				.listDrops(session.id, session.activeGeneration)
				.some(drop => drop.status === "queued");
			store.markSessionMaterialized(session.id, now, queuedRemain);
		}
		return materialized.compartments;
	}

	transformContext(
		messages: AgentMessage[],
		signal?: AbortSignal,
		model?: Model,
		nonMessageTokens = 0,
	): Promise<AgentMessage[]> {
		return this.#transformContext(messages, signal, model, nonMessageTokens);
	}

	async flush(model?: Model, signal?: AbortSignal): Promise<ContextFlushResult> {
		if (!this.#active || this.#disposing) {
			return {
				status: "unavailable",
				activatedDrops: 0,
				activeDrops: 0,
				queuedDrops: 0,
				compartments: 0,
				facts: 0,
				...(this.#failure ? { error: this.#failure } : {}),
			};
		}
		signal?.throwIfAborted();
		await this.rebind();
		const store = this.#store;
		const sessionId = this.#boundSessionId;
		const session = sessionId ? store?.getSession(sessionId) : undefined;
		if (!store || !sessionId || !session) {
			return {
				status: "unavailable",
				activatedDrops: 0,
				activeDrops: 0,
				queuedDrops: 0,
				compartments: 0,
				facts: 0,
			};
		}
		const visibleEntryIds = new Set(this.#sessionManager.getBranch().map(entry => entry.id));
		const beforeActive = store.listActiveDrops(sessionId, session.activeGeneration, visibleEntryIds).length;
		const canonical = await this.prepareCanonicalMessages(
			this.#sessionManager.buildSessionContext().messages,
			signal,
		);
		await this.#transformContext(canonical, signal, model, 0, true);
		signal?.throwIfAborted();
		if (!this.#active) {
			return {
				status: "failed",
				activatedDrops: 0,
				activeDrops: 0,
				queuedDrops: 0,
				compartments: 0,
				facts: 0,
				...(this.#failure ? { error: this.#failure } : {}),
			};
		}
		const current = store.getSession(sessionId);
		if (!current) {
			return {
				status: "failed",
				activatedDrops: 0,
				activeDrops: 0,
				queuedDrops: 0,
				compartments: 0,
				facts: 0,
				error: `Context session ${sessionId} disappeared during flush`,
			};
		}
		const activeDrops = store.listActiveDrops(sessionId, current.activeGeneration, visibleEntryIds).length;
		const queuedDrops = store
			.listDrops(sessionId, current.activeGeneration)
			.filter(drop => drop.status === "queued").length;
		return {
			status: "ok",
			activatedDrops: Math.max(0, activeDrops - beforeActive),
			activeDrops,
			queuedDrops,
			compartments: store.listActiveCompartments(sessionId, current.activeGeneration, visibleEntryIds).length,
			facts: store.listSessionFacts(sessionId, current.activeGeneration).length,
		};
	}

	async #transformContext(
		messages: AgentMessage[],
		signal?: AbortSignal,
		model?: Model,
		nonMessageTokens = 0,
		forceMaterialization = false,
	): Promise<AgentMessage[]> {
		if (!this.#active || this.#disposing) return messages;
		signal?.throwIfAborted();
		await this.rebind();
		const sessionId = this.#boundSessionId;
		const store = this.#store;
		if (!this.#active || !sessionId || !store) return messages;
		try {
			const taggedMessages =
				this.#identity?.transformMessages(
					sessionId,
					messages,
					this.#settings.get("contextManager.temporalAwareness"),
				) ?? messages;
			const policy = resolveContextCachePolicy(this.#settings, model);
			const updateRuntime = (wireMessages: AgentMessage[]) => {
				const stats = this.#onWireTokenCounter.measure(wireMessages, nonMessageTokens);
				return store.updateSessionRuntime({
					sessionId,
					modelKey: policy.modelKey,
					contextLimit: policy.contextLimit,
					pressurePercent: policy.contextLimit > 0 ? (stats.totalTokens / policy.contextLimit) * 100 : 0,
					executeThresholdTokens: policy.executeThresholdTokens,
					cacheTtlMs: policy.cacheTtlMs,
					...stats,
				});
			};
			let runtime = updateRuntime(taggedMessages);
			const session = store.getSession(sessionId);
			if (!session) throw new Error(`Context session ${sessionId} is unavailable`);
			const fullBranch = this.#sessionManager.getBranch();
			const latestLegacyCompactionIndex = fullBranch.findLastIndex(entry => entry.type === "compaction");
			const branch =
				latestLegacyCompactionIndex >= 0 ? fullBranch.slice(latestLegacyCompactionIndex + 1) : fullBranch;
			const visibleEntryIds = new Set(fullBranch.map(entry => entry.id));
			const tags = store.listMessageTags(sessionId);
			const protectedTagCount = this.#settings.get("contextManager.protectedTags");
			const autoScheduled = shouldScheduleAutomaticCleanup(tags, protectedTagCount, runtime.cleanupWatermarkTag);
			const runAutomaticCleanup = forceMaterialization || autoScheduled;
			if (autoScheduled && runtime.pendingSince === undefined) {
				store.markSessionMaterializationPending(sessionId);
				runtime = store.getSessionRuntime(sessionId) ?? runtime;
			}
			let blockingHistorianPublished = false;
			const historianPlan = this.#historian?.plan(
				session,
				runtime,
				branch,
				tags,
				visibleEntryIds,
				forceMaterialization,
			);
			if (historianPlan?.shouldRun && historianPlan.chunk) {
				if (historianPlan.blocking) {
					const result = await this.#historian?.run(
						session,
						runtime,
						visibleEntryIds,
						historianPlan.chunk,
						signal,
					);
					if (result?.status === "published") {
						runtime = store.getSessionRuntime(sessionId) ?? runtime;
						blockingHistorianPublished = true;
						this.#legacyFallbackRequired = false;
					} else if (result?.status === "failed" || result?.status === "unavailable") {
						this.#legacyFallbackRequired = true;
					}
				} else {
					void this.#historian
						?.run(session, runtime, visibleEntryIds, historianPlan.chunk, signal)
						.then(result => {
							if (result.status === "published") void this.#promoteEligibleFacts(session);
						});
				}
			}
			const decision = decideContextMaterialization(runtime, runtime.pendingSince !== undefined);
			if (forceMaterialization || decision.action === "execute") {
				const now = Date.now();
				const existingDrops = store.listDrops(sessionId, session.activeGeneration);
				const cleanupCandidates = runAutomaticCleanup
					? planAutomaticCleanup(branch, tags, existingDrops, {
							protectedTagCount,
							clearReasoningAge: this.#settings.get("contextManager.clearReasoningAge"),
							smartDrops: this.#settings.get("contextManager.smartDrops"),
							cavemanEnabled: this.#settings.get("contextManager.caveman.enabled"),
							cavemanMinChars: this.#settings.get("contextManager.caveman.minChars"),
						})
					: [];
				store.transaction(() => {
					const tagsByOrdinal = new Map(tags.map(tag => [tag.tagOrdinal, tag]));
					const scopeLeafEntryId = this.#sessionManager.getLeafId();
					if (scopeLeafEntryId) {
						for (const candidate of cleanupCandidates) {
							const tag = tagsByOrdinal.get(candidate.targetTag);
							if (!tag) continue;
							store.recordSourceContent(tag, candidate.entryId, candidate.replacementText, now);
							store.insertDrop(
								{
									sessionId,
									targetTag: candidate.targetTag,
									expandedTags: [candidate.targetTag],
									source: candidate.source,
									reason: candidate.reason,
									scopeLeafEntryId,
									replacementText: candidate.replacementText,
									clearReasoning: candidate.clearReasoning,
									status: "active",
									eligibleAt: now,
									generation: session.activeGeneration,
								},
								now,
							);
						}
					}
					const activated = store.activateEligibleDrops(
						sessionId,
						session.activeGeneration,
						visibleEntryIds,
						now,
						forceMaterialization || decision.reason === "token-threshold",
					);
					const historyMaterialized = store.materializePendingCompartments(
						sessionId,
						session.activeGeneration,
						visibleEntryIds,
						now,
					);
					if (runAutomaticCleanup) {
						const newestTag = tags.reduce(
							(maximum, tag) => (tag.supersededAt === undefined ? Math.max(maximum, tag.tagOrdinal) : maximum),
							0,
						);
						store.markAutomaticCleanupScanned(sessionId, newestTag, now);
					}
					const materializedHistory = historyMaterialized.compartments > 0;
					const queuedRemain = store
						.listDrops(sessionId, session.activeGeneration)
						.some(drop => drop.status === "queued");
					if (activated > 0 || cleanupCandidates.length > 0 || runAutomaticCleanup || materializedHistory) {
						store.markSessionMaterialized(sessionId, now, queuedRemain);
					}
				});
			}
			this.#search?.syncSession(session, visibleEntryIds);
			let searchMessages = taggedMessages;
			const latestUser = taggedMessages.findLast(message => message.role === "user");
			const latestUserRef = latestUser ? getContextMessageRef(latestUser) : undefined;
			const searchQuery = this.#lastMemoryQuery ?? latestContextMemoryQuery(messages);
			if (this.#search && latestUserRef && searchQuery) {
				const hint = await this.#search.autoSearch(
					sessionId,
					latestUserRef.tagOrdinal,
					latestUserRef.contentHash,
					searchQuery,
					signal,
				);
				searchMessages = injectAutoSearchHint(taggedMessages, hint);
				await this.#promoteEligibleFacts(session);
			}
			let omittedHistoryIds: readonly string[] = [];
			const buildManagedWire = (): AgentMessage[] => {
				const activeDrops = store.listActiveDrops(sessionId, session.activeGeneration, visibleEntryIds);
				let wireMessages = applyContextDrops(searchMessages, activeDrops);
				const compartments = store.listActiveCompartments(sessionId, session.activeGeneration, visibleEntryIds);
				if (compartments.length > 0) {
					const history = renderTieredHistory(
						compartments,
						runtime.executeThresholdTokens * this.#settings.get("contextManager.historyBudgetPercent"),
						this.#settings.get("contextManager.temporalAwareness"),
					);
					omittedHistoryIds = history.omittedCompartmentIds;
					wireMessages = injectTieredHistory(wireMessages, history.block);
				}
				return wireMessages;
			};
			let transformed = buildManagedWire();
			runtime = updateRuntime(transformed);
			while (blockingHistorianPublished && runtime.totalTokens > runtime.executeThresholdTokens * 0.8) {
				const nextPlan = this.#historian?.plan(session, runtime, branch, tags, visibleEntryIds, true);
				if (!nextPlan?.shouldRun || !nextPlan.chunk) {
					this.#legacyFallbackRequired = true;
					break;
				}
				const result = await this.#historian?.run(session, runtime, visibleEntryIds, nextPlan.chunk, signal);
				if (result?.status !== "published") {
					if (result?.status === "failed" || result?.status === "unavailable") {
						this.#legacyFallbackRequired = true;
					}
					break;
				}
				const now = Date.now();
				const activated = store.activateEligibleDrops(
					sessionId,
					session.activeGeneration,
					visibleEntryIds,
					now,
					true,
				);
				const materialized = store.materializePendingCompartments(
					sessionId,
					session.activeGeneration,
					visibleEntryIds,
					now,
				);
				const queuedRemain = store
					.listDrops(sessionId, session.activeGeneration)
					.some(drop => drop.status === "queued");
				store.markSessionMaterialized(sessionId, now, queuedRemain);
				if (activated === 0 || materialized.compartments === 0) {
					this.#legacyFallbackRequired = true;
					break;
				}
				transformed = buildManagedWire();
				runtime = updateRuntime(transformed);
			}
			if (runtime.totalTokens <= runtime.executeThresholdTokens * 0.8) this.#legacyFallbackRequired = false;
			if (blockingHistorianPublished) void this.#promoteEligibleFacts(session);
			if (omittedHistoryIds.length > 0) {
				void this.#historian?.mergeOldest(
					session,
					runtime,
					branch,
					tags,
					visibleEntryIds,
					omittedHistoryIds,
					signal,
				);
			}
			this.#search?.syncSession(session, visibleEntryIds);
			this.#search?.scheduleEmbeddingDrain();
			return transformed;
		} catch (error) {
			this.#disable(error);
			return messages;
		}
	}

	async #refreshMemoryContext(signal?: AbortSignal): Promise<void> {
		const adapter = this.#memoryAdapter;
		const query = this.#lastMemoryQuery;
		if (!adapter?.available || !adapter.autoRecall || !query) {
			this.#memoryBlock = undefined;
			this.#loadedMemoryQuery = undefined;
			return;
		}
		try {
			const recalled = await adapter.recall(query, this.#settings.get("mnemopi.recallLimit"), signal);
			signal?.throwIfAborted();
			const rendered = renderContextMemory(
				recalled,
				this.#settings.get("contextManager.memory.injectionBudgetTokens"),
			);
			this.#memoryBlock = rendered.block;
			this.#loadedMemoryQuery = query;
		} catch (error) {
			if (signal?.aborted) throw error;
			this.#memoryBlock = undefined;
			this.#loadedMemoryQuery = undefined;
			logger.warn("Managed context memory recall failed; continuing without memory injection", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #promoteEligibleFacts(session: ContextSessionRecord): Promise<void> {
		const adapter = this.#memoryAdapter;
		const store = this.#store;
		if (!adapter?.available || !store || !this.#settings.get("contextManager.memory.autoPromote")) {
			return;
		}
		const facts = store.listSessionFacts(session.id, session.activeGeneration);
		const byNormalized = new Map<string, number>();
		const canonicalByNormalized = new Map<string, string>();
		const promotionKey = (scope: "session" | "project" | "user", text: string): string => {
			const memoryScope = scope === "user" ? "user" : "project";
			return `${memoryScope}\0${normalizePromotableFact(text)}`;
		};
		for (const fact of facts) {
			const key = promotionKey(fact.scope, fact.text);
			if (!key.endsWith("\0")) byNormalized.set(key, (byNormalized.get(key) ?? 0) + 1);
			if (fact.canonicalMemoryId) canonicalByNormalized.set(key, fact.canonicalMemoryId);
		}
		const retrievalThreshold = this.#settings.get("contextManager.memory.retrievalPromotionThreshold");
		for (const fact of facts) {
			if (fact.canonicalMemoryId) continue;
			const key = promotionKey(fact.scope, fact.text);
			const repeated = !key.endsWith("\0") && (byNormalized.get(key) ?? 0) >= 2;
			const retrieved = fact.retrievalCount >= retrievalThreshold;
			if (!repeated && !retrieved) continue;
			if (fact.scope === "user" && !USER_PROFILE_MEMORY_TYPES.has(fact.category)) continue;
			try {
				let canonicalMemoryId = canonicalByNormalized.get(key);
				if (!canonicalMemoryId) {
					canonicalMemoryId = await adapter.remember(fact.scope === "user" ? "user" : "project", {
						content: fact.text,
						source: "managed-context-historian",
						importance: fact.confidence,
						memoryType: fact.category,
						metadata: {
							sourceSessionId: fact.sessionId,
							sourceProjectId: fact.projectId,
							startTag: fact.startTag,
							endTag: fact.endTag,
							sourceTags: [...fact.sourceTags],
							confidence: fact.confidence,
							category: fact.category,
						},
					});
					if (canonicalMemoryId) canonicalByNormalized.set(key, canonicalMemoryId);
				}
				if (!canonicalMemoryId) continue;
				store.markSessionFactPromoted(
					fact.id,
					canonicalMemoryId,
					[
						repeated ? { kind: "repeated-compartment", occurrences: byNormalized.get(key) } : {},
						retrieved ? { kind: "retrieval-count", count: fact.retrievalCount } : {},
					].filter(evidence => Object.keys(evidence).length > 0),
				);
			} catch (error) {
				logger.warn("Managed context fact promotion failed", {
					factId: fact.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	async #loadManagedProjectDocs(): Promise<string | undefined> {
		if (!this.#settings.get("contextManager.dreamer.injectDocs")) return undefined;
		const cwd = this.#sessionManager.getCwd();
		const now = Date.now();
		if (this.#docsCache?.cwd === cwd && this.#docsCache.expiresAt > now) return this.#docsCache.block;
		const documents: Array<{ readonly path: string; readonly content: string; readonly truncated: boolean }> = [];
		for (const name of MANAGED_DOC_NAMES) {
			try {
				const file = Bun.file(path.join(cwd, name));
				const truncated = file.size > MANAGED_DOC_MAX_BYTES;
				const content = (await file.slice(0, MANAGED_DOC_MAX_BYTES).text()).trim();
				if (content) documents.push({ path: name, content: escapeXmlText(content), truncated });
			} catch (error) {
				if (!isEnoent(error)) {
					logger.debug("Managed-context project document read failed", {
						path: name,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
		const block =
			documents.length > 0
				? prompt.render(projectDocumentsTemplate, {
						documents,
					})
				: undefined;
		this.#docsCache = { cwd, expiresAt: now + MANAGED_DOC_CACHE_TTL_MS, block };
		return block;
	}

	async decorateSystemPrompt(systemPrompt: string[], signal?: AbortSignal, memoryQuery?: string): Promise<string[]> {
		if (!this.#active || this.#disposing) return systemPrompt;
		signal?.throwIfAborted();
		await this.rebind();
		if (memoryQuery !== undefined) this.#setMemoryQuery(memoryQuery);
		if (this.#lastMemoryQuery && this.#loadedMemoryQuery !== this.#lastMemoryQuery) {
			await this.#refreshMemoryContext(signal);
		}
		const docsBlock = await this.#loadManagedProjectDocs();
		if (!docsBlock && !this.#memoryBlock) return systemPrompt;
		return [...systemPrompt, ...(docsBlock ? [docsBlock] : []), ...(this.#memoryBlock ? [this.#memoryBlock] : [])];
	}

	async rebind(): Promise<void> {
		if (!this.#active || this.#disposing || !this.#store) return;
		const store = this.#store;
		try {
			const previousProjectId = this.#boundProjectId;
			const previousSessionId = this.#boundSessionId;
			const previousSessionFile = this.#boundSessionFile;
			const cwd = this.#sessionManager.getCwd();
			if (cwd !== this.#boundCwd) {
				const project = await resolveContextProjectIdentity(cwd);
				store.registerProject(project);
				this.#boundCwd = cwd;
				this.#boundProjectId = project.id;
				this.#bindingKey = undefined;
			}

			const projectId = this.#boundProjectId;
			if (!projectId) throw new Error("Context project identity is unavailable");
			this.#search?.bindProject(projectId, cwd);
			const sessionId = this.#sessionManager.getSessionId();
			if (
				(previousProjectId !== undefined && previousProjectId !== projectId) ||
				(previousSessionId !== undefined && previousSessionId !== sessionId)
			) {
				this.#setMemoryQuery(undefined);
			}
			const sessionFile = this.#sessionManager.getSessionFile();
			const currentLeafEntryId = this.#sessionManager.getLeafId() ?? undefined;
			const bindingKey = `${projectId}\0${sessionId}\0${sessionFile ?? ""}\0${currentLeafEntryId ?? ""}`;
			if (bindingKey === this.#bindingKey) return;
			const targetAlreadyRegistered = store.getSession(sessionId) !== undefined;
			const parentSession = this.#sessionManager.getHeader()?.parentSession;
			const copyFromPrevious =
				previousSessionId !== undefined &&
				previousSessionId !== sessionId &&
				previousProjectId === projectId &&
				(!targetAlreadyRegistered ||
					parentSession === previousSessionId ||
					(previousSessionFile !== undefined && parentSession === previousSessionFile));
			const visibleEntryIds = copyFromPrevious
				? new Set(this.#sessionManager.getBranch().map(entry => entry.id))
				: undefined;
			const branch = this.#sessionManager.getBranch();
			const latestLegacyCompaction = branch.findLast(entry => entry.type === "compaction");
			const legacyCutoffKey = `legacy-compaction-cutoff:${sessionId}`;
			store.transaction(() => {
				store.upsertSession({
					id: sessionId,
					projectId,
					sessionFile,
					mode: "primary",
					currentLeafEntryId,
				});
				if (visibleEntryIds && previousSessionId) {
					store.copySessionStateForBranch(previousSessionId, sessionId, visibleEntryIds);
					const previousCutoff = store.getMeta(`legacy-compaction-cutoff:${previousSessionId}`);
					if (previousCutoff) store.setMeta(legacyCutoffKey, previousCutoff);
				}
			});
			if (latestLegacyCompaction && store.getMeta(legacyCutoffKey) !== latestLegacyCompaction.id) {
				store.transaction(() => {
					store.advanceSessionGeneration(sessionId);
					store.setMeta(legacyCutoffKey, latestLegacyCompaction.id);
				});
				this.#legacyFallbackRequired = false;
			}
			this.#boundSessionId = sessionId;
			this.#boundSessionFile = sessionFile;
			this.#bindingKey = bindingKey;
		} catch (error) {
			this.#disable(error);
		}
	}

	status(): ContextManagerStatus {
		return {
			mode: this.mode,
			active: this.#active,
			projectId: this.#boundProjectId,
			sessionId: this.#boundSessionId,
			failure: this.#failure,
			fallbackRequired: this.#legacyFallbackRequired,
		};
	}

	async dispose(): Promise<void> {
		this.beginDispose();
		this.#active = false;
		const dreamer = this.#dreamer;
		await Promise.all([this.#historian?.dispose(), this.#search?.dispose(), dreamer?.dispose(5_000)]);
		this.#historian = undefined;
		this.#search = undefined;
		this.#dreamer = undefined;
		this.#sidekick = undefined;
		this.#agentRunner = undefined;
		this.#store?.close();
		this.#store = undefined;
		this.#identity = undefined;
		this.#memoryAdapter = undefined;
		this.#memoryBlock = undefined;
		this.#loadedMemoryQuery = undefined;
		this.#onWireTokenCounter.clear();
	}

	#disable(error: unknown): void {
		this.#failure = error instanceof Error ? error.message : String(error);
		const historian = this.#historian;
		const search = this.#search;
		const store = this.#store;
		historian?.beginDispose();
		search?.beginDispose();
		const dreamer = this.#dreamer;
		dreamer?.beginDispose();
		this.#active = false;
		this.#historian = undefined;
		this.#search = undefined;
		this.#dreamer = undefined;
		this.#sidekick = undefined;
		this.#agentRunner = undefined;
		this.#store = undefined;
		this.#identity = undefined;
		this.#memoryAdapter = undefined;
		this.#memoryBlock = undefined;
		this.#loadedMemoryQuery = undefined;
		this.#onWireTokenCounter.clear();
		void Promise.allSettled([historian?.dispose(), search?.dispose(), dreamer?.dispose(1_000)]).then(() =>
			store?.close(),
		);
		if (!this.#warningEmitted) {
			this.#warningEmitted = true;
			logger.warn("Managed context disabled for this session; using legacy compaction", {
				error: this.#failure,
				mode: this.mode,
			});
		}
	}
}
