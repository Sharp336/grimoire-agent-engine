import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type {
	RpcActiveOperation,
	RpcCancelOperationResult,
	RpcOperationCancellationCode,
	RpcOperationCancellationReason,
	RpcOperationCommand,
	RpcOperationStartedFrame,
	RpcOperationsSnapshot,
	RpcOperationTerminalFrame,
} from "./rpc-types";

export interface RpcOperationHandle {
	readonly operationId: string;
	readonly requestId: string | undefined;
	readonly command: RpcOperationCommand;
}

type ActiveRpcOperation = RpcOperationHandle & {
	acceptedAt: number;
	startedAt?: number;
	state: "accepted" | "started" | "cancelling";
	cancellation?: {
		reason: RpcOperationCancellationReason;
		code: RpcOperationCancellationCode;
	};
};

type RpcOperationOutputFrame = RpcOperationStartedFrame | RpcOperationTerminalFrame;
type UnsettledTerminalFrame = RpcOperationTerminalFrame extends infer TFrame
	? TFrame extends RpcOperationTerminalFrame
		? Omit<TFrame, "settledAt">
		: never
	: never;

const RECENT_OPERATION_LIMIT = 128;
const RECENT_OPERATION_TTL_MS = 5 * 60_000;

/** Owns server-generated IDs, lifecycle timing, and exactly-once settlement. */
export class RpcOperationManager {
	readonly #active = new Map<string, ActiveRpcOperation>();
	readonly #recent = new Map<string, { frame: RpcOperationTerminalFrame; expiresAt: number }>();
	readonly #settlementWaiters = new Map<string, Set<(frame: RpcOperationTerminalFrame) => void>>();
	readonly #output: (frame: RpcOperationOutputFrame) => void;
	readonly #nextId: () => string;
	readonly #now: () => number;

	constructor(
		output: (frame: RpcOperationOutputFrame) => void,
		nextId = () => Snowflake.next() as string,
		now = Date.now,
	) {
		this.#output = output;
		this.#nextId = nextId;
		this.#now = now;
	}

	/** Accept work without starting it. The caller can emit the response before {@link begin}. */
	start(requestId: string | undefined, command: RpcOperationCommand): RpcOperationHandle {
		const operation: ActiveRpcOperation = {
			operationId: this.#nextId(),
			requestId,
			command,
			acceptedAt: this.#now(),
			state: "accepted",
		};
		this.#active.set(operation.operationId, operation);
		return operation;
	}

	/** Mark the point where accepted work actually begins. */
	begin(handle: RpcOperationHandle): boolean {
		const operation = this.#active.get(handle.operationId);
		if (operation?.state !== "accepted") return false;
		operation.startedAt = this.#now();
		operation.state = "started";
		this.#output({
			type: "operation_started",
			operationId: operation.operationId,
			requestId: operation.requestId,
			command: operation.command,
			startedAt: operation.startedAt,
		});
		return true;
	}
	/** Mark an accepted operation started when its tagged session message becomes active. */
	beginById(operationId: string): boolean {
		const operation = this.#active.get(operationId);
		return operation ? this.begin(operation) : false;
	}

	isActive(handle: RpcOperationHandle): boolean {
		return this.#active.has(handle.operationId);
	}
	/** Whether work may still advance rather than only quiesce for cancellation. */
	canContinue(handle: RpcOperationHandle): boolean {
		const operation = this.#active.get(handle.operationId);
		return operation !== undefined && operation.state !== "cancelling";
	}

	/** Whether accepted, started, or cancelling work for this command is unsettled. */
	hasActiveCommand(command: RpcOperationCommand): boolean {
		for (const operation of this.#active.values()) {
			if (operation.command === command) return true;
		}
		return false;
	}

	/** Resolve when an accepted operation reaches its exactly-once terminal outcome. */
	waitForSettlement(operationId: string): Promise<RpcOperationTerminalFrame | undefined> {
		this.#pruneRecent();
		const recent = this.#recent.get(operationId)?.frame;
		if (recent) return Promise.resolve(recent);
		if (!this.#active.has(operationId)) return Promise.resolve(undefined);
		const waiter = Promise.withResolvers<RpcOperationTerminalFrame>();
		let waiters = this.#settlementWaiters.get(operationId);
		if (!waiters) {
			waiters = new Set();
			this.#settlementWaiters.set(operationId, waiters);
		}
		waiters.add(waiter.resolve);
		return waiter.promise;
	}

	complete(
		handle: RpcOperationHandle,
		agentInvoked: boolean,
		data?: Extract<RpcOperationTerminalFrame, { type: "operation_completed" }>["data"],
	): boolean {
		return this.#settle(handle, {
			type: "operation_completed",
			operationId: handle.operationId,
			requestId: handle.requestId,
			command: handle.command,
			agentInvoked,
			data,
		});
	}

	fail(handle: RpcOperationHandle, error: Error, code = "operation_failed"): boolean {
		return this.#settle(handle, {
			type: "operation_failed",
			operationId: handle.operationId,
			requestId: handle.requestId,
			command: handle.command,
			error: error.message,
			code,
		});
	}

	/**
	 * Request cancellation. Started work stays retained in `cancelling` until
	 * the owner has awaited its abort/quiescence and calls
	 * {@link settleCancellation}. Accepted-but-not-started work can settle
	 * immediately; the owner still removes its queued message separately.
	 */
	cancel(
		operationId: string,
		reason: RpcOperationCancellationReason = "user",
		code: RpcOperationCancellationCode = "cancelled_by_client",
		options: { deferAcceptedSettlement?: boolean } = {},
	): { result: RpcCancelOperationResult; wasStarted: boolean; wasQueued: boolean; didInitiate: boolean } {
		this.#pruneRecent();
		const operation = this.#active.get(operationId);
		if (operation) {
			const wasStarted = operation.startedAt !== undefined;
			const wasQueued = !wasStarted;
			if (operation.state === "cancelling") {
				return {
					result: { operationId, status: "cancelling" },
					wasStarted,
					wasQueued,
					didInitiate: false,
				};
			}
			operation.state = "cancelling";
			operation.cancellation = { reason, code };
			if (!wasStarted && !options.deferAcceptedSettlement) {
				this.#settle(operation, this.#cancelFrame(operation, reason, code), true);
				const terminal = this.#recent.get(operationId)?.frame;
				return {
					result: terminal ? this.#resultForTerminal(terminal) : { operationId, status: "cancelling" },
					wasStarted,
					wasQueued,
					didInitiate: true,
				};
			}
			return {
				result: { operationId, status: "cancelling" },
				wasStarted,
				wasQueued,
				didInitiate: true,
			};
		}
		const terminal = this.#recent.get(operationId)?.frame;
		if (!terminal) {
			return {
				result: { operationId, status: "not_found" },
				wasStarted: false,
				wasQueued: false,
				didInitiate: false,
			};
		}
		return { result: this.#resultForTerminal(terminal), wasStarted: false, wasQueued: false, didInitiate: false };
	}

	/**
	 * Complete a previously requested cancellation after the implementation has
	 * stopped producing output and all owned work is quiescent.
	 */
	settleCancellation(operationId: string): boolean {
		const operation = this.#active.get(operationId);
		if (operation?.state !== "cancelling" || !operation.cancellation) return false;
		return this.#settle(
			operation,
			this.#cancelFrame(operation, operation.cancellation.reason, operation.cancellation.code),
			true,
		);
	}

	cancelAll(
		reason: RpcOperationCancellationReason,
		code: RpcOperationCancellationCode,
		excludedOperationIds: ReadonlySet<string> = new Set(),
	): void {
		for (const operation of Array.from(this.#active.values())) {
			if (excludedOperationIds.has(operation.operationId)) continue;
			this.cancel(operation.operationId, reason, code);
		}
	}

	snapshot(): RpcOperationsSnapshot {
		this.#pruneRecent();
		const active: RpcActiveOperation[] = Array.from(this.#active.values(), operation => ({
			operationId: operation.operationId,
			requestId: operation.requestId,
			command: operation.command,
			status: operation.state,
			acceptedAt: operation.acceptedAt,
			startedAt: operation.startedAt,
		}));
		return {
			active,
			recent: Array.from(this.#recent.values(), entry => entry.frame),
		};
	}

	get activeCount(): number {
		return this.#active.size;
	}

	#cancelFrame(
		operation: RpcOperationHandle,
		reason: RpcOperationCancellationReason,
		code: RpcOperationCancellationCode,
	): Omit<Extract<RpcOperationTerminalFrame, { type: "operation_cancelled" }>, "settledAt"> {
		return {
			type: "operation_cancelled",
			operationId: operation.operationId,
			requestId: operation.requestId,
			command: operation.command,
			reason,
			code,
		};
	}

	#resultForTerminal(terminal: RpcOperationTerminalFrame): RpcCancelOperationResult {
		if (terminal.type === "operation_cancelled") {
			return { operationId: terminal.operationId, status: "cancelled", terminal };
		}
		if (terminal.type === "operation_completed") {
			return { operationId: terminal.operationId, status: "completed", terminal };
		}
		return { operationId: terminal.operationId, status: "failed", terminal };
	}

	#settle(handle: RpcOperationHandle, frame: UnsettledTerminalFrame, allowCancelling = false): boolean {
		const operation = this.#active.get(handle.operationId);
		if (!operation || (operation.state === "cancelling" && !allowCancelling)) return false;
		this.#active.delete(handle.operationId);
		const terminal = { ...frame, settledAt: this.#now() } as RpcOperationTerminalFrame;
		this.#recent.set(handle.operationId, {
			frame: terminal,
			expiresAt: terminal.settledAt + RECENT_OPERATION_TTL_MS,
		});
		this.#pruneRecent();
		this.#output(terminal);
		const waiters = this.#settlementWaiters.get(handle.operationId);
		if (waiters) {
			this.#settlementWaiters.delete(handle.operationId);
			for (const resolve of waiters) resolve(terminal);
		}
		return true;
	}

	#pruneRecent(): void {
		const now = this.#now();
		for (const [operationId, entry] of this.#recent) {
			if (entry.expiresAt > now) continue;
			this.#recent.delete(operationId);
		}
		while (this.#recent.size > RECENT_OPERATION_LIMIT) {
			const oldest = this.#recent.keys().next().value;
			if (typeof oldest !== "string") break;
			this.#recent.delete(oldest);
		}
	}
}

export interface RpcOperationMessageSession {
	getMessageTag(message: AgentMessage): string | undefined;
	removeQueuedMessagesByTag(tag: string): number;
	abort(options: { reason: string }): Promise<void>;
}

/**
 * Preserves the operation that owns the active AgentSession message while
 * untagged assistant/internal messages stream through the same turn.
 */
export class RpcOperationMessageOwnership {
	#activeOperationId: string | undefined;
	readonly #preparations = new Map<string, { controller: AbortController; task: Promise<void> }>();

	constructor(readonly session: RpcOperationMessageSession) {}

	observeMessageStart(message: AgentMessage): string | undefined {
		const operationId = this.session.getMessageTag(message);
		if (operationId !== undefined) this.#activeOperationId = operationId;
		return operationId;
	}

	trackPreparation(operationId: string, controller: AbortController, task: Promise<void>): void {
		const preparation = { controller, task };
		this.#preparations.set(operationId, preparation);
		void task
			.finally(() => {
				if (this.#preparations.get(operationId) === preparation) this.#preparations.delete(operationId);
			})
			.catch(() => undefined);
	}

	settle(operationId: string): void {
		if (this.#activeOperationId === operationId) this.#activeOperationId = undefined;
		this.#preparations.delete(operationId);
	}

	async cancel(manager: RpcOperationManager, operationId: string): Promise<RpcCancelOperationResult> {
		const active = manager.snapshot().active.find(operation => operation.operationId === operationId);
		const wasAccepted = active?.status === "accepted";
		const preparation = this.#preparations.get(operationId);
		if (wasAccepted) this.session.removeQueuedMessagesByTag(operationId);
		const cancellation = manager.cancel(
			operationId,
			"user",
			"cancelled_by_client",
			preparation && wasAccepted ? { deferAcceptedSettlement: true } : {},
		);
		if (cancellation.didInitiate && cancellation.result.status === "cancelling") {
			preparation?.controller.abort();
			let activeAborted = false;
			if (this.#activeOperationId === operationId) {
				await this.session.abort({ reason: USER_INTERRUPT_LABEL });
				activeAborted = true;
			}
			if (preparation) {
				await preparation.task.catch(() => undefined);
				this.session.removeQueuedMessagesByTag(operationId);
			}
			if (!activeAborted && this.#activeOperationId === operationId) {
				await this.session.abort({ reason: USER_INTERRUPT_LABEL });
			} else if (!wasAccepted && !activeAborted) {
				this.session.removeQueuedMessagesByTag(operationId);
			}
			manager.settleCancellation(operationId);
		}
		if (cancellation.result.status !== "cancelling") return cancellation.result;
		const terminal = await manager.waitForSettlement(operationId);
		if (!terminal) return cancellation.result;
		if (terminal.type === "operation_cancelled") {
			return { operationId, status: "cancelled", terminal };
		}
		if (terminal.type === "operation_completed") {
			return { operationId, status: "completed", terminal };
		}
		return { operationId, status: "failed", terminal };
	}
}
