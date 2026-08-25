import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { searchWithParallel } from "@oh-my-pi/pi-coding-agent/web/parallel";
import { ParallelProvider, searchParallel } from "@oh-my-pi/pi-coding-agent/web/search/providers/parallel";

describe("Parallel web search", () => {
	const fakeStorage = {
		listAuthCredentials: () => [
			{
				id: 1,
				credential: {
					type: "oauth",
					access: "test-access-token",
					expires: Date.now() + 600_000,
					accountId: "acct-test",
				},
			},
		],
		updateAuthCredential: () => undefined,
		get authStore() {
			return null as never;
		},
	} as unknown as AgentStorage;
	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.PARALLEL_API_KEY ?? undefined;
		},
		hasAuth() {
			return Boolean(process.env.PARALLEL_API_KEY);
		},
		resolver(_provider: string) {
			return async () => process.env.PARALLEL_API_KEY ?? undefined;
		},
		async rotateSessionCredential() {
			return false;
		},
	} as unknown as AuthStorage;

	let capturedRequestBody: unknown;

	beforeEach(() => {
		capturedRequestBody = undefined;
		process.env.PARALLEL_API_KEY = "test-parallel-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PARALLEL_API_KEY;
	});

	function mockFetch(responseBody: unknown, status = 200): FetchImpl {
		return (_url, init) => {
			if (typeof init?.body === "string") {
				capturedRequestBody = JSON.parse(init.body);
			}
			return Promise.resolve(
				new Response(JSON.stringify(responseBody), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};
	}

	it("sends the expected Parallel search request and parses results", async () => {
		const fetchMock = mockFetch({
			search_id: "search-parallel-1",
			results: [
				{
					title: "Parallel result",
					url: "https://example.com/article",
					publish_date: "2025-01-01",
					excerpts: ["First excerpt", "Second excerpt"],
				},
			],
			warnings: null,
			usage: [{ name: "sku_search", count: 1 }],
		});

		const result = await searchWithParallel("parallel query", ["parallel query"], { fetch: fetchMock }, fakeStorage);
		expect(capturedRequestBody).toEqual({
			objective: "parallel query",
			search_queries: ["parallel query"],
			mode: "fast",
			excerpts: { max_chars_per_result: 10_000 },
		});
		expect(result).toEqual({
			requestId: "search-parallel-1",
			sources: [
				{
					title: "Parallel result",
					url: "https://example.com/article",
					snippet: "First excerpt\n\nSecond excerpt",
					publishedDate: "2025-01-01",
					excerpts: ["First excerpt", "Second excerpt"],
				},
			],
			warnings: [],
			usage: [{ name: "sku_search", count: 1 }],
		});
	});

	it("maps Parallel search responses into SearchResponse", async () => {
		const fetchMock = mockFetch({
			search_id: "search-parallel-2",
			results: [
				{
					title: "Alpha",
					url: "https://alpha.example",
					publish_date: "2024-12-24",
					excerpts: ["Alpha excerpt"],
				},
			],
			errors: [],
			warnings: null,
			usage: null,
		});

		const result = await searchParallel({ query: "alpha search", fetch: fetchMock }, fakeAuthStorage);
		expect(result.provider).toBe("parallel");
		expect(result.requestId).toBe("search-parallel-2");
		expect(result.sources).toEqual([
			{
				title: "Alpha",
				url: "https://alpha.example",
				snippet: "Alpha excerpt",
				publishedDate: "2024-12-24",
				ageSeconds: expect.any(Number),
			},
		]);
	});

	it("keeps credential-free Parallel out of the auto chain while allowing explicit selection", () => {
		delete process.env.PARALLEL_API_KEY;
		const provider = new ParallelProvider();

		expect(provider.isAvailable(fakeAuthStorage)).toBe(false);
		expect(provider.isExplicitlyAvailable(fakeAuthStorage)).toBe(true);
	});

	it("uses anonymous MCP and maps structured results when Parallel has no credential", async () => {
		delete process.env.PARALLEL_API_KEY;
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;
		const fetchMock: FetchImpl = (url, init) => {
			capturedUrl = url.toString();
			capturedHeaders = init?.headers as Record<string, string> | undefined;
			capturedRequestBody = JSON.parse(init?.body as string);
			return Promise.resolve(
				new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: "parallel-mcp-test",
						result: {
							structuredContent: {
								search_id: "search-parallel-mcp",
								results: [
									{
										title: "Free Parallel result",
										url: "https://parallel.ai/example",
										publish_date: "2026-08-01",
										excerpts: ["Public MCP excerpt"],
									},
									{ title: "Extra result", url: "https://parallel.ai/extra", excerpts: [] },
								],
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		};

		const result = await searchParallel(
			{ query: "free web search", num_results: 1, fetch: fetchMock },
			fakeAuthStorage,
		);

		expect(capturedUrl).toBe("https://search.parallel.ai/mcp");
		expect(capturedHeaders).toEqual({
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		});
		expect(capturedRequestBody).toEqual({
			jsonrpc: "2.0",
			id: expect.any(String),
			method: "tools/call",
			params: {
				name: "web_search",
				arguments: {
					objective: "free web search",
					search_queries: ["free web search"],
				},
			},
		});
		expect(result).toEqual({
			provider: "parallel",
			requestId: "search-parallel-mcp",
			sources: [
				{
					title: "Free Parallel result",
					url: "https://parallel.ai/example",
					snippet: "Public MCP excerpt",
					publishedDate: "2026-08-01",
					ageSeconds: expect.any(Number),
				},
			],
		});
	});

	it("parses SSE MCP text content after skipping non-JSON content blocks", async () => {
		delete process.env.PARALLEL_API_KEY;
		const payload = {
			search_id: "search-parallel-mcp-text",
			results: [{ title: "Text result", url: "https://example.com/text", excerpts: ["Text excerpt"] }],
		};
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(
					`event: message\ndata: ${JSON.stringify({
						jsonrpc: "2.0",
						id: "parallel-mcp-text",
						result: {
							content: [
								{ type: "text", text: "Search completed successfully." },
								{ type: "text", text: JSON.stringify(payload) },
							],
						},
					})}\n\n`,
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
			);

		const result = await searchParallel({ query: "text fallback", fetch: fetchMock }, fakeAuthStorage);

		expect(result.requestId).toBe("search-parallel-mcp-text");
		expect(result.sources).toEqual([
			{
				title: "Text result",
				url: "https://example.com/text",
				snippet: "Text excerpt",
				publishedDate: undefined,
				ageSeconds: undefined,
			},
		]);
	});

	it("preserves authenticated REST precedence for a stored key without an environment key", async () => {
		delete process.env.PARALLEL_API_KEY;
		const storedAuthStorage = {
			...fakeAuthStorage,
			async getApiKey() {
				return "stored-parallel-key";
			},
			hasAuth() {
				return true;
			},
			resolver() {
				return async () => "stored-parallel-key";
			},
		} as unknown as AuthStorage;
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;
		const fetchMock: FetchImpl = (url, init) => {
			capturedUrl = url.toString();
			capturedHeaders = init?.headers as Record<string, string> | undefined;
			return Promise.resolve(
				new Response(JSON.stringify({ search_id: "search-stored-key", results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchParallel({ query: "stored credential", fetch: fetchMock }, storedAuthStorage);

		expect(capturedUrl).toBe("https://api.parallel.ai/v1beta/search");
		expect(capturedHeaders).toMatchObject({
			"x-api-key": "stored-parallel-key",
			"parallel-beta": "search-extract-2025-10-10",
		});
	});

	it("surfaces anonymous MCP JSON-RPC errors as Parallel provider errors", async () => {
		delete process.env.PARALLEL_API_KEY;
		const fetchMock = mockFetch({
			jsonrpc: "2.0",
			id: "parallel-mcp-error",
			error: { code: -32602, message: "Search query was rejected" },
		});

		await expect(searchParallel({ query: "invalid", fetch: fetchMock }, fakeAuthStorage)).rejects.toMatchObject({
			provider: "parallel",
			message: expect.stringContaining("Search query was rejected"),
		});
	});

	it("surfaces anonymous MCP tool errors as Parallel provider errors", async () => {
		delete process.env.PARALLEL_API_KEY;
		const fetchMock = mockFetch({
			jsonrpc: "2.0",
			id: "parallel-mcp-tool-error",
			result: {
				isError: true,
				content: [{ type: "text", text: "Parallel search is temporarily unavailable" }],
			},
		});

		await expect(searchParallel({ query: "unavailable", fetch: fetchMock }, fakeAuthStorage)).rejects.toMatchObject({
			provider: "parallel",
			message: "Parallel search is temporarily unavailable",
		});
	});

	it("explains anonymous MCP rate limits and preserves the HTTP status", async () => {
		delete process.env.PARALLEL_API_KEY;
		const fetchMock: FetchImpl = () => Promise.resolve(new Response("rate limited", { status: 429 }));

		await expect(searchParallel({ query: "limited", fetch: fetchMock }, fakeAuthStorage)).rejects.toMatchObject({
			provider: "parallel",
			status: 429,
			message: expect.stringContaining("configure a Parallel API key"),
		});
	});

	it("maps site: directives onto source_policy.include_domains and strips them from the query", async () => {
		const fetchMock = mockFetch({
			search_id: "search-parallel-3",
			results: [],
			warnings: null,
			usage: null,
		});

		await searchParallel({ query: "web api site:parallel.ai", fetch: fetchMock }, fakeAuthStorage);
		expect(capturedRequestBody).toEqual({
			objective: "web api",
			search_queries: ["web api"],
			mode: "fast",
			excerpts: { max_chars_per_result: 10_000 },
			source_policy: { include_domains: ["parallel.ai"] },
		});
	});

	it("maps recency onto source_policy.after_date", async () => {
		setSystemTime(new Date("2026-08-10T12:00:00Z"));
		try {
			const fetchMock = mockFetch({
				search_id: "search-parallel-recency",
				results: [],
				warnings: null,
				usage: null,
			});

			await searchParallel({ query: "recent api changes", recency: "week", fetch: fetchMock }, fakeAuthStorage);
			expect(capturedRequestBody).toEqual({
				objective: "recent api changes",
				search_queries: ["recent api changes"],
				mode: "fast",
				excerpts: { max_chars_per_result: 10_000 },
				source_policy: { after_date: "2026-08-03" },
			});
		} finally {
			setSystemTime();
		}
	});

	it("maps -site: and after: onto exclude_domains/after_date, keeping phrases and negation", async () => {
		const fetchMock = mockFetch({
			search_id: "search-parallel-4",
			results: [],
			warnings: null,
			usage: null,
		});

		await searchParallel(
			{
				query: '"web api" -legacy -site:reddit.com/r/node after:2025-06-01',
				recency: "day",
				fetch: fetchMock,
			},
			fakeAuthStorage,
		);
		expect(capturedRequestBody).toEqual({
			objective: '"web api" -legacy',
			search_queries: ['"web api" -legacy'],
			mode: "fast",
			excerpts: { max_chars_per_result: 10_000 },
			source_policy: { exclude_domains: ["reddit.com"], after_date: "2025-06-01" },
		});
	});

	it("surfaces plain-text Parallel API errors", async () => {
		const fetchMock: FetchImpl = () => Promise.resolve(new Response("upstream unavailable", { status: 503 }));
		await expect(searchParallel({ query: "broken", fetch: fetchMock }, fakeAuthStorage)).rejects.toMatchObject({
			provider: "parallel",
			status: 503,
			message: "Parallel API error (503): upstream unavailable",
		});
	});

	it("classifies malformed successful responses as Parallel errors", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response("{not-json", { status: 200, headers: { "Content-Type": "application/json" } }));
		await expect(searchParallel({ query: "broken", fetch: fetchMock }, fakeAuthStorage)).rejects.toMatchObject({
			provider: "parallel",
			message: expect.stringContaining("Parallel search returned invalid JSON:"),
		});
	});
});
