import { Snowflake } from "@oh-my-pi/pi-utils";
import {
	type SemanticActionHandler,
	type SemanticContent,
	type SemanticContentValidation,
	type SemanticRenderResult,
	validateSemanticContent,
} from "../../session/semantic-content";
import type { SessionJsonValue } from "../../session/session-host";

export const MAX_RPC_SEMANTIC_RENDERS = 256;

export type RpcSemanticRenderSource =
	| { kind: "system" }
	| { kind: "extension"; extensionPath: string }
	| { kind: "tool"; toolCallId: string; toolName: string };

export interface RpcSemanticContentFrame {
	type: "semantic_content";
	renderId: string;
	revision: number;
	source: RpcSemanticRenderSource;
	content: SemanticContent;
}

export interface RpcSemanticActionRequestedFrame {
	type: "semantic_action_requested";
	renderId: string;
	actionId: string;
	requestId: string;
}

export type RpcSemanticActionOutcome =
	| { state: "accepted" }
	| { state: "cancelled" }
	| { state: "unsupported"; message: string }
	| { state: "failed"; message: string };

export interface RpcSemanticActionSettledFrame {
	type: "semantic_action_settled";
	renderId: string;
	actionId: string;
	requestId: string;
	outcome: RpcSemanticActionOutcome;
}

export interface RpcSemanticRenderRegistration extends SemanticRenderResult {
	source: RpcSemanticRenderSource;
}

type RpcSemanticRenderingFrame =
	| RpcSemanticContentFrame
	| RpcSemanticActionRequestedFrame
	| RpcSemanticActionSettledFrame;

interface RegisteredSemanticRender {
	source: RpcSemanticRenderSource;
	content: SemanticContent;
	revision: number;
	actions: ReadonlyMap<string, SemanticActionHandler>;
	disabledActions: ReadonlySet<string>;
}

function validationError(validation: Exclude<SemanticContentValidation, { ok: true }>): Error {
	return new Error(`Invalid semantic content (${validation.code}): ${validation.error}`);
}

function collectDeclaredActions(content: SemanticContent): { ids: Set<string>; disabled: Set<string> } {
	const ids = new Set<string>();
	const disabled = new Set<string>();
	for (const block of content.blocks) {
		if (block.kind !== "actions") continue;
		for (const action of block.actions) {
			ids.add(action.id);
			if (action.disabled) disabled.add(action.id);
		}
	}
	return { ids, disabled };
}

export class RpcSemanticRenderingManager {
	readonly #output: (frame: RpcSemanticRenderingFrame) => void;
	readonly #renders = new Map<string, RegisteredSemanticRender>();
	readonly #activeActions = new Map<string, AbortController>();

	constructor(output: (frame: RpcSemanticRenderingFrame) => void) {
		this.#output = output;
	}

	register(registration: RpcSemanticRenderRegistration): string {
		if (this.#renders.size >= MAX_RPC_SEMANTIC_RENDERS) {
			throw new Error(`RPC semantic render capacity is ${MAX_RPC_SEMANTIC_RENDERS}`);
		}
		const validation = validateSemanticContent(registration.content);
		if (!validation.ok) throw validationError(validation);
		const declared = collectDeclaredActions(validation.content);
		const handlers = registration.actions ?? new Map<string, SemanticActionHandler>();
		for (const actionId of declared.ids) {
			if (!declared.disabled.has(actionId) && !handlers.has(actionId)) {
				throw new Error(`Semantic action ${actionId} has no handler`);
			}
		}
		for (const actionId of handlers.keys()) {
			if (!declared.ids.has(actionId))
				throw new Error(`Semantic action handler ${actionId} is not declared by content`);
		}

		const renderId = Snowflake.next() as string;
		const render: RegisteredSemanticRender = {
			source: registration.source,
			content: validation.content,
			revision: 1,
			actions: handlers,
			disabledActions: declared.disabled,
		};
		this.#renders.set(renderId, render);
		this.#emitContent(renderId, render);
		return renderId;
	}

	update(renderId: string, registration: RpcSemanticRenderRegistration): boolean {
		const render = this.#renders.get(renderId);
		if (!render) return false;
		this.cancel(renderId);
		const validation = validateSemanticContent(registration.content);
		if (!validation.ok) throw validationError(validation);
		const declared = collectDeclaredActions(validation.content);
		const handlers = registration.actions ?? new Map<string, SemanticActionHandler>();
		for (const actionId of declared.ids) {
			if (!declared.disabled.has(actionId) && !handlers.has(actionId)) {
				throw new Error(`Semantic action ${actionId} has no handler`);
			}
		}
		for (const actionId of handlers.keys()) {
			if (!declared.ids.has(actionId))
				throw new Error(`Semantic action handler ${actionId} is not declared by content`);
		}
		render.source = registration.source;
		render.content = validation.content;
		render.revision++;
		render.actions = handlers;
		render.disabledActions = declared.disabled;
		this.#emitContent(renderId, render);
		return true;
	}

	async invoke(
		renderId: string,
		actionId: string,
		input: Record<string, SessionJsonValue> | undefined,
		requestId: string,
	): Promise<RpcSemanticActionSettledFrame> {
		const render = this.#renders.get(renderId);
		const handler = render?.actions.get(actionId);
		if (!render || !handler || render.disabledActions.has(actionId)) {
			return this.#settle(renderId, actionId, requestId, {
				state: "unsupported",
				message: `Unknown semantic action: ${actionId}`,
			});
		}
		const key = this.#actionKey(renderId, actionId);
		if (this.#activeActions.has(key)) {
			return this.#settle(renderId, actionId, requestId, {
				state: "failed",
				message: `Semantic action is already active: ${actionId}`,
			});
		}

		const controller = new AbortController();
		this.#activeActions.set(key, controller);
		this.#output({ type: "semantic_action_requested", renderId, actionId, requestId });
		try {
			const updated = await handler({ renderId, actionId, requestId, input, signal: controller.signal });
			if (controller.signal.aborted) return this.#settle(renderId, actionId, requestId, { state: "cancelled" });
			if (updated !== undefined) {
				const validation = validateSemanticContent(updated);
				if (!validation.ok) throw validationError(validation);
				const declared = collectDeclaredActions(validation.content);
				for (const declaredActionId of declared.ids) {
					if (!declared.disabled.has(declaredActionId) && !render.actions.has(declaredActionId)) {
						throw new Error(`Semantic action ${declaredActionId} has no handler`);
					}
				}
				render.content = validation.content;
				render.revision++;
				render.disabledActions = declared.disabled;
				this.#emitContent(renderId, render);
			}
			return this.#settle(renderId, actionId, requestId, { state: "accepted" });
		} catch (cause) {
			if (controller.signal.aborted) return this.#settle(renderId, actionId, requestId, { state: "cancelled" });
			return this.#settle(renderId, actionId, requestId, {
				state: "failed",
				message: cause instanceof Error ? cause.message : String(cause),
			});
		} finally {
			this.#activeActions.delete(key);
		}
	}

	cancel(renderId: string, actionId?: string): boolean {
		if (actionId !== undefined) {
			const controller = this.#activeActions.get(this.#actionKey(renderId, actionId));
			if (!controller) return false;
			controller.abort();
			return true;
		}
		let cancelled = false;
		for (const [key, controller] of this.#activeActions) {
			if (!key.startsWith(`${renderId}:`)) continue;
			controller.abort();
			cancelled = true;
		}
		return cancelled;
	}

	release(renderId: string): boolean {
		this.cancel(renderId);
		return this.#renders.delete(renderId);
	}

	dispose(): void {
		for (const controller of this.#activeActions.values()) controller.abort();
		this.#activeActions.clear();
		this.#renders.clear();
	}

	#settle(
		renderId: string,
		actionId: string,
		requestId: string,
		outcome: RpcSemanticActionOutcome,
	): RpcSemanticActionSettledFrame {
		const frame: RpcSemanticActionSettledFrame = {
			type: "semantic_action_settled",
			renderId,
			actionId,
			requestId,
			outcome,
		};
		this.#output(frame);
		return frame;
	}

	#emitContent(renderId: string, render: RegisteredSemanticRender): void {
		this.#output({
			type: "semantic_content",
			renderId,
			revision: render.revision,
			source: render.source,
			content: render.content,
		});
	}

	#actionKey(renderId: string, actionId: string): string {
		return `${renderId}:${actionId}`;
	}
}
