import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	AnySearchProvider,
	type AnySearchSearchParams,
	buildRequestBody,
	searchAnySearch,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/anysearch";

describe("AnySearch buildRequestBody", () => {
	it("always includes query and clamps max_results into the 1-20 range", () => {
		expect(buildRequestBody({ query: "go release notes" })).toEqual({
			query: "go release notes",
			max_results: 10,
		});
		expect(buildRequestBody({ query: "q", num_results: 3 })).toEqual({ query: "q", max_results: 3 });
		expect(buildRequestBody({ query: "q", num_results: 100 })).toEqual({ query: "q", max_results: 20 });
		expect(buildRequestBody({ query: "q", num_results: 0 })).toEqual({ query: "q", max_results: 10 });
	});
});

describe("AnySearch searchAnySearch request shape (integration)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.ANYSEARCH_API_KEY;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.ANYSEARCH_API_KEY ?? undefined;
		},
		resolver: vi.fn(() => async () => process.env.ANYSEARCH_API_KEY ?? undefined),
		hasAuth() {
			return Boolean(process.env.ANYSEARCH_API_KEY);
		},
	} as unknown as AuthStorage;

	function makeParams(query: string, extras: Partial<AnySearchSearchParams> = {}) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "AnySearch integration test prompt",
			...extras,
		};
	}

	function makeFetchMock(captured: { body?: Record<string, unknown>; headers?: Headers }, payload: unknown) {
		const fetchMock: FetchImpl = async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url === "https://api.anysearch.com/v1/search") {
				captured.body = JSON.parse(init?.body as string);
				captured.headers = new Headers(init?.headers);
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not mocked", { status: 500 });
		};
		return fetchMock;
	}

	const successPayload = {
		code: 0,
		message: "success",
		request_id: "req-anysearch-1",
		data: {
			results: [
				{
					title: "Go 1.26 Release Notes",
					url: "https://go.dev/doc/go1.26",
					snippet: "Go 1.26 is a major release",
					content: "Detailed content",
				},
				{
					url: "https://example.com/empty-title",
					snippet: "falls back to url title",
				},
				{ url: "" },
			],
			metadata: { total_results: 2, search_time_ms: 946 },
		},
	};

	it("calls the anonymous tier without an Authorization header when no key is configured", async () => {
		const captured: { body?: Record<string, unknown>; headers?: Headers } = {};
		const fetchMock = makeFetchMock(captured, successPayload);

		const response = await searchAnySearch({
			...makeParams("Go 1.26 release notes"),
			fetch: fetchMock,
		});

		expect(captured.body).toEqual({ query: "Go 1.26 release notes", max_results: 10 });
		expect(captured.headers?.get("authorization")).toBeNull();

		expect(response.provider).toBe("anysearch");
		expect(response.authMode).toBe("keyless");
		expect(response.requestId).toBe("req-anysearch-1");
		expect(response.sources).toHaveLength(2);
		expect(response.sources[0]).toEqual({
			title: "Go 1.26 Release Notes",
			url: "https://go.dev/doc/go1.26",
			snippet: "Go 1.26 is a major release",
		});
		// Missing-title results fall back to the URL; url-less results are dropped.
		expect(response.sources[1]).toEqual({
			title: "https://example.com/empty-title",
			url: "https://example.com/empty-title",
			snippet: "falls back to url title",
		});
	});

	it("sends the Bearer token and reports api_key auth mode when a key is configured", async () => {
		process.env.ANYSEARCH_API_KEY = "test-key";

		const captured: { body?: Record<string, unknown>; headers?: Headers } = {};
		const fetchMock = makeFetchMock(captured, successPayload);

		await searchAnySearch({ ...makeParams("go release notes"), fetch: fetchMock });

		expect(captured.headers?.get("authorization")).toBe("Bearer test-key");
	});

	it("passes numSearchResults through as max_results", async () => {
		const captured: { body?: Record<string, unknown>; headers?: Headers } = {};
		const fetchMock = makeFetchMock(captured, successPayload);

		await searchAnySearch({
			...makeParams("go release notes"),
			numSearchResults: 3,
			fetch: fetchMock,
		});

		expect(captured.body?.max_results).toBe(3);
	});

	it("strips Google-style directives into a natural-language query", async () => {
		const captured: { body?: Record<string, unknown>; headers?: Headers } = {};
		const fetchMock = makeFetchMock(captured, successPayload);

		await searchAnySearch({
			...makeParams("pricing site:tavily.com -reddit"),
			fetch: fetchMock,
		});

		expect(captured.body?.query).toBe("pricing -reddit");
	});

	it("throws a provider error when the payload carries a non-zero code", async () => {
		const fetchMock = makeFetchMock(
			{},
			{
				code: -1,
				message: "Missing required params for tag 'code.doc': library.",
				request_id: "req-err",
			},
		);

		await expect(searchAnySearch({ ...makeParams("go release notes"), fetch: fetchMock })).rejects.toThrow(
			"AnySearch API error: Missing required params for tag 'code.doc': library.",
		);
	});

	it("throws a provider error with the upstream message on HTTP failure", async () => {
		const fetchMock: FetchImpl = async input => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url === "https://api.anysearch.com/v1/search") {
				return new Response(JSON.stringify({ code: -1, message: "rate limit hit", request_id: "req-429" }), {
					status: 429,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not mocked", { status: 500 });
		};

		await expect(searchAnySearch({ ...makeParams("go release notes"), fetch: fetchMock })).rejects.toThrow(
			"AnySearch API error (429): rate limit hit",
		);
	});

	it("maps quota/credit error bodies through classifyProviderHttpError", async () => {
		const fetchMock: FetchImpl = async input => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url === "https://api.anysearch.com/v1/search") {
				return new Response(JSON.stringify({ code: -1, message: "daily free quota exhausted" }), {
					status: 402,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not mocked", { status: 500 });
		};

		await expect(searchAnySearch({ ...makeParams("go release notes"), fetch: fetchMock })).rejects.toThrow(
			"anysearch: credits exhausted",
		);
	});
});

describe("AnySearchProvider availability", () => {
	afterEach(() => {
		delete process.env.ANYSEARCH_API_KEY;
	});

	it("is explicitly available without credentials because the anonymous tier exists", () => {
		const provider = new AnySearchProvider();
		const storage = { hasAuth: () => false } as unknown as AuthStorage;
		expect(provider.isAvailable(storage)).toBe(false);
		expect(provider.isExplicitlyAvailable(storage)).toBe(true);
	});

	it("is auto-chain available when ANYSEARCH_API_KEY is set", () => {
		process.env.ANYSEARCH_API_KEY = "test-key";
		const provider = new AnySearchProvider();
		expect(provider.isAvailable({ hasAuth: () => false } as unknown as AuthStorage)).toBe(true);
	});
});
