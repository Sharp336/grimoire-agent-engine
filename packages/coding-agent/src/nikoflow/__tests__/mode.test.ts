import { describe, expect, test } from "bun:test";
import {
	createNikoflowBeforeToolCall,
	createNikoflowCallbackBundle,
	createNikoflowGetToolChoice,
	createNikoflowOnBeforeYield,
	createNikoflowOnTurnEnd,
	installNikoflowCallbacks,
	isWriteTool,
	type MinimalToolCallContext,
	type NikoflowCallbackHost,
	nikoflowToolViolation,
} from "../mode";
import { advancePhase, createState, mintGateRequest } from "../state";

const tool = (name: string, args: Record<string, unknown> = {}): MinimalToolCallContext => ({
	toolCall: { name },
	args,
});

describe("nikoflow mode callback helpers", () => {
	test("chains onTurnEnd after the previous handler", async () => {
		const calls: string[] = [];
		const chained = createNikoflowOnTurnEnd(
			async () => {
				calls.push("previous");
			},
			async () => {
				calls.push("nikoflow");
			},
		);

		await chained([]);
		expect(calls).toEqual(["previous", "nikoflow"]);
	});

	test("detects direct and shell writes", () => {
		expect(isWriteTool(tool("apply_patch"))).toBe(true);
		expect(isWriteTool(tool("bash", { command: "rg needle src" }))).toBe(false);
		expect(isWriteTool(tool("bash", { command: "sed -i 's/a/b/' file.ts" }))).toBe(true);
		expect(isWriteTool(tool("exec_command", { cmd: "echo hi > file.txt" }))).toBe(true);
	});

	test("blocks write-capable tools in grilling", async () => {
		const state = createState("standard");
		const before = createNikoflowBeforeToolCall(() => state);

		expect(await before(tool("bash", { command: "rg needle src" }))).toBeUndefined();
		expect(await before(tool("write"))).toEqual({
			block: true,
			reason: "Nikoflow grilling is read-only; write-capable tools are blocked until the plan gate advances.",
		});
	});

	test("preserves a previous beforeToolCall block", async () => {
		const before = createNikoflowBeforeToolCall(
			() => createState("standard"),
			() => ({ block: true, reason: "previous" }),
		);
		expect(await before(tool("write"))).toEqual({ block: true, reason: "previous" });
	});

	test("blocks execute writes until a failing test exists", () => {
		const executeState = advancePhase(createState("tactical"));
		expect(nikoflowToolViolation(executeState, tool("write"))).toContain("failing test");
		expect(nikoflowToolViolation(executeState, tool("write"), { hasFailingTest: () => true })).toBeNull();
	});

	test("chains tool choice with nikoflow priority", () => {
		expect(
			createNikoflowGetToolChoice(
				() => "previous",
				() => "nikoflow",
			)(),
		).toBe("nikoflow");
		expect(
			createNikoflowGetToolChoice(
				() => "previous",
				() => undefined,
			)(),
		).toBe("previous");
	});

	test("enqueues a follow-up when a gate is unmet", async () => {
		const calls: string[] = [];
		const state = mintGateRequest(createState("standard"), "g1");
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => false,
			message => {
				calls.push(message);
			},
			() => {
				calls.push("previous");
			},
		);

		await onBeforeYield();
		expect(calls[0]).toBe("previous");
		expect(calls[1]).toContain("gate");
		expect(calls[1]).toContain("grilling");
	});

	test("does not enqueue when there is no pending gate or the gate is satisfied", async () => {
		const calls: string[] = [];
		await createNikoflowOnBeforeYield(
			() => createState("standard"),
			() => false,
			message => {
				calls.push(message);
			},
		)();
		await createNikoflowOnBeforeYield(
			() => mintGateRequest(createState("standard"), "g1"),
			() => true,
			message => {
				calls.push(message);
			},
		)();
		expect(calls).toEqual([]);
	});

	test("creates a callback bundle without clobbering previous hooks", async () => {
		const calls: string[] = [];
		const state = mintGateRequest(createState("standard"), "g1");
		const bundle = createNikoflowCallbackBundle<string[], undefined, string>({
			getState: () => state,
			isGateSatisfied: () => false,
			enqueueFollowUp: message => {
				calls.push(message);
			},
			beforeToolCall: () => undefined,
			onTurnEnd: () => {
				calls.push("previous-turn");
			},
			afterTurnEnd: () => {
				calls.push("nikoflow-turn");
			},
			onBeforeYield: () => {
				calls.push("previous-yield");
			},
			getToolChoice: () => "previous-choice",
			nikoflowToolChoice: () => "nikoflow-choice",
		});

		await bundle.onTurnEnd?.([]);
		await bundle.onBeforeYield();

		expect(await bundle.beforeToolCall(tool("write"))).toEqual({
			block: true,
			reason: "Nikoflow grilling is read-only; write-capable tools are blocked until the plan gate advances.",
		});
		expect(bundle.getToolChoice?.()).toBe("nikoflow-choice");
		expect(calls[0]).toBe("previous-turn");
		expect(calls[1]).toBe("nikoflow-turn");
		expect(calls[2]).toBe("previous-yield");
		expect(calls[3]).toContain('phase "grilling"');
	});

	test("installs callbacks on a host and restores the previous hooks", async () => {
		const calls: string[] = [];
		const state = mintGateRequest(createState("standard"), "g1");
		const previousBefore = () => {
			calls.push("previous-before");
			return undefined;
		};
		const previousTurn = () => {
			calls.push("previous-turn");
		};
		const previousYield = () => {
			calls.push("previous-yield");
		};
		const previousChoice = () => "previous-choice";
		let installedTurn: ((messages: string[]) => Promise<void> | void) | undefined;
		let installedYield: (() => Promise<void> | void) | undefined;
		let installedChoice: (() => string | undefined) | undefined;
		const host: NikoflowCallbackHost<string[], undefined, string> = {
			beforeToolCall: previousBefore,
			setOnTurnEnd: (fn: typeof installedTurn) => {
				installedTurn = fn;
			},
			setOnBeforeYield: (fn: typeof installedYield) => {
				installedYield = fn;
			},
			setGetToolChoice: (fn: typeof installedChoice) => {
				installedChoice = fn;
			},
		};

		const installed = installNikoflowCallbacks<string[], undefined, string>(host, {
			getState: () => state,
			isGateSatisfied: () => false,
			enqueueFollowUp: message => {
				calls.push(message);
			},
			onTurnEnd: previousTurn,
			afterTurnEnd: () => {
				calls.push("nikoflow-turn");
			},
			onBeforeYield: previousYield,
			getToolChoice: previousChoice,
			nikoflowToolChoice: () => "nikoflow-choice",
		});

		await installedTurn?.([]);
		await installedYield?.();

		expect(await host.beforeToolCall?.(tool("write"))).toEqual({
			block: true,
			reason: "Nikoflow grilling is read-only; write-capable tools are blocked until the plan gate advances.",
		});
		expect(installed.bundle.getToolChoice?.()).toBe("nikoflow-choice");
		expect(installedChoice?.()).toBe("nikoflow-choice");
		expect(calls).toEqual([
			"previous-turn",
			"nikoflow-turn",
			"previous-yield",
			'Nikoflow gate for phase "grilling" is not satisfied. Continue only by satisfying the current gate; do not self-approve it.',
			"previous-before",
		]);

		installed.uninstall();
		expect(host.beforeToolCall).toBe(previousBefore);
		expect(installedTurn).toBe(previousTurn);
		expect(installedYield).toBe(previousYield);
		expect(installedChoice).toBe(previousChoice);
	});
});
