import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcModeController, type RpcModeControllerSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/mode-control";
import type { RpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { PlanProposalHandler } from "@oh-my-pi/pi-coding-agent/tools/resolve";

interface ControllerHarness {
	controller: RpcModeController;
	getState(): PlanModeState | undefined;
	getHandler(): PlanProposalHandler | null;
	getReference(): string | undefined;
	getTools(): string[];
	modeChanges: RpcMode[];
	confirmCalls: Array<{ title: string; message: string }>;
}

describe("RPC mode controller", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-mode-"));
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	function makeHarness(
		options: {
			planEnabled?: boolean;
			approved?: boolean;
			confirm?: (signal: AbortSignal) => Promise<boolean>;
			tools?: string[];
			builtInWrite?: boolean;
			initialState?: PlanModeState;
			planYolo?: boolean;
		} = {},
	): ControllerHarness {
		let state: PlanModeState | undefined = options.initialState;
		let handler: PlanProposalHandler | null = null;
		let reference: string | undefined;
		let enabledTools = [...(options.tools ?? ["read"])];
		const modeChanges: RpcMode[] = [];
		const confirmCalls: Array<{ title: string; message: string }> = [];
		const session: RpcModeControllerSession = {
			settings: { get: () => options.planEnabled ?? true },
			sessionManager: {
				getArtifactsDir: () => path.join(cwd, "artifacts"),
				getSessionId: () => "session-1",
				getCwd: () => cwd,
			},
			hasPlanYoloWorkflow: () => options.planYolo ?? false,
			getEnabledToolNames: () => enabledTools,
			hasBuiltInTool: name => name === "write" && (options.builtInWrite ?? true),
			setActiveToolsByName: async next => {
				enabledTools = [...next];
			},
			getPlanModeState: () => state,
			setPlanModeState: next => {
				state = next;
			},
			setPlanProposalHandler: next => {
				handler = next;
			},
			setPlanReferencePath: next => {
				reference = next;
			},
		};
		const controller = new RpcModeController({
			session,
			confirm: (title, message, signal) => {
				confirmCalls.push({ title, message });
				return options.confirm?.(signal) ?? Promise.resolve(options.approved ?? false);
			},
			onModeChanged: mode => modeChanges.push(mode),
		});
		return {
			controller,
			getState: () => state,
			getHandler: () => handler,
			getReference: () => reference,
			getTools: () => enabledTools,
			modeChanges,
			confirmCalls,
		};
	}

	test("enters and exits native plan mode", async () => {
		const harness = makeHarness();

		await harness.controller.apply("plan");
		expect(harness.controller.mode).toBe("plan");
		expect(harness.getState()).toMatchObject({
			enabled: true,
			planFilePath: "local://PLAN.md",
			workflow: "parallel",
		});
		expect(harness.getHandler()).toBeFunction();
		expect(harness.getTools()).toEqual(["read", "write"]);

		await harness.controller.apply("default");
		expect(harness.controller.mode).toBe("default");
		expect(harness.getState()).toBeUndefined();
		expect(harness.getHandler()).toBeNull();
		expect(harness.getTools()).toEqual(["read"]);
		expect(harness.modeChanges).toEqual(["plan", "default"]);
	});

	test("rejects plan mode when disabled", async () => {
		const harness = makeHarness({ planEnabled: false });

		await expect(harness.controller.apply("plan")).rejects.toThrow("Plan mode is disabled");
		expect(harness.controller.mode).toBe("default");
		expect(harness.modeChanges).toEqual([]);
	});

	test("keeps plan mode active when approval requests refinement", async () => {
		const planPath = path.join(cwd, "rpc-plan.md");
		await Bun.write(planPath, "# RPC plan\n\n1. Add mode control\n2. Add approval control\n");
		const harness = makeHarness({ approved: false });
		await harness.controller.apply("plan");
		harness.getState()!.planFilePath = planPath;

		const result = await harness.getHandler()!("RPC controls");

		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("Plan refinement requested") }),
		]);
		expect(harness.controller.mode).toBe("plan");
		expect(harness.getHandler()).toBeFunction();
		expect(harness.confirmCalls).toEqual([
			expect.objectContaining({ title: "Approve plan?", message: expect.stringContaining("# RPC plan") }),
		]);
		expect(harness.modeChanges).toEqual(["plan"]);
	});

	test("approval records the plan reference and returns to default mode", async () => {
		const planPath = path.join(cwd, "rpc-plan.md");
		await Bun.write(planPath, "# RPC plan\n\nImplement the controls.\n");
		const harness = makeHarness({ approved: true });
		await harness.controller.apply("plan");
		harness.getState()!.planFilePath = planPath;

		const result = await harness.getHandler()!("RPC controls");

		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("Plan approved") }),
		]);
		expect(harness.getReference()).toBe(planPath);
		expect(harness.controller.mode).toBe("default");
		expect(harness.getHandler()).toBeNull();
		expect(harness.modeChanges).toEqual(["plan", "default"]);
	});

	test("rejects a stale proposal result after plan mode changes", async () => {
		const planPath = path.join(cwd, "rpc-plan.md");
		await Bun.write(planPath, "# RPC plan\n\nImplement the controls.\n");
		const approval = Promise.withResolvers<boolean>();
		const confirmationStarted = Promise.withResolvers<void>();
		const harness = makeHarness({
			confirm: signal => {
				confirmationStarted.resolve();
				signal.addEventListener("abort", () => approval.resolve(false), { once: true });
				return approval.promise;
			},
		});
		await harness.controller.apply("plan");
		harness.getState()!.planFilePath = planPath;

		const proposal = harness.getHandler()!("RPC controls");
		await confirmationStarted.promise;
		await harness.controller.apply("default");

		await expect(proposal).rejects.toThrow("Plan approval was cancelled");
		expect(harness.controller.mode).toBe("default");
		expect(harness.getReference()).toBeUndefined();
	});

	test("cancels a proposal before plan resolution completes", async () => {
		const planPath = path.join(cwd, "rpc-plan.md");
		await Bun.write(planPath, "# RPC plan\n\nImplement the controls.\n");
		const harness = makeHarness({ approved: true });
		await harness.controller.apply("plan");
		harness.getState()!.planFilePath = planPath;

		const proposal = harness.getHandler()!("RPC controls");
		harness.controller.cancelPendingProposal();

		await expect(proposal).rejects.toThrow("Plan approval was cancelled");
		expect(harness.confirmCalls).toEqual([]);
		expect(harness.controller.mode).toBe("plan");
	});
	test("reapplying the active mode is idempotent", async () => {
		const harness = makeHarness();

		await harness.controller.apply("plan");
		const state = harness.getState();
		await harness.controller.apply("plan");

		expect(harness.getState()).toBe(state);
		expect(harness.getState()?.reentry).toBe(false);
		expect(harness.modeChanges).toEqual(["plan"]);
		expect(harness.getTools()).toEqual(["read", "write"]);
	});

	test("does not tear down plan mode owned by another workflow", async () => {
		const initialState: PlanModeState = {
			enabled: true,
			planFilePath: "local://PLAN.md",
			workflow: "parallel",
			reentry: false,
		};
		const harness = makeHarness({ initialState, tools: ["read", "write"] });

		await expect(harness.controller.apply("default")).rejects.toThrow("managed by another workflow");
		expect(harness.getState()).toBe(initialState);
		expect(harness.getTools()).toEqual(["read", "write"]);
		expect(harness.modeChanges).toEqual([]);
	});

	test("rejects RPC plan mode while plan-yolo is configured", async () => {
		const harness = makeHarness({ planYolo: true });

		await expect(harness.controller.apply("plan")).rejects.toThrow("plan-yolo workflow is configured");
		expect(harness.controller.mode).toBe("default");
		expect(harness.getTools()).toEqual(["read"]);
		expect(harness.modeChanges).toEqual([]);
	});
});
