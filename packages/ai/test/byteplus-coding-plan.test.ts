import { afterEach, describe, expect, it, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: FetchStub): void {
	const fetchMock: typeof fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			return handler(input, init);
		},
		{ preconnect: fetch.preconnect },
	);

	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("BytePlus Coding Plan provider", () => {
	it("opens the Coding Plan page and validates against the Coding Plan API", async () => {
		const authUrls: string[] = [];
		const validationUrls: string[] = [];
		const validationModels: string[] = [];
		const provider = getProviderDefinition("byteplus-coding-plan");

		mockFetch((input, init) => {
			validationUrls.push(String(input));
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
			if (body && typeof body.model === "string") {
				validationModels.push(body.model);
			}
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		});

		const apiKey = await provider?.login?.({
			onAuth: info => authUrls.push(info.url),
			onPrompt: async () => "  byteplus-key  ",
		});

		expect(apiKey).toBe("byteplus-key");
		expect(getOAuthProviders().map(info => info.id)).toContain("byteplus-coding-plan");
		expect(authUrls).toEqual(["https://www.byteplus.com/en/activity/codingplan"]);
		expect(validationUrls).toEqual(["https://ark.ap-southeast.bytepluses.com/api/coding/v3/chat/completions"]);
		expect(validationModels).toEqual(["ark-code-latest"]);
	});
});
