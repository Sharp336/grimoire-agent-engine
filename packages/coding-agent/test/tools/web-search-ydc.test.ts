import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { searchYou } from "@oh-my-pi/pi-coding-agent/web/search/providers/ydc";
import type { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

describe("You.com web search provider", () => {
	beforeEach(() => {
		process.env.YDC_API_KEY = "test-ydc-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.YDC_API_KEY;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.YDC_API_KEY ?? undefined;
		},
		hasAuth() {
			return Boolean(process.env.YDC_API_KEY);
		},
		resolver(_provider: string) {
			return async () => process.env.YDC_API_KEY ?? undefined;
		},
		async rotateSessionCredential() {
			return false;
		},
	} as unknown as AuthStorage;

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "You.com test prompt",
		} as const;
	}

	it("maps web and news results into a unified SearchResponse", async () => {
		const fetchMock = async (): Promise<Response> =>
			new Response(
				JSON.stringify({
					results: {
						web: [
							{
								title: "Result One",
								url: "https://example.com/one",
								description: "First description",
								snippets: ["snippet a", "snippet b"],
								page_age: "2026-03-01T00:00:00Z",
								authors: ["Jane Doe"],
							},
							{ url: "https://example.com/two", description: "Second description" },
							{ title: "No URL", description: "dropped" },
						],
						news: [
							{
								title: "News One",
								url: "https://news.example.com/n1",
								description: "News description",
								page_age: "2026-05-01T00:00:00Z",
							},
						],
					},
					metadata: { search_uuid: "req-ydc-123", query: "latest ai" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchYou({
			...makeParams("latest ai"),
			numSearchResults: 5,
			fetch: fetchMock,
		});

		expect(response.provider).toBe("ydc");
		expect(response.authMode).toBe("api_key");
		expect(response.requestId).toBe("req-ydc-123");
		// URL-less result is dropped; web results precede news results.
		expect(response.sources).toMatchObject([
			{
				title: "Result One",
				url: "https://example.com/one",
				snippet: "First description\nsnippet a\nsnippet b",
				publishedDate: "2026-03-01T00:00:00Z",
				author: "Jane Doe",
			},
			{
				title: "https://example.com/two",
				url: "https://example.com/two",
				snippet: "Second description",
			},
			{
				title: "News One",
				url: "https://news.example.com/n1",
				snippet: "News description",
				publishedDate: "2026-05-01T00:00:00Z",
			},
		]);
		expect(response.sources[0]?.ageSeconds).toBeTypeOf("number");
	});

	it("slices combined web and news results to numSearchResults", async () => {
		const fetchMock = async (): Promise<Response> =>
			new Response(
				JSON.stringify({
					results: {
						web: [
							{ title: "W1", url: "https://example.com/w1" },
							{ title: "W2", url: "https://example.com/w2" },
						],
						news: [{ title: "N1", url: "https://news.example.com/n1" }],
					},
					metadata: {},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchYou({
			...makeParams("bounded"),
			numSearchResults: 2,
			fetch: fetchMock,
		});

		expect(response.sources.map(s => s.url)).toEqual(["https://example.com/w1", "https://example.com/w2"]);
	});

	it("surfaces structured API errors", async () => {
		const fetchMock = (): Promise<Response> =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "invalid api key" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				}),
			);

		await expect(searchYou({ ...makeParams("bad auth"), fetch: fetchMock })).rejects.toEqual(
			expect.objectContaining({
				provider: "ydc",
				status: 403,
				message: "ydc: 403 forbidden",
			}) satisfies Partial<SearchProviderError>,
		);
	});

	it("throws a clear error when You.com credentials are missing", async () => {
		delete process.env.YDC_API_KEY;
		await expect(searchYou(makeParams("missing creds"))).rejects.toThrow(
			'You.com credentials not found. Set YDC_API_KEY or configure an API key for provider "ydc".',
		);
	});
});
