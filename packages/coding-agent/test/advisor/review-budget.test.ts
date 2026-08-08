import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AdvisorReviewBudget } from "../../src/advisor/review-budget";
import { Settings } from "../../src/config/settings";

const defaults = {
	maxRequests: 0,
	maxCostUsd: 0,
	maxIdenticalToolCalls: 2,
	maxToolCallsPerTurn: 10,
};

function createReadTool(execute: (params: { path?: string; line?: number }) => string): AgentTool {
	return {
		name: "read",
		label: "Read",
		description: "Read a file",
		parameters: type({ "path?": "string", "line?": "number" }),
		execute: async (_id, params) => ({
			content: [{ type: "text", text: execute(params as { path?: string; line?: number }) }],
		}),
	};
}

class PrivateFieldReadTool {
	readonly name = "read";
	readonly label = "Read";
	readonly description = "Read a file";
	readonly parameters = type({ "path?": "string" });
	#executions = 0;

	get executions(): number {
		return this.#executions;
	}

	async execute(): Promise<{ content: [{ type: "text"; text: string }] }> {
		this.#executions++;
		return { content: [{ type: "text", text: `execution ${this.#executions}` }] };
	}
}

describe("AdvisorReviewBudget", () => {
	it("uses conservative configurable defaults", () => {
		const settings = Settings.isolated();

		expect(settings.get("advisor.maxRequestsPerReview")).toBe(0);
		expect(settings.get("advisor.maxCostPerReview")).toBe(0);
		expect(settings.get("advisor.maxIdenticalToolCalls")).toBe(2);
		expect(settings.get("advisor.maxToolCallsPerTurn")).toBe(10);
	});

	it("hard-stops before the request after the configured request count", () => {
		const budget = new AdvisorReviewBudget({ ...defaults, maxRequests: 3 });
		budget.beginReview();

		expect(budget.beforeModelCall()).toBeUndefined();
		expect(budget.beforeModelCall()).toBeUndefined();
		expect(budget.beforeModelCall()).toBeUndefined();
		expect(budget.beforeModelCall()).toEqual({
			stop: true,
			reason: "advisor review reached 3 provider requests",
		});
		expect(budget.requests).toBe(3);
	});

	it("keeps one budget when the same logical review is retried", () => {
		const budget = new AdvisorReviewBudget({ ...defaults, maxRequests: 2 });
		budget.beginReview(7);
		expect(budget.beforeModelCall()).toBeUndefined();
		budget.beginReview(7);
		expect(budget.beforeModelCall()).toBeUndefined();
		expect(budget.beforeModelCall()?.stop).toBe(true);

		budget.beginReview(8);
		expect(budget.requests).toBe(0);
		expect(budget.beforeModelCall()).toBeUndefined();
	});

	it("reads changed limits without rebuilding the budget", () => {
		const settings = Settings.isolated();
		const budget = new AdvisorReviewBudget(() => ({
			maxRequests: settings.get("advisor.maxRequestsPerReview"),
			maxCostUsd: settings.get("advisor.maxCostPerReview"),
			maxIdenticalToolCalls: settings.get("advisor.maxIdenticalToolCalls"),
			maxToolCallsPerTurn: settings.get("advisor.maxToolCallsPerTurn"),
		}));
		budget.beginReview(1);
		expect(budget.beforeModelCall()).toBeUndefined();

		settings.set("advisor.maxRequestsPerReview", 1);
		expect(budget.beforeModelCall()?.stop).toBe(true);
	});

	it("checks completed cost before dispatch and can lag by one completed request", () => {
		const budget = new AdvisorReviewBudget({ ...defaults, maxCostUsd: 1 });
		budget.beginReview();

		expect(budget.beforeModelCall()).toBeUndefined();
		budget.recordCompletedCost(0.6);
		expect(budget.beforeModelCall()).toBeUndefined();
		budget.recordCompletedCost(0.6);
		expect(budget.beforeModelCall()).toEqual({
			stop: true,
			reason: "advisor review spent $1.20 of its $1.00 ceiling",
		});
		expect(budget.costUsd).toBeCloseTo(1.2);
	});

	it("resets request, cost, repeat, and stop state for the next review", () => {
		const budget = new AdvisorReviewBudget({ ...defaults, maxRequests: 1 });
		budget.beginReview();
		expect(budget.beforeModelCall()).toBeUndefined();
		budget.recordCompletedCost(2);
		expect(budget.noteToolCall("read", { path: "a.ts" })).toBeUndefined();
		expect(budget.noteToolCall("read", { path: "a.ts" })).toContain("Refused");
		expect(budget.beforeModelCall()?.stop).toBe(true);

		budget.beginReview();
		expect(budget.requests).toBe(0);
		expect(budget.costUsd).toBe(0);
		expect(budget.stop).toBeUndefined();
		expect(budget.noteToolCall("read", { path: "a.ts" })).toBeUndefined();
		expect(budget.beforeModelCall()).toBeUndefined();
	});

	it("canonicalizes object key order while allowing different arguments", () => {
		const budget = new AdvisorReviewBudget(defaults);
		budget.beginReview();

		expect(budget.noteToolCall("read", { path: "a.ts", line: 1 })).toBeUndefined();
		expect(budget.noteToolCall("read", { line: 1, path: "a.ts" })).toContain("attempt 2");
		expect(budget.noteToolCall("read", { path: "a.ts", line: 2 })).toBeUndefined();
		expect(budget.noteToolCall("glob", { path: "a.ts", line: 1 })).toBeUndefined();
	});

	it("short-circuits a repeated guarded tool without re-executing it", async () => {
		const executed: string[] = [];
		const budget = new AdvisorReviewBudget(defaults);
		const guarded = budget.guardTool(
			createReadTool(params => {
				executed.push(params.path ?? "");
				return "file contents";
			}),
		);
		budget.beginReview();

		const first = await guarded.execute("tc-1", { path: "a.ts" });
		const repeat = await guarded.execute("tc-2", { path: "a.ts" });

		expect(first.content).toEqual([{ type: "text", text: "file contents" }]);
		expect(repeat.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Refused") });
		expect(repeat.useless).toBe(true);
		expect(repeat.isError).toBeUndefined();
		expect(executed).toEqual(["a.ts"]);
	});

	it("includes dynamic bridge options in repeated-call identity", async () => {
		let executions = 0;
		const budget = new AdvisorReviewBudget(defaults);
		const original = createReadTool(() => {
			executions++;
			return "ok";
		});
		const noContext = budget.guardTool(original, { context: 0 });
		const wideContext = budget.guardTool(original, { context: 5 });
		budget.beginReview();

		await noContext.execute("tc-1", { path: "a.ts" });
		await wideContext.execute("tc-2", { path: "a.ts" });
		const repeat = await noContext.execute("tc-3", { path: "a.ts" });

		expect(executions).toBe(2);
		expect(repeat.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Refused") });
	});

	it("preserves the original receiver for class tools with private fields", async () => {
		const original = new PrivateFieldReadTool();
		const budget = new AdvisorReviewBudget(defaults);
		const guarded = budget.guardTool(original as AgentTool);
		budget.beginReview();

		const first = await guarded.execute("tc-1", { path: "a.ts" });
		const repeat = await guarded.execute("tc-2", { path: "a.ts" });

		expect(first.content).toEqual([{ type: "text", text: "execution 1" }]);
		expect(repeat.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Refused") });
		expect(original.executions).toBe(1);
	});

	it("disables each limiter independently with a non-positive value", async () => {
		let executions = 0;
		const budget = new AdvisorReviewBudget({
			maxRequests: 0,
			maxCostUsd: 0,
			maxIdenticalToolCalls: 0,
			maxToolCallsPerTurn: 0,
		});
		const tool = budget.guardTool(
			createReadTool(() => {
				executions++;
				return "ok";
			}),
		);
		budget.beginReview();
		budget.recordCompletedCost(1_000);

		for (let i = 0; i < 100; i++) expect(budget.beforeModelCall()).toBeUndefined();
		await tool.execute("tc-1", { path: "a.ts" });
		await tool.execute("tc-2", { path: "a.ts" });
		expect(executions).toBe(2);
	});

	it("refreshes the investigative allowance for each provider turn", () => {
		const budget = new AdvisorReviewBudget({ ...defaults, maxToolCallsPerTurn: 2 });
		budget.beginReview(1);

		expect(budget.beforeModelCall()).toBeUndefined();
		expect(budget.beforeToolCall("read", { path: "a.ts" })).toBeUndefined();
		expect(budget.beforeToolCall("read", { path: "b.ts" })).toBeUndefined();
		expect(budget.beforeToolCall("read", { path: "c.ts" })).toEqual({
			block: true,
			reason:
				"Refused: this advisor provider turn already used 2 investigative tool calls. Use the results you have and call `advise`, or end this provider turn.",
		});
		expect(budget.beforeToolCall("advise", {})).toBeUndefined();

		expect(budget.beforeModelCall()).toBeUndefined();
		expect(budget.beforeToolCall("read", { path: "c.ts" })).toBeUndefined();
		expect(budget.stop).toBeUndefined();
	});
	it("does not charge refused repeats against the per-turn execution allowance", () => {
		const budget = new AdvisorReviewBudget({ ...defaults, maxToolCallsPerTurn: 2 });
		budget.beginReview(1);
		expect(budget.beforeModelCall()).toBeUndefined();

		expect(budget.beforeToolCall("read", { path: "a.ts" })).toBeUndefined();
		expect(budget.beforeToolCall("read", { path: "a.ts" })?.reason).toContain("already ran");
		expect(budget.beforeToolCall("read", { path: "b.ts" })).toBeUndefined();
		expect(budget.beforeToolCall("read", { path: "c.ts" })?.reason).toContain("already used 2");
	});

	it("applies the per-turn gate to ordinary Agent tool dispatch", async () => {
		const executed: number[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", name: "read", arguments: { path: "a.ts", line: 1 } },
						{ type: "toolCall", name: "read", arguments: { path: "a.ts", line: 2 } },
						{ type: "toolCall", name: "read", arguments: { path: "a.ts", line: 3 } },
					],
				},
				{
					content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts", line: 4 } }],
				},
				{ content: ["done"] },
			],
		});
		const budget = new AdvisorReviewBudget({ ...defaults, maxToolCallsPerTurn: 2 });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock.model,
				systemPrompt: ["Test"],
				tools: [
					createReadTool(params => {
						executed.push(params.line ?? -1);
						return "ok";
					}),
				],
			},
			beforeToolCall: ({ tool, args }) => budget.beforeToolCall(tool.name, args),
			streamFn: mock.stream,
		});
		agent.addBeforeModelCall(() => budget.beforeModelCall());
		budget.beginReview(1);

		await agent.prompt("Review this change");

		expect(mock.calls).toHaveLength(3);
		expect(executed).toEqual([1, 2, 4]);
		expect(budget.requests).toBe(3);
		expect(budget.stop).toBeUndefined();
	});

	it("enforces completed cost between provider calls in one Agent.prompt loop", async () => {
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts", line: 1 } }],
					usage: { cost: { total: 0.6 } },
				},
				{
					content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts", line: 2 } }],
					usage: { cost: { total: 0.6 } },
				},
				{ content: ["this third request must never be sent"] },
			],
		});
		const budget = new AdvisorReviewBudget({ ...defaults, maxCostUsd: 1 });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [createReadTool(() => "ok")] },
			streamFn: mock.stream,
		});
		agent.addBeforeModelCall(() => budget.beforeModelCall());
		agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				budget.recordCompletedCost(event.message.usage.cost.total);
			}
		});
		budget.beginReview();

		await agent.prompt("Review this change");

		expect(mock.calls).toHaveLength(2);
		expect(budget.requests).toBe(2);
		expect(budget.costUsd).toBeCloseTo(1.2);
		expect(budget.stop?.kind).toBe("cost");
		expect(agent.state.error).toBeUndefined();
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(2);
	});
});
