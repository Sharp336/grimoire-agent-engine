import { describe, expect, test } from "bun:test";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ExecutorOptions, SingleResult } from "@oh-my-pi/pi-coding-agent";
import {
	ANIMA_CLAUDE_API,
	ANIMA_CLAUDE_PROVIDER,
	configuredClaudeSelectors,
	renderProviderConversation,
	streamAnimaClaude,
} from "../src/provider";

function model(id = "opus"): Model<typeof ANIMA_CLAUDE_API> {
	return {
		id,
		name: `Anima Claude ${id}`,
		api: ANIMA_CLAUDE_API,
		provider: ANIMA_CLAUDE_PROVIDER,
		baseUrl: "http://anima.local/control",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		compat: undefined,
	};
}

function context(): Context {
	return {
		systemPrompt: ["Follow the repository rules."],
		messages: [
			{ role: "user", content: "Inspect the quota mapper.", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "I found the mapper." }],
				api: "mock",
				provider: "mock",
				model: "mock",
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
			},
			{ role: "user", content: "Fix it.", timestamp: 3 },
		],
	};
}

describe("Anima Claude provider", () => {
	test("exposes direct Claude Code selectors without a strength mapping", () => {
		expect(configuredClaudeSelectors("anthropic/claude-opus-5-20260701,claude-fable-5-20260701,bogus,opus")).toEqual([
			"opus",
			"fable",
			"sonnet",
			"haiku",
			"claude-opus-5-20260701",
			"claude-fable-5-20260701",
		]);
	});

	test("renders the OMP conversation for the Claude Code turn", () => {
		const prompt = renderProviderConversation(context());
		expect(prompt).toContain("### USER\nInspect the quota mapper.");
		expect(prompt).toContain("### ASSISTANT\nI found the mapper.");
		expect(prompt).toContain("### USER\nFix it.");
	});

	test("runs the selected underlying model through the Anima executor", async () => {
		let captured: ExecutorOptions | undefined;
		const execute = async (options: ExecutorOptions): Promise<SingleResult> => {
			captured = options;
			return {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				exitCode: 0,
				output: "Quota mapper fixed.",
				stderr: "",
				truncated: false,
				durationMs: 10,
				tokens: 0,
				requests: 1,
			};
		};

		const stream = streamAnimaClaude(
			model("fable"),
			context(),
			{ cwd: "/tmp/project", reasoning: Effort.High },
			execute,
		);
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "Quota mapper fixed." }]);
		expect(captured?.cwd).toBe("/tmp/project");
		expect(captured?.modelOverride).toBe("anthropic/fable");
		expect(captured?.effort).toBe("hi");
		expect(captured?.agent.systemPrompt).toContain("Follow the repository rules.");
	});
});
