import { describe, expect, test, vi } from "bun:test";
import { loginFeatherless } from "../src/registry/featherless";
import { getOAuthProviders } from "../src/registry/oauth";
import type { FetchImpl } from "../src/types";

describe("Featherless login", () => {
	test("registers Featherless as an available API-key provider", () => {
		const provider = getOAuthProviders().find(item => item.id === "featherless");
		expect(provider).toMatchObject({ id: "featherless", name: "Featherless", available: true });
	});

	test("validates the key against the models endpoint instead of a plan-gated model", async () => {
		const requests: Array<{ url: string; method: string | undefined; headers: Headers }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			requests.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers) });
			return Response.json({ total: 43_750, data: [{ id: "example/model" }] });
		});

		const apiKey = await loginFeatherless({
			onPrompt: async () => " featherless-test-key ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("featherless-test-key");
		expect(requests).toHaveLength(1);
		const request = requests[0];
		// A chat-completions probe would reject a valid key whose plan excludes
		// the probed model; Featherless gates model access per plan.
		expect(request.url).toBe("https://api.featherless.ai/v1/models?per_page=1");
		expect(request.method).toBe("GET");
		expect(request.headers.get("authorization")).toBe("Bearer featherless-test-key");
		expect(request.headers.get("http-referer")).toBe("https://omp.sh/");
		expect(request.headers.get("x-title")).toBe("Oh-My-Pi");
	});
});
