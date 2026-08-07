import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopLimitConfig,
	type LoopLimitRuntime,
} from "./session-loop-limit";

export type SessionLoopAction = "prompt" | "compact" | "reset";
export type SessionLoopPhase = "disabled" | "waiting" | "running" | "paused";

export interface SessionLoopState {
	enabled: boolean;
	phase: SessionLoopPhase;
	action: SessionLoopAction;
	prompt?: string;
	limit?: LoopLimitRuntime;
}

export interface SessionLoopEnableInput {
	action?: SessionLoopAction;
	prompt?: string;
	limit?: LoopLimitConfig;
}

export interface SessionLoopIteration {
	action: SessionLoopAction;
	prompt: string;
}

function cloneLimit(limit: LoopLimitRuntime | undefined): LoopLimitRuntime | undefined {
	return limit ? { ...limit } : undefined;
}

function validateLimit(limit: LoopLimitConfig | undefined): void {
	if (!limit) return;
	const amount = limit.kind === "iterations" ? limit.iterations : limit.durationMs;
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		throw new Error(
			`Loop ${limit.kind === "iterations" ? "iterations" : "duration"} must be a positive safe integer.`,
		);
	}
}
/** Authoritative loop lifecycle and iteration-budget state, independent of presentation scheduling. */
export class SessionLoopController {
	#enabled = false;
	#paused = false;
	#action: SessionLoopAction = "prompt";
	#prompt: string | undefined;
	#limit: LoopLimitRuntime | undefined;

	get snapshot(): SessionLoopState {
		return {
			enabled: this.#enabled,
			phase: !this.#enabled ? "disabled" : this.#paused ? "paused" : this.#prompt ? "running" : "waiting",
			action: this.#action,
			...(this.#prompt ? { prompt: this.#prompt } : {}),
			...(this.#limit ? { limit: cloneLimit(this.#limit) } : {}),
		};
	}

	enable(input: SessionLoopEnableInput = {}): SessionLoopState {
		validateLimit(input.limit);
		const prompt = input.prompt?.trim();
		this.#enabled = true;
		this.#paused = false;
		this.#action = input.action ?? "prompt";
		this.#prompt = prompt || undefined;
		this.#limit = createLoopLimitRuntime(input.limit);
		return this.snapshot;
	}

	disable(): SessionLoopState {
		this.#enabled = false;
		this.#paused = false;
		this.#prompt = undefined;
		this.#limit = undefined;
		return this.snapshot;
	}

	pause(): SessionLoopState {
		if (!this.#enabled) throw new Error("Loop is not enabled.");
		this.#paused = true;
		this.#prompt = undefined;
		return this.snapshot;
	}

	capturePrompt(prompt: string): SessionLoopState {
		if (!this.#enabled) return this.snapshot;
		const normalized = prompt.trim();
		if (!normalized) throw new Error("Loop prompt cannot be empty.");
		this.#prompt = normalized;
		this.#paused = false;
		return this.snapshot;
	}

	resume(prompt: string): SessionLoopState {
		if (!this.#enabled) throw new Error("Loop is not enabled.");
		if (!this.#paused) throw new Error("Loop is not paused.");
		return this.capturePrompt(prompt);
	}

	/** Consume one iteration budget and return the work to schedule, or disable an exhausted loop. */
	beginIteration(nowMs = Date.now()): SessionLoopIteration | undefined {
		if (!this.#enabled || this.#paused || !this.#prompt) return undefined;
		if (isLoopDurationExpired(this.#limit, nowMs) || !consumeLoopLimitIteration(this.#limit, nowMs)) {
			this.disable();
			return undefined;
		}
		return { action: this.#action, prompt: this.#prompt };
	}
}

export interface SessionLoopAuthority {
	getLoopState(): SessionLoopState;
	beginLoopIteration(): SessionLoopIteration | undefined;
	disableLoop(): SessionLoopState;
}

export interface SessionLoopSchedulerHost {
	waitForIdle(): Promise<void>;
	compact(): Promise<void>;
	reset(): Promise<void>;
	prompt(prompt: string, causationId?: string): Promise<void>;
	onStateChange(state: SessionLoopState, causationId?: string): void;
	onError(cause: unknown): void;
}

/**
 * Serial loop scheduler shared by non-interactive hosts.
 *
 * The authority owns lifecycle and budgets; this adapter waits for turn
 * settlement and invokes host actions without allowing overlapping iterations.
 */
export class SessionLoopScheduler {
	readonly #authority: SessionLoopAuthority;
	readonly #host: SessionLoopSchedulerHost;
	#running = false;
	#scheduled = false;
	#disposed = false;
	#causationId: string | undefined;
	#settled: Promise<void> = Promise.resolve();
	#resolveSettled: (() => void) | undefined;

	constructor(authority: SessionLoopAuthority, host: SessionLoopSchedulerHost) {
		this.#authority = authority;
		this.#host = host;
	}

	request(causationId?: string): void {
		if (this.#disposed) throw new Error("Loop scheduler is disposed.");
		if (causationId !== undefined) this.#causationId = causationId;
		if (this.#running || this.#scheduled) return;
		this.#scheduled = true;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#settled = promise;
		this.#resolveSettled = resolve;
		setImmediate(() => {
			this.#scheduled = false;
			void this.#drain();
		});
	}

	waitForSettled(): Promise<void> {
		return this.#settled;
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		await this.#settled;
	}

	async #drain(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			while (!this.#disposed) {
				await this.#host.waitForIdle();
				if (this.#disposed) return;
				const iteration = this.#authority.beginLoopIteration();
				this.#host.onStateChange(this.#authority.getLoopState(), this.#causationId);
				if (!iteration) return;

				if (iteration.action === "compact") {
					await this.#host.compact();
				} else if (iteration.action === "reset") {
					await this.#host.reset();
				}

				const state = this.#authority.getLoopState();
				if (!state.enabled || state.phase === "paused" || state.prompt !== iteration.prompt) continue;
				await this.#host.prompt(iteration.prompt, this.#causationId);
			}
		} catch (cause) {
			this.#authority.disableLoop();
			this.#host.onStateChange(this.#authority.getLoopState(), this.#causationId);
			this.#host.onError(cause);
		} finally {
			this.#running = false;
			this.#resolveSettled?.();
			this.#resolveSettled = undefined;
		}
	}
}
