/**
 * OKF session state — the additive knowledge layer that runs alongside the
 * active memory backend.
 *
 * Unlike the memory backends (hindsight/mnemopi/local), OKF is NOT mutually
 * exclusive with them. It runs independently: loads concepts from the on-disk
 * bundle, maintains a derived search index, and injects relevant concepts
 * into the system prompt at session start.
 *
 * Lifecycle mirrors the memory backend pattern:
 *   - `start()` is called once per session at startup.
 *   - `buildDeveloperInstructions()` returns the static + recall block appended
 *     to the base system prompt.
 *   - `beforeAgentStartPrompt()` runs just before the first generation, doing
 *     auto-recall against the first user message.
 */

import * as logger from "@oh-my-pi/pi-utils/logger";
import type { Settings } from "../config/settings";
import okfInstructions from "../prompts/okf/okf-instructions.md" with { type: "text" };
import okfRecallSnippet from "../prompts/okf/okf-recall-snippet.md" with { type: "text" };
import { loadConcept, loadSummaries, loadSummary, resolveBundleRoot } from "./bundle";
import { resolveOkfStore } from "./store/store-resolve";
import type { OkfStore } from "./store/types";

export interface OkfSessionStateOptions {
	sessionId: string;
	settings: Settings;
	cwd: string;
	store?: OkfStore;
	aliasOf?: OkfSessionState;
}

export class OkfSessionState {
	readonly #sessionId: string;
	readonly #settings: Settings;
	readonly #cwd: string;
	readonly #store: OkfStore | undefined;
	readonly #aliasOf: OkfSessionState | undefined;

	#lastRecallSnippet: string | undefined;
	#hasRecalledForFirstTurn = false;
	#disposed = false;

	constructor(options: OkfSessionStateOptions) {
		this.#sessionId = options.sessionId;
		this.#settings = options.settings;
		this.#cwd = options.cwd;
		this.#store = options.store;
		this.#aliasOf = options.aliasOf;
	}

	get aliasOf(): OkfSessionState | undefined {
		return this.#aliasOf;
	}

	get lastRecallSnippet(): string | undefined {
		return this.#aliasOf?.lastRecallSnippet ?? this.#lastRecallSnippet;
	}

	get bundleRoot(): string {
		// An alias shares the parent's bundle/store, so its bundle root is the
		// parent's — not the child session's cwd.
		if (this.#aliasOf) return this.#aliasOf.bundleRoot;
		const custom = this.#settings.get("okf.bundleDir") as string | undefined;
		// Resolve a relative `okf.bundleDir` against the session cwd (not the
		// process cwd) so reindex/auto-recall match `okf://` reads/writes.
		return resolveBundleRoot(this.#cwd, custom);
	}

	get store(): OkfStore | undefined {
		return this.#aliasOf?.store ?? this.#store;
	}

	/**
	 * Reconcile the search index with the on-disk bundle.
	 * Walks the bundle, upserts every concept into the store, and removes
	 * entries for concepts that no longer exist.
	 */
	async reindex(): Promise<number> {
		const store = this.store;
		if (!store) return 0;

		const root = this.bundleRoot;
		const summaries = await loadSummaries(root, { autoUpdate: false });
		const seenIds = new Set<string>();

		// Load concept bodies and upsert.
		for (const summary of summaries) {
			seenIds.add(summary.id);
			try {
				const concept = await loadConcept(root, summary.id);
				await store.upsert(summary, concept.body);
			} catch {
				// Skip concepts that fail to load.
			}
		}

		// Remove stale entries.
		const existing = await store.list({ limit: 10000 });
		for (const item of existing) {
			if (!seenIds.has(item.id)) {
				await store.delete(item.id);
			}
		}

		return summaries.length;
	}

	/**
	 * Recall concepts relevant to a query string and cache the rendered snippet.
	 * Called from `beforeAgentStartPrompt` for auto-recall, and from the
	 * `okf_recall` tool for explicit search.
	 */
	async recall(query: string, limit?: number): Promise<string | undefined> {
		const effectiveLimit = limit ?? 5;
		const store = this.store;
		if (!store) return undefined;

		const results = await store.search(query, { limit: effectiveLimit });
		if (results.length === 0) return undefined;

		const lines = results.map(r => {
			const href = r.id.includes("/") ? `okf://${r.id}.md` : `okf:///${r.id}.md`;
			return `- ${r.type}: [${r.title ?? r.id}](${href}) — ${r.description}`;
		});
		const snippet = okfRecallSnippet.replace("{{concepts}}", lines.join("\n"));

		this.#lastRecallSnippet = snippet;
		return snippet;
	}

	/**
	 * Hook called just before the agent starts generating its first response.
	 * If `okf.autoRecall` is enabled, extracts the user's message and recalls
	 * relevant concepts.
	 */
	async beforeAgentStartPrompt(promptText: string): Promise<string | undefined> {
		if (this.#hasRecalledForFirstTurn) return undefined;
		this.#hasRecalledForFirstTurn = true;

		if (!this.#settings.get("okf.autoRecall")) return undefined;

		// Extract search keywords from the prompt text: strip stopwords,
		// take the most significant tokens (up to ~10), not raw prose.
		const query = extractQuery(promptText);
		if (!query) return undefined;

		// Derive recall limit from okf.recallMaxTokens setting (~1 concept per 400 tokens).
		const maxTokens = this.#settings.get("okf.recallMaxTokens") as number;
		const limit = maxTokens ? Math.max(1, Math.floor(maxTokens / 400)) : 5;

		try {
			return await this.recall(query, limit);
		} catch {
			return undefined;
		}
	}

	/**
	 * Index (upsert) a single concept into the active store after it has been
	 * written to disk — e.g. via `write okf://…` — so recall/search stay in sync
	 * with the on-disk bundle without waiting for a full reindex. Best-effort:
	 * failures are swallowed (the write itself already succeeded).
	 */
	async indexConcept(id: string): Promise<void> {
		const store = this.store;
		if (!store) return;
		try {
			const root = this.bundleRoot;
			const summary = await loadSummary(root, id);
			const concept = await loadConcept(root, id);
			await store.upsert(summary, concept.body);
		} catch (error) {
			logger.debug("OKF: failed to index concept after write", {
				id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Reset the first-turn auto-recall guard for a new transcript/conversation
	 * (e.g. `/new`, handoff, fork, branch, or switching sessions within the same
	 * `AgentSession`). Without this, `#hasRecalledForFirstTurn` stays true from
	 * the previous conversation and the new one's first turn skips OKF
	 * auto-recall entirely.
	 */
	resetFirstTurnRecall(): void {
		this.#hasRecalledForFirstTurn = false;
		this.#lastRecallSnippet = undefined;
	}

	/**
	 * Static OKF instructions appended to the base system prompt.
	 */
	async buildDeveloperInstructions(): Promise<string | undefined> {
		const rendered = okfInstructions.trim();
		return rendered || undefined;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		// Only the primary (non-alias) state owns the store.
		if (!this.#aliasOf && this.#store) {
			this.#store.close().catch(() => {});
		}
	}
}

/**
 * Start the OKF session layer if `okf.enabled` is true.
 * Returns the OkfSessionState or `undefined` if disabled or inert.
 */
export async function startOkfLayer(options: {
	sessionId: string;
	settings: Settings;
	cwd: string;
	taskDepth: number;
	parentOkfState?: OkfSessionState;
}): Promise<OkfSessionState | undefined> {
	const { sessionId, settings, cwd, taskDepth, parentOkfState } = options;

	if (!settings.get("okf.enabled")) return undefined;

	// Subagents alias the parent's state so they share the same bundle/store.
	if (taskDepth > 0 && parentOkfState) {
		return new OkfSessionState({
			sessionId,
			settings,
			cwd,
			aliasOf: parentOkfState,
		});
	}

	// Resolve the store (auto = Hindsight if configured, else SQLite).
	const customBundleDir = settings.get("okf.bundleDir") as string | undefined;
	const { store, backend } = await resolveOkfStore(settings, cwd, customBundleDir ?? undefined);

	const state = new OkfSessionState({ sessionId, settings, cwd, store });

	// Reindex on start if enabled.
	if (settings.get("okf.reindexOnStart")) {
		try {
			const count = await state.reindex();
			if (count > 0) {
				logger.debug("OKF: concepts indexed", { count, backend });
			}
		} catch (error) {
			logger.warn("OKF: reindex failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	return state;
}

/**
 * WeakMap-based session state storage (mirrors the hindsight/mnemopi pattern
 * but using a standalone map to avoid modifying AgentSession internals for now).
 */
const okfStates = new WeakMap<object, OkfSessionState | undefined>();

export function getOkfSessionState(session: object): OkfSessionState | undefined {
	return okfStates.get(session);
}

export function setOkfSessionState(session: object, state: OkfSessionState | undefined): OkfSessionState | undefined {
	const previous = okfStates.get(session);
	if (previous) previous.dispose();
	okfStates.set(session, state);
	return previous;
}

/**
 * Dispose the OKF session state for a session (closes the SQLite store).
 * Call during session teardown alongside the memory backend cleanup.
 */
export function disposeOkfSessionState(session: object): void {
	const state = okfStates.get(session);
	if (state) state.dispose();
	okfStates.delete(session);
}

const STOPWORDS: ReadonlySet<string> = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"to",
	"of",
	"in",
	"on",
	"at",
	"by",
	"for",
	"with",
	"from",
	"as",
	"into",
	"about",
	"than",
	"that",
	"this",
	"these",
	"those",
	"it",
	"its",
	"and",
	"or",
	"but",
	"not",
	"no",
	"so",
	"if",
	"can",
	"could",
	"should",
	"would",
	"will",
	"just",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"what",
	"which",
	"who",
	"how",
	"why",
	"when",
	"where",
	"there",
	"here",
	"all",
	"any",
	"some",
	"each",
	"every",
	"both",
	"few",
	"more",
	"most",
	"other",
	"such",
	"only",
	"own",
	"same",
	"very",
	"just",
	"too",
	"also",
	"now",
	"then",
	"also",
	"get",
	"got",
	"make",
	"made",
	"use",
	"using",
	"used",
	"like",
	"need",
	"want",
	"know",
	"think",
	"say",
	"tell",
	"let",
	"set",
	"put",
	"take",
	"give",
	"go",
	"come",
	"see",
	"try",
	"help",
	"show",
	"find",
]);

/**
 * Extract search keywords from a prompt string. Strips common English stopwords
 * and takes up to 10 significant tokens (3+ chars), to produce a focused FTS5 query.
 */
function extractQuery(promptText: string): string {
	const words = promptText
		.toLowerCase()
		.replace(/[^\w\s-]/g, " ")
		.split(/\s+/)
		.filter(w => w.length >= 3 && !STOPWORDS.has(w));
	return [...new Set(words)].slice(0, 10).join(" ");
}
