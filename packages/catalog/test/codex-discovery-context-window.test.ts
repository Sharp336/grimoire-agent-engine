import { describe, expect, it, vi } from "bun:test";
import { fetchCodexModels } from "../src/discovery/codex";

async function discoverCodexModels(payload: unknown) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.2.3");
		expect(init?.method).toBe("GET");
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});

	const result = await fetchCodexModels({
		accessToken: "codex-test-token",
		clientVersion: "1.2.3",
		fetchFn: fetchMock as unknown as typeof fetch,
	});

	expect(result).not.toBeNull();
	return { models: result?.models ?? [], fetchMock };
}

describe("codex discovery context windows", () => {
	it("uses an explicit max context window before the prompt budget", async () => {
		const { models, fetchMock } = await discoverCodexModels({
			models: [
				{
					slug: "gpt-codex-test",
					display_name: "GPT Codex Test",
					context_window: 272_000,
					max_context_window: 400_000,
					default_reasoning_level: "high",
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-codex-test");
		expect(model).toBeDefined();
		expect(model?.contextWindow).toBe(400_000);
		expect(model?.maxTokens).toBe(128_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("uses the published GPT-5.5 Codex total window when context_window is the 272K prompt budget", async () => {
		const { models } = await discoverCodexModels({
			models: [
				{
					slug: "gpt-5.5",
					display_name: "GPT-5.5",
					context_window: 272_000,
					default_reasoning_level: "high",
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-5.5");
		expect(model).toBeDefined();
		expect(model?.contextWindow).toBe(400_000);
		expect(model?.maxTokens).toBe(128_000);
	});

	it("keeps the published GPT-5.5 Codex total window when max_context_window is the 272K prompt budget", async () => {
		const { models } = await discoverCodexModels({
			models: [
				{
					slug: "gpt-5.5",
					display_name: "GPT-5.5",
					context_window: 272_000,
					max_context_window: 272_000,
					default_reasoning_level: "high",
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-5.5");
		expect(model).toBeDefined();
		expect(model?.contextWindow).toBe(400_000);
		expect(model?.maxTokens).toBe(128_000);
	});
	it("keeps other Codex model context_window values unchanged", async () => {
		const { models } = await discoverCodexModels({
			models: [
				{
					slug: "gpt-5.3-codex-spark",
					display_name: "GPT-5.3 Codex Spark",
					context_window: 128_000,
					default_reasoning_level: "high",
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-5.3-codex-spark");
		expect(model).toBeDefined();
		expect(model?.contextWindow).toBe(128_000);
		expect(model?.maxTokens).toBe(128_000);
	});
});
