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
} from "@oh-my-pi/pi-coding-agent/session/session-host";

const flushMicrotasks = () => new Promise<void>(resolve => setImmediate(resolve));

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
