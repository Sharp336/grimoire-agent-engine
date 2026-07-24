import { type AgentMessage, countTokens } from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, escapeXmlText, logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import autoSearchHintTemplate from "../prompts/context-manager/auto-search-hint.md" with { type: "text" };
import autoSearchInjectionTemplate from "../prompts/context-manager/auto-search-injection.md" with { type: "text" };
import * as git from "../utils/git";
import type { ContextMemoryAdapter, ContextMemoryRecord } from "./memory";
import type { ContextStore } from "./storage";
import type {
	ContextEmbeddingStatus,
	ContextSearchDocumentRecord,
	ContextSearchDocumentSource,
	ContextSearchHit,
	ContextSearchOptions,
	ContextSearchResult,
	ContextSearchSource,
	ContextSessionRecord,
} from "./types";

const DOCUMENT_SOURCES: readonly ContextSearchDocumentSource[] = ["session_fact", "compartment", "note", "git_commit"];
const ALL_SOURCES: readonly ContextSearchSource[] = ["memory", ...DOCUMENT_SOURCES];
const SEARCH_RRF_K = 60;
const FTS_CANDIDATE_MULTIPLIER = 4;
const SEMANTIC_SCAN_LIMIT = 2_000;
const EMBEDDING_BATCH_SIZE = 32;
const EMBEDDING_LEASE_MS = 120_000;
const GIT_INDEX_LEASE_MS = 300_000;
const GIT_INDEX_INTERVAL_MS = 15 * 60_000;
const AUTO_SEARCH_TOKEN_BUDGET = 200;
const AUTO_SEARCH_MAX_FRAGMENTS = 3;
const renderAutoSearchInjection = prompt.compile(autoSearchInjectionTemplate);
const renderAutoSearchBlock = prompt.compile(autoSearchHintTemplate);

interface RankedDocument {
	readonly document: ContextSearchDocumentRecord;
	readonly lexicalRank?: number;
	readonly semanticRank?: number;
	readonly semanticScore?: number;
}

function hashText(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function normalizeText(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function ftsMatchQuery(query: string): string | undefined {
	const tokens =
		query
			.normalize("NFKC")
			.match(/[\p{L}\p{N}_]+/gu)
			?.slice(0, 24) ?? [];
	if (tokens.length === 0) return undefined;
	return [...new Set(tokens.map(token => token.toLowerCase()))].map(token => `"${token}"`).join(" OR ");
}

function shortSnippet(text: string, query: string, maxChars = 320): string {
	const normalizedQuery = normalizeText(query);
	const lower = text.toLowerCase();
	const firstTerm = normalizedQuery.split(" ").find(Boolean);
	const match = firstTerm ? lower.indexOf(firstTerm) : -1;
	const start = match <= 0 ? 0 : Math.max(0, match - Math.floor(maxChars / 3));
	const end = Math.min(text.length, start + maxChars);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function memoryHit(record: ContextMemoryRecord, query: string, normalizedScore: number): ContextSearchHit {
	return {
		source: "memory",
		id: record.id,
		canonicalId: record.id,
		contentHash: hashText(record.content),
		title: record.scope === "user" ? "User profile" : "Project memory",
		snippet: shortSnippet(record.content, query),
		score: Math.min(1, normalizedScore + (record.scope === "project" ? 0.02 : 0)),
	};
}

function documentHit(
	ranked: RankedDocument,
	query: string,
	normalizedScore: number,
	sessionId: string | undefined,
): ContextSearchHit {
	const document = ranked.document;
	const normalizedQuery = normalizeText(query);
	const exact =
		normalizedQuery.length > 0 && normalizeText(`${document.title}\n${document.text}`).includes(normalizedQuery);
	const scopeBoost = document.sessionId && document.sessionId === sessionId ? 0.05 : 0;
	return {
		source: document.source,
		id: document.sourceId,
		canonicalId: document.canonicalId,
		contentHash: document.contentHash,
		title: document.title,
		snippet: shortSnippet(document.text, query),
		score: Math.min(1, normalizedScore + (exact ? 0.08 : 0) + scopeBoost + 0.02),
		startTag: document.startTag,
		endTag: document.endTag,
		sessionId: document.sessionId,
		projectId: document.projectId,
	};
}

interface AutoSearchFragment {
	readonly source: string;
	readonly id: string;
	readonly score: string;
	readonly tags?: string;
	readonly snippet: string;
}

function renderAutoSearchTemplate(fragments: readonly AutoSearchFragment[], generation: number): string {
	if (fragments.length === 0) return "";
	return renderAutoSearchBlock({ generation, fragments }).replace(/\n$/, "");
}

function renderAutoSearchHint(hits: readonly ContextSearchHit[], generation: number): string {
	const selected: AutoSearchFragment[] = [];
	for (const hit of hits.slice(0, AUTO_SEARCH_MAX_FRAGMENTS)) {
		const tags =
			hit.startTag === undefined
				? undefined
				: `§${hit.startTag}§${hit.endTag !== undefined && hit.endTag !== hit.startTag ? `-§${hit.endTag}§` : ""}`;
		const fragment: AutoSearchFragment = {
			source: escapeXmlAttribute(hit.source),
			id: escapeXmlAttribute(hit.id),
			score: hit.score.toFixed(4),
			...(tags ? { tags } : {}),
			snippet: escapeXmlText(hit.snippet),
		};
		const candidate = renderAutoSearchTemplate([...selected, fragment], generation);
		if (countTokens(candidate) > AUTO_SEARCH_TOKEN_BUDGET) continue;
		selected.push(fragment);
	}
	return renderAutoSearchTemplate(selected, generation);
}

export function injectAutoSearchHint(messages: AgentMessage[], hint: string): AgentMessage[] {
	if (!hint) return messages;
	const index = messages.findLastIndex(message => message.role === "user");
	if (index < 0) return messages;
	const message = messages[index];
	if (message?.role !== "user") return messages;
	const content =
		typeof message.content === "string"
			? renderAutoSearchInjection({ original: message.content, hint })
			: [...message.content, { type: "text" as const, text: hint }];
	const clone = [...messages];
	clone[index] = { ...message, content };
	return clone;
}

export class ContextSearchService {
	readonly #store: ContextStore;
	readonly #settings: Settings;
	readonly #ownerId = `context-search:${Bun.randomUUIDv7()}`;
	#memory: ContextMemoryAdapter | undefined;
	#projectId: string | undefined;
	#cwd: string | undefined;
	#gitTimer: Timer | undefined;
	#gitAbort: AbortController | undefined;
	#gitRun: Promise<number> | undefined;
	#embeddingAbort: AbortController | undefined;
	#embeddingRun: Promise<ContextEmbeddingStatus> | undefined;
	#embeddingState: ContextEmbeddingStatus = { state: "idle", pending: 0, completed: 0, progress: 0 };
	#embeddingScheduled = false;
	#disposed = false;

	constructor(options: { readonly store: ContextStore; readonly settings: Settings }) {
		this.#store = options.store;
		this.#settings = options.settings;
	}

	setMemoryAdapter(adapter: ContextMemoryAdapter | undefined): void {
		this.#memory = adapter;
		if (!adapter) {
			this.#embeddingAbort?.abort(new Error("Context memory adapter was detached"));
			this.#embeddingState = { state: "unavailable", pending: 0, completed: 0, progress: 0 };
		} else if (this.#embeddingState.state === "unavailable") {
			this.#embeddingState = { state: "idle", pending: 0, completed: 0, progress: 0 };
		}
	}

	bindProject(projectId: string, cwd: string): void {
		if (this.#projectId === projectId && this.#cwd === cwd) return;
		this.#projectId = projectId;
		this.#cwd = cwd;
		this.#embeddingScheduled = false;
		clearInterval(this.#gitTimer);
		this.#gitTimer = undefined;
		if (this.#settings.get("contextManager.gitCommitIndexing.enabled")) {
			void Bun.sleep(0).then(() => this.indexGit());
			this.#gitTimer = setInterval(() => void this.indexGit(), GIT_INDEX_INTERVAL_MS);
			this.#gitTimer.unref?.();
		}
	}

	syncSession(session: ContextSessionRecord, visibleEntryIds: ReadonlySet<string>): number {
		const changes = this.#store.syncDerivedSearchDocuments(session.id, session.activeGeneration, visibleEntryIds);
		if (changes > 0 && this.#embeddingScheduled) void Bun.sleep(0).then(() => this.startEmbeddingDrain());
		return changes;
	}

	async search(query: string, options: ContextSearchOptions = {}): Promise<ContextSearchResult> {
		const projectId = this.#projectId;
		const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 10)));
		const requested = new Set(options.sources ?? ALL_SOURCES);
		const unavailable = new Set<ContextSearchSource>();
		if (!projectId || !query.trim()) {
			return { query, hits: [], unavailableSources: [...requested], generation: 0 };
		}
		options.signal?.throwIfAborted();
		const adapter = this.#memory;
		let queryVector: Float32Array | undefined;
		if (
			adapter?.available &&
			adapter.embeddingIdentity.enabled &&
			this.#settings.get("contextManager.embeddings.enabled")
		) {
			try {
				queryVector = (await adapter.embedBatch([query]))?.[0];
			} catch (error) {
				logger.debug("Managed context query embedding failed; using FTS only", { error: String(error) });
			}
		}
		options.signal?.throwIfAborted();
		const hits: ContextSearchHit[] = [];
		if (requested.has("memory")) {
			if (!adapter?.available) {
				unavailable.add("memory");
			} else {
				try {
					const recalled = await adapter.recall(query, limit * FTS_CANDIDATE_MULTIPLIER, options.signal);
					const records = [...recalled.project, ...recalled.user].sort(
						(left, right) => right.score - left.score || left.id.localeCompare(right.id),
					);
					const maximum = Math.max(0, ...records.map(record => record.score));
					for (const record of records) {
						hits.push(memoryHit(record, query, maximum > 0 ? record.score / maximum : 0));
					}
				} catch (error) {
					unavailable.add("memory");
					logger.debug("Managed context memory search failed", { error: String(error) });
				}
			}
		}
		const matchQuery = ftsMatchQuery(query);
		for (const source of DOCUMENT_SOURCES) {
			if (!requested.has(source)) continue;
			try {
				const candidateLimit = Math.max(limit * FTS_CANDIDATE_MULTIPLIER, 20);
				const lexical = matchQuery ? this.#store.searchFts(projectId, matchQuery, source, candidateLimit) : [];
				const semantic =
					queryVector && adapter
						? this.#store
								.listEmbeddedDocuments(
									projectId,
									source,
									adapter.embeddingIdentity.provider,
									adapter.embeddingIdentity.model,
									SEMANTIC_SCAN_LIMIT,
								)
								.map(item => ({
									document: item.document,
									score: adapter.cosineSimilarity(queryVector, item.embedding.vector),
								}))
								.sort(
									(left, right) =>
										right.score - left.score || left.document.id.localeCompare(right.document.id),
								)
								.slice(0, candidateLimit)
						: [];
				const ranked = new Map<string, RankedDocument>();
				for (const [index, document] of lexical.entries()) {
					ranked.set(document.id, { document, lexicalRank: index + 1 });
				}
				for (const [index, item] of semantic.entries()) {
					const existing = ranked.get(item.document.id);
					ranked.set(item.document.id, {
						document: item.document,
						lexicalRank: existing?.lexicalRank,
						semanticRank: index + 1,
						semanticScore: item.score,
					});
				}
				const raw = [...ranked.values()].map(item => ({
					item,
					score:
						(item.lexicalRank ? 1 / (SEARCH_RRF_K + item.lexicalRank) : 0) +
						(item.semanticRank ? 1 / (SEARCH_RRF_K + item.semanticRank) : 0),
					quality: item.lexicalRank ? 1 : Math.max(0, Math.min(1, item.semanticScore ?? 0)),
				}));
				const maximum = Math.max(0, ...raw.map(item => item.score));
				for (const item of raw) {
					hits.push(
						documentHit(
							item.item,
							query,
							maximum > 0 ? (item.score / maximum) * item.quality : 0,
							options.sessionId,
						),
					);
				}
			} catch (error) {
				unavailable.add(source);
				logger.debug("Managed context search source failed", { source, error: String(error) });
			}
		}
		options.signal?.throwIfAborted();
		const deduped = new Map<string, ContextSearchHit>();
		for (const hit of hits) {
			const key = hit.canonicalId ? `canonical:${hit.canonicalId}` : `content:${hit.contentHash}`;
			const existing = deduped.get(key);
			if (!existing || hit.score > existing.score) deduped.set(key, hit);
		}
		const ordered = [...deduped.values()]
			.sort(
				(left, right) =>
					right.score - left.score || left.source.localeCompare(right.source) || left.id.localeCompare(right.id),
			)
			.slice(0, limit);
		this.#store.incrementSessionFactRetrieval(
			ordered.filter(hit => hit.source === "session_fact").map(hit => hit.id),
		);
		return {
			query,
			hits: ordered,
			unavailableSources: [...unavailable],
			generation: this.#store.getSearchGeneration(projectId),
		};
	}

	async autoSearch(
		sessionId: string,
		tagOrdinal: number,
		contentHash: string,
		query: string,
		signal?: AbortSignal,
	): Promise<string> {
		const existing = this.#store.getAutoSearchSnapshot(sessionId, tagOrdinal, contentHash);
		if (existing) return existing.hint;
		const enabled = this.#settings.get("contextManager.autoSearch.enabled");
		const minimumChars = this.#settings.get("contextManager.autoSearch.minPromptChars");
		if (
			!enabled ||
			query.trim().length < minimumChars ||
			query.includes("<ctx-search-hint") ||
			query.includes("<sidekick-augmentation")
		) {
			return (
				this.#store.storeAutoSearchSnapshot(
					sessionId,
					tagOrdinal,
					contentHash,
					"",
					this.#store.getSearchGeneration(this.#projectId ?? ""),
				)?.hint ?? ""
			);
		}
		const result = await this.search(query, { sessionId, limit: AUTO_SEARCH_MAX_FRAGMENTS, signal });
		const threshold = this.#settings.get("contextManager.autoSearch.scoreThreshold");
		const hint =
			(result.hits[0]?.score ?? 0) >= threshold ? renderAutoSearchHint(result.hits, result.generation) : "";
		return (
			this.#store.storeAutoSearchSnapshot(sessionId, tagOrdinal, contentHash, hint, result.generation)?.hint ?? hint
		);
	}

	scheduleEmbeddingDrain(): void {
		if (this.#embeddingScheduled || this.#disposed) return;
		this.#embeddingScheduled = true;
		void Bun.sleep(0).then(() => this.startEmbeddingDrain());
	}

	startEmbeddingDrain(signal?: AbortSignal): Promise<ContextEmbeddingStatus> {
		if (this.#embeddingRun) return this.#embeddingRun;
		const controller = new AbortController();
		this.#embeddingAbort = controller;
		const forwardAbort = (): void => controller.abort(signal?.reason);
		signal?.addEventListener("abort", forwardAbort, { once: true });
		const run = this.#runEmbeddingDrain(controller.signal).finally(() => {
			signal?.removeEventListener("abort", forwardAbort);
			if (this.#embeddingRun === run) this.#embeddingRun = undefined;
			if (this.#embeddingAbort === controller) this.#embeddingAbort = undefined;
		});
		this.#embeddingRun = run;
		return run;
	}

	pauseEmbedding(): ContextEmbeddingStatus {
		this.#embeddingAbort?.abort(new Error("Context embedding paused"));
		this.#embeddingState = { ...this.#embeddingState, state: "paused" };
		return this.#embeddingState;
	}

	embeddingStatus(): ContextEmbeddingStatus {
		const adapter = this.#memory;
		const projectId = this.#projectId;
		if (!adapter?.available || !adapter.embeddingIdentity.enabled || !projectId) {
			return { state: "unavailable", pending: 0, completed: 0, progress: 0 };
		}
		const pending = this.#store.countDocumentsMissingEmbedding(
			projectId,
			adapter.embeddingIdentity.provider,
			adapter.embeddingIdentity.model,
		);
		return {
			...this.#embeddingState,
			provider: adapter.embeddingIdentity.provider,
			model: adapter.embeddingIdentity.model,
			pending,
		};
	}

	indexGit(signal?: AbortSignal): Promise<number> {
		if (this.#gitRun) return this.#gitRun;
		const controller = new AbortController();
		this.#gitAbort = controller;
		const forwardAbort = (): void => controller.abort(signal?.reason);
		signal?.addEventListener("abort", forwardAbort, { once: true });
		const run = this.#runGitIndex(controller.signal).finally(() => {
			signal?.removeEventListener("abort", forwardAbort);
			if (this.#gitRun === run) this.#gitRun = undefined;
			if (this.#gitAbort === controller) this.#gitAbort = undefined;
		});
		this.#gitRun = run;
		return run;
	}

	async #runGitIndex(signal: AbortSignal): Promise<number> {
		const projectId = this.#projectId;
		const cwd = this.#cwd;
		if (this.#disposed || !projectId || !cwd || !this.#settings.get("contextManager.gitCommitIndexing.enabled")) {
			return 0;
		}
		const jobId = `git-index:${projectId}`;
		this.#store.ensureJob({ id: jobId, projectId, kind: "git-index", task: "head-non-merge" });
		if (!this.#store.tryAcquireJobLease(jobId, this.#ownerId, GIT_INDEX_LEASE_MS)) return 0;
		try {
			const since = Date.now() - this.#settings.get("contextManager.gitCommitIndexing.sinceDays") * 86_400_000;
			const maxCommits = this.#settings.get("contextManager.gitCommitIndexing.maxCommits");
			const commits = await git.log.metadata(cwd, { since, maxCommits, signal });
			if (this.#disposed) {
				this.#store.releaseJobLease(jobId, this.#ownerId, "paused");
				return 0;
			}
			if (!commits) {
				this.#store.finishJob(jobId, this.#ownerId, "failed", { error: "Git HEAD is unavailable" });
				return 0;
			}
			const changes = this.#store.replaceGitCommits(
				projectId,
				commits.map(commit => ({ projectId, ...commit })),
				maxCommits,
			);
			this.#store.finishJob(jobId, this.#ownerId, "succeeded", { progress: 1 });
			if (changes > 0 && this.#embeddingScheduled) void Bun.sleep(0).then(() => this.startEmbeddingDrain());
			return changes;
		} catch (error) {
			this.#store.finishJob(jobId, this.#ownerId, signal?.aborted ? "cancelled" : "failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return 0;
		}
	}

	beginDispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#gitTimer);
		this.#gitTimer = undefined;
		this.#embeddingAbort?.abort(new Error("Context search service is disposing"));
		this.#gitAbort?.abort(new Error("Context search service is disposing"));
	}

	async dispose(): Promise<void> {
		this.beginDispose();
		const pending = [this.#embeddingRun, this.#gitRun].filter(
			(value): value is Promise<ContextEmbeddingStatus> | Promise<number> => value !== undefined,
		);
		if (pending.length > 0) {
			await Promise.race([Promise.allSettled(pending), Bun.sleep(5_000)]);
		}
	}

	async #runEmbeddingDrain(signal: AbortSignal): Promise<ContextEmbeddingStatus> {
		const adapter = this.#memory;
		const projectId = this.#projectId;
		if (
			this.#disposed ||
			!this.#settings.get("contextManager.embeddings.enabled") ||
			!adapter?.available ||
			!adapter.embeddingIdentity.enabled ||
			!projectId
		) {
			return { state: "unavailable", pending: 0, completed: 0, progress: 0 };
		}
		const { provider, model } = adapter.embeddingIdentity;
		const jobId = `embed:${projectId}`;
		this.#store.ensureJob({ id: jobId, projectId, kind: "embed", task: `${provider}:${model}` });
		if (!this.#store.tryAcquireJobLease(jobId, this.#ownerId, EMBEDDING_LEASE_MS)) return this.embeddingStatus();
		const total = this.#store.countDocumentsMissingEmbedding(projectId, provider, model);
		let completed = 0;
		this.#embeddingState = { state: "running", provider, model, pending: total, completed, progress: 0 };
		try {
			while (true) {
				signal.throwIfAborted();
				const documents = this.#store.listDocumentsMissingEmbedding(
					projectId,
					provider,
					model,
					EMBEDDING_BATCH_SIZE,
				);
				if (documents.length === 0) break;
				const vectors = await adapter.embedBatch(documents.map(document => `${document.title}\n${document.text}`));
				signal.throwIfAborted();
				if (!vectors || vectors.length !== documents.length) {
					this.#store.releaseJobLease(jobId, this.#ownerId, "paused");
					this.#embeddingState = {
						state: "unavailable",
						provider,
						model,
						pending: Math.max(0, total - completed),
						completed,
						progress: total > 0 ? completed / total : 0,
						error: "Embedding provider returned no complete batch",
					};
					return this.#embeddingState;
				}
				for (let index = 0; index < documents.length; index++) {
					const document = documents[index];
					const vector = vectors[index];
					if (!document || !vector) continue;
					this.#store.putEmbedding(document.id, provider, model, vector, document.contentHash);
					completed++;
				}
				const progress = total > 0 ? Math.min(1, completed / total) : 1;
				if (!this.#store.heartbeatJobLease(jobId, this.#ownerId, EMBEDDING_LEASE_MS)) {
					throw new Error("Context embedding lease ownership was lost");
				}
				this.#store.updateJobProgress(jobId, this.#ownerId, progress);
				this.#embeddingState = {
					state: "running",
					provider,
					model,
					pending: Math.max(0, total - completed),
					completed,
					progress,
				};
			}
			this.#store.finishJob(jobId, this.#ownerId, "succeeded", { progress: 1 });
			this.#embeddingState = { state: "idle", provider, model, pending: 0, completed, progress: 1 };
			return this.#embeddingState;
		} catch (error) {
			if (signal.aborted) {
				this.#store.releaseJobLease(jobId, this.#ownerId, "paused");
				this.#embeddingState = {
					...this.#embeddingState,
					state: "paused",
					pending: Math.max(0, total - completed),
					completed,
				};
			} else {
				const message = error instanceof Error ? error.message : String(error);
				this.#store.finishJob(jobId, this.#ownerId, "failed", { error: message });
				this.#embeddingState = {
					...this.#embeddingState,
					state: "failed",
					pending: Math.max(0, total - completed),
					completed,
					error: message,
				};
			}
			return this.#embeddingState;
		}
	}
}
