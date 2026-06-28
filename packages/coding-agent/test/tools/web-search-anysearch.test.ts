import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { parseAnySearchMarkdown, searchAnySearch } from "../../src/web/search/providers/anysearch";

describe("AnySearch web search provider", () => {
	beforeEach(() => {
		process.env.ANYSEARCH_API_KEY = "test-anysearch-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.ANYSEARCH_API_KEY;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.ANYSEARCH_API_KEY ?? undefined;
		},
		hasAuth() {
			return Boolean(process.env.ANYSEARCH_API_KEY);
		},
		resolver(_provider: string) {
			return async () => process.env.ANYSEARCH_API_KEY ?? undefined;
		},
		async rotateSessionCredential() {
			return false;
		},
	} as unknown as AuthStorage;

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "test system prompt",
		} as const;
	}

	it("parses AnySearch Markdown response correctly", () => {
		const md = `## Search Results (2 results, 1800ms)

### 1. OpenAI | Info
- **URL**: https://openai.com/
- OpenAI is an AI research and deployment company...

### 2. DeepMind | Google
- **URL**: https://deepmind.google/
- [Google DeepMind](https://deepmind.google/) is a pioneer in [AI research](https://example.com/ai)...
`;
		const parsed = parseAnySearchMarkdown(md);
		expect(parsed.sources).toHaveLength(2);
		expect(parsed.sources[0]?.title).toBe("OpenAI | Info");
		expect(parsed.sources[0]?.url).toBe("https://openai.com/");
		expect(parsed.sources[0]?.snippet).toBe("OpenAI is an AI research and deployment company...");
		expect(parsed.sources[1]?.title).toBe("DeepMind | Google");
		expect(parsed.sources[1]?.url).toBe("https://deepmind.google/");
		expect(parsed.sources[1]?.snippet).toBe("Google DeepMind is a pioneer in AI research...");
	});

	it("executes search and returns SearchResponse", async () => {
		let requestBody: Record<string, unknown> | null = null;
		let authHeader: string | null | undefined = null;

		const fetchMock = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			if (init?.body) {
				requestBody = JSON.parse(init.body as string);
			}
			if (init?.headers) {
				authHeader = (init.headers as Record<string, string>).Authorization ?? null;
			}
			const md = `## Search Results (1 result)

### 1. seL4 Microkernel
- **URL**: https://sel4.systems/
- seL4 is the world's most highly assured kernel.
`;
			const payload = {
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: md }],
				},
			};
			return new Response(JSON.stringify(payload), { status: 200 });
		};

		const response = await searchAnySearch({
			...makeParams("seL4"),
			fetch: fetchMock,
		});

		expect(authHeader as unknown as string).toBe("Bearer test-anysearch-key");
		expect(requestBody).toMatchObject({
			method: "tools/call",
			params: {
				name: "search",
				arguments: {
					query: "seL4",
					max_results: 5,
				},
			},
		});
		expect(response.provider).toBe("anysearch");
		expect(response.sources).toHaveLength(1);
		expect(response.sources[0]?.title).toBe("seL4 Microkernel");
		expect(response.sources[0]?.url).toBe("https://sel4.systems/");
		expect(response.sources[0]?.snippet).toBe("seL4 is the world's most highly assured kernel.");
	});

	it("falls back to anonymous search when key is missing", async () => {
		delete process.env.ANYSEARCH_API_KEY;
		const noKeyAuthStorage = {
			async getApiKey() {
				return undefined;
			},
			hasAuth() {
				return false;
			},
			resolver() {
				return () => undefined;
			},
		} as unknown as AuthStorage;

		let authHeader: string | null = null;

		const fetchMock = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			if (init?.headers) {
				authHeader = (init.headers as Record<string, string>).Authorization ?? null;
			}
			const payload = {
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: "## Search Results" }],
				},
			};
			return new Response(JSON.stringify(payload), { status: 200 });
		};

		const response = await searchAnySearch({
			query: "test",
			authStorage: noKeyAuthStorage,
			systemPrompt: "prompt",
			fetch: fetchMock,
		});

		expect(authHeader).toBeNull();
		expect(response.authMode).toBe("anonymous");
	});

	it("throws SearchProviderError on HTTP error status", async () => {
		const fetchMock = async () => new Response("Internal Server Error", { status: 500 });
		expect(
			searchAnySearch({
				...makeParams("test"),
				fetch: fetchMock,
			}),
		).rejects.toThrow("AnySearch API error (500)");
	});

	it("throws SearchProviderError when JSON-RPC parse fails", async () => {
		const fetchMock = async () => new Response("invalid sse data", { status: 200 });
		expect(
			searchAnySearch({
				...makeParams("test"),
				fetch: fetchMock,
			}),
		).rejects.toThrow("Failed to parse AnySearch MCP response");
	});

	it("throws SearchProviderError when JSON-RPC returns error", async () => {
		const payload = {
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32603, message: "Internal tool call error" },
		};
		const fetchMock = async () => new Response(JSON.stringify(payload), { status: 200 });
		expect(
			searchAnySearch({
				...makeParams("test"),
				fetch: fetchMock,
			}),
		).rejects.toThrow("AnySearch MCP error (-32603): Internal tool call error");
	});

	it("throws SearchProviderError when tool result isError is true", async () => {
		const payload = {
			jsonrpc: "2.0",
			id: 1,
			result: {
				isError: true,
				content: [{ type: "text", text: "Database connection failed" }],
			},
		};
		const fetchMock = async () => new Response(JSON.stringify(payload), { status: 200 });
		expect(
			searchAnySearch({
				...makeParams("test"),
				fetch: fetchMock,
			}),
		).rejects.toThrow("Database connection failed");
	});

	it("throws SearchProviderError when tool result contains no text", async () => {
		const payload = {
			jsonrpc: "2.0",
			id: 1,
			result: {
				content: [],
			},
		};
		const fetchMock = async () => new Response(JSON.stringify(payload), { status: 200 });
		expect(
			searchAnySearch({
				...makeParams("test"),
				fetch: fetchMock,
			}),
		).rejects.toThrow("AnySearch returned no text content");
	});
});
