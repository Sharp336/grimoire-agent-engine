import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { attachHeadlessGoalAdapter } from "@oh-my-pi/pi-coding-agent/goals/headless-goal-adapter";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/**
 * Adapter-level contracts for attachHeadlessGoalAdapter:
 *  - lifecycle wiring (async attach, initial restore, switch reconciler, detach)
 *  - continuation timing (RPC marks before submit; ACP does not mark)
 *
 * The shared GoalModeController unit-tests the suppression DECISION; these pin
 * the adapter WIRING. The adapter's Bun.sleep settle delay is spied to resolve
 * instantly (nothing real to settle against stubbed sessions) and the async
 * chain is driven via microtask flushes — no wall-clock, no fake timers.
 */

function createStubSession(options: { continuationModes: string[]; decision: { prompt: string } | null }) {
	let listener: ((event: { type: string; message?: { role: string; synthetic?: boolean } }) => void) | undefined;
	const controller = {
		onAgentEnd: vi.fn(async () => options.decision),
		onAgentStart: vi.fn(),
		onToolStart: vi.fn(),
		onGoalUpdated: vi.fn(async () => {}),
		markContinuationInFlight: vi.fn(),
		noteContinuationSubmissionEnded: vi.fn(),
		resetContinuationSuppression: vi.fn(),
		restore: vi.fn(async () => undefined),
	};
	const setSessionSwitchReconciler = vi.fn();
	const sendCustomMessage = vi.fn(async (): Promise<boolean> => true);
	const session = {
		subscribe: vi.fn((fn: (event: { type: string }) => void) => {
			listener = fn;
			return () => {
				listener = undefined;
			};
		}),
		setSessionSwitchReconciler,
		goalModeController: controller,
		settings: {
			get: vi.fn((key: string) => (key === "goal.continuationModes" ? options.continuationModes : undefined)),
		},
		isStreaming: false,
		getGoalModeState: () => ({ enabled: true, mode: "active", goal: { status: "active" } }),
		sendCustomMessage,
	} as unknown as AgentSession;
	return { session, controller, sendCustomMessage, setSessionSwitchReconciler, emit: (event: { type: string; message?: { role: string; synthetic?: boolean } }) => listener?.(event) };
}

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("attachHeadlessGoalAdapter lifecycle", () => {
	beforeEach(() => {
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("awaits an initial restore and registers as the session switch reconciler", async () => {
		const h = createStubSession({ continuationModes: ["rpc"], decision: null });
		const detach = await attachHeadlessGoalAdapter(h.session, "rpc");

		// Race-free initial reconciliation of any persisted goal.
		expect(h.controller.restore).toHaveBeenCalledTimes(1);
		// In-process switchSession re-reconciles instead of leaking goal state.
		expect(h.setSessionSwitchReconciler).toHaveBeenCalledTimes(1);
		const reconciler = h.setSessionSwitchReconciler.mock.calls[0]?.[0];
		expect(typeof reconciler).toBe("function");
		await reconciler();
		expect(h.controller.restore).toHaveBeenCalledTimes(2);

		detach();
		expect(h.setSessionSwitchReconciler).toHaveBeenLastCalledWith(null);
	});

	it("RPC arms the continuation mark BEFORE submitting the turn", async () => {
		const h = createStubSession({ continuationModes: ["rpc"], decision: { prompt: "CONTINUATION" } });
		const order: string[] = [];
		h.controller.markContinuationInFlight.mockImplementation(() => {
			order.push("mark");
		});
		h.sendCustomMessage.mockImplementation(async () => {
			order.push("send");
			return true;
		});
		await attachHeadlessGoalAdapter(h.session, "rpc");

		h.emit({ type: "agent_end" });
		await settle();

		expect(order).toEqual(["mark", "send"]);
		expect(h.sendCustomMessage).toHaveBeenCalledWith(
			{ customType: "goal-continuation", content: "CONTINUATION" },
			{ triggerTurn: true },
		);
	});

	it("RPC rolls back the mark when the submit throws", async () => {
		const h = createStubSession({ continuationModes: ["rpc"], decision: { prompt: "CONTINUATION" } });
		h.sendCustomMessage.mockRejectedValue(new Error("boom"));
		await attachHeadlessGoalAdapter(h.session, "rpc");

		h.emit({ type: "agent_end" });
		await settle();

		expect(h.controller.markContinuationInFlight).toHaveBeenCalledTimes(1);
		expect(h.controller.noteContinuationSubmissionEnded).toHaveBeenCalledTimes(1);
	});

	it("ACP does NOT mark and submits via the central trigger path", async () => {
		const h = createStubSession({ continuationModes: ["acp"], decision: { prompt: "CONTINUATION" } });
		await attachHeadlessGoalAdapter(h.session, "acp");

		h.emit({ type: "agent_end" });
		await settle();

		expect(h.controller.markContinuationInFlight).not.toHaveBeenCalled();
		expect(h.sendCustomMessage).toHaveBeenCalledWith(
			{ customType: "goal-continuation", content: "CONTINUATION" },
			{ triggerTurn: true },
		);
	});

	it("clears continuation suppression on a real user message", async () => {
		const h = createStubSession({ continuationModes: ["rpc"], decision: null });
		await attachHeadlessGoalAdapter(h.session, "rpc");

		h.emit({ type: "message_start", message: { role: "user", synthetic: false } });
		h.emit({ type: "message_start", message: { role: "assistant" } });
		h.emit({ type: "message_start", message: { role: "user", synthetic: true } });
		await settle();

		// Only the non-synthetic user message resets suppression.
		expect(h.controller.resetContinuationSuppression).toHaveBeenCalledTimes(1);
	});

	it("does not submit when the run mode is absent from continuationModes", async () => {
		const h = createStubSession({ continuationModes: ["interactive"], decision: { prompt: "CONTINUATION" } });
		await attachHeadlessGoalAdapter(h.session, "rpc");

		h.emit({ type: "agent_end" });
		await settle();

		expect(h.sendCustomMessage).not.toHaveBeenCalled();
		expect(h.controller.markContinuationInFlight).not.toHaveBeenCalled();
	});
});
