import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcOperationManager, RpcOperationMessageOwnership } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-operations";
import type {
	RpcOperationStartedFrame,
	RpcOperationTerminalFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

describe("RpcOperationManager", () => {
	test("emits started at begin and exactly one terminal settlement", () => {
		const frames: Array<RpcOperationStartedFrame | RpcOperationTerminalFrame> = [];
		let now = 10;
		const manager = new RpcOperationManager(
			frame => frames.push(frame),
			() => "operation-1",
			() => ++now,
		);
		const operation = manager.start("request-1", "prompt");

		expect(frames).toEqual([]);
		expect(manager.begin(operation)).toBe(true);
		expect(manager.complete(operation, true)).toBe(true);
		expect(manager.fail(operation, new Error("late failure"))).toBe(false);
		expect(manager.complete(operation, false)).toBe(false);
		expect(frames.map(frame => frame.type)).toEqual(["operation_started", "operation_completed"]);
		expect(frames[1]).toMatchObject({
			operationId: "operation-1",
			requestId: "request-1",
			command: "prompt",
			agentInvoked: true,
		});
	});

	test("retains active cancellation until explicit quiescence and settles exactly once", async () => {
		const frames: Array<RpcOperationStartedFrame | RpcOperationTerminalFrame> = [];
		let sequence = 0;
		const manager = new RpcOperationManager(
			frame => frames.push(frame),
			() => `operation-${++sequence}`,
			() => 100,
		);
		const first = manager.start("request-1", "prompt");
		const second = manager.start("request-2", "prompt");
		manager.begin(first);
		const settlement = manager.waitForSettlement(first.operationId);

		const initial = manager.cancel(first.operationId, "user", "cancelled_by_client");
		const repeated = manager.cancel(first.operationId, "shutdown", "session_shutdown");

		expect(initial.wasStarted).toBe(true);
		expect(initial.wasQueued).toBe(false);
		expect(initial.didInitiate).toBe(true);
		expect(repeated.didInitiate).toBe(false);
		expect(initial.result).toEqual(repeated.result);
		expect(initial.result).toEqual({ operationId: first.operationId, status: "cancelling" });
		expect(manager.snapshot().active).toContainEqual(
			expect.objectContaining({ operationId: first.operationId, status: "cancelling" }),
		);
		expect(manager.complete(first, true)).toBe(false);
		expect(frames.filter(frame => frame.type === "operation_cancelled")).toHaveLength(0);
		let settled = false;
		void settlement.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		expect(manager.settleCancellation(first.operationId)).toBe(true);
		expect(manager.settleCancellation(first.operationId)).toBe(false);

		await expect(settlement).resolves.toMatchObject({
			type: "operation_cancelled",
			operationId: first.operationId,
			reason: "user",
			code: "cancelled_by_client",
		});
		expect(manager.isActive(first)).toBe(false);
		expect(manager.isActive(second)).toBe(true);
		expect(frames.filter(frame => frame.type === "operation_cancelled")).toHaveLength(1);
	});

	test("reports active commands from acceptance through settlement", () => {
		const manager = new RpcOperationManager(
			() => {},
			() => "operation-1",
		);
		const operation = manager.start("request-1", "set_mode");

		expect(manager.hasActiveCommand("set_mode")).toBe(true);
		expect(manager.hasActiveCommand("resolve_plan_approval")).toBe(false);

		manager.begin(operation);
		expect(manager.hasActiveCommand("set_mode")).toBe(true);

		manager.complete(operation, false);
		expect(manager.hasActiveCommand("set_mode")).toBe(false);
	});

	test("waits for the terminal outcome of an accepted operation", async () => {
		const manager = new RpcOperationManager(
			() => {},
			() => "operation-1",
			() => 100,
		);
		const operation = manager.start("request-1", "set_mode");
		const settlement = manager.waitForSettlement(operation.operationId);

		manager.begin(operation);
		manager.complete(operation, false, {
			state: {
				providerId: "test",
				name: "Test",
				authenticated: true,
				disabled: false,
				available: true,
				methods: [],
			},
		});

		await expect(settlement).resolves.toMatchObject({
			type: "operation_completed",
			operationId: "operation-1",
			data: { state: { providerId: "test", authenticated: true } },
		});
		await expect(manager.waitForSettlement(operation.operationId)).resolves.toMatchObject({
			type: "operation_completed",
			operationId: "operation-1",
		});
	});

	test("bulk cancellation preserves explicitly protected operations", () => {
		let sequence = 0;
		const manager = new RpcOperationManager(
			() => {},
			() => `operation-${++sequence}`,
		);
		const protectedOperation = manager.start("request-protected", "provider_auth");
		const cancellableOperation = manager.start("request-cancellable", "prompt");
		manager.begin(protectedOperation);
		manager.begin(cancellableOperation);

		manager.cancelAll("user", "cancelled_by_client", new Set([protectedOperation.operationId]));

		expect(manager.isActive(protectedOperation)).toBeTrue();
		expect(manager.isActive(cancellableOperation)).toBeTrue();
		expect(manager.snapshot().active).toContainEqual(
			expect.objectContaining({ operationId: cancellableOperation.operationId, status: "cancelling" }),
		);
		expect(manager.snapshot().recent).not.toContainEqual(
			expect.objectContaining({ type: "operation_cancelled", operationId: cancellableOperation.operationId }),
		);

		expect(manager.settleCancellation(cancellableOperation.operationId)).toBe(true);
		expect(manager.isActive(cancellableOperation)).toBeFalse();
		expect(manager.snapshot().recent).toContainEqual(
			expect.objectContaining({ type: "operation_cancelled", operationId: cancellableOperation.operationId }),
		);
	});

	test("cancelling a queued follow-up never aborts the active operation", async () => {
		const frames: Array<RpcOperationStartedFrame | RpcOperationTerminalFrame> = [];
		let sequence = 0;
		const manager = new RpcOperationManager(
			frame => frames.push(frame),
			() => `operation-${++sequence}`,
			() => 100,
		);
		const active = manager.start("request-active", "prompt");
		const followUp = manager.start("request-follow-up", "prompt");

		const activeMessage: AgentMessage = { role: "user", content: "active", timestamp: 1 };
		const tags = new WeakMap<AgentMessage, string>([[activeMessage, active.operationId]]);
		const queuedTags = [followUp.operationId, "unrelated-operation"];
		let abortCount = 0;
		const ownership = new RpcOperationMessageOwnership({
			getMessageTag: message => tags.get(message),
			removeQueuedMessagesByTag: tag => {
				const index = queuedTags.indexOf(tag);
				if (index === -1) return 0;
				queuedTags.splice(index, 1);
				return 1;
			},
			abort: async () => {
				abortCount++;
			},
		});
		expect(manager.beginById(ownership.observeMessageStart(activeMessage)!)).toBe(true);
		expect(manager.snapshot().active).toEqual([
			expect.objectContaining({ operationId: active.operationId, status: "started" }),
			expect.objectContaining({ operationId: followUp.operationId, status: "accepted" }),
		]);

		const followUpCancellation = await ownership.cancel(manager, followUp.operationId);
		expect(followUpCancellation.status).toBe("cancelled");
		expect(abortCount).toBe(0);
		expect(queuedTags).toEqual(["unrelated-operation"]);
		expect(manager.isActive(active)).toBe(true);

		const activeCancellation = await ownership.cancel(manager, active.operationId);
		expect(activeCancellation.status).toBe("cancelled");
		expect(abortCount).toBe(1);
		expect(frames.filter(frame => frame.type === "operation_cancelled")).toEqual([
			expect.objectContaining({ operationId: followUp.operationId }),
			expect.objectContaining({ operationId: active.operationId }),
		]);
	});

	test("cancelling an accepted queued operation removes only its queue entry", async () => {
		const frames: Array<RpcOperationStartedFrame | RpcOperationTerminalFrame> = [];
		const manager = new RpcOperationManager(
			frame => frames.push(frame),
			() => "operation-queued",
		);
		const queued = manager.start("request-queued", "prompt");
		const queuedTags = [queued.operationId, "other-operation"];
		let abortCount = 0;
		const ownership = new RpcOperationMessageOwnership({
			getMessageTag: () => undefined,
			removeQueuedMessagesByTag: operationId => {
				const index = queuedTags.indexOf(operationId);
				if (index === -1) return 0;
				queuedTags.splice(index, 1);
				return 1;
			},
			abort: async () => {
				abortCount++;
			},
		});

		const result = await ownership.cancel(manager, queued.operationId);
		expect(result.status).toBe("cancelled");
		expect(queuedTags).toEqual(["other-operation"]);
		expect(abortCount).toBe(0);
		expect(manager.isActive(queued)).toBe(false);
		expect(frames.filter(frame => frame.type === "operation_cancelled")).toHaveLength(1);
	});

	test("cancelling prompt preparation waits for quiescence and removes a raced queue entry", async () => {
		const frames: Array<RpcOperationStartedFrame | RpcOperationTerminalFrame> = [];
		const manager = new RpcOperationManager(
			frame => frames.push(frame),
			() => "operation-preparing",
		);
		const operation = manager.start("request-preparing", "prompt");
		const queuedTags: string[] = [];
		const controller = new AbortController();
		const preparation = Promise.withResolvers<void>();
		const ownership = new RpcOperationMessageOwnership({
			getMessageTag: () => undefined,
			removeQueuedMessagesByTag: operationId => {
				const index = queuedTags.indexOf(operationId);
				if (index === -1) return 0;
				queuedTags.splice(index, 1);
				return 1;
			},
			abort: async () => {
				throw new Error("Accepted preparation must not abort an unrelated active turn");
			},
		});
		ownership.trackPreparation(operation.operationId, controller, preparation.promise);

		const cancellation = ownership.cancel(manager, operation.operationId);
		await Promise.resolve();
		expect(controller.signal.aborted).toBe(true);
		expect(frames).toEqual([]);
		queuedTags.push(operation.operationId);
		preparation.resolve();

		await expect(cancellation).resolves.toMatchObject({ status: "cancelled" });
		expect(queuedTags).toEqual([]);
		expect(frames).toEqual([expect.objectContaining({ type: "operation_cancelled" })]);
	});

	test("an untagged assistant message preserves active operation ownership", async () => {
		const manager = new RpcOperationManager(
			() => {},
			() => "operation-active",
		);
		const operation = manager.start("request-active", "prompt");
		manager.begin(operation);
		const tagged: AgentMessage = { role: "user", content: "tagged", timestamp: 1 };
		const untagged: AgentMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		let abortCount = 0;
		const ownership = new RpcOperationMessageOwnership({
			getMessageTag: message => (message === tagged ? operation.operationId : undefined),
			removeQueuedMessagesByTag: () => 0,
			abort: async () => {
				abortCount++;
			},
		});

		ownership.observeMessageStart(tagged);
		ownership.observeMessageStart(untagged);
		expect((await ownership.cancel(manager, operation.operationId)).status).toBe("cancelled");
		expect(abortCount).toBe(1);
	});

	test("snapshot retains bounded recent outcomes and distinguishes accepted from started", () => {
		let sequence = 0;
		let now = 0;
		const manager = new RpcOperationManager(
			() => {},
			() => `operation-${++sequence}`,
			() => ++now,
		);
		const accepted = manager.start(undefined, "prompt");
		const started = manager.start(undefined, "abort_and_prompt");
		manager.begin(started);
		for (let index = 0; index < 130; index++) {
			const operation = manager.start(undefined, "prompt");
			manager.complete(operation, false);
		}

		const snapshot = manager.snapshot();
		expect(snapshot.active).toEqual([
			expect.objectContaining({ operationId: accepted.operationId, status: "accepted" }),
			expect.objectContaining({ operationId: started.operationId, status: "started" }),
		]);
		expect(snapshot.recent).toHaveLength(128);
	});
});
