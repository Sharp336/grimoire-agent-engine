/**
 * Contracts:
 * 1. resolveApproval: "approve-for-me" auto-approves read+write tiers, prompts for exec
 *    (same tier gate as "write" — the reviewer only runs on the prompt path).
 * 2. ApproveForMeReviewer: fail-closed deny when no settings/registry/model.
 * 3. Policy enforcement: outcome is derived from risk+auth, never trusted from model.
 * 4. Circuit breaker: 3 consecutive denials → shouldInterruptTurn(sessionId) = true.
 * 5. resetCircuitBreaker clears per-session counters.
 * 6. Cache: a returned "allow" decision is reused on the next identical call (no model call).
 * 7. Truncation: args exceeding the review context → fail-closed deny.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { type ApprovalSubject, resolveApproval } from "../approval";
import { ApproveForMeReviewer, MAX_CONSECUTIVE_DENIALS } from "../approve-for-me";

function makeModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as Model<Api>;
}

const SMOL = makeModel("p", "smol");

function assistant(opts: {
	toolCall?: { name: string; arguments: Record<string, unknown> };
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (opts.text) content.push({ type: "text", text: opts.text });
	if (opts.toolCall) {
		content.push({ type: "toolCall", id: "tc-1", name: opts.toolCall.name, arguments: opts.toolCall.arguments });
	}
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "p",
		model: "smol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: opts.stopReason ?? "stop",
		errorMessage: opts.errorMessage,
		timestamp: Date.now(),
	};
}

function makeContext(opts: { available?: Model<Api>[]; apiKey?: string | null }): Record<string, unknown> {
	const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
	settings.setModelRole("smol", "p/smol");
	settings.setModelRole("tiny", "p/smol");
	const modelRegistry = {
		getAvailable: () => opts.available ?? [SMOL],
		getApiKey: async () => (opts.apiKey === undefined ? "test-key" : opts.apiKey),
		resolver: () => async () => (opts.apiKey === undefined ? "test-key" : opts.apiKey),
	} as unknown as ModelRegistry;
	return {
		settings,
		modelRegistry,
		sessionManager: { getSessionId: () => "test-session" },
	};
}

const execTool: ApprovalSubject = {
	name: "bash",
	approval: { tier: "exec" },
};

const writeTool: ApprovalSubject = {
	name: "edit",
	approval: { tier: "write" },
};

const readTool: ApprovalSubject = {
	name: "read",
	approval: { tier: "read" },
};

/** Model returns risk+auth only (no outcome — system derives it). */
function modelResponse(risk: string, auth: string, rationale = "review"): Record<string, unknown> {
	return { risk_level: risk, user_authorization: auth, rationale };
}

describe("resolveApproval — approve-for-me mode", () => {
	it("auto-approves read-tier tools (same as always-ask)", () => {
		const { policy, tier } = resolveApproval(readTool, {}, "approve-for-me");
		expect(policy).toBe("allow");
		expect(tier).toBe("read");
	});

	it("auto-approves write-tier tools (same as write mode)", () => {
		const { policy, tier } = resolveApproval(writeTool, {}, "approve-for-me");
		expect(policy).toBe("allow");
		expect(tier).toBe("write");
	});

	it("prompts for exec-tier tools (reviewer runs on the prompt path)", () => {
		const { policy, tier } = resolveApproval(execTool, {}, "approve-for-me");
		expect(policy).toBe("prompt");
		expect(tier).toBe("exec");
	});

	it("honors per-tool deny override in approve-for-me mode", () => {
		const { policy } = resolveApproval(execTool, {}, "approve-for-me", { bash: "deny" });
		expect(policy).toBe("deny");
	});

	it("honors per-tool allow override in approve-for-me mode", () => {
		const { policy } = resolveApproval(execTool, {}, "approve-for-me", { bash: "allow" });
		expect(policy).toBe("allow");
	});
});

describe("ApproveForMeReviewer — fail-closed", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns a deny when settings or registry is missing", async () => {
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const decision = await reviewer.review(tool, {}, undefined, undefined);
		expect(decision.outcome).toBe("deny");
		expect(decision.rationale).toContain("Auto-review failed");
	});

	it("returns a deny when no tiny/smol model is available", async () => {
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const context = makeContext({ available: [] });
		const decision = await reviewer.review(tool, {}, undefined, context as never);
		expect(decision.outcome).toBe("deny");
		expect(decision.rationale).toContain("no tiny/smol model");
	});

	it("returns a deny when no API key is available", async () => {
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const context = makeContext({ apiKey: null });
		const decision = await reviewer.review(tool, {}, undefined, context as never);
		expect(decision.outcome).toBe("deny");
		expect(decision.rationale).toContain("no API key");
	});

	it("returns a deny on model error stop reason", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistant({ stopReason: "error", errorMessage: "rate limited" }),
		);
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const context = makeContext({});
		const decision = await reviewer.review(tool, {}, undefined, context as never);
		expect(decision.outcome).toBe("deny");
		expect(decision.rationale).toContain("rate limited");
	});

	it("returns a deny when the model returns no structured response", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "I cannot help" }));
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const context = makeContext({});
		const decision = await reviewer.review(tool, {}, undefined, context as never);
		expect(decision.outcome).toBe("deny");
		expect(decision.rationale).toContain("no structured response");
	});

	it("fails closed when args are truncated (exceed review context)", async () => {
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const context = makeContext({});
		// Create args > 4000 chars to trigger truncation
		const longArgs = { command: "echo " + "x".repeat(5000) };
		const decision = await reviewer.review(tool, longArgs, undefined, context as never);
		expect(decision.outcome).toBe("deny");
		expect(decision.rationale).toContain("truncated");
	});
});

describe("ApproveForMeReviewer — policy enforcement", () => {
	afterEach(() => vi.restoreAllMocks());

	it("derives allow for low risk regardless of model outcome", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistant({ toolCall: { name: "respond", arguments: modelResponse("low", "unknown", "safe") } }),
		);
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "read" } as unknown as AgentTool;
		const context = makeContext({});
		const decision = await reviewer.review(tool, {}, undefined, context as never);
		expect(decision.outcome).toBe("allow");
		expect(decision.risk_level).toBe("low");
	});

	it("derives deny for critical risk even if model somehow says allow", async () => {
		// Model returns risk_level: "critical" — system MUST deny regardless
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistant({
				toolCall: {
					name: "respond",
					arguments: { risk_level: "critical", user_authorization: "high", rationale: "looks ok" },
				},
			}),
		);
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const context = makeContext({});
		const decision = await reviewer.review(tool, { command: "rm -rf /" }, undefined, context as never);
		expect(decision.outcome).toBe("deny");
		expect(decision.risk_level).toBe("critical");
	});

	it("derives deny for high risk with unknown authorization", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistant({ toolCall: { name: "respond", arguments: modelResponse("high", "unknown", "risky") } }),
		);
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const context = makeContext({});
		const decision = await reviewer.review(tool, { command: "git push --force" }, undefined, context as never);
		expect(decision.outcome).toBe("deny");
	});

	it("derives allow for high risk with medium authorization", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistant({ toolCall: { name: "respond", arguments: modelResponse("high", "medium", "authorized") } }),
		);
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const context = makeContext({});
		const decision = await reviewer.review(tool, { command: "git push" }, undefined, context as never);
		expect(decision.outcome).toBe("allow");
	});

	it("parses JSON text fallback when the model skips the tool", async () => {
		const json = JSON.stringify(modelResponse("low", "medium", "json fallback"));
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: json }));
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "read" } as unknown as AgentTool;
		const context = makeContext({});
		const decision = await reviewer.review(tool, {}, undefined, context as never);
		expect(decision.outcome).toBe("allow");
	});
});

describe("ApproveForMeReviewer — session cache", () => {
	afterEach(() => vi.restoreAllMocks());

	it("caches an allow decision and skips the model on the second identical call", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(
				assistant({ toolCall: { name: "respond", arguments: modelResponse("low", "medium", "safe") } }),
			);
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "read" } as unknown as AgentTool;
		const context = makeContext({});

		await reviewer.review(tool, { path: "/src/a.ts" }, undefined, context as never);
		await reviewer.review(tool, { path: "/src/a.ts" }, undefined, context as never);

		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("does not cache deny decisions", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(
				assistant({ toolCall: { name: "respond", arguments: modelResponse("critical", "unknown", "bad") } }),
			);
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const context = makeContext({});

		await reviewer.review(tool, { command: "rm" }, undefined, context as never);
		await reviewer.review(tool, { command: "rm" }, undefined, context as never);

		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe("ApproveForMeReviewer — circuit breaker", () => {
	afterEach(() => vi.restoreAllMocks());
	const SID = "test-session";

	it("trips after MAX_CONSECUTIVE_DENIALS consecutive denials", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistant({ toolCall: { name: "respond", arguments: modelResponse("critical", "unknown", "no") } }),
		);
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const context = makeContext({});

		expect(reviewer.shouldInterruptTurn(SID)).toBe(false);
		for (let i = 0; i < MAX_CONSECUTIVE_DENIALS; i++) {
			await reviewer.review(tool, { i }, undefined, context as never);
		}
		expect(reviewer.shouldInterruptTurn(SID)).toBe(true);
	});

	it("resets the consecutive counter on an allow", async () => {
		const deny = assistant({ toolCall: { name: "respond", arguments: modelResponse("critical", "unknown", "no") } });
		const allow = assistant({ toolCall: { name: "respond", arguments: modelResponse("low", "medium", "ok") } });
		vi.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(deny)
			.mockResolvedValueOnce(deny)
			.mockResolvedValueOnce(allow);
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const context = makeContext({});

		await reviewer.review(tool, { a: 1 }, undefined, context as never);
		await reviewer.review(tool, { a: 2 }, undefined, context as never);
		await reviewer.review(tool, { a: 3 }, undefined, context as never);
		expect(reviewer.shouldInterruptTurn(SID)).toBe(false);
	});

	it("resetCircuitBreaker clears all counters", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistant({ toolCall: { name: "respond", arguments: modelResponse("critical", "unknown", "no") } }),
		);
		const reviewer = new ApproveForMeReviewer();
		const tool = { name: "bash" } as unknown as AgentTool;
		const context = makeContext({});

		for (let i = 0; i < MAX_CONSECUTIVE_DENIALS; i++) {
			await reviewer.review(tool, { i }, undefined, context as never);
		}
		expect(reviewer.shouldInterruptTurn(SID)).toBe(true);
		reviewer.resetCircuitBreaker(SID);
		expect(reviewer.shouldInterruptTurn(SID)).toBe(false);
	});
});
