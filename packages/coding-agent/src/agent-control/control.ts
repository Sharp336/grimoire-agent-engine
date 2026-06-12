import type { AgentLifecycleManager } from "../registry/agent-lifecycle";
import type { AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";

/** Opaque identifier supplied by the top-level host for one control lifetime. */
export type ControlGeneration = string;

/** Identity bound when a direct child is admitted to a control generation. */
export interface ChildControlTarget {
	controlGeneration: ControlGeneration;
	id: string;
	sessionFile: string;
}

/**
 * Capability handed only to the top-level task tool. The executor stamps its
 * immutable generation onto child events and admits the exact child identity
 * after the child session has been registered.
 */
export interface DirectChildControlAdmission {
	readonly controlGeneration: ControlGeneration;
	admit(target: ChildControlTarget): boolean;
	markTerminal(target: ChildControlTarget): void;
}

/** Session-scoped source that snapshots the active generation at task submission. */
export interface DirectChildControlSource {
	capture(): DirectChildControlAdmission | undefined;
}

export type ChildControlErrorCode =
	| "stale_generation"
	| "unknown_target"
	| "foreign_target"
	| "identity_mismatch"
	| "terminal"
	| "not_revivable"
	| "unavailable";

export type ChildControlSendResult =
	| { ok: true; action: "steered" | "prompted" | "revived" }
	| { ok: false; code: ChildControlErrorCode; message: string };

/**
 * Session-scoped control for one immutable top-level generation.
 *
 * Agent Hub and IRC intentionally keep using their existing process-global
 * registry and lifecycle manager. This controller is explicitly constructed
 * by a trusted host and receives those dependencies; it has no global or
 * test-only global state of its own.
 */
export class DirectChildControl implements DirectChildControlAdmission {
	readonly controlGeneration: ControlGeneration;
	readonly #registry: AgentRegistry;
	readonly #lifecycle: AgentLifecycleManager;
	readonly #targets = new Map<string, string>();
	readonly #terminal = new Set<string>();
	readonly #revivals = new Map<string, Promise<AgentSession>>();
	#closed = false;

	constructor(controlGeneration: ControlGeneration, registry: AgentRegistry, lifecycle: AgentLifecycleManager) {
		if (!controlGeneration) throw new Error("A direct-child control generation is required.");
		this.controlGeneration = controlGeneration;
		this.#registry = registry;
		this.#lifecycle = lifecycle;
	}

	/** Close this control generation without touching any child lifecycle state. */
	close(): void {
		this.#closed = true;
		this.#targets.clear();
		this.#terminal.clear();
	}

	/** Admit an exact tuple stamped by the trusted direct-task execution path. */
	admit(target: ChildControlTarget): boolean {
		if (this.#closed || target.controlGeneration !== this.controlGeneration || !target.id || !target.sessionFile) {
			return false;
		}
		const ref = this.#registry.get(target.id);
		if (ref?.kind !== "sub" || ref.sessionFile !== target.sessionFile) return false;
		const existing = this.#targets.get(target.id);
		if (existing !== undefined && existing !== target.sessionFile) return false;
		this.#targets.set(target.id, target.sessionFile);
		return true;
	}

	/** Preserve terminal identity after the registry disposes an aborted child. */
	markTerminal(target: ChildControlTarget): void {
		if (
			!this.#closed &&
			target.controlGeneration === this.controlGeneration &&
			this.#targets.get(target.id) === target.sessionFile
		) {
			this.#terminal.add(target.id);
		}
	}

	/** Send one prompt through the safe mutation allowed by the child's current state. */
	async send(target: ChildControlTarget, text: string): Promise<ChildControlSendResult> {
		const resolution = this.#resolve(target);
		if (!resolution.ok) return resolution;
		const { ref } = resolution;

		if (ref.status === "aborted") {
			return this.#error("terminal", `Agent "${target.id}" is aborted and cannot accept prompts.`);
		}
		if (ref.status === "running") {
			if (!ref.session) return this.#error("unavailable", `Agent "${target.id}" has no live session.`);
			return this.#invoke(target, ref.session, "steered", () => ref.session!.steer(text));
		}
		if (ref.status === "idle") {
			if (!ref.session) return this.#error("unavailable", `Agent "${target.id}" has no live session.`);
			return this.#invoke(target, ref.session, "prompted", () => ref.session!.prompt(text));
		}

		return this.#sendParked(target, text);
	}

	async #sendParked(target: ChildControlTarget, text: string): Promise<ChildControlSendResult> {
		const existing = this.#revivals.get(target.id);
		if (existing) {
			try {
				const session = await existing;
				const resolution = this.#resolve(target);
				if (!resolution.ok) return resolution;
				return this.#invoke(target, session, "steered", () => session.steer(text));
			} catch {
				return this.#error("not_revivable", `Agent "${target.id}" could not be revived.`);
			}
		}

		const revival = this.#lifecycle.ensureLive(target.id);
		this.#revivals.set(target.id, revival);
		try {
			const session = await revival;
			const resolution = this.#resolve(target);
			if (!resolution.ok) return resolution;
			if (resolution.ref.status === "aborted") {
				return this.#error("terminal", `Agent "${target.id}" is aborted and cannot accept prompts.`);
			}
			if (resolution.ref.status === "running") {
				return this.#invoke(target, session, "steered", () => session.steer(text));
			}
			if (resolution.ref.status !== "idle") {
				return this.#error("unavailable", `Agent "${target.id}" did not become idle after revival.`);
			}
			return this.#invoke(target, session, "revived", () => session.prompt(text));
		} catch {
			return this.#error("not_revivable", `Agent "${target.id}" could not be revived.`);
		} finally {
			if (this.#revivals.get(target.id) === revival) this.#revivals.delete(target.id);
		}
	}

	async #invoke(
		target: ChildControlTarget,
		session: AgentSession,
		action: "steered" | "prompted" | "revived",
		invoke: () => Promise<unknown>,
	): Promise<ChildControlSendResult> {
		const before = this.#resolve(target);
		if (!before.ok) return before;
		if (before.ref.session !== session) {
			return this.#error("identity_mismatch", `Agent "${target.id}" no longer refers to the bound session.`);
		}
		try {
			await invoke();
			return { ok: true, action };
		} catch (error) {
			return this.#error("unavailable", error instanceof Error ? error.message : String(error));
		}
	}

	#resolve(target: ChildControlTarget): { ok: true; ref: AgentRef } | Extract<ChildControlSendResult, { ok: false }> {
		if (this.#closed || target.controlGeneration !== this.controlGeneration) {
			return this.#error("stale_generation", "The child control generation is no longer current.");
		}
		const ref = this.#registry.get(target.id);
		if (!ref) {
			if (this.#targets.get(target.id) === target.sessionFile && this.#terminal.has(target.id)) {
				return this.#error("terminal", `Agent "${target.id}" is aborted and cannot accept prompts.`);
			}
			return this.#error("unknown_target", `Unknown agent "${target.id}".`);
		}
		const boundSessionFile = this.#targets.get(target.id);
		if (boundSessionFile === undefined) {
			return this.#error("foreign_target", `Agent "${target.id}" is not a direct child of this control generation.`);
		}
		if (boundSessionFile !== target.sessionFile || ref.sessionFile !== target.sessionFile) {
			return this.#error("identity_mismatch", `Agent "${target.id}" no longer matches the bound session file.`);
		}
		if (ref.kind !== "sub") {
			return this.#error("foreign_target", `Agent "${target.id}" is not a controllable child.`);
		}
		return { ok: true, ref };
	}

	#error(code: ChildControlErrorCode, message: string): Extract<ChildControlSendResult, { ok: false }> {
		return { ok: false, code, message };
	}
}
