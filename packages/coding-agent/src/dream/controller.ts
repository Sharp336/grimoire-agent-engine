/**
 * Dream controller — idle-time scheduling for dreaming passes.
 *
 * One controller is installed per top-level session (like the auto-learn
 * controller, the session's listener array keeps it alive; no disposal hook is
 * needed). It subscribes to the session event stream: every `agent_end` arms
 * an idle timer, any `agent_start` cancels it and aborts an in-flight dream so
 * dreaming never competes with live work. When the timer fires with the
 * session still quiet, the controller runs one dreaming pass and then backs
 * off — a full `dream.minIntervalHours` after a productive pass, a short
 * suppression after a no-op scan — so an overnight idle stretch dreams once,
 * not every idle window.
 *
 * The cooldown seeds from the dream diary's newest entry, so restarts don't
 * forget the last dream. All gates are read live from settings: dreaming can
 * be enabled or disabled mid-session.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { MemoryBackendId } from "../memory-backend/types";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { getDreamDiaryPath, readLastDreamTimeSec } from "./diary";
import { type DreamRunResult, type DreamTrigger, runDream } from "./runner";

/** Idle wait bounds (minutes). */
const MIN_IDLE_MINUTES = 5;
const MAX_IDLE_MINUTES = 720;
/** Cooldown bounds (hours). */
const MIN_INTERVAL_HOURS = 0.25;
const MAX_INTERVAL_HOURS = 168;
/** Floor for the post-no-op suppression window (seconds). */
const MIN_SUPPRESSION_SECONDS = 30 * 60;

export interface DreamControllerOptions {
	session: AgentSession;
	settings: Settings;
	agentDir: string;
}

export interface DreamStatus {
	enabled: boolean;
	backend: MemoryBackendId;
	/** An idle timer is currently armed. */
	armed: boolean;
	/** A dreaming pass is currently running. */
	running: boolean;
	lastDreamAtSec?: number;
	/** Earliest unix time an idle dream may run again. */
	nextEligibleAtSec?: number;
	lastResult?: DreamRunResult;
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export class DreamController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #agentDir: string;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#abort: AbortController | undefined;
	#running = false;
	#lastResult: DreamRunResult | undefined;
	#lastDreamAtSec: number | undefined;
	#nextEligibleAtSec: number | undefined;
	/** The diary is consulted once per session for the persisted cooldown seed. */
	#seededFromDiary = false;

	constructor(options: DreamControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#agentDir = options.agentDir;
		this.#session.subscribe(event => this.#onEvent(event));
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.#cancel();
			return;
		}
		if (event.type === "agent_end") {
			this.#arm();
		}
	}

	#arm(): void {
		this.#clearTimer();
		if (this.#session.isDisposed) return;
		if (!this.#settings.get("dream.enabled")) return;
		if (this.#settings.get("memory.backend") === "off") return;

		const idleMinutes = clamp(this.#settings.get("dream.idleMinutes"), MIN_IDLE_MINUTES, MAX_IDLE_MINUTES);
		this.#armIn(idleMinutes * 60);
	}

	#armIn(delaySeconds: number): void {
		this.#clearTimer();
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#fire();
		}, delaySeconds * 1000);
		this.#timer.unref?.();
	}

	async #fire(): Promise<void> {
		if (this.#running) return;
		if (this.#session.isDisposed) return;
		if (this.#session.isStreaming || this.#session.isCompacting) return;
		if (!this.#settings.get("dream.enabled")) return;
		if (this.#settings.get("memory.backend") === "off") return;

		await this.#seedFromDiary();
		const now = unixNow();
		if (this.#nextEligibleAtSec !== undefined && now < this.#nextEligibleAtSec) {
			// Still cooling down mid-idle-stretch: wake again when the cooldown
			// lapses so walking away overnight still dreams exactly once it may.
			this.#armIn(this.#nextEligibleAtSec - now);
			return;
		}
		await this.#dream("idle");
	}

	/**
	 * Run a dreaming pass now. Manual triggers bypass the idle cooldown; the
	 * concurrency guard still applies.
	 */
	async dreamNow(trigger: DreamTrigger = "manual"): Promise<DreamRunResult> {
		if (this.#running) {
			return {
				outcome: "skipped",
				backend: this.#settings.get("memory.backend"),
				trigger,
				startedAtSec: unixNow(),
				durationMs: 0,
				detail: "A dream is already in progress.",
			};
		}
		return await this.#dream(trigger);
	}

	async #dream(trigger: DreamTrigger): Promise<DreamRunResult> {
		this.#running = true;
		const abort = new AbortController();
		this.#abort = abort;
		try {
			const result = await runDream({
				session: this.#session,
				settings: this.#settings,
				agentDir: this.#agentDir,
				cwd: this.#session.sessionManager.getCwd(),
				trigger,
				signal: abort.signal,
			});
			this.#lastResult = result;
			const now = unixNow();
			if (result.outcome === "dreamt") {
				this.#lastDreamAtSec = result.startedAtSec;
				this.#nextEligibleAtSec = now + this.#cooldownSeconds();
			} else if (result.outcome === "failed") {
				// Full cooldown after a failure so a broken config is not hammered.
				this.#nextEligibleAtSec = now + this.#cooldownSeconds();
			} else {
				// No-op scans are cheap but not free (they re-read session headers);
				// suppress briefly instead of retrying every idle window.
				this.#nextEligibleAtSec = now + Math.max(MIN_SUPPRESSION_SECONDS, Math.floor(this.#cooldownSeconds() / 4));
			}
			logger.debug("Dream pass finished", {
				trigger,
				outcome: result.outcome,
				backend: result.backend,
				durationMs: result.durationMs,
				detail: result.detail,
			});
			return result;
		} finally {
			this.#running = false;
			if (this.#abort === abort) this.#abort = undefined;
		}
	}

	#cooldownSeconds(): number {
		const hours = clamp(this.#settings.get("dream.minIntervalHours"), MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS);
		return Math.floor(hours * 3600);
	}

	async #seedFromDiary(): Promise<void> {
		if (this.#seededFromDiary) return;
		this.#seededFromDiary = true;
		try {
			const diaryPath = getDreamDiaryPath(this.#agentDir, this.#session.sessionManager.getCwd());
			const lastSec = await readLastDreamTimeSec(diaryPath);
			if (lastSec === undefined) return;
			this.#lastDreamAtSec = this.#lastDreamAtSec ?? lastSec;
			const eligible = lastSec + this.#cooldownSeconds();
			if (this.#nextEligibleAtSec === undefined || eligible > this.#nextEligibleAtSec) {
				this.#nextEligibleAtSec = eligible;
			}
		} catch (error) {
			logger.debug("Dream cooldown seed failed", { error: String(error) });
		}
	}

	async status(): Promise<DreamStatus> {
		await this.#seedFromDiary();
		return {
			enabled: this.#settings.get("dream.enabled") && this.#settings.get("memory.backend") !== "off",
			backend: this.#settings.get("memory.backend"),
			armed: this.#timer !== undefined,
			running: this.#running,
			lastDreamAtSec: this.#lastDreamAtSec,
			nextEligibleAtSec: this.#nextEligibleAtSec,
			lastResult: this.#lastResult,
		};
	}

	#cancel(): void {
		this.#clearTimer();
		this.#abort?.abort();
	}

	#clearTimer(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}
}

const controllers = new WeakMap<AgentSession, DreamController>();

/** Install (or return the existing) dream controller for a session. */
export function installDreamController(options: DreamControllerOptions): DreamController {
	const existing = controllers.get(options.session);
	if (existing) return existing;
	const controller = new DreamController(options);
	controllers.set(options.session, controller);
	return controller;
}

/** The session's dream controller, when one was installed at session start. */
export function getDreamController(session: AgentSession): DreamController | undefined {
	return controllers.get(session);
}
