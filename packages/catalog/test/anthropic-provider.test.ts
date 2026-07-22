import { describe, expect, test } from "bun:test";
import { anthropicModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

type AnthropicDiscoveryCall = {
	authorization: string | null;
	apiKey: string | null;
};

function createDiscoveryFetch(calls: AnthropicDiscoveryCall[]): FetchImpl {
	return async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url === "https://models.dev/api.json") {
			return Response.json({ anthropic: { models: {} } });
		}

		const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
		calls.push({
			authorization: headers.get("authorization"),
			apiKey: headers.get("x-api-key"),
		});
		return Response.json({
			data: [{ id: "claude-test", display_name: "Claude Test", type: "model" }],
		});
	};
}

describe("Anthropic provider discovery", () => {
	test("unwraps Cowork credentials before OAuth classification and authorization", async () => {
		const calls: AnthropicDiscoveryCall[] = [];
		const credential = JSON.stringify({ token: "sk-ant-oat-cowork-token", clientProfile: "cowork" });
		const options = anthropicModelManagerOptions({
			apiKey: credential,
			fetch: createDiscoveryFetch(calls),
		});

		await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				authorization: "Bearer sk-ant-oat-cowork-token",
				apiKey: null,
			},
		]);
		expect(calls[0]?.authorization).not.toContain(credential);
	});

	test("preserves ordinary OAuth authentication", async () => {
		const calls: AnthropicDiscoveryCall[] = [];
		const options = anthropicModelManagerOptions({
			apiKey: "sk-ant-oat-ordinary-token",
			fetch: createDiscoveryFetch(calls),
		});

		await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				authorization: "Bearer sk-ant-oat-ordinary-token",
				apiKey: null,
			},
		]);
	});

	test("preserves API-key authentication", async () => {
		const calls: AnthropicDiscoveryCall[] = [];
		const options = anthropicModelManagerOptions({
			apiKey: "sk-ant-api-key",
			fetch: createDiscoveryFetch(calls),
		});

		await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				authorization: null,
				apiKey: "sk-ant-api-key",
			},
		]);
	});
});
