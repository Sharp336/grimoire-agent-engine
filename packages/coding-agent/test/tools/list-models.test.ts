import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ListModelsTool } from "@oh-my-pi/pi-coding-agent/tools/list-models-tool";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

function makeModel(provider: string, id: string, opts?: Partial<Model<Api>>): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic" as Api,
		provider,
		baseUrl: "https://api.example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 4096,
		...opts,
	};
}

function mockRegistry(models: Model<Api>[]) {
	return {
		getAvailable: () => models,
	} as unknown as import("@oh-my-pi/pi-coding-agent/config/model-registry").ModelRegistry;
}

function createTestSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("ListModelsTool", () => {
	describe("createIf", () => {
		it("returns null when modelRegistry is undefined", () => {
			const session = createTestSession({ modelRegistry: undefined });
			expect(ListModelsTool.createIf(session)).toBeNull();
		});

		it("returns tool when modelRegistry is present", () => {
			const session = createTestSession({ modelRegistry: mockRegistry([]) });
			const tool = ListModelsTool.createIf(session);
			expect(tool).toBeInstanceOf(ListModelsTool);
			expect(tool!.name).toBe("list_models");
		});
	});

	describe("registration", () => {
		it("list_models appears in createTools when registry is set", async () => {
			const session = createTestSession({ modelRegistry: mockRegistry([]) });
			const tools = await createTools(session);
			const names = tools.map(t => t.name);
			expect(names).toContain("list_models");
		});

		it("list_models excluded from createTools when no registry", async () => {
			const session = createTestSession({ modelRegistry: undefined });
			const tools = await createTools(session);
			const names = tools.map(t => t.name);
			expect(names).not.toContain("list_models");
		});
	});

	describe("execute", () => {
		const models = [
			makeModel("anthropic", "claude-haiku-4-5", { reasoning: true, contextWindow: 200_000 }),
			makeModel("anthropic", "claude-opus-4-6", { reasoning: true, contextWindow: 200_000 }),
			makeModel("anthropic", "claude-sonnet-4-5", { reasoning: true, contextWindow: 200_000 }),
			makeModel("anthropic", "claude-sonnet-4-6", { reasoning: true, contextWindow: 200_000 }),
			makeModel("openai", "gpt-4o", { contextWindow: 128_000 }),
			makeModel("openai", "o3-mini", { reasoning: true, contextWindow: 200_000 }),
		];

		function createTool(modelList: Model<Api>[] = models) {
			const session = createTestSession({ modelRegistry: mockRegistry(modelList) });
			return ListModelsTool.createIf(session)!;
		}

		it("returns all models when no query", async () => {
			const tool = createTool();
			const result = await tool.execute("call-1", {});
			expect(result.details!.models).toHaveLength(6);
			// Sorted by provider then id
			expect(result.details!.models[0].provider).toBe("anthropic");
			expect(result.details!.models[0].id).toBe("claude-haiku-4-5");
			expect(result.details!.models[4].provider).toBe("openai");
		});

		it("returns correct fields per model", async () => {
			const tool = createTool();
			const result = await tool.execute("call-1", {});
			const haiku = result.details!.models.find(m => m.id === "claude-haiku-4-5")!;
			expect(haiku.provider).toBe("anthropic");
			expect(haiku.reasoning).toBe(true);
			expect(haiku.contextWindow).toBe(200_000);
		});

		it("fuzzy filters by query", async () => {
			const tool = createTool();
			const result = await tool.execute("call-1", { query: "haiku" });
			expect(result.details!.models).toHaveLength(1);
			expect(result.details!.models[0].id).toBe("claude-haiku-4-5");
		});

		it("fuzzy filters across provider and id", async () => {
			const tool = createTool();
			const result = await tool.execute("call-1", { query: "openai" });
			expect(result.details!.models).toHaveLength(2);
			expect(result.details!.models.every(m => m.provider === "openai")).toBe(true);
		});

		it("returns no-match message for unmatched query", async () => {
			const tool = createTool();
			const result = await tool.execute("call-1", { query: "lollipop" });
			expect(result.details!.models).toHaveLength(0);
			expect(result.content[0]).toEqual({ type: "text", text: 'No models matching "lollipop".' });
		});

		it("returns empty message when no models available", async () => {
			const tool = createTool([]);
			const result = await tool.execute("call-1", {});
			expect(result.details!.models).toHaveLength(0);
			expect(result.content[0]).toEqual({ type: "text", text: "No models available. No API keys configured." });
		});

		it("matches 'opus 4.6' with dot separator", async () => {
			const tool = createTool();
			const result = await tool.execute("call-1", { query: "opus 4.6" });
			expect(result.details!.models).toHaveLength(1);
			expect(result.details!.models[0].id).toBe("claude-opus-4-6");
		});

		it("matches 'opus 4 6' with space separator", async () => {
			const tool = createTool();
			const result = await tool.execute("call-1", { query: "opus 4 6" });
			expect(result.details!.models).toHaveLength(1);
			expect(result.details!.models[0].id).toBe("claude-opus-4-6");
		});

		it("matches 'opus 4-6' with dash separator", async () => {
			const tool = createTool();
			const result = await tool.execute("call-1", { query: "opus 4-6" });
			expect(result.details!.models).toHaveLength(1);
			expect(result.details!.models[0].id).toBe("claude-opus-4-6");
		});

		it("matches 'opus46' without separator", async () => {
			const tool = createTool();
			const result = await tool.execute("call-1", { query: "opus46" });
			expect(result.details!.models).toHaveLength(1);
			expect(result.details!.models[0].id).toBe("claude-opus-4-6");
		});
		it("text output contains provider/modelId format", async () => {
			const tool = createTool();
			const result = await tool.execute("call-1", { query: "haiku" });
			const text = (result.content[0] as { type: "text"; text: string }).text;
			expect(text).toContain("anthropic/claude-haiku-4-5");
			expect(text).toContain("reasoning=true");
			expect(text).toContain("context=200000");
		});
	});
});
