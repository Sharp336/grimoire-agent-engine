import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildRequestBody, searchYou, type YouSearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/ydc";

describe("You.com buildRequestBody", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("always includes query and count", () => {
		const body = buildRequestBody({ query: "Bun 1.3 release notes", num_results: 7 });
		expect(body.query).toBe("Bun 1.3 release notes");
		expect(body.count).toBe(7);
	});

	it("defaults count to 5 when num_results is unset", () => {
		const body = buildRequestBody({ query: "q" });
		expect(body.count).toBe(5);
	});

	it("omits freshness when recency is unset", () => {
		const body = buildRequestBody({ query: "q" });
		expect(body).not.toHaveProperty("freshness");
	});

	it.each(["day", "week", "month", "year"] as const)("passes %s through as freshness verbatim", recency => {
		const body = buildRequestBody({ query: "q", recency });
		expect(body.freshness).toBe(recency);
	});
});

describe("You.com searchYou request shape (integration)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.YDC_API_KEY;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.YDC_API_KEY ?? undefined;
		},
		resolver: vi.fn(() => async () => process.env.YDC_API_KEY ?? undefined),
		hasAuth() {
			return Boolean(process.env.YDC_API_KEY);
		},
	} as unknown as AuthStorage;

	function makeParams(query: string, extras: Partial<YouSearchParams> = {}) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "You.com integration test prompt",
			...extras,
		};
	}

	it("posts query, count, and freshness with the X-API-Key header", async () => {
		process.env.YDC_API_KEY = "test-ydc-key";

		let capturedUrl: string | undefined;
		let capturedBody: Record<string, unknown> | undefined;
		let capturedApiKey: string | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			capturedUrl =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			capturedBody = JSON.parse(init?.body as string);
			capturedApiKey = new Headers(init?.headers).get("X-API-Key") ?? undefined;
			return new Response(JSON.stringify({ results: { web: [] }, metadata: { search_uuid: "req-0" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchYou({
			...makeParams("Bun runtime latest release notes", { recency: "week" }),
			numSearchResults: 3,
			fetch: fetchMock,
		});

		expect(capturedUrl).toBe("https://api.you.com/v1/agents/search");
		expect(capturedApiKey).toBe("test-ydc-key");
		expect(capturedBody).toMatchObject({
			query: "Bun runtime latest release notes",
			count: 3,
			freshness: "week",
		});
	});

	it("omits freshness entirely when recency is not provided", async () => {
		process.env.YDC_API_KEY = "test-ydc-key";

		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ results: {}, metadata: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchYou({ ...makeParams("bun sqlite"), fetch: fetchMock });

		expect(capturedBody).toBeDefined();
		expect(capturedBody).not.toHaveProperty("freshness");
	});
});
