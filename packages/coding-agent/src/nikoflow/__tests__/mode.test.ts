import { describe, expect, test } from "bun:test";
import {
	advanceNikoflowAdvisorGate,
	advanceNikoflowExecuteGate,
	advanceNikoflowHumanGate,
	createNikoflowBeforeToolCall,
	createNikoflowCallbackBundle,
	createNikoflowGetToolChoice,
	createNikoflowOnBeforeYield,
	createNikoflowOnTurnEnd,
	enterNikoflowPhase,
	formatGateHoldMessage,
	installNikoflowAgentSessionMode,
	installNikoflowCallbacks,
	isNikoflowReadOnlyPhaseToolAllowed,
	type MinimalToolCallContext,
	type NikoflowAdvisorReview,
	type NikoflowAgentSessionHost,
	type NikoflowCallbackHost,
	type NikoflowPhaseEntryHost,
	nikoflowToolViolation,
} from "../mode";
import { getPhasePrompt } from "../prompts";
import {
	advancePhase,
	createState,
	currentPhase,
	currentRole,
	isComplete,
	markPhaseTurnStarted,
	mintGateRequest,
	type NikoflowState,
	setTicketDag,
} from "../state";
import type { NikoflowTicket } from "../tickets";

const readOnlyReason = (phase: string, gate = "the Ticketization gate advances") =>
	`Nikoflow ${phase} is read-only; only read/search/planning tools are allowed. Writes and code-execution tools are blocked until ${gate}.`;

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
	advisorReviews: unknown[],
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
		requestAdvisorReview: state => {
			events.push(`advisor:${state.gateRequestId ?? "none"}`);
			return advisorReviews.shift();
		},
	};
}

function advisorReview(
	gateId: string,
	severity: "nit" | "concern" | "blocker" = "nit",
	note = "ok",
): NikoflowAdvisorReview {
	return { gateId, reviewed: true, notes: [{ severity, note }] };
}

const ticket = (id: string, blocked_by: string[] = [], status: NikoflowTicket["status"] = "todo"): NikoflowTicket => ({
	id,
	acceptance: [`${id} acceptance`],
	blocked_by,
	implementation_notes: `${id} notes`,
	status,
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

	test("allows only explicit read-only planning tools before execute", () => {
		for (const name of ["read", "glob", "grep", "nikoflow_define_tickets"]) {
			expect(isNikoflowReadOnlyPhaseToolAllowed(tool(name))).toBe(true);
		}
		for (const name of ["bash", "node_repl", "python_repl", "edit", "write", "unknown_tool"]) {
			expect(isNikoflowReadOnlyPhaseToolAllowed(tool(name))).toBe(false);
		}
	});

	test("blocks writes, code execution, and unknown tools before execute", async () => {
		const state = createState("standard");
		const before = createNikoflowBeforeToolCall(() => state);
		const blockedTools = ["bash", "node_repl", "python_repl", "edit", "write", "apply_patch", "unknown_tool"];
		const allowedTools = ["read", "glob", "grep", "nikoflow_define_tickets"];

		let preExecute = state;
		for (const phase of ["grilling", "adr", "prd", "tickets"] as const) {
			expect(currentPhase(preExecute)).toBe(phase);
			for (const name of allowedTools) {
				expect(nikoflowToolViolation(preExecute, tool(name))).toBeNull();
			}
			for (const name of blockedTools) {
				expect(nikoflowToolViolation(preExecute, tool(name))).toBe(readOnlyReason(phase));
			}
			preExecute = advancePhase(preExecute);
		}
		expect(await before(tool("write"))).toEqual({ block: true, reason: readOnlyReason("grilling") });
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
		for (const name of ["write", "edit", "apply_patch", "bash", "eval", "node_repl", "python_repl"]) {
			expect(nikoflowToolViolation(executeState, tool(name))).toBeNull();
		}
	});

	test("names the tactical grilling gate in read-only blocks", () => {
		const grilling = createState("tactical");
		expect(nikoflowToolViolation(grilling, tool("bash"))).toBe(
			readOnlyReason("grilling", "grilling advances to execute"),
		);
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

	test("blocks ticketization approval until the ticket DAG is captured", () => {
		const ticketsPhase = mintGateRequest(advancePhase(advancePhase(advancePhase(createState("standard")))), "g1", 10);
		const next = advanceNikoflowHumanGate(ticketsPhase, [{ role: "user", timestamp: 11 }], {
			isGenuineUserTurn: message => message.role === "user",
			messageTimestamp: message => message.timestamp,
			nextGateRequestId: () => "next-gate",
			now: () => 20,
		});

		expect(currentPhase(next)).toBe("tickets");
		expect(next.gateRequestId).toBe("g1");
		expect(formatGateHoldMessage(next)).toContain("nikoflow_define_tickets");
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
					requestAdvisorReview: false,
				});
				return result.advisorReview;
			},
			state => host.requestAdvisorReview?.(state),
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
			"advisor:verify-gate",
		]);
	});

	test("runs a standard-depth ticket through execute, advisor review, and done", async () => {
		let state = createState("standard");
		state = advancePhase(advancePhase(advancePhase(advancePhase(state))));
		state = setTicketDag(state, [ticket("TSK-001"), ticket("TSK-002", ["TSK-001"])]);
		const events: string[] = [];
		const followUps: string[] = [];
		const host = phaseEntryHost(events, [], next => {
			state = next;
		});
		const entered = await enterNikoflowPhase(host, "tickets", "execute", state, {
			nextGateRequestId: () => "unused",
			now: () => 100,
			requestAdvisorReview: false,
		});
		state = entered.state;

		expect(state.activeTicketId).toBe("TSK-001");
		expect(state.tickets[0].status).toBe("red");

		state = markPhaseTurnStarted(state);
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			current => current.gateRequestId === null,
			message => {
				followUps.push(message);
			},
			undefined,
			current => {
				state = advanceNikoflowExecuteGate(current, {
					nextGateRequestId: () => "ticket-gate",
					now: () => 200,
				});
			},
			current => advisorReview(current.gateRequestId ?? "missing"),
			(current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
		);

		await onBeforeYield();

		expect(state.tickets.map(item => [item.id, item.status])).toEqual([
			["TSK-001", "done"],
			["TSK-002", "red"],
		]);
		expect(state.activeTicketId).toBe("TSK-002");
		expect(currentPhase(state)).toBe("execute");
		expect(followUps.at(-1)).toContain("Nikoflow execute ticket TSK-002.");
	});

	test("execute exposes only the active ticket until advisor review marks it done", async () => {
		let state = advancePhase(advancePhase(advancePhase(advancePhase(createState("standard")))));
		state = setTicketDag(state, [ticket("TSK-001"), ticket("TSK-002", ["TSK-001"])]);
		const host = phaseEntryHost([], [], next => {
			state = next;
		});
		state = (
			await enterNikoflowPhase(host, "tickets", "execute", state, {
				nextGateRequestId: () => "unused",
				now: () => 100,
				requestAdvisorReview: false,
			})
		).state;

		expect(getPhasePrompt(state)).toContain("Active ticket: TSK-001");
		expect(getPhasePrompt(state)).not.toContain("TSK-002");

		state = advanceNikoflowExecuteGate(markPhaseTurnStarted(state), {
			nextGateRequestId: () => "ticket-gate",
			now: () => 200,
		});
		expect(state.activeTicketId).toBe("TSK-001");
		expect(state.tickets.map(item => [item.id, item.status])).toEqual([
			["TSK-001", "review"],
			["TSK-002", "todo"],
		]);
		expect(getPhasePrompt(state)).toContain("Active ticket: TSK-001");
		expect(getPhasePrompt(state)).not.toContain("Active ticket: TSK-002");

		const blocked = advanceNikoflowAdvisorGate(state, advisorReview("ticket-gate", "blocker", "missing test"));
		expect(blocked).toBe(state);
		expect(blocked.activeTicketId).toBe("TSK-001");

		state = advanceNikoflowAdvisorGate(state, advisorReview("ticket-gate"));
		expect(state.tickets.map(item => [item.id, item.status])).toEqual([
			["TSK-001", "done"],
			["TSK-002", "red"],
		]);
		expect(getPhasePrompt(state)).toContain("Active ticket: TSK-002");
	});

	test("a stuck active ticket escalates boundedly without aborting execute", async () => {
		let state = advancePhase(advancePhase(advancePhase(advancePhase(createState("standard")))));
		state = setTicketDag(state, [ticket("TSK-001"), ticket("TSK-002", ["TSK-001"])]);
		const host = phaseEntryHost([], [], next => {
			state = next;
		});
		state = (
			await enterNikoflowPhase(host, "tickets", "execute", state, {
				nextGateRequestId: () => "unused",
				now: () => 100,
				requestAdvisorReview: false,
			})
		).state;
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
			undefined,
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
		expect(followUps.every(message => message.includes("Nikoflow execute ticket TSK-001."))).toBe(true);
		expect(followUps.some(message => message.includes("TSK-002"))).toBe(false);
		expect(externalActions).toHaveLength(1);
		expect(externalActions[0]).toContain("yielding instead of queuing another follow-up");
		expect(currentPhase(state)).toBe("execute");
		expect(state.activeTicketId).toBe("TSK-001");
	});

	test("execute does not skip to verify when the captured DAG is missing", () => {
		const execute = markPhaseTurnStarted(
			advancePhase(advancePhase(advancePhase(advancePhase(createState("standard"))))),
		);
		const next = advanceNikoflowExecuteGate(execute);

		expect(currentPhase(next)).toBe("execute");
		expect(next.gateRequestId).toBeNull();
		expect(formatGateHoldMessage(next)).toContain("return to Ticketization");
	});

	test("missing post-ticketization DAG yields externally without follow-up loop", async () => {
		const state = advancePhase(advancePhase(advancePhase(advancePhase(createState("standard")))));
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
			undefined,
			undefined,
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();

		expect(followUps).toEqual([]);
		expect(externalActions).toHaveLength(1);
		expect(externalActions[0]).toContain("nikoflow_define_tickets");
	});

	test("sends a blocked ticket to the block handler without aborting the run", async () => {
		let state = createState("standard");
		state = advancePhase(advancePhase(advancePhase(advancePhase(state))));
		state = setTicketDag(state, [ticket("TSK-001")]);
		state = { ...state, activeTicketId: "TSK-001", phaseTurnStarted: true };
		const blocks: string[] = [];
		const externalActions: string[] = [];

		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			current => current.gateRequestId === null,
			() => {},
			undefined,
			current => {
				state = advanceNikoflowExecuteGate(current, {
					nextGateRequestId: () => "ticket-gate",
					now: () => 200,
				});
			},
			current => advisorReview(current.gateRequestId ?? "missing", "blocker", "acceptance missing"),
			(current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			(_current, review) => {
				blocks.push(review.notes[0]?.note ?? "");
			},
			(_current, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();

		expect(blocks).toEqual(["acceptance missing"]);
		expect(externalActions).toEqual([]);
		expect(currentPhase(state)).toBe("execute");
		expect(state.activeTicketId).toBe("TSK-001");
		expect(state.tickets[0].status).toBe("review");
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
			reason: readOnlyReason("grilling"),
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
			reason: readOnlyReason("grilling"),
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
			reason: readOnlyReason("grilling"),
		});
		expect(calls).toContain("previous-before");
		expect(installedChoice?.()).toBe("previous-choice");

		state = advancePhase(createState("tactical"));
		await installedTurn?.([]);
		expect(appliedRoles).toEqual([]);
	});

	test("enters a phase with role, fresh context, gate mint, and advisor review in one driver", async () => {
		let state = createState("standard");
		const events: string[] = [];
		const advisorReviews: unknown[] = [advisorReview("verify-gate")];
		const host = phaseEntryHost(events, advisorReviews, next => {
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

		expect(result.advisorReview).toEqual(advisorReview("verify-gate"));
		expect(currentRole(state)).toBe("advisor");
		expect(events).toEqual([
			"role:advisor",
			"state:verify:verify-gate",
			"context:verify:verify-gate",
			"advisor:verify-gate",
		]);
	});

	test("execute completion enters verify through the driver and requests advisor review", async () => {
		let gateCounter = 0;
		let state = advancePhase(createState("tactical"));
		const events: string[] = [];
		const followUps: string[] = [];
		const blocked: string[] = [];
		const advisorReviews: unknown[] = [advisorReview("gate-1", "blocker", "needs fixes")];
		const host = phaseEntryHost(events, advisorReviews, next => {
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
					requestAdvisorReview: false,
				});
				return result.advisorReview;
			},
			requestAdvisorReview: state => host.requestAdvisorReview?.(state),
			advanceAdvisorGate: (current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			onAdvisorBlock: (_current, review) => {
				blocked.push(review.notes[0]?.note ?? "");
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
		expect(events).toEqual(["role:advisor", "state:verify:gate-1", "context:verify:gate-1", "advisor:gate-1"]);
		expect(followUps).toHaveLength(1);
		expect(blocked).toEqual(["needs fixes"]);

		await bundle.onTurnEnd?.(
			[{ role: "assistant", content: [{ type: "text", text: `{"gateId":"${gateId}","verdict":"pass"}` }] }],
			undefined,
			{ toolResults: [{ type: "tool_result", content: { gateId, verdict: "pass", score: 10 } }] },
		);
		expect(currentPhase(state)).toBe("verify");
		expect(isComplete(state)).toBe(false);
	});

	test("stale empty-diff blocker from execute handoff does not block a fresh clean verify review", async () => {
		let state = markPhaseTurnStarted(advancePhase(createState("tactical")));
		const events: string[] = [];
		const blocked: string[] = [];
		const externalActions: string[] = [];
		const host = phaseEntryHost(events, [], next => {
			state = next;
		});
		const bundle = createNikoflowCallbackBundle<unknown[], undefined, string>({
			getState: () => state,
			isGateSatisfied: current => current.gateRequestId === null,
			enqueueFollowUp: () => undefined,
			advanceExecuteGate: async current => {
				const next = advanceNikoflowExecuteGate(current);
				await enterNikoflowPhase(host, currentPhase(current), currentPhase(next), next, {
					nextGateRequestId: () => "final-gate",
					now: () => 100,
					requestAdvisorReview: false,
				});
				return advisorReview("grilling-gate", "blocker", "Empty diff, acceptance not met, no code written");
			},
			requestAdvisorReview: current => advisorReview(current.gateRequestId ?? "none", "nit", "final diff clean"),
			advanceAdvisorGate: (current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			onAdvisorBlock: (_current, review) => {
				blocked.push(review.notes[0]?.note ?? "");
			},
			onGateNeedsExternalAction: (_state, message) => {
				externalActions.push(message);
			},
		});

		await bundle.onBeforeYield();

		expect(isComplete(state)).toBe(true);
		expect(blocked).toEqual([]);
		expect(externalActions).toEqual([]);
		expect(events).toEqual(["role:advisor", "state:verify:final-gate", "context:verify:final-gate"]);
	});

	test("fresh final-diff blocker holds the verify gate", async () => {
		let state = markPhaseTurnStarted(advancePhase(createState("tactical")));
		const blocked: string[] = [];
		const host = phaseEntryHost([], [], next => {
			state = next;
		});
		const bundle = createNikoflowCallbackBundle<unknown[], undefined, string>({
			getState: () => state,
			isGateSatisfied: current => current.gateRequestId === null,
			enqueueFollowUp: () => undefined,
			advanceExecuteGate: async current => {
				const next = advanceNikoflowExecuteGate(current);
				await enterNikoflowPhase(host, currentPhase(current), currentPhase(next), next, {
					nextGateRequestId: () => "final-gate",
					now: () => 100,
					requestAdvisorReview: false,
				});
			},
			requestAdvisorReview: current => advisorReview(current.gateRequestId ?? "none", "blocker", "real diff fails"),
			advanceAdvisorGate: (current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			onAdvisorBlock: (_current, review) => {
				blocked.push(review.notes[0]?.note ?? "");
			},
		});

		await bundle.onBeforeYield();

		expect(currentPhase(state)).toBe("verify");
		expect(state.gateRequestId).toBe("final-gate");
		expect(isComplete(state)).toBe(false);
		expect(blocked).toEqual(["real diff fails"]);
	});

	test("missing fresh verify review escalates instead of accepting stale handoff success", async () => {
		let state = markPhaseTurnStarted(advancePhase(createState("tactical")));
		const externalActions: string[] = [];
		const host = phaseEntryHost([], [], next => {
			state = next;
		});
		const bundle = createNikoflowCallbackBundle<unknown[], undefined, string>({
			getState: () => state,
			isGateSatisfied: current => current.gateRequestId === null,
			enqueueFollowUp: () => undefined,
			advanceExecuteGate: async current => {
				const next = advanceNikoflowExecuteGate(current);
				await enterNikoflowPhase(host, currentPhase(current), currentPhase(next), next, {
					nextGateRequestId: () => "final-gate",
					now: () => 100,
					requestAdvisorReview: false,
				});
				return advisorReview("final-gate", "nit", "stale handoff clean");
			},
			advanceAdvisorGate: (current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			onGateNeedsExternalAction: (_state, message) => {
				externalActions.push(message);
			},
		});

		await bundle.onBeforeYield();

		expect(currentPhase(state)).toBe("verify");
		expect(isComplete(state)).toBe(false);
		expect(externalActions).toHaveLength(1);
		expect(externalActions[0]).toContain("yielding instead of queuing another follow-up");
	});

	test("advisor blocker retry re-enters verify with a fresh gate and advisor review", async () => {
		let gateCounter = 0;
		let reviewerAttempt = 0;
		let state = markPhaseTurnStarted(advancePhase(createState("tactical")));
		const events: string[] = [];
		const blocked: string[] = [];
		const host = phaseEntryHost(events, [], next => {
			state = next;
		});
		host.requestAdvisorReview = current => {
			events.push(`advisor:${current.gateRequestId ?? "none"}`);
			reviewerAttempt++;
			return advisorReview(
				current.gateRequestId ?? "none",
				reviewerAttempt === 1 ? "blocker" : "nit",
				reviewerAttempt === 1 ? "needs fixes" : "clean",
			);
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
					requestAdvisorReview: false,
				});
				return result.advisorReview;
			},
			requestAdvisorReview: async current => {
				if (!current.phaseTurnStarted) return host.requestAdvisorReview?.(current);
				const result = await enterNikoflowPhase(host, currentPhase(current), currentPhase(current), current, {
					nextGateRequestId: () => `gate-${++gateCounter}`,
					now: () => 100 + gateCounter,
				});
				return result.advisorReview;
			},
			advanceAdvisorGate: (current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			onAdvisorBlock: current => {
				blocked.push(current.gateRequestId ?? "none");
			},
		});

		await bundle.onBeforeYield();
		expect(currentPhase(state)).toBe("verify");
		expect(state.gateRequestId).toBe("gate-1");
		expect(blocked).toEqual(["gate-1"]);
		expect(events).toEqual(["role:advisor", "state:verify:gate-1", "context:verify:gate-1", "advisor:gate-1"]);

		state = markPhaseTurnStarted(state);
		await bundle.onBeforeYield();
		expect(isComplete(state)).toBe(true);
		expect(events.slice(4)).toEqual([
			"role:advisor",
			"state:verify:gate-2",
			"context:verify:gate-2",
			"advisor:gate-2",
		]);
	});

	test("verify gate passes only after a clean native advisor review", async () => {
		let state = markPhaseTurnStarted(mintGateRequest(advancePhase(advancePhase(createState("tactical"))), "gate-1"));
		const externalActions: string[] = [];
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => state.gateRequestId === null,
			() => undefined,
			undefined,
			undefined,
			() => advisorReview("gate-1", "concern", "non-blocking caveat"),
			(current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();

		expect(isComplete(state)).toBe(true);
		expect(externalActions).toEqual([]);
	});

	test("primary text never satisfies the verify gate", async () => {
		let state = markPhaseTurnStarted(mintGateRequest(advancePhase(advancePhase(createState("tactical"))), "gate-1"));
		const externalActions: string[] = [];
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => state.gateRequestId === null,
			() => undefined,
			undefined,
			undefined,
			() => ({ type: "tool_result", content: { gateId: "gate-1", verdict: "pass" } }),
			(current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();

		expect(currentPhase(state)).toBe("verify");
		expect(isComplete(state)).toBe(false);
		expect(externalActions).toHaveLength(1);
	});

	test("holds externally when advisor review is absent or down", async () => {
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
			() => undefined,
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

		expect(followUps).toHaveLength(0);
		expect(externalActions).toHaveLength(4);
		expect(externalActions[0]).toContain("yielding instead of queuing another follow-up");
	});
});
