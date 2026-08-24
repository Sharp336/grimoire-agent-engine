import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function model(supportsContextManagement?: boolean): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		api: "anthropic-messages",
		provider: "custom-anthropic-proxy",
		baseUrl: "https://models.example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		compat: supportsContextManagement === undefined ? undefined : { supportsContextManagement },
	} as ModelSpec<"anthropic-messages">);
}

async function captureRequest(
	modelUnderTest: Model<"anthropic-messages">,
	apiKey = "test-key",
): Promise<{
	beta: string;
	payload: { context_management?: unknown; thinking?: { type?: string } };
}> {
	let beta = "";
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
		return new Response(
			JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
	const { promise, resolve } = Promise.withResolvers<{
		context_management?: unknown;
		thinking?: { type?: string };
	}>();
	await streamAnthropic(
		modelUnderTest,
		{ systemPrompt: [], messages: [{ role: "user", content: "continue", timestamp: 0 }] },
		{
			apiKey,
			thinkingEnabled: true,
			fetch: fetchMock,
			onPayload: payload => resolve(payload as { context_management?: unknown; thinking?: { type?: string } }),
		},
	).result();
	return { beta, payload: await promise };
}

describe("Anthropic context management compatibility", () => {
	it("omits only context management when a proxy opts out", async () => {
		const request = await captureRequest(model(false));

		expect(request.payload.thinking?.type).toBe("enabled");
		expect(request.payload.context_management).toBeUndefined();
		expect(request.beta).not.toContain("context-management-2025-06-27");
	});

	it("preserves context management by default", async () => {
		const request = await captureRequest(model());

		expect(request.payload.context_management).toBeDefined();
		expect(request.beta).toContain("context-management-2025-06-27");
	});

	it("removes context management from OAuth-shaped requests", async () => {
		const request = await captureRequest(model(false), "sk-ant-oat-test");

		expect(request.payload.thinking?.type).toBe("enabled");
		expect(request.payload.context_management).toBeUndefined();
		expect(request.beta).not.toContain("context-management-2025-06-27");
	});
});
