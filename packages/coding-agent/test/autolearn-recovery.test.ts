import { describe, expect, it } from "bun:test";
import type { AgentMessage, AgentTurnEndContext, SoftToolRequirement } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import type {
	AutoLearnCaptureRequest,
	AutoLearnCaptureResult,
} from "@oh-my-pi/pi-coding-agent/autolearn/capture-request";
import type { ProcedureDescriptorRow } from "@oh-my-pi/pi-coding-agent/autolearn/catalog";
import {
	AutoLearnController,
	type AutoLearnControllerOptions,
	type ProcedureCatalog,
} from "@oh-my-pi/pi-coding-agent/autolearn/controller";
import { RecoveryTracker } from "@oh-my-pi/pi-coding-agent/autolearn/recovery";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AutolearnRecallEntry } from "@oh-my-pi/pi-coding-agent/session/autolearn-recall";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface ToolSpec {
	name: string;
	text?: string;
	isError?: boolean;
	args?: Record<string, unknown>;
	details?: unknown;
	id?: string;
}

function turn(specs: readonly ToolSpec[], stopReason: AssistantMessage["stopReason"] = "stop"): AgentTurnEndContext {
	const calls: ToolCall[] = specs.map((spec, index) => ({
		type: "toolCall",
		id: spec.id ?? `call-${index}`,
		name: spec.name,
		arguments: spec.args ?? {},
	}));
	const toolResults: ToolResultMessage[] = specs.map((spec, index) => ({
		role: "toolResult",
		toolCallId: calls[index].id,
		toolName: spec.name,
		content: [{ type: "text", text: spec.text ?? "result" }],
		isError: spec.isError === true,
		details: spec.details,
		timestamp: index + 1,
	}));
	return {
		message: {
			role: "assistant",
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-3.5-flash",
			content: calls,
			usage: ZERO_USAGE,
			stopReason,
			timestamp: Date.now(),
		},
		toolResults,
		willContinue: false,
	};
}

function failure(
	name: string,
	text = `${name} failed`,
	args: Record<string, unknown> = {},
	details?: unknown,
): ToolSpec {
	return { name, text, args, isError: true, details };
}

function success(name: string, text = `${name} succeeded`, args: Record<string, unknown> = {}): ToolSpec {
	return { name, text, args };
}

class FakeSession {
	readonly listeners: Array<(event: AgentSessionEvent) => void> = [];
	readonly captures: AutoLearnCaptureRequest[] = [];
	readonly turnEndHooks: Array<(context: AgentTurnEndContext) => Promise<void> | void> = [];
	readonly recallCards: Array<Omit<AutolearnRecallEntry, "epoch">> = [];
	proceduralRequirement: SoftToolRequirement | undefined;
	captureGate: Promise<void> | undefined;

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}

	registerTurnEndHook(hook: (context: AgentTurnEndContext) => Promise<void> | void): () => void {
		this.turnEndHooks.push(hook);
		return () => {};
	}

	setManualAutoLearnHandler(): void {}

	setProceduralMemoryRequirement(requirement: SoftToolRequirement | undefined): void {
		this.proceduralRequirement = requirement;
	}

	enqueueAutolearnRecall(entry: Omit<AutolearnRecallEntry, "epoch">): void {
		this.recallCards.push(entry);
	}

	invalidateAutolearnRecall(): void {}

	async capture(request: AutoLearnCaptureRequest): Promise<AutoLearnCaptureResult> {
		this.captures.push(request);
		if (this.captureGate) await this.captureGate;
		return { stored: [{ action: "create", name: "captured-procedure" }] };
	}

	getPlanModeState(): { enabled: boolean } | undefined {
		return undefined;
	}

	getGoalModeState(): { enabled: boolean } | undefined {
		return undefined;
	}

	async turnEnd(context: AgentTurnEndContext): Promise<void> {
		for (const hook of [...this.turnEndHooks]) await hook(context);
	}

	agentEnd(messages: AgentMessage[] = [], isTerminal = true): void {
		for (const listener of [...this.listeners]) listener({ type: "agent_end", messages, isTerminal });
	}
}

const IDENTITY = { key: "proj-000000000000", label: "proj" };

function descriptor(name: string, overrides: Partial<ProcedureDescriptorRow> = {}): ProcedureDescriptorRow {
	return {
		name,
		description: "Recover cl compiler setup after bash failure",
		scope: "global",
		toolFamilies: ["bash"],
		platforms: ["win32"],
		triggers: ["cl not recognized"],
		successCount: 0,
		missCount: 0,
		lastRecalledAt: null,
		updatedAt: 1,
		...overrides,
	};
}

function catalogWith(
	rows: ProcedureDescriptorRow[],
): ProcedureCatalog & { outcomes: Array<[string, "success" | "miss"]> } {
	const outcomes: Array<[string, "success" | "miss"]> = [];
	return {
		outcomes,
		search: () => ({ rows, lexicalRank: new Map(rows.map((row, index) => [row.name, index])) }),
		recordOutcome: (name: string, outcome: "success" | "miss") => outcomes.push([name, outcome]),
		readBody: async () => null,
	};
}

function install(
	session: FakeSession,
	overrides: Record<string, unknown> = {},
	controllerOverrides: Partial<AutoLearnControllerOptions> = {},
): void {
	const settings = Settings.isolated({ "autolearn.enabled": true, ...overrides });
	new AutoLearnController({
		session: session as unknown as AgentSession,
		settings,
		capture: request => session.capture(request),
		resolveToolFamily: () => undefined,
		hasReadTool: () => true,
		projectIdentity: () => IDENTITY,
		selectManualWindow: () => [],
		...controllerOverrides,
	});
}

async function settleCaptures(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function tracker(resolveFamily: (toolName: string) => string | undefined = () => undefined): RecoveryTracker {
	return new RecoveryTracker({ resolveFamily, threshold: 3, platform: "win32" });
}

function callForRequirement(name: string, path: string): ToolCall {
	return { type: "toolCall", id: "requirement", name, arguments: { path } };
}

describe("RecoveryTracker", () => {
	it("arms only on the threshold failure and retains evidence", () => {
		const state = tracker();
		expect(state.observeTurn(turn([failure("bash", "first failure")])).thresholdHits).toHaveLength(0);
		expect(state.observeTurn(turn([failure("bash", "second failure")])).thresholdHits).toHaveLength(0);
		const observation = state.observeTurn(turn([failure("bash", "third failure")]));
		expect(observation.thresholdHits).toHaveLength(1);
		expect(observation.thresholdHits[0]).toMatchObject({ family: "bash", failureCount: 3 });
		expect(observation.thresholdHits[0].evidence.map(item => item.resultSummary)).toContain("third failure");
	});

	it("keeps failure families independent across successful tools", () => {
		const state = tracker();
		state.observeTurn(turn([failure("bash", "bash one")]));
		state.observeTurn(turn([success("read", "read succeeded")]));
		state.observeTurn(turn([failure("bash", "bash two")]));
		const observation = state.observeTurn(turn([failure("bash", "bash three")]));
		expect(observation.thresholdHits).toHaveLength(1);
		expect(observation.thresholdHits[0].family).toBe("bash");
	});

	it("resets a same-family episode when it succeeds below threshold", () => {
		const state = tracker();
		state.observeTurn(turn([failure("bash", "one")]));
		state.observeTurn(turn([failure("bash", "two")]));
		state.observeTurn(turn([success("bash", "recovered transiently")]));
		const observation = state.observeTurn(turn([failure("bash", "new episode one")]));
		expect(observation.thresholdHits).toHaveLength(0);
		expect(state.failureCount("bash")).toBe(1);
	});

	it("reports a recovery after an armed episode", () => {
		const state = tracker();
		state.observeTurn(turn([failure("bash", "one")]));
		state.observeTurn(turn([failure("bash", "two")]));
		state.observeTurn(turn([failure("bash", "three")]));
		const observation = state.observeTurn(turn([success("bash", "compiler succeeded")]));
		expect(observation.recoveries).toHaveLength(1);
		expect(observation.recoveries[0]).toMatchObject({
			family: "bash",
			failureCount: 3,
			recoveredToolName: "bash",
		});
		expect(observation.recoveries[0].evidence.length).toBeGreaterThan(0);
	});

	it("caps evidence to the latest three failures", () => {
		const state = tracker();
		for (let index = 1; index <= 5; index++) state.observeTurn(turn([failure("bash", `failure-${index}`)]));
		const observation = state.observeTurn(turn([success("bash", "recovered after failures")]));
		expect(observation.recoveries).toHaveLength(1);
		expect(observation.recoveries[0].evidence.map(item => item.resultSummary)).toEqual([
			"failure-3",
			"failure-4",
			"failure-5",
		]);
	});

	it("expires a quiet family after eight eligible results from elsewhere", () => {
		const state = tracker();
		state.observeTurn(turn([failure("bash", "bash one")]));
		state.observeTurn(turn([failure("bash", "bash two")]));
		const otherResults = Array.from({ length: 8 }, (_, index) => success(`other-${index}`, `other ${index}`));
		state.observeTurn(turn(otherResults));
		const observation = state.observeTurn(turn([failure("bash", "bash after expiry")]));
		expect(observation.thresholdHits).toHaveLength(0);
		expect(state.failureCount("bash")).toBe(1);
	});

	it("keys MCP families by the active raw server name", () => {
		const resolveFamily = (toolName: string): string | undefined => {
			if (toolName === "mcp__one__build" || toolName === "mcp__one__lint") return "MyServer";
			if (toolName === "mcp__two__build" || toolName === "mcp__two__lint") return "OtherServer";
			return undefined;
		};
		const state = tracker(resolveFamily);
		state.observeTurn(turn([failure("mcp__one__build", "first")]));
		state.observeTurn(turn([failure("mcp__one__lint", "second")]));
		const sameServer = state.observeTurn(turn([failure("mcp__one__build", "third")]));
		expect(sameServer.thresholdHits[0]).toMatchObject({ family: "mcp:MyServer", failureCount: 3 });

		const other = tracker(resolveFamily);
		other.observeTurn(turn([failure("mcp__one__build", "one server")]));
		other.observeTurn(turn([failure("mcp__two__build", "another server")]));
		other.observeTurn(turn([failure("mcp__one__lint", "one server again")]));
		expect(other.failureCount("mcp:MyServer")).toBe(2);
		expect(other.failureCount("mcp:OtherServer")).toBe(1);
		expect(other.observeTurn(turn([failure("mcp__two__lint", "other server again")])).thresholdHits).toHaveLength(0);
	});

	it("excludes structured host results, control tools, and preview writes", () => {
		const state = tracker();
		const observation = state.observeTurn(
			turn([
				failure("bash", "blocked", {}, { __synthetic: true, source: "host_blocked", executed: false }),
				failure(
					"bash",
					"interrupted",
					{},
					{ __interrupted: true, source: "interrupt_skipped", execution: "started" },
				),
				failure("manage_skill", "writer failed"),
				failure("write", "preview failed", { path: "xd://resolve" }),
			]),
		);
		expect(observation.thresholdHits).toHaveLength(0);
		expect(state.failureCount("bash")).toBe(0);
		expect(state.failureCount("manage_skill")).toBe(0);
		expect(state.failureCount("write")).toBe(0);
	});

	it("ignores all errors in an aborted assistant turn", () => {
		const state = tracker();
		const observation = state.observeTurn(turn([failure("bash", "aborted failure")], "aborted"));
		expect(observation.thresholdHits).toHaveLength(0);
		expect(state.failureCount("bash")).toBe(0);
	});

	it("redacts JWT and GitHub tokens in evidence summaries", () => {
		const state = tracker();
		const tokenText = "jwt eyJabcdefghijklmnop.eyJqrstuvwxyzabcdef.eyJ0123456789abcdef ghp_12345678901234567890";
		state.observeTurn(turn([failure("bash", tokenText)]));
		state.observeTurn(turn([failure("bash", tokenText)]));
		const hit = state.observeTurn(turn([failure("bash", tokenText)])).thresholdHits[0];
		expect(hit.evidence[0].resultSummary).not.toContain("eyJabcdefghijklmnop");
		expect(hit.evidence[0].resultSummary).toContain("[REDACTED]");
		expect(hit.evidence[0].resultSummary).not.toContain("ghp_12345678901234567890");
	});
});

describe("AutoLearnController recovery recall and capture", () => {
	it("requires one exact procedure body after the threshold and enqueues one card", async () => {
		const session = new FakeSession();
		const catalog = catalogWith([descriptor("msvc-setup")]);
		install(session, {}, { catalog });
		await session.turnEnd(turn([failure("bash", "cl not recognized")]));
		await session.turnEnd(turn([failure("bash", "cl not recognized")]));
		expect(session.proceduralRequirement).toBeUndefined();
		await session.turnEnd(turn([failure("bash", "cl not recognized")]));
		const requirement = session.proceduralRequirement;
		expect(requirement).toBeDefined();
		if (!requirement?.satisfies) throw new Error("expected a procedural requirement");
		expect(requirement.toolName).toBe("read");
		expect(requirement.satisfies(callForRequirement("read", "skill://msvc-setup"))).toBe(true);
		expect(requirement.satisfies(callForRequirement("read", "skill://other"))).toBe(false);
		expect(requirement.satisfies(callForRequirement("read", "src/README.md"))).toBe(false);
		expect(session.recallCards).toHaveLength(1);
		expect(session.recallCards[0].cards[0].name).toBe("msvc-setup");
	});

	it("records recalled success after a targeted read without redundant capture", async () => {
		const session = new FakeSession();
		const catalog = catalogWith([descriptor("msvc-setup")]);
		install(session, {}, { catalog });
		for (let index = 0; index < 3; index++) await session.turnEnd(turn([failure("bash", "cl not recognized")]));
		await session.turnEnd(turn([success("read", "body opened", { path: "skill://msvc-setup" })]));
		expect(session.proceduralRequirement).toBeUndefined();
		await session.turnEnd(turn([success("bash", "compiler succeeded")]));
		session.agentEnd([turn([], "stop").message]);
		await settleCaptures();
		expect(catalog.outcomes).toEqual([["msvc-setup", "success"]]);
		expect(session.captures).toHaveLength(0);
	});

	it("does not record an unread suggestion, but records a miss after a read", async () => {
		const unreadSession = new FakeSession();
		const unreadCatalog = catalogWith([descriptor("msvc-setup")]);
		install(unreadSession, {}, { catalog: unreadCatalog });
		for (let index = 0; index < 3; index++) await unreadSession.turnEnd(turn([failure("bash", "cl not recognized")]));
		unreadSession.agentEnd([turn([], "stop").message]);
		await settleCaptures();
		expect(unreadCatalog.outcomes).toHaveLength(0);

		const missSession = new FakeSession();
		const missCatalog = catalogWith([descriptor("msvc-setup")]);
		install(missSession, {}, { catalog: missCatalog });
		for (let index = 0; index < 3; index++) await missSession.turnEnd(turn([failure("bash", "cl not recognized")]));
		await missSession.turnEnd(turn([success("read", "body opened", { path: "skill://msvc-setup" })]));
		missSession.agentEnd([turn([], "stop").message]);
		await settleCaptures();
		expect(missCatalog.outcomes).toEqual([["msvc-setup", "miss"]]);
	});

	it("suggests at most three matching cards without installing a requirement", async () => {
		const session = new FakeSession();
		const catalog = catalogWith([
			descriptor("msvc-one"),
			descriptor("msvc-two"),
			descriptor("msvc-three"),
			descriptor("msvc-four"),
		]);
		install(session, { "autolearn.recallMode": "suggest" }, { catalog });
		for (let index = 0; index < 3; index++) await session.turnEnd(turn([failure("bash", "cl not recognized")]));
		expect(session.proceduralRequirement).toBeUndefined();
		expect(session.recallCards).toHaveLength(1);
		expect(session.recallCards[0].cards).toHaveLength(3);
	});

	it("does not recall without read, but still captures a later recovery", async () => {
		const session = new FakeSession();
		const catalog = catalogWith([descriptor("msvc-setup")]);
		install(session, {}, { catalog, hasReadTool: () => false });
		for (let index = 0; index < 3; index++) await session.turnEnd(turn([failure("bash", "cl not recognized")]));
		expect(session.recallCards).toHaveLength(0);
		expect(session.proceduralRequirement).toBeUndefined();
		await session.turnEnd(turn([success("bash", "compiler succeeded")]));
		session.agentEnd([turn([], "stop").message]);
		await settleCaptures();
		expect(session.captures).toHaveLength(1);
		expect(session.captures[0].kind).toBe("recovery");
	});

	it("schedules one recovery capture only for a normal terminal stop", async () => {
		const makeSession = (): FakeSession => {
			const session = new FakeSession();
			install(session, {}, { catalog: catalogWith([]) });
			return session;
		};

		const aborted = makeSession();
		for (let index = 0; index < 3; index++) await aborted.turnEnd(turn([failure("bash", "cl not recognized")]));
		await aborted.turnEnd(turn([success("bash", "compiler succeeded")]));
		aborted.agentEnd([turn([], "aborted").message]);
		await settleCaptures();
		expect(aborted.captures).toHaveLength(0);

		const continuation = makeSession();
		for (let index = 0; index < 3; index++) await continuation.turnEnd(turn([failure("bash", "cl not recognized")]));
		await continuation.turnEnd(turn([success("bash", "compiler succeeded")]));
		continuation.agentEnd([turn([], "stop").message], false);
		await settleCaptures();
		expect(continuation.captures).toHaveLength(0);

		const normal = makeSession();
		for (let index = 0; index < 3; index++) await normal.turnEnd(turn([failure("bash", "cl not recognized")]));
		await normal.turnEnd(turn([success("bash", "compiler succeeded")]));
		normal.agentEnd([turn([], "stop").message]);
		await settleCaptures();
		expect(normal.captures).toHaveLength(1);
		const request = normal.captures[0];
		expect(request.kind).toBe("recovery");
		if (request.kind !== "recovery") throw new Error("expected recovery request");
		expect(request.families[0].family).toBe("bash");
		expect(request.metadata.platforms).toContain(process.platform);
	});
});
