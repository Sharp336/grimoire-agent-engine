/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`hub`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 */

import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";

export const MAIN_AGENT_ID = "Main";

/** Reserved pseudo-recipient for `hub send --to all` (broadcast fan-out); never a real/registered agent id. */
export const BROADCAST_ID = "all";

/**
 * Reserved leading marker for the cross-process REMOTE agent id space (`@<namespace>/<name>`, see
 * `src/irc/bus.ts`). A LOCAL agent id (`main`/`sub`) may never begin with it, so local and remote id
 * spaces are disjoint by construction — no per-id reserved-name or clobber guards are needed.
 */
export const REMOTE_ID_PREFIX = "@";

/** Sidecar marker retained beside a child transcript after an explicit kill. */
const AGENT_TOMBSTONE_SUFFIX = ".tombstone";

export function getAgentTombstonePath(sessionFile: string): string {
	return `${sessionFile}${AGENT_TOMBSTONE_SUFFIX}`;
}

/**
 * - `running`: a turn is in flight.
 * - `idle`: live AgentSession in memory, awaiting work. Finished agents are
 *   `idle`, not removed.
 * - `parked`: session disposed; AgentRef + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal.
 */
export type AgentStatus = "running" | "idle" | "parked" | "aborted";
/** Provenance of a displayed duration: active runtime, transcript span, or unavailable. */
type AgentDurationKind = "active" | "span" | "unknown";
/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents) — messageable
 *   peers with a locally-managed session.
 * - `advisor`: a passive review transcript, persisted for usage attribution + Agent Hub
 *   observability, but never a peer — hidden from agent-facing rosters (`hub`, `history://`)
 *   and not messageable/revivable.
 * - `remote`: a proxy for an agent on another node (murmur-q00p) — a messageable peer with NO
 *   local session (controlled over IRC/the transport, not the local lifecycle).
 * See the capability predicates below (isMessageablePeer / isLocalSession / hasLocalPresence).
 */
export type AgentKind = "main" | "sub" | "advisor" | "remote";

/**
 * Capability taxonomy for {@link AgentKind} — the single source of truth for the class
 * differences callers care about, so each surface tests a capability instead of a scattered
 * `kind !== "advisor"` / `kind !== "remote"` denylist. A new kind declares its membership
 * here once, not across every consumer.
 */
/** Messageable peer: appears in the IRC roster and is a broadcast target (main | sub | remote). */
export function isMessageablePeer(kind: AgentKind): boolean {
	return kind !== "advisor";
}
/**
 * Locally-managed session (main | sub): focus/revive/kill via the local lifecycle,
 * disk-restorable, drivable by collab guests, readable via the agent-facing `history://`.
 * A `remote` proxy is controlled over IRC (no local session); an `advisor` is read-only.
 */
export function isLocalSession(kind: AgentKind): boolean {
	return kind === "main" || kind === "sub";
}
/**
 * Has a local presence to display/read — a live/parked session or a persisted transcript
 * (main | sub | advisor); a `remote` proxy has neither.
 */
export function hasLocalPresence(kind: AgentKind): boolean {
	return kind !== "remote";
}
/**
 * A peer worth waiting on for a future message: a `running` local agent (its status tracks its
 * turn), or any live `remote` proxy — a remote executes off-node and can deliver an inbound
 * message at any time, so its local idle/running status is not a waitability signal. Takes the
 * full ref (kind + status), unlike the kind-only predicates above.
 *
 * INTERIM band-aid over the `running`-only wait-liveness gate, which is already racy for local
 * peers (an idle-but-wakeable peer can still deliver). Remove once that gate is redesigned to
 * "waitable = alive, timeout as backstop" — see can1357/oh-my-pi#7503.
 */
export function isWaitablePeer(ref: AgentRef): boolean {
	return ref.status === "running" || ref.kind === "remote";
}

/** Persisted per-agent totals reconstructed from the child session transcript. */
export interface AgentMetricsSummary {
	tokens: number;
	requests: number;
	tools: number;
	cost: number;
	durationMs: number;
	durationKind?: AgentDurationKind;
	contextTokens?: number;
	contextWindow?: number;
}

/** Historical identity and telemetry that remain available after the live session is disposed. */
export interface AgentHistorySummary {
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;
	/** Whether the last resolved model was selected by retry fallback routing. */
	resolvedModelIsFallback?: boolean;
	metrics?: AgentMetricsSummary;
	readOnly?: boolean;
	/** Durable task output artifact, when the executor wrote one. */
	outputPath?: string;
	/** Captured isolated-worktree patch, when patch capture succeeded. */
	patchPath?: string;
	/** Isolated branch identity, when branch-mode capture succeeded. */
	branchName?: string;
}

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	/** Null exactly when parked/aborted. */
	session: AgentSession | null;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	/** Short gist of what the agent is currently doing (latest intent or tool), for the work-aware roster. Display-only. */
	activity?: string;
	/** Persisted identity and telemetry restored after the live observer is gone. */
	history?: AgentHistorySummary;
	/**
	 * Per-load owner token of the extension that registered this ref (e.g. a `remote` proxy seeded via
	 * `pi.irc.registerRemotePeer`), formatted `${extensionPath}:${randomId}`. Unique per extension
	 * LOAD — not per source path — so a failed or unloading load rolls back exactly its own refs
	 * without touching a sibling load of the same extension (subagents / other SDK sessions reuse the
	 * path) (can1357/oh-my-pi#7401 review).
	 */
	ownerToken?: string;
}

export type AgentRefExpectation = AgentRef | AgentSession;

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "metadata_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	status?: AgentStatus;
	/** Last persisted task summary, when restoring a historical agent. */
	activity?: string;
	/** Original registration timestamp, when known from persisted history. */
	createdAt?: number;
	/** Last transcript activity timestamp, when known from persisted history. */
	lastActivity?: number;
	/** Persisted identity and telemetry restored after the live observer is gone. */
	history?: AgentHistorySummary;
	/** Per-load owner token of the registering extension load, for attribution-based rollback (see {@link AgentRef.ownerToken}). */
	ownerToken?: string;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();

	#matchesExpected(ref: AgentRef, expected?: AgentRefExpectation): boolean {
		return expected === undefined || ref === expected || ref.session === expected;
	}

	register(input: RegisterInput): AgentRef {
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: input.createdAt ?? now,
			lastActivity: input.lastActivity ?? now,
			activity: input.activity,
			history: input.history,
			ownerToken: input.ownerToken,
		};
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	/**
	 * Register a new id only when it is absent, or reuse the exact detached
	 * `parked` ref a revival was authorized to revive. A missing, replaced, or
	 * terminal expected ref is a failed CAS: delayed revivers must never claim an
	 * id after its prior generation disappeared or was hard-killed.
	 */
	registerIfAvailable(input: RegisterInput, expected: AgentRef | null): AgentRef | undefined {
		const current = this.#refs.get(input.id);
		if (expected === null) return current ? undefined : this.register(input);
		return current === expected && current.status === "parked" && !current.session ? current : undefined;
	}

	/** Attach transcript-derived identity and telemetry without changing lifecycle state. */
	setHistory(id: string, history: AgentHistorySummary, expectedSessionFile?: string): boolean {
		const ref = this.#refs.get(id);
		if (!ref || (expectedSessionFile !== undefined && ref.sessionFile !== expectedSessionFile)) return false;
		const definedHistory = Object.fromEntries(
			Object.entries(history).filter(([, value]) => value !== undefined),
		) as AgentHistorySummary;
		ref.history = { ...ref.history, ...definedHistory };
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	setStatus(id: string, status: AgentStatus, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		// `aborted` is terminal: delayed progress/revival work from the killed
		// generation must never transition the tombstone back to a live status.
		if (ref.status === "aborted") return status === "aborted";
		if (ref.status === status) return true;
		ref.status = status;
		// Activity describes current work; it is meaningless once the agent
		// leaves `running`, so drop it to avoid showing stale work in rosters.
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	/**
	 * Record a short activity gist for the work-aware roster. Display-only and
	 * read on demand (`irc list`, peer roster), so it emits no event — keeping
	 * the per-tool-call update rate off the registry listener path (same as
	 * `attachSession`, which also bumps `lastActivity` without emitting). Only a
	 * `running` agent has current work: a heartbeat for any other status is
	 * dropped, so a late progress flush can't resurrect activity on a ref that
	 * `setStatus` just cleared. Every running heartbeat refreshes `lastActivity`
	 * — even when the gist text is unchanged — so the roster's "active … ago" and
	 * recency sort track real work, not just the last status change.
	 * The gist is normalized to one bounded line (`oneLineLabel`) so model-derived
	 * intent text can neither break the roster nor smuggle terminal escapes —
	 * every caller is safe without sanitizing at its own call site.
	 */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
	}

	attachSession(
		id: string,
		session: AgentSession,
		sessionFile?: string | null,
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.#refs.get(id);
		// Never attach a late-created session to a hard-killed tombstone. This
		// closes the race between a parked reviver claiming the ref and finishing
		// createAgentSession after an explicit kill.
		if (!ref || ref.status === "aborted" || !this.#matchesExpected(ref, expected)) return false;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		ref.session = null;
		return true;
	}

	unregister(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
		return true;
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	/**
	 * Every alive (running | idle) messageable peer except the caller — the IRC roster /
	 * broadcast target set. Advisors are observability-only (never peers); remote proxies are
	 * included when live, since the bridge registers them running/idle (murmur-q00p).
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref => ref.id !== id && isMessageablePeer(ref.kind) && (ref.status === "running" || ref.status === "idle"),
		);
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
