import { describe, expect, test } from "bun:test";
import {
	createRpcSessionCommandInvoker,
	getRpcSessionCommandCapability,
	RpcSessionHostAdapter,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-host";
import type {
	RpcOperationTerminalFrame,
	RpcSessionObservationFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	type SessionAuthority,
	type SessionAuthorityObservation,
	SessionHost,
	type SessionJsonValue,
	SessionSubscriptionCapacityError,
} from "@oh-my-pi/pi-coding-agent/session/session-host";

const flushMicrotasks = () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};

describe("RPC session command capabilities", () => {
	test("routes catalog authority independently from execution authority", () => {
		expect(getRpcSessionCommandCapability("list_sessions")).toBe("session.catalog");
		expect(getRpcSessionCommandCapability("get_session_tree")).toBe("session.catalog");
		expect(getRpcSessionCommandCapability("select_session_leaf")).toBe("session.catalog");
		expect(getRpcSessionCommandCapability("reset_session")).toBe("session.catalog");
		expect(getRpcSessionCommandCapability("prompt")).toBe("session.execute");
	});
});

describe("RpcSessionHostAdapter", () => {
	test("opens an atomic snapshot-to-live subscription and forwards acknowledgements", async () => {
		let listener: ((observation: SessionAuthorityObservation) => void) | undefined;
		const authority: SessionAuthority = {
			sessionId: "session-1",
			snapshot: async captureWatermark => {
				const snapshot = {
					revision: 7,
					state: { phase: "idle" },
					journalCursor: { sessionId: "session-1", leafId: "entry-7", entryId: "entry-7" },
				};
				captureWatermark();
				return snapshot;
			},
			replay: async after => ({ observations: [], journalCursor: after }),
			subscribe: next => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			invoke: async () => ({ outcome: "completed" }),
			settle: async () => ({ state: "settled" }),
			dispose: () => {
				listener = undefined;
			},
		};
		const host = new SessionHost(authority, { epoch: "epoch-1", maxBufferedObservations: 8 });
		const frames: RpcSessionObservationFrame[] = [];
		const adapter = new RpcSessionHostAdapter(host, {
			output: frame => frames.push(frame),
		});

		const opened = await adapter.open({ snapshot: true });
		expect(opened.snapshot).toMatchObject({
			sessionId: "session-1",
			revision: 7,
			watermark: { epoch: "epoch-1", sequence: 0 },
		});
		expect(opened.durableCursor).toEqual({
			sessionId: "session-1",
			leafId: "entry-7",
			entryId: "entry-7",
		});

		listener?.({
			durability: "transient",
			kind: "activity",
			payload: { phase: "provider" },
			terminalSettlement: "none",
		});
		await flushMicrotasks();
		expect(frames).toEqual([
			{
				type: "session_observation",
				subscriptionId: opened.subscriptionId,
				observation: {
					type: "observation",
					sessionId: "session-1",
					epoch: "epoch-1",
					sequence: 1,
					eventId: "epoch-1:1",
					kind: "activity",
					replay: false,
					payload: { phase: "provider" },
					durability: "transient",
					terminalSettlement: "none",
				},
			},
		]);

		await adapter.acknowledge(opened.subscriptionId, 1);
		await adapter.unsubscribe(opened.subscriptionId);
	});
	test("waits for durable replay delivery before returning the cursor and watermark", async () => {
		const durable: SessionAuthorityObservation = {
			kind: "journal_entry",
			payload: { id: "entry-2" },
			durability: "durable",
			eventId: "session-1:entry-2",
			journalCursor: { sessionId: "session-1", leafId: "entry-2", entryId: "entry-2" },
			terminalSettlement: "none",
		};
		const authority: SessionAuthority = {
			sessionId: "session-1",
			snapshot: async captureWatermark => {
				captureWatermark();
				return {
					revision: 2,
					state: {},
					journalCursor: durable.journalCursor,
				};
			},
			replay: async () => ({ observations: [durable], journalCursor: durable.journalCursor }),
			subscribe: () => () => {},
			invoke: async () => ({ outcome: "completed" }),
			settle: async () => ({ state: "settled" }),
			dispose: () => {},
		};
		const frames: RpcSessionObservationFrame[] = [];
		const adapter = new RpcSessionHostAdapter(
			new SessionHost(authority, { epoch: "epoch-2", maxBufferedObservations: 8 }),
			{
				output: frame => frames.push(frame),
			},
		);

		const opened = await adapter.open({
			afterCursor: { sessionId: "session-1", leafId: "entry-1", entryId: "entry-1" },
			snapshot: false,
		});
		expect(opened).toMatchObject({
			replayComplete: true,
			durableCursor: durable.journalCursor,
			watermark: { sequence: 1 },
		});
		expect(opened.watermark?.epoch).not.toBe("epoch-2");
		expect(frames).toHaveLength(1);
		expect(frames[0]?.observation).toMatchObject({
			epoch: opened.watermark?.epoch,
			eventId: durable.eventId,
			replay: true,
			sequence: 1,
		});
		await adapter.unsubscribe(opened.subscriptionId);
		await adapter.shutdown();
	});

	test("delivers the terminal observation before graceful shutdown settles", async () => {
		let listener: ((observation: SessionAuthorityObservation) => void) | undefined;
		const authority: SessionAuthority = {
			sessionId: "session-1",
			snapshot: async captureWatermark => {
				const snapshot = {
					revision: 0,
					state: {},
					journalCursor: { sessionId: "session-1", leafId: null, entryId: null },
				};
				captureWatermark();
				return snapshot;
			},
			replay: async after => ({ observations: [], journalCursor: after }),
			subscribe: next => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			invoke: async () => ({ outcome: "completed" }),
			settle: async () => {
				listener?.({
					durability: "transient",
					kind: "session_settled",
					payload: {},
					terminalSettlement: "completed",
				});
				return { state: "settled" };
			},
			dispose: () => {
				listener = undefined;
			},
		};
		const frames: RpcSessionObservationFrame[] = [];
		const adapter = new RpcSessionHostAdapter(
			new SessionHost(authority, { epoch: "epoch-1", maxBufferedObservations: 8 }),
			{
				output: frame => frames.push(frame),
			},
		);
		await adapter.open({ snapshot: false });

		await expect(adapter.shutdown()).resolves.toEqual({ state: "settled" });
		expect(frames).toHaveLength(1);
		expect(frames[0]?.observation).toMatchObject({
			kind: "session_settled",
			terminalSettlement: "completed",
		});
	});

	test("enforces the adapter subscription limit and frees a slot after unsubscribe", async () => {
		const authority: SessionAuthority = {
			sessionId: "session-1",
			snapshot: async captureWatermark => {
				captureWatermark();
				return {
					revision: 0,
					state: {},
					journalCursor: { sessionId: "session-1", leafId: null, entryId: null },
				};
			},
			replay: async after => ({ observations: [], journalCursor: after }),
			subscribe: () => () => {},
			invoke: async () => ({ outcome: "completed" }),
			settle: async () => ({ state: "settled" }),
			dispose: () => {},
		};
		const adapter = new RpcSessionHostAdapter(
			new SessionHost(authority, { epoch: "epoch-1", maxBufferedObservations: 8, maxSubscriptions: 4 }),
			{ output: () => {}, maxSubscriptions: 1 },
		);
		const first = await adapter.open({ snapshot: false });
		await expect(adapter.open({ snapshot: false })).rejects.toBeInstanceOf(SessionSubscriptionCapacityError);
		await adapter.unsubscribe(first.subscriptionId);
		const second = await adapter.open({ snapshot: false });
		await adapter.unsubscribe(second.subscriptionId);
		await adapter.shutdown();
	});

	test("shares shutdown settlement through final observation pump drain", async () => {
		const settlementStarted = Promise.withResolvers<void>();
		const releaseSettlement = Promise.withResolvers<void>();
		let listener: ((observation: SessionAuthorityObservation) => void) | undefined;
		const frames: RpcSessionObservationFrame[] = [];
		const authority: SessionAuthority = {
			sessionId: "session-1",
			snapshot: async captureWatermark => {
				captureWatermark();
				return {
					revision: 0,
					state: {},
					journalCursor: { sessionId: "session-1", leafId: null, entryId: null },
				};
			},
			replay: async after => ({ observations: [], journalCursor: after }),
			subscribe: next => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			invoke: async () => ({ outcome: "completed" }),
			settle: async () => {
				settlementStarted.resolve();
				await releaseSettlement.promise;
				listener?.({
					durability: "transient",
					kind: "session_settled",
					payload: {},
					terminalSettlement: "completed",
				});
				return { state: "settled" };
			},
			dispose: () => {
				listener = undefined;
			},
		};
		const adapter = new RpcSessionHostAdapter(
			new SessionHost(authority, { epoch: "epoch-1", maxBufferedObservations: 8 }),
			{ output: frame => frames.push(frame) },
		);
		await adapter.open({ snapshot: false });

		let firstSettled = false;
		const shutdownPromise = adapter.shutdown();
		const firstShutdown = shutdownPromise.then(value => {
			firstSettled = true;
			return value;
		});
		await settlementStarted.promise;
		let secondSettled = false;
		const secondPromise = adapter.shutdown();
		expect(secondPromise).toBe(shutdownPromise);
		const secondShutdown = secondPromise.then(value => {
			secondSettled = true;
			return value;
		});
		await flushMicrotasks();
		expect(firstSettled).toBe(false);
		expect(secondSettled).toBe(false);
		releaseSettlement.resolve();
		await expect(Promise.all([firstShutdown, secondShutdown])).resolves.toEqual([
			{ state: "settled" },
			{ state: "settled" },
		]);
		expect(frames).toHaveLength(1);
		expect(frames[0]?.observation).toMatchObject({
			kind: "session_settled",
			terminalSettlement: "completed",
		});
	});

	test("maps an accepted legacy operation to its terminal semantic outcome", async () => {
		const terminal: RpcOperationTerminalFrame = {
			type: "operation_completed",
			operationId: "operation-1",
			requestId: "request-1",
			command: "prompt",
			agentInvoked: true,
			settledAt: 2,
		};
		const invoke = createRpcSessionCommandInvoker({
			execute: async command => ({
				id: command.id,
				type: "response",
				command: "prompt",
				success: true,
				data: { operationId: "operation-1", accepted: true },
			}),
			waitForSettlement: async operationId => {
				expect(operationId).toBe("operation-1");
				return terminal;
			},
			cancelOperation: () => {},
		});

		await expect(
			invoke({ kind: "prompt", input: { message: "hello" } }, { requestId: "request-1" }),
		).resolves.toEqual({
			outcome: "completed",
			result: terminal as unknown as SessionJsonValue,
		});
	});

	test("rejects recursive host commands and accepts authority-scoped idempotency keys", async () => {
		let executions = 0;
		const invoke = createRpcSessionCommandInvoker({
			execute: async command => {
				executions++;
				return {
					id: command.id,
					type: "response",
					command: "set_follow_up_mode",
					success: true,
				};
			},
			waitForSettlement: async () => undefined,
			cancelOperation: () => {},
		});

		await expect(invoke({ kind: "session_open" }, { requestId: "recursive" })).resolves.toMatchObject({
			outcome: "failed",
			error: { code: "unsupported_session_command" },
		});
		await expect(
			invoke(
				{ kind: "set_follow_up_mode", input: { mode: "all" }, idempotencyKey: "once" },
				{ requestId: "idempotent" },
			),
		).resolves.toEqual({ outcome: "completed" });
		expect(executions).toBe(1);
	});
});
