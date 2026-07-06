import { describe, expect, test } from "bun:test";
import {
	advanceNikoflowExecuteGate,
	advanceNikoflowHumanGate,
	advanceNikoflowReviewerGate,
	createNikoflowBeforeToolCall,
	createNikoflowCallbackBundle,
	createNikoflowGetToolChoice,
	createNikoflowOnBeforeYield,
	createNikoflowOnTurnEnd,
	enterNikoflowPhase,
	installNikoflowAgentSessionMode,
	installNikoflowCallbacks,
	isWriteTool,
	type MinimalToolCallContext,
	type NikoflowAgentSessionHost,
	type NikoflowCallbackHost,
	type NikoflowPhaseEntryHost,
	nikoflowToolViolation,
} from "../mode";
import {
	advancePhase,
	createState,
	currentPhase,
	currentRole,
	isComplete,
	markPhaseTurnStarted,
	mintGateRequest,
	type NikoflowState,
} from "../state";

const tool = (name: string, args: Record<string, unknown> = {}): MinimalToolCallContext => ({
	toolCall: { name },
	args,
});

interface MockModel {
	provider: string;
	id: string;
}

function roleModel(role: string): MockModel {
	return {
		provider: "mock",
		id: role === "plan" ? "strong" : role,
	};
}

function phaseEntryHost(
	events: string[],
	reviewerResults: unknown[],
	setState: (state: NikoflowState) => void,
): NikoflowPhaseEntryHost<MockModel> {
	return {
		resolveRoleModelWithThinking: role => ({
			model: roleModel(role),
			explicitThinkingLevel: false,
		}),
		applyRoleModel: entry => {
			events.push(`role:${entry.role}`);
		},
		setState: state => {
			setState(state);
			events.push(`state:${currentPhase(state) ?? "complete"}:${state.gateRequestId ?? "none"}`);
		},
		sendNikoflowContext: state => {
			events.push(`context:${currentPhase(state) ?? "complete"}:${state.gateRequestId ?? "none"}`);
		},
		requestReviewer: state => {
			events.push(`reviewer:${state.gateRequestId ?? "none"}`);
			return reviewerResults.shift();
		},
	};
}

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

	test("allows execute writes after grilling advances", () => {
		const executeState = advancePhase(createState("tactical"));
		expect(nikoflowToolViolation(executeState, tool("write"))).toBeNull();
	});

	test("advances human gates only from later genuine user turns", async () => {
		type Message = { role: "user" | "assistant" | "toolResult"; timestamp: number };
		const options = {
			isGenuineUserTurn: (message: Message) => message.role === "user",
			messageTimestamp: (message: Message) => message.timestamp,
			nextGateRequestId: () => "next-gate",
			now: () => 20,
		};

		const grilling = mintGateRequest(createState("tactical"), "gate-1", 10);
		const execute = advanceNikoflowHumanGate(grilling, [{ role: "user", timestamp: 11 }], options);
		expect(currentPhase(execute)).toBe("execute");
		expect(execute.gateRequestId).toBeNull();
		expect(await createNikoflowBeforeToolCall(() => execute)(tool("write"))).toBeUndefined();

		const assistantOnly = advanceNikoflowHumanGate(grilling, [{ role: "assistant", timestamp: 11 }], options);
		expect(currentPhase(assistantOnly)).toBe("grilling");
		expect(assistantOnly.gateRequestId).toBe("gate-1");

		const toolOnly = advanceNikoflowHumanGate(grilling, [{ role: "toolResult", timestamp: 11 }], options);
		expect(currentPhase(toolOnly)).toBe("grilling");
		expect(toolOnly.gateRequestId).toBe("gate-1");

		const staleUser = advanceNikoflowHumanGate(grilling, [{ role: "user", timestamp: 9 }], options);
		expect(currentPhase(staleUser)).toBe("grilling");
		expect(staleUser.gateRequestId).toBe("gate-1");
	});

	test("chains tool choice without swallowing the previous directive", () => {
		expect(
			createNikoflowGetToolChoice(
				() => "previous",
				() => "nikoflow",
			)(),
		).toBe("previous");
		expect(
			createNikoflowGetToolChoice(
				() => undefined,
				() => "nikoflow",
			)(),
		).toBe("nikoflow");
	});

	test("yields human gates instead of queuing a follow-up", async () => {
		const calls: string[] = [];
		const externalActions: string[] = [];
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
			undefined,
			undefined,
			undefined,
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();
		expect(calls).toEqual(["previous"]);
		expect(externalActions).toHaveLength(1);
		expect(externalActions[0]).toContain("human approval");
	});

	test("queues execute work once before execute can advance to verify", async () => {
		let state = advancePhase(createState("tactical"));
		const events: string[] = [];
		const followUps: string[] = [];
		const host = phaseEntryHost(events, [], next => {
			state = next;
		});
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => false,
			message => {
				followUps.push(message);
			},
			undefined,
			async current => {
				const next = advanceNikoflowExecuteGate(current);
				const result = await enterNikoflowPhase(host, currentPhase(current), currentPhase(next), next, {
					nextGateRequestId: () => "verify-gate",
					now: () => 100,
				});
				return result.reviewerToolResult;
			},
		);

		await onBeforeYield();
		expect(currentPhase(state)).toBe("execute");
		expect(followUps).toEqual([
			"Nikoflow execute phase is active. Do the execute work now; do not skip straight to verify.",
		]);

		state = markPhaseTurnStarted(state);
		await onBeforeYield();
		expect(currentPhase(state)).toBe("verify");
		expect(state.gateRequestId).toBe("verify-gate");
		expect(events).toEqual([
			"role:advisor",
			"state:verify:verify-gate",
			"context:verify:verify-gate",
			"reviewer:verify-gate",
		]);
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
		expect(bundle.getToolChoice?.()).toBe("previous-choice");
		expect(calls[0]).toBe("previous-turn");
		expect(calls[1]).toBe("nikoflow-turn");
		expect(calls[2]).toBe("previous-yield");
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
		expect(installed.bundle.getToolChoice?.()).toBe("previous-choice");
		expect(installedChoice?.()).toBe("previous-choice");
		expect(calls).toEqual(["previous-turn", "nikoflow-turn", "previous-yield", "previous-before"]);

		installed.uninstall();
		expect(host.beforeToolCall).toBe(previousBefore);
		expect(installedTurn).toBe(previousTurn);
		expect(installedYield).toBe(previousYield);
		expect(installedChoice).toBe(previousChoice);
	});

	test("attaches to an AgentSession-like host without clobbering existing handlers", async () => {
		const calls: string[] = [];
		const followUps: string[] = [];
		const appliedRoles: string[] = [];
		let state = mintGateRequest(createState("standard"), "g1");
		let gateSatisfied = false;
		let installedTurn: ((messages: string[]) => Promise<void> | void) | undefined = () => {
			calls.push("advisor-turn");
		};
		let installedYield: (() => Promise<void> | void) | undefined = () => {
			calls.push("previous-yield");
		};
		let installedChoice: (() => string | undefined) | undefined = () => "previous-choice";

		const host: NikoflowAgentSessionHost<string[], undefined, string, MockModel> = {
			beforeToolCall: () => {
				calls.push("previous-before");
				return undefined;
			},
			getOnTurnEnd: () => installedTurn,
			setOnTurnEnd: fn => {
				installedTurn = fn;
			},
			getOnBeforeYield: () => installedYield,
			setOnBeforeYield: fn => {
				installedYield = fn;
			},
			getGetToolChoice: () => installedChoice,
			setGetToolChoice: fn => {
				installedChoice = fn;
			},
			resolveRoleModelWithThinking: role => ({
				model: roleModel(role),
				explicitThinkingLevel: false,
			}),
			applyRoleModel: entry => {
				appliedRoles.push(entry.role);
			},
		};

		await installNikoflowAgentSessionMode(host, {
			getState: () => state,
			isGateSatisfied: () => gateSatisfied,
			enqueueFollowUp: message => {
				followUps.push(message);
			},
			afterTurnEnd: () => {
				calls.push("nikoflow-turn");
			},
			nikoflowToolChoice: () => undefined,
		});

		await installedTurn?.([]);
		expect(calls.slice(0, 2)).toEqual(["advisor-turn", "nikoflow-turn"]);
		expect(appliedRoles).toEqual([]);

		expect(await installedYield?.()).toBeUndefined();
		expect(followUps).toEqual([]);

		gateSatisfied = true;
		expect(await installedYield?.()).toBeUndefined();
		expect(followUps).toEqual([]);

		expect(await host.beforeToolCall?.(tool("write"))).toEqual({
			block: true,
			reason: "Nikoflow grilling is read-only; write-capable tools are blocked until the plan gate advances.",
		});
		expect(calls).toContain("previous-before");
		expect(installedChoice?.()).toBe("previous-choice");

		state = advancePhase(createState("tactical"));
		await installedTurn?.([]);
		expect(appliedRoles).toEqual([]);
	});

	test("enters a phase with role, fresh context, gate mint, and verify reviewer in one driver", async () => {
		let state = createState("standard");
		const events: string[] = [];
		const reviewerResults: unknown[] = [{ type: "tool_result", content: { gateId: "verify-gate", verdict: "pass" } }];
		const host = phaseEntryHost(events, reviewerResults, next => {
			state = next;
		});

		await enterNikoflowPhase(host, null, "grilling", state, {
			nextGateRequestId: () => "human-gate",
			now: () => 10,
		});
		expect(events).toEqual(["role:plan", "state:grilling:human-gate", "context:grilling:human-gate"]);
		expect(state.gateRequestId).toBe("human-gate");

		events.length = 0;
		const execute = markPhaseTurnStarted(advancePhase(createState("tactical")));
		const verify = advanceNikoflowExecuteGate(execute);
		const result = await enterNikoflowPhase(host, "execute", "verify", verify, {
			nextGateRequestId: () => "verify-gate",
			now: () => 20,
		});

		expect(result.reviewerToolResult).toEqual({
			type: "tool_result",
			content: { gateId: "verify-gate", verdict: "pass" },
		});
		expect(currentRole(state)).toBe("advisor");
		expect(events).toEqual([
			"role:advisor",
			"state:verify:verify-gate",
			"context:verify:verify-gate",
			"reviewer:verify-gate",
		]);
	});

	test("execute completion enters verify through the driver and requests a reviewer", async () => {
		let gateCounter = 0;
		let state = advancePhase(createState("tactical"));
		const events: string[] = [];
		const followUps: string[] = [];
		const reviewerResults: unknown[] = [{ type: "tool_result", content: { gateId: "gate-1", verdict: "block" } }];
		const host = phaseEntryHost(events, reviewerResults, next => {
			state = next;
		});
		const bundle = createNikoflowCallbackBundle<unknown[], { toolResults?: unknown[] }, string>({
			getState: () => state,
			isGateSatisfied: current => current.gateRequestId === null,
			enqueueFollowUp: message => {
				followUps.push(message);
			},
			afterTurnEnd: () => undefined,
			advanceHumanGate: () => {
				if (currentPhase(state) === "execute") state = markPhaseTurnStarted(state);
			},
			advanceExecuteGate: async current => {
				const next = advanceNikoflowExecuteGate(current);
				const result = await enterNikoflowPhase(host, currentPhase(current), currentPhase(next), next, {
					nextGateRequestId: () => `gate-${++gateCounter}`,
					now: () => 100,
				});
				return result.reviewerToolResult;
			},
			advanceReviewerGate: (current, verdict) => {
				state = advanceNikoflowReviewerGate(current, verdict);
			},
		});

		await bundle.onBeforeYield();
		expect(currentPhase(state)).toBe("execute");
		expect(currentRole(state)).toBe("default");
		expect(isComplete(state)).toBe(false);
		expect(followUps).toHaveLength(1);
		expect(events).toEqual([]);

		await bundle.onTurnEnd?.([], undefined, { toolResults: [] });
		await bundle.onBeforeYield();
		expect(currentPhase(state)).toBe("verify");
		expect(currentRole(state)).toBe("advisor");
		expect(isComplete(state)).toBe(false);
		const gateId = state.gateRequestId;
		expect(gateId).toBe("gate-1");
		expect(events).toEqual(["role:advisor", "state:verify:gate-1", "context:verify:gate-1", "reviewer:gate-1"]);
		expect(followUps).toHaveLength(2);

		await bundle.onTurnEnd?.(
			[{ role: "assistant", content: [{ type: "text", text: `{"gateId":"${gateId}","verdict":"pass"}` }] }],
			undefined,
			{ toolResults: [{ type: "tool_result", content: { gateId, verdict: "pass", score: 10 } }] },
		);
		expect(currentPhase(state)).toBe("verify");
		expect(isComplete(state)).toBe(false);
	});

	test("reviewer block retry re-enters verify with a fresh gate and reviewer request", async () => {
		let gateCounter = 0;
		let reviewerAttempt = 0;
		let state = markPhaseTurnStarted(advancePhase(createState("tactical")));
		const events: string[] = [];
		const blocked: string[] = [];
		const host = phaseEntryHost(events, [], next => {
			state = next;
		});
		host.requestReviewer = current => {
			events.push(`reviewer:${current.gateRequestId ?? "none"}`);
			reviewerAttempt++;
			return {
				type: "tool_result",
				content: {
					gateId: current.gateRequestId,
					verdict: reviewerAttempt === 1 ? "block" : "pass",
					reason: reviewerAttempt === 1 ? "needs fixes" : undefined,
				},
			};
		};
		const bundle = createNikoflowCallbackBundle<unknown[], { toolResults?: unknown[] }, string>({
			getState: () => state,
			isGateSatisfied: current => current.gateRequestId === null,
			enqueueFollowUp: () => undefined,
			advanceExecuteGate: async current => {
				const next = advanceNikoflowExecuteGate(current);
				const result = await enterNikoflowPhase(host, currentPhase(current), currentPhase(next), next, {
					nextGateRequestId: () => `gate-${++gateCounter}`,
					now: () => 100 + gateCounter,
				});
				return result.reviewerToolResult;
			},
			requestReviewer: async current => {
				const result = await enterNikoflowPhase(host, currentPhase(current), currentPhase(current), current, {
					nextGateRequestId: () => `gate-${++gateCounter}`,
					now: () => 100 + gateCounter,
				});
				return result.reviewerToolResult;
			},
			advanceReviewerGate: (current, verdict) => {
				state = advanceNikoflowReviewerGate(current, verdict);
			},
			onReviewerBlock: current => {
				blocked.push(current.gateRequestId ?? "none");
			},
		});

		await bundle.onBeforeYield();
		expect(currentPhase(state)).toBe("verify");
		expect(state.gateRequestId).toBe("gate-1");
		expect(blocked).toEqual(["gate-1"]);
		expect(events).toEqual(["role:advisor", "state:verify:gate-1", "context:verify:gate-1", "reviewer:gate-1"]);

		state = markPhaseTurnStarted(state);
		await bundle.onBeforeYield();
		expect(isComplete(state)).toBe(true);
		expect(events.slice(4)).toEqual([
			"role:advisor",
			"state:verify:gate-2",
			"context:verify:gate-2",
			"reviewer:gate-2",
		]);
	});

	test("caps repeated reviewer-block follow-ups and then yields externally", async () => {
		const state = markPhaseTurnStarted(
			mintGateRequest(advancePhase(advancePhase(createState("tactical"))), "gate-1"),
		);
		const followUps: string[] = [];
		const externalActions: string[] = [];
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => false,
			message => {
				followUps.push(message);
			},
			undefined,
			undefined,
			() => ({ type: "tool_result", details: { gateId: "gate-1" }, content: { verdict: "block" } }),
			undefined,
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();
		await onBeforeYield();
		await onBeforeYield();
		await onBeforeYield();

		expect(followUps).toHaveLength(3);
		expect(externalActions).toHaveLength(1);
		expect(externalActions[0]).toContain("yielding instead of queuing another follow-up");
	});
});
