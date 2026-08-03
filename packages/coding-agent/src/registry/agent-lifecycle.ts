/**
 * AgentLifecycleManager - Owns the idle → parked → revived lifecycle of
 * adopted subagents.
 *
 * The task executor hands a finished agent over via {@link AgentLifecycleManager.adopt};
 * from then on the manager arms a TTL timer whenever the agent goes `idle`,
 * parks it on expiry (disposes the live session, keeps the AgentRef +
 * sessionFile), and revives it on demand through
 * {@link AgentLifecycleManager.ensureLive}. Only this manager flips
 * `parked` ↔ `idle`.
 *
 * Park/dispose is gated against concurrent ensureLive/hub-send:
 * - A disposing session is never handed out.
 * - ensureLive during an in-flight park either cancels the park (session still
 *   live) or waits for detach+park and then revives.
 * - Concurrent ensureLive/park operations coalesce per id.
 *
 * Every adoption, park, and revival is bound to the exact {@link AgentRef} it
 * started from, so stale async work (a late finalizer, a cancelled initializer,
 * a superseded revive) can never clobber a newer same-id ref.
 */

import * as fs from "node:fs/promises";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { trackLateCleanup } from "../utils/late-cleanup";
import {
	type AgentRef,
	type AgentRefExpectation,
	AgentRegistry,
	getAgentTombstonePath,
	MAIN_AGENT_ID,
	type RegistryEvent,
} from "./agent-registry";

const TERMINATION_ABORT_TIMEOUT_MS = 5_000;

export type AgentReviver = (expected: AgentRef) => Promise<AgentSession>;

const AGENT_RELEASE_GRACE_MS = 5000;

async function persistAgentTombstone(sessionFile: string): Promise<void> {
	try {
		await fs.writeFile(getAgentTombstonePath(sessionFile), "", { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/**
 * Builds a reviver for a `parked` ref restored from disk (Agent Hub scan,
 * collab mirror, resumed process) that carries a sessionFile but no in-memory
 * adoption. Returns undefined when the ref cannot be faithfully rebuilt (no
 * persisted session contract, or its workspace is gone). Injected from the
 * top-level session so this manager stays free of sdk/SessionManager imports.
 */
export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;

export interface AdoptOptions {
	/** TTL before an idle agent is parked. <= 0 disables parking. */
	idleTtlMs: number;
	/** Recreates a live AgentSession from the ref's sessionFile. Absent => not resumable after park (e.g. isolated runs). */
	revive?: AgentReviver;
}

interface AdoptedAgent {
	ref: AgentRef;
	idleTtlMs: number;
	revive?: AgentReviver;
	timer?: NodeJS.Timeout;
}

interface ParkInFlight {
	/** The exact ref this park was started for. */
	ref: AgentRef;
	/** Resolves when the park attempt finishes (success, cancel, or dispose error). */
	promise: Promise<void>;
	/** Cancel before the session is detached. Returns true if cancel took effect. */
	cancel: () => boolean;
	/** True once cancel() succeeded (ensureLive kept the live session). */
	cancelled: boolean;
	/** True once the live session has been detached and status is parked. */
	detached: boolean;
}

interface RevivingAgent {
	ref: AgentRef;
	promise: Promise<AgentSession>;
}

interface ActiveRun {
	ref: AgentRef;
	session: AgentSession;
	abort: () => Promise<void>;
}

interface TerminatingAgent {
	ref: AgentRef;
	session: AgentSession | null;
	promise: Promise<void>;
}

export class AgentLifecycleManager {
	static #global: AgentLifecycleManager | undefined;

	static global(): AgentLifecycleManager {
		if (!AgentLifecycleManager.#global) {
			AgentLifecycleManager.#global = new AgentLifecycleManager();
		}
		return AgentLifecycleManager.#global;
	}

	/** Reset the global manager. Test-only. */
	static resetGlobalForTests(): void {
		const current = AgentLifecycleManager.#global;
		if (current) {
			current.#unsubscribe?.();
			current.#unsubscribe = undefined;
			for (const adopted of current.#adopted.values()) {
				clearTimeout(adopted.timer);
			}
			current.#adopted.clear();
			current.#revivals.clear();
			current.#parks.clear();
			current.#runs.clear();
			current.#terminations.clear();
			current.#persistedReviverFactory = undefined;
		}
		AgentLifecycleManager.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/**
	 * In-flight park attempts, each bound to the ref it started from. A park is
	 * cancelable until the live session is detached; after detach, ensureLive
	 * waits for the park and revives.
	 */
	readonly #parks = new Map<string, ParkInFlight>();
	/** In-flight revives, bound to the parked ref that initiated them, so concurrent {@link ensureLive} calls coalesce. */
	readonly #revivals = new Map<string, RevivingAgent>();
	/** Active executor runs, used to stop the run monitor rather than only its current model turn. */
	readonly #runs = new Map<string, ActiveRun>();
	/** Terminal cleanup coalesced per exact ref. */
	readonly #terminations = new Map<string, TerminatingAgent>();
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedSubagentReviverFactory | undefined;
	/** TTL applied when a cold-revived ref is adopted on demand. */
	#persistedReviveTtlMs = 0;

	constructor(registry: AgentRegistry = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	/**
	 * Install the factory used to cold-revive `parked` refs restored from disk
	 * (Agent Hub scan, collab mirror, resumed process) — they carry a sessionFile
	 * but no adoption. Set by the top-level session, which owns the ambient deps
	 * (auth, models, MCP, artifacts) the factory needs at revive time.
	 */
	setPersistedSubagentReviverFactory(factory: PersistedSubagentReviverFactory, idleTtlMs: number): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtlMs = idleTtlMs;
	}

	/**
	 * Take ownership of a finished subagent. Caller has already set registry
	 * status to "idle". Arms the TTL timer (idleTtlMs <= 0 adopts without one).
	 * When `expected` is given, the adoption is refused if the id no longer
	 * resolves to that ref (or that ref's session).
	 */
	adopt(id: string, opts: AdoptOptions, expected?: AgentRefExpectation): void {
		if (id === MAIN_AGENT_ID) return;
		const ref = this.#registry.get(id);
		if (!ref || (expected !== undefined && ref !== expected && ref.session !== expected)) {
			logger.warn("AgentLifecycleManager.adopt: unknown or replaced agent id", { id });
			return;
		}
		const existing = this.#adopted.get(id);
		clearTimeout(existing?.timer);
		const adopted: AdoptedAgent = { ref, idleTtlMs: opts.idleTtlMs, revive: opts.revive };
		this.#adopted.set(id, adopted);
		this.#armTimer(id, adopted);
	}

	/** True if the id is adopted (parked or live) — and, when `expected` is given, still bound to that ref. */
	has(id: string, expected?: AgentRefExpectation): boolean {
		const adopted = this.#adopted.get(id);
		return Boolean(
			adopted && (expected === undefined || adopted.ref === expected || adopted.ref.session === expected),
		);
	}

	/**
	 * True when this manager owns `registry` — i.e. its adopt/park/revive state
	 * describes that registry's refs. Lets a caller holding a specific registry
	 * (e.g. a custom-registry {@link IrcBus} that fell back to the global
	 * manager) skip lifecycle gating that would consult unrelated park state.
	 */
	manages(registry: AgentRegistry): boolean {
		return this.#registry === registry;
	}

	/**
	 * Bind a live session to its owning executor run. Descendant cancellation
	 * invokes `abort` so the run monitor's signal stops yield retries and final
	 * lifecycle bookkeeping, not merely the session's current model turn.
	 */
	trackRun(id: string, session: AgentSession, abort: () => Promise<void>): () => void {
		const ref = this.#registry.get(id);
		if (!ref || ref.session !== session || ref.status === "aborted") return () => {};
		const run: ActiveRun = { ref, session, abort };
		this.#runs.set(id, run);
		return () => {
			if (this.#runs.get(id) === run) this.#runs.delete(id);
		};
	}

	/** Wait for terminal cleanup when cancellation already owns this ref. */
	async waitForTermination(id: string, expected?: AgentRefExpectation): Promise<void> {
		const termination = this.#terminations.get(id);
		if (termination && (expected === undefined || termination.ref === expected || termination.session === expected)) {
			await termination.promise;
		}
	}

	/** True while terminal cancellation owns disposal/detachment for this exact ref. */
	isTerminating(id: string, expected?: AgentRefExpectation): boolean {
		const termination = this.#terminations.get(id);
		return Boolean(
			termination && (expected === undefined || termination.ref === expected || termination.session === expected),
		);
	}

	/**
	 * True while {@link park} is disposing this agent's session (lets dispose
	 * hooks distinguish park from teardown). False once the park is cancelled
	 * by ensureLive or after detach+dispose completes. When `expected` is
	 * given, only a park bound to that ref (or its session) counts.
	 */
	isParking(id: string, expected?: AgentRefExpectation): boolean {
		const park = this.#parks.get(id);
		return Boolean(
			park && !park.cancelled && (expected === undefined || park.ref === expected || park.ref.session === expected),
		);
	}

	/**
	 * Dispose the live session, detach it from the registry, and mark the
	 * agent `parked`. No-op unless the id is adopted and live.
	 *
	 * The session is detached (and status flipped to `parked`) *before*
	 * `session.dispose()` so concurrent {@link ensureLive}/hub-send never
	 * observe or inject into a disposing session. A concurrent ensureLive that
	 * arrives before detach cancels the park and keeps the live session.
	 */
	async park(id: string): Promise<void> {
		const existing = this.#parks.get(id);
		if (existing) return existing.promise;

		const adopted = this.#adopted.get(id);
		if (!adopted) return;
		const ref = this.#registry.get(id);
		if (!ref || adopted.ref !== ref || ref.status !== "idle") return;
		const session = ref.session;
		if (!session) return;

		if (adopted.timer) {
			clearTimeout(adopted.timer);
			adopted.timer = undefined;
		}

		let cancelled = false;
		const park: ParkInFlight = {
			ref,
			promise: undefined as unknown as Promise<void>,
			cancel: () => {
				// Cancel only before detach — once detached the old session is already
				// leaving the registry and must finish disposing.
				if (park.detached || cancelled) return cancelled;
				cancelled = true;
				park.cancelled = true;
				return true;
			},
			cancelled: false,
			detached: false,
		};

		park.promise = (async () => {
			try {
				// Yield so a same-tick ensureLive/hub-send can cancel before we
				// commit to dispose. Deterministic with Promise microtasks; no timers.
				await Promise.resolve();
				if (cancelled) return;

				// Re-check liveness: release/unregister/replace may have raced us.
				const live = this.#registry.get(id);
				if (live !== ref || !live.session || live.session !== session) return;
				if (this.#adopted.get(id)?.ref !== ref) return;

				// Commit: detach + parked *before* dispose so callers never see a
				// dying session via ref.session / idle status.
				park.detached = true;
				this.#registry.detachSession(id, ref);
				this.#registry.setStatus(id, "parked", ref);

				try {
					await session.dispose();
				} catch (error) {
					logger.warn("AgentLifecycleManager.park: session dispose failed", { id, error: String(error) });
				}
			} finally {
				// Only clear if we are still the in-flight entry (a later park would
				// have replaced us only after we resolved).
				if (this.#parks.get(id) === park) this.#parks.delete(id);
			}
		})();

		this.#parks.set(id, park);
		return park.promise;
	}

	/**
	 * Return the live session, reviving from the sessionFile if parked.
	 * Throws a plain Error if the id is unknown or parked without a reviver.
	 * Concurrent calls share one in-flight revive.
	 *
	 * Never returns a session that is mid-dispose: an in-flight park is either
	 * cancelled (session still live) or awaited to completion before revive.
	 */
	async ensureLive(id: string): Promise<AgentSession> {
		const park = this.#parks.get(id);
		if (park) {
			const parked = this.#registry.get(id);
			// Cancel if the live session is still attached — keep it instead of
			// thrashing dispose + revive.
			if (parked?.session && !park.detached && park.cancel()) {
				await park.promise;
				const kept = this.#registry.get(id)?.session;
				if (kept) {
					// Park cleared the idle timer; re-arm so TTL park still works.
					const adopted = this.#adopted.get(id);
					if (adopted && adopted.ref === parked && parked.status === "idle") this.#armTimer(id, adopted);
					return kept;
				}
			} else {
				// Already committed to detach (or no live session): wait for park,
				// then fall through to the revive path.
				await park.promise;
			}
		}

		const ref = this.#registry.get(id);
		if (!ref) {
			throw new Error(
				`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			);
		}
		if (ref.status === "aborted") {
			await this.waitForTermination(id, ref);
			throw new Error(
				`Agent "${id}" is aborted and cannot be revived. Its transcript remains readable at history://${id}.`,
			);
		}
		if (ref.session) return ref.session;
		const inflight = this.#revivals.get(id);
		if (inflight?.ref === ref) return inflight.promise;
		const revival = this.#resolveAndRevive(id, ref);
		const pending: RevivingAgent = { ref, promise: revival };
		this.#revivals.set(id, pending);
		try {
			return await revival;
		} finally {
			if (this.#revivals.get(id) === pending) this.#revivals.delete(id);
		}
	}

	/**
	 * Resolve a reviver and bring the agent back to a live session. A ref
	 * restored from disk is `parked` with a sessionFile but no in-memory
	 * adoption; build a reviver via the injected persisted-subagent factory and
	 * adopt it so the agent rejoins the normal idle↔parked lifecycle. Throws
	 * when the agent is not revivable or no reviver can be produced.
	 */
	async #resolveAndRevive(id: string, ref: AgentRef): Promise<AgentSession> {
		let adoption = this.#adopted.get(id);
		let revive = adoption?.ref === ref ? adoption.revive : undefined;
		let coldAdopted = false;
		if (!revive && ref.status === "parked" && ref.sessionFile && this.#persistedReviverFactory) {
			revive = await this.#persistedReviverFactory(ref);
			if (revive) {
				adoption = { ref, idleTtlMs: this.#persistedReviveTtlMs, revive };
				this.#adopted.set(id, adoption);
				coldAdopted = true;
			}
		}
		if (this.#registry.get(id) !== ref) {
			throw new Error(`Agent "${id}" changed while its persisted session was being prepared.`);
		}
		if (ref.status !== "parked" || !revive || !adoption) {
			throw new Error(
				`Agent "${id}" is ${ref.status} and cannot be revived${revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
			);
		}
		try {
			return await this.#revive(id, revive, ref, adoption);
		} catch (error) {
			// A failed cold revive (stale ctx, missing cwd, bad MCP) must not leave a
			// poisoned reviver stuck in #adopted — drop it so a later ensureLive
			// rebuilds via the factory (which may have fresher context by then).
			if (coldAdopted && this.#adopted.get(id) === adoption) this.#adopted.delete(id);
			throw error;
		}
	}
	/**
	 * Terminally clean up the exact registered subtree. Descendants remain as
	 * detached `aborted` refs so history stays readable and they cannot be
	 * revived. By default the root is unregistered; `tombstone: true` keeps it
	 * as a detached terminal ref after an explicit kill. When `expected` is
	 * given, only a matching ref is released, so stale cleanup cannot remove a
	 * newer same-id generation. Returns true when a matching ref was released.
	 */
	async release(id: string, expected?: AgentRefExpectation, options?: { tombstone?: boolean }): Promise<boolean> {
		const adopted = this.#adopted.get(id);
		const current = this.#registry.get(id);
		const currentMatches =
			current && (expected === undefined || current === expected || current.session === expected);
		if (current && !currentMatches) return false;
		const adoptedMatches =
			adopted && (expected === undefined || adopted.ref === expected || adopted.ref.session === expected);
		const ref = currentMatches ? current : adoptedMatches ? adopted.ref : undefined;
		if (!ref) return false;

		// Snapshot the exact registered subtree before asynchronous cleanup so
		// removing a parent cannot orphan live or revivable descendants.
		const registered = this.#registry.list();
		const subtree = [ref];
		// An adopted ref may be stale while a newer same-id ref is registered.
		// Only a root that is still current owns the registered descendants.
		if (this.#registry.get(id) === ref) {
			const subtreeIds = new Set([ref.id]);
			for (let index = 0; index < subtree.length; index++) {
				const parent = subtree[index];
				for (const child of registered) {
					if (child.parentId === parent.id && !subtreeIds.has(child.id)) {
						subtree.push(child);
						subtreeIds.add(child.id);
					}
				}
			}
		}
		if (options?.tombstone && ref.sessionFile) await persistAgentTombstone(ref.sessionFile);
			}
		}
		for (const descendant of subtree) {
			if (this.#registry.get(descendant.id) === descendant && descendant.status !== "aborted") {
				this.#registry.setStatus(descendant.id, "aborted", descendant);
			}
		}
		await Promise.all(subtree.map(descendant => this.#terminate(descendant)));

		if (!options?.tombstone) this.#registry.unregister(id, ref);
		return true;
	}

	/** Teardown everything (process exit / main session dispose). */
	async dispose(deadlineAt: number = Date.now() + AGENT_RELEASE_GRACE_MS): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		const ids = [...new Set([...this.#adopted.keys(), ...this.#parks.keys(), ...this.#runs.keys()])];
		await Promise.all(
			ids.map(async id => {
				const release = this.release(id).then(() => {});
				try {
					await untilAborted(AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())), () => release);
				} catch (error) {
					if (Date.now() >= deadlineAt) {
						trackLateCleanup(release, { id, resource: "adopted-agent" });
					}
					logger.warn("Agent cleanup exceeded its deadline", {
						id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
		const terminating = [...this.#terminations.values()];
		await Promise.all(
			terminating.map(async entry => {
				try {
					await untilAborted(AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())), () => entry.promise);
				} catch (error) {
					if (Date.now() >= deadlineAt) {
						trackLateCleanup(entry.promise, { id: entry.ref.id, resource: "terminating-agent" });
					}
					logger.warn("Agent termination exceeded its deadline", {
						id: entry.ref.id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
		this.#revivals.clear();
		this.#parks.clear();
		this.#runs.clear();
		this.#terminations.clear();
		this.#persistedReviverFactory = undefined;
	}

	async #revive(id: string, revive: AgentReviver, ref: AgentRef, adopted: AdoptedAgent): Promise<AgentSession> {
		const session = await revive(ref);
		let liveRef = this.#registry.get(id);
		if (liveRef === ref && ref.status !== "parked") {
			await session.dispose();
			if (ref.status === "aborted") {
				throw new Error(`Agent "${id}" became terminal before its persisted session could attach.`);
			}
			throw new Error(`Agent "${id}" changed before its persisted session could attach.`);
		}
		if (liveRef === ref) {
			if (!this.#registry.attachSession(id, session, ref.sessionFile, ref)) {
				await session.dispose();
				throw new Error(`Agent "${id}" changed before its persisted session could attach.`);
			}
			liveRef = ref;
		} else if (
			liveRef !== ref ||
			liveRef.status !== "running" ||
			liveRef.session !== session ||
			liveRef.kind !== ref.kind ||
			liveRef.parentId !== ref.parentId ||
			liveRef.sessionFile !== ref.sessionFile
		) {
			// createAgentSession may have already claimed this exact parked ref and
			// attached the returned session. Any other state — especially an
			// `aborted` tombstone set while revive() was in flight — is stale.
			await session.dispose();
			throw new Error(`Agent "${id}" was replaced or became terminal while its persisted session was reviving.`);
		}
		if (liveRef.status === "aborted") {
			await session.dispose();
			throw new Error(`Agent "${id}" was aborted while its persisted session was reviving.`);
		}
		adopted.ref = liveRef;
		// Emits status_changed → "idle", which re-arms the TTL timer below.
		if (!this.#registry.setStatus(id, "idle", liveRef)) {
			await session.dispose();
			throw new Error(`Agent "${id}" changed before its persisted session became idle.`);
		}
		return session;
	}

	#armTimer(id: string, adopted: AdoptedAgent): void {
		if (adopted.idleTtlMs <= 0) return;
		clearTimeout(adopted.timer);
		const timer = setTimeout(() => {
			adopted.timer = undefined;
			void this.park(id);
		}, adopted.idleTtlMs);
		timer.unref?.();
		adopted.timer = timer;
	}

	async #settleTerminationStep(
		ref: AgentRef,
		step: string,
		deadline: Promise<false>,
		operation: () => Promise<void>,
	): Promise<boolean> {
		let pending: Promise<void>;
		try {
			pending = operation();
		} catch (error) {
			logger.debug(`AgentLifecycleManager descendant ${step} failed`, {
				id: ref.id,
				error: error instanceof Error ? error.message : String(error),
			});
			return true;
		}
		const completion = pending.then(
			() => true,
			error => {
				// Observe late rejections even when the deadline wins the race.
				logger.debug(`AgentLifecycleManager descendant ${step} failed`, {
					id: ref.id,
					error: error instanceof Error ? error.message : String(error),
				});
				return true;
			},
		);
		const settled = await Promise.race([completion, deadline]);
		if (!settled) logger.debug(`AgentLifecycleManager descendant ${step} timed out`, { id: ref.id });
		return settled;
	}

	#terminate(ref: AgentRef): Promise<void> {
		const existing = this.#terminations.get(ref.id);
		if (existing?.ref === ref) return existing.promise;

		const session = ref.session;
		const termination: TerminatingAgent = {
			ref,
			session,
			promise: undefined as unknown as Promise<void>,
		};

		const adopted = this.#adopted.get(ref.id);
		if (adopted?.ref === ref) {
			clearTimeout(adopted.timer);
			this.#adopted.delete(ref.id);
		}
		if (this.#registry.get(ref.id) === ref) {
			if (ref.status !== "aborted") this.#registry.setStatus(ref.id, "aborted", ref);
			// Preserve the live session locally for abort/dispose, but detach it
			// immediately so terminal refs never route callers into dead work.
			this.#registry.detachSession(ref.id, ref);
		}

		let deadlineTimer: NodeJS.Timeout | undefined;
		const { promise: deadline, resolve: resolveDeadline } = Promise.withResolvers<false>();
		deadlineTimer = setTimeout(() => resolveDeadline(false), TERMINATION_ABORT_TIMEOUT_MS);
		deadlineTimer.unref?.();
		termination.promise = (async () => {
			try {
				const park = this.#parks.get(ref.id);
				if (park?.ref === ref) {
					if (!park.detached) park.cancel();
					const settled = await this.#settleTerminationStep(ref, "park", deadline, () => park.promise);
					if (!settled && this.#parks.get(ref.id) === park) this.#parks.delete(ref.id);
				}

				const run = this.#runs.get(ref.id);
				if (run?.ref === ref) {
					try {
						await this.#settleTerminationStep(ref, "run abort", deadline, run.abort);
					} finally {
						if (this.#runs.get(ref.id) === run) this.#runs.delete(ref.id);
					}
				} else if (session) {
					await this.#settleTerminationStep(ref, "abort", deadline, () => session.abort());
				}

				if (session) {
					await this.#settleTerminationStep(ref, "dispose", deadline, () => session.dispose());
				}
			} finally {
				clearTimeout(deadlineTimer);
				if (this.#registry.get(ref.id) === ref) {
					this.#registry.detachSession(ref.id, ref);
					this.#registry.setStatus(ref.id, "aborted", ref);
				}
			}
		})().finally(() => {
			if (this.#terminations.get(ref.id) === termination) this.#terminations.delete(ref.id);
		});

		this.#terminations.set(ref.id, termination);
		return termination.promise;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		if (event.type === "status_changed" && event.ref.status === "aborted") {
			void this.#terminate(event.ref);
			for (const child of this.#registry.list()) {
				if (child.parentId === event.ref.id && child.status !== "aborted") {
					this.#registry.setStatus(child.id, "aborted", child);
				}
			}
		}
		const adopted = this.#adopted.get(event.ref.id);
		if (!adopted || adopted.ref !== event.ref) return;
		if (event.type === "removed") {
			clearTimeout(adopted.timer);
			this.#adopted.delete(event.ref.id);
			return;
		}
		if (event.type !== "status_changed") return;
		if (event.ref.status === "running") {
			if (adopted.timer) {
				clearTimeout(adopted.timer);
				adopted.timer = undefined;
			}
		} else if (event.ref.status === "idle") {
			// Don't re-arm while a park is in flight — the park owns the transition.
			if (this.#parks.has(event.ref.id)) return;
			this.#armTimer(event.ref.id, adopted);
		}
	}
}
