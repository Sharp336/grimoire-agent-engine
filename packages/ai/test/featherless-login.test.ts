import { describe, expect, test, vi } from "bun:test";
import { loginFeatherless } from "../src/registry/featherless";
import { getOAuthProviders } from "../src/registry/oauth";
import type { FetchImpl } from "../src/types";

describe("Featherless login", () => {
	test("registers Featherless as an available API-key provider", () => {
		const provider = getOAuthProviders().find(item => item.id === "featherless");
		expect(provider).toMatchObject({ id: "featherless", name: "Featherless", available: true });
	});

	test("validates GLM 5.2 with Featherless application attribution", async () => {
		const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
				body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
			});
			return Response.json({ choices: [{ message: { role: "assistant", content: "" } }] });
		});

		const apiKey = await loginFeatherless({
			onPrompt: async () => " featherless-test-key ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("featherless-test-key");
		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request.url).toBe("https://api.featherless.ai/v1/chat/completions");
		expect(request.headers.get("authorization")).toBe("Bearer featherless-test-key");
		expect(request.headers.get("http-referer")).toBe("https://omp.sh/");
		expect(request.headers.get("x-title")).toBe("Oh-My-Pi");
		expect(request.body).toEqual({
			model: "zai-org/GLM-5.2",
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 1,
			temperature: 0,
		});
	});
});
