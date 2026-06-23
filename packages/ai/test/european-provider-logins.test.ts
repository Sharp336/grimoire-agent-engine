import { describe, expect, test, vi } from "bun:test";
import { loginCortecs } from "@oh-my-pi/pi-ai/registry/cortecs";
import { loginEURouter } from "@oh-my-pi/pi-ai/registry/eurouter";
import { loginMelious } from "@oh-my-pi/pi-ai/registry/melious";
import { loginNebius } from "@oh-my-pi/pi-ai/registry/nebius";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const loginCases = [
	{
		id: "melious",
		name: "Melious",
		login: loginMelious,
		key: "sk-mel-test",
		modelsUrl: "https://api.melious.ai/v1/models",
	},
	{
		id: "nebius",
		name: "Nebius Token Factory",
		login: loginNebius,
		key: "nebius-test-key",
		modelsUrl: "https://api.tokenfactory.nebius.com/v1/models",
	},
	{
		id: "cortecs",
		name: "Cortecs",
		login: loginCortecs,
		key: "cortecs-test-key",
		modelsUrl: "https://api.cortecs.ai/v1/models",
	},
	{
		id: "eurouter",
		name: "EUrouter",
		login: loginEURouter,
		key: "eur_test_key",
		modelsUrl: "https://api.eurouter.ai/api/v1/models",
	},
] as const;

describe("European gateway provider logins", () => {
	test("registers European gateways in the login provider selector", () => {
		const loginProviders = getOAuthProviders();
		for (const provider of loginCases) {
			expect(loginProviders).toContainEqual(expect.objectContaining({ id: provider.id, name: provider.name }));
		}
	});

	for (const provider of loginCases) {
		test(`${provider.id} validates API keys against its models endpoint`, async () => {
			const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				expect(url).toBe(provider.modelsUrl);
				expect(init?.method).toBe("GET");
				expect(init?.headers).toEqual({ Authorization: `Bearer ${provider.key}` });
				return new Response(JSON.stringify({ object: "list", data: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const apiKey = await provider.login({
				onPrompt: async () => provider.key,
				fetch: fetchMock,
			});

			expect(apiKey).toBe(provider.key);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		test(`${provider.id} surfaces validation failures`, async () => {
			const fetchMock: FetchImpl = vi.fn(async () => new Response('{"error":"invalid_api_key"}', { status: 401 }));

			await expect(
				provider.login({
					onPrompt: async () => provider.key,
					fetch: fetchMock,
				}),
			).rejects.toThrow(`${provider.name} API key validation failed (401)`);
		});
	}
});
