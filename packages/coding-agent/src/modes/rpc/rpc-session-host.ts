import { isRecord, Snowflake } from "@oh-my-pi/pi-utils";
import type {
	SessionAuthoritySettlement,
	SessionCommand,
	SessionCommandContext,
	SessionCommandOutcome,
	SessionHost,
	SessionJournalCursor,
	SessionJsonValue,
	SessionObservationPosition,
	SessionOpenResult,
} from "../../session/session-host";
import { isRpcJsonValue, validateRpcCommand } from "./rpc-command-registry";
import type {
	RpcCommand,
	RpcOperationTerminalFrame,
	RpcResponse,
	RpcSessionObservationFrame,
	RpcSessionOpenResult,
} from "./rpc-types";

const RECURSIVE_SESSION_COMMANDS = new Set([
	"negotiate_protocol",
	"initialize",
	"session_open",
	"session_ack",
	"session_unsubscribe",
	"session_invoke",
	"session_shutdown",
]);
const SESSION_CATALOG_COMMANDS = new Set([
	"list_sessions",
	"get_session_info",
	"list_workspace_roots",
	"resume_session",
	"fork_session",
	"rename_session",
	"delete_session",
	"new_session",
	"switch_session",
	"branch",
	"get_branch_messages",
	"set_session_name",
	"get_session_tree",
	"select_session_leaf",
	"reset_session",
]);

export type RpcSessionCommandCapability = "session.catalog" | "session.execute";

export function getRpcSessionCommandCapability(commandKind: string): RpcSessionCommandCapability {
	return SESSION_CATALOG_COMMANDS.has(commandKind) ? "session.catalog" : "session.execute";
}

export interface RpcSessionCommandInvokerOptions {
	execute(command: RpcCommand): Promise<RpcResponse>;
	waitForSettlement(operationId: string): Promise<RpcOperationTerminalFrame | undefined>;
	cancelOperation(operationId: string): void;
}

function failedOutcome(code: string, message: string, retryable = false): SessionCommandOutcome {
	return { outcome: "failed", error: { code, message, retryable } };
}

function terminalOutcome(terminal: RpcOperationTerminalFrame): SessionCommandOutcome {
	switch (terminal.type) {
		case "operation_completed":
			return { outcome: "completed", result: terminal as unknown as SessionJsonValue };
		case "operation_cancelled":
			return { outcome: "cancelled", result: terminal as unknown as SessionJsonValue };
		case "operation_failed":
			return failedOutcome(terminal.code ?? "operation_failed", terminal.error);
	}
}

export function createRpcSessionCommandInvoker(
	options: RpcSessionCommandInvokerOptions,
): (command: SessionCommand, context: SessionCommandContext) => Promise<SessionCommandOutcome> {
	return async (command, context) => {
		if (RECURSIVE_SESSION_COMMANDS.has(command.kind)) {
			return failedOutcome(
				"unsupported_session_command",
				`Session command ${command.kind} cannot invoke RPC host management`,
			);
		}
		if (context.signal?.aborted) return { outcome: "cancelled" };
		if (command.input !== undefined && !isRecord(command.input)) {
			return failedOutcome("invalid_command_input", "Session command input must be a JSON object");
		}

		const validation = validateRpcCommand({
			...(command.input ?? {}),
			id: context.requestId,
			type: command.kind,
		});
		if (!validation.ok) return failedOutcome(validation.code, validation.error);

		const response = await options.execute(validation.command);
		if (!response.success) return failedOutcome(response.code ?? "command_failed", response.error);

		const data = "data" in response ? response.data : undefined;
		const operationId =
			isRecord(data) && "operationId" in data && typeof data.operationId === "string" ? data.operationId : undefined;
		if (operationId) {
			const cancel = () => options.cancelOperation(operationId);
			context.signal?.addEventListener("abort", cancel, { once: true });
			try {
				const terminal = await options.waitForSettlement(operationId);
				return terminal ? terminalOutcome(terminal) : { outcome: "unknown" };
			} finally {
				context.signal?.removeEventListener("abort", cancel);
			}
		}

		if (data === undefined) return { outcome: "completed" };
		if (!isRpcJsonValue(data)) {
			return failedOutcome("invalid_command_result", `Session command ${command.kind} returned non-JSON data`);
		}
		return { outcome: "completed", result: data as SessionJsonValue };
	};
}

export class RpcSessionSubscriptionNotFoundError extends Error {
	readonly code = "subscription_not_found";

	constructor(subscriptionId: string) {
		super(`RPC session subscription not found: ${subscriptionId}`);
		this.name = "RpcSessionSubscriptionNotFoundError";
	}
}

export interface RpcSessionHostAdapterOptions {
	output(frame: RpcSessionObservationFrame): void;
}

export class RpcSessionHostAdapter {
	readonly #host: SessionHost;
	readonly #options: RpcSessionHostAdapterOptions;
	readonly #subscriptions = new Map<string, SessionOpenResult>();
	readonly #pumps = new Set<Promise<void>>();
	#closed = false;

	constructor(host: SessionHost, options: RpcSessionHostAdapterOptions) {
		this.#host = host;
		this.#options = options;
	}

	async open(options: {
		after?: SessionObservationPosition;
		afterCursor?: SessionJournalCursor;
		snapshot?: boolean;
	}): Promise<RpcSessionOpenResult> {
		if (this.#closed) throw new Error("RPC session host is closed");
		const subscription = await this.#host.open(options);
		const subscriptionId = Snowflake.next() as string;
		this.#subscriptions.set(subscriptionId, subscription);
		const pump = this.#pump(subscriptionId, subscription);
		this.#pumps.add(pump);
		void pump.then(
			() => this.#pumps.delete(pump),
			() => this.#pumps.delete(pump),
		);
		return {
			subscriptionId,
			...(subscription.snapshot === undefined ? {} : { snapshot: subscription.snapshot }),
		};
	}

	async acknowledge(subscriptionId: string, sequence: number): Promise<void> {
		await this.#subscription(subscriptionId).acknowledge(sequence);
	}

	async unsubscribe(subscriptionId: string): Promise<void> {
		const subscription = this.#subscription(subscriptionId);
		this.#subscriptions.delete(subscriptionId);
		await subscription.close();
	}

	invoke(command: SessionCommand, context: SessionCommandContext): Promise<SessionCommandOutcome> {
		return this.#host.invoke(command, context);
	}

	async shutdown(): Promise<SessionAuthoritySettlement> {
		if (this.#closed) return { state: "settled" };
		this.#closed = true;
		const settlement = await this.#host.close();
		await this.#waitForPumps();
		return settlement;
	}

	async disconnect(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#host.disconnect();
		await this.#waitForPumps();
	}

	#subscription(subscriptionId: string): SessionOpenResult {
		const subscription = this.#subscriptions.get(subscriptionId);
		if (!subscription) throw new RpcSessionSubscriptionNotFoundError(subscriptionId);
		return subscription;
	}
	async #waitForPumps(): Promise<void> {
		while (this.#pumps.size > 0) {
			await Promise.allSettled(Array.from(this.#pumps));
		}
	}

	async #pump(subscriptionId: string, subscription: SessionOpenResult): Promise<void> {
		try {
			while (true) {
				const next = await subscription.observations.next();
				if (next.done) return;
				this.#options.output({ type: "session_observation", subscriptionId, observation: next.value });
			}
		} finally {
			if (this.#subscriptions.get(subscriptionId) === subscription) {
				this.#subscriptions.delete(subscriptionId);
				await subscription.close();
			}
		}
	}
}
