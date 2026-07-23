import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { MoonshotProvider, searchMoonshot } from "@oh-my-pi/pi-coding-agent/web/search/providers/moonshot";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

interface CapturedRequest {
	url: string;
	method: string;
	headers: Headers;
	body: Record<string, unknown>;
}

const ORIGINAL_MOONSHOT_BASE_URL = Bun.env.MOONSHOT_BASE_URL;
const ORIGINAL_MOONSHOT_SEARCH_MODEL = Bun.env.MOONSHOT_SEARCH_MODEL;
const ORIGINAL_MOONSHOT_API_KEY = Bun.env.MOONSHOT_API_KEY;

afterEach(() => {
	if (ORIGINAL_MOONSHOT_BASE_URL === undefined) {
		delete Bun.env.MOONSHOT_BASE_URL;
	} else {
		Bun.env.MOONSHOT_BASE_URL = ORIGINAL_MOONSHOT_BASE_URL;
	}

	if (ORIGINAL_MOONSHOT_SEARCH_MODEL === undefined) {
		delete Bun.env.MOONSHOT_SEARCH_MODEL;
	} else {
		Bun.env.MOONSHOT_SEARCH_MODEL = ORIGINAL_MOONSHOT_SEARCH_MODEL;
	}

	if (ORIGINAL_MOONSHOT_API_KEY === undefined) {
		delete Bun.env.MOONSHOT_API_KEY;
	} else {
		Bun.env.MOONSHOT_API_KEY = ORIGINAL_MOONSHOT_API_KEY;
	}
});

describe("Moonshot web search provider", () => {
	it("executes the $web_search built-in tool loop and returns normalized SearchResponse", async () => {
		const capturedRequests: CapturedRequest[] = [];
		let stepCount = 0;

		const fetchImpl: FetchImpl = (input, init) => {
			const url = typeof input === "string" ? input : input.toString();
			const method = init?.method ?? "GET";
			const headers = new Headers(init?.headers);
			const rawBody = init?.body;
			const bodyText =
				typeof rawBody === "string"
					? rawBody
					: rawBody instanceof Uint8Array
						? new TextDecoder().decode(rawBody)
						: String(rawBody ?? "");
			const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};

			capturedRequests.push({ url, method, headers, body });
			stepCount++;

			if (stepCount === 1) {
				// Turn 1: model returns tool_calls for $web_search
				return Promise.resolve(
					new Response(
						JSON.stringify({
							id: "chatcmpl-step1",
							model: "kimi-k3",
							choices: [
								{
									index: 0,
									finish_reason: "tool_calls",
									message: {
										role: "assistant",
										reasoning_content: "Thinking about searching Moonshot caching...",
										tool_calls: [
											{
												id: "call_search_1",
												type: "function",
												function: {
													name: "$web_search",
													arguments: JSON.stringify({ query: "Moonshot AI Context Caching" }),
												},
											},
										],
									},
								},
							],
							usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			// Turn 2: model produces final answer
			return Promise.resolve(
				new Response(
					JSON.stringify({
						id: "chatcmpl-step2",
						model: "kimi-k3",
						choices: [
							{
								index: 0,
								finish_reason: "stop",
								message: {
									role: "assistant",
									content: "Moonshot AI Context Caching optimizes repeated prompt tokens.",
									annotations: [
										{
											url: "https://platform.kimi.ai/docs",
											title: "Kimi Docs",
											text: "Context caching documentation",
										},
									],
								},
							},
						],
						usage: { prompt_tokens: 120, completion_tokens: 25, total_tokens: 145 },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		};

		const authStorage = {
			getApiKey: () => Promise.resolve("sk-moonshot-test-key"),
			hasAuth: () => true,
		} as unknown as AuthStorage;

		const response = await searchMoonshot({
			query: "Tell me about Moonshot context caching",
			systemPrompt: "You are a web search helper.",
			authStorage,
			fetch: fetchImpl,
		});

		expect(capturedRequests).toHaveLength(2);
		expect(capturedRequests[0]?.url).toBe("https://api.moonshot.ai/v1/chat/completions");
		expect(capturedRequests[0]?.headers.get("Authorization")).toBe("Bearer sk-moonshot-test-key");
		expect(capturedRequests[0]?.body.model).toBe("kimi-k3");
		expect(capturedRequests[0]?.body.tools).toEqual([
			{
				type: "builtin_function",
				function: { name: "$web_search" },
			},
		]);

		// Verify turn 2 request carried assistant reasoning and tool result
		const step2Messages = capturedRequests[1]?.body.messages as Array<Record<string, unknown>>;
		expect(step2Messages).toHaveLength(4); // system, user, assistant (tool_calls), tool
		expect(step2Messages[2]?.reasoning_content).toBe("Thinking about searching Moonshot caching...");
		expect(step2Messages[3]).toEqual({
			role: "tool",
			tool_call_id: "call_search_1",
			name: "$web_search",
			content: JSON.stringify({ query: "Moonshot AI Context Caching" }),
		});

		expect(response.answer).toBe("Moonshot AI Context Caching optimizes repeated prompt tokens.");
		expect(response.model).toBe("kimi-k3");
		expect(response.searchQueries).toEqual(["Moonshot AI Context Caching"]);
		expect(response.sources).toEqual([
			{
				title: "Kimi Docs",
				url: "https://platform.kimi.ai/docs",
				snippet: "Context caching documentation",
			},
		]);
		expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 25 });
	});

	it("honors MOONSHOT_BASE_URL and MOONSHOT_SEARCH_MODEL overrides", async () => {
		Bun.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1/";
		Bun.env.MOONSHOT_SEARCH_MODEL = "kimi-k2.6";

		let capturedUrl = "";
		let capturedModel = "";

		const fetchImpl: FetchImpl = (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			const bodyText = typeof init?.body === "string" ? init.body : "";
			const body = JSON.parse(bodyText) as { model: string };
			capturedModel = body.model;

			return Promise.resolve(
				new Response(
					JSON.stringify({
						model: "kimi-k2.6",
						choices: [{ finish_reason: "stop", message: { content: "Done" } }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		};

		const authStorage = {
			getApiKey: () => Promise.resolve("sk-china-key"),
			hasAuth: () => true,
		} as unknown as AuthStorage;

		const response = await searchMoonshot({
			query: "test override",
			systemPrompt: "sys",
			authStorage,
			fetch: fetchImpl,
		});

		expect(capturedUrl).toBe("https://api.moonshot.cn/v1/chat/completions");
		expect(capturedModel).toBe("kimi-k2.6");
		expect(response.answer).toBe("Done");
	});

	it("throws 401 SearchProviderError when API key is missing", async () => {
		delete Bun.env.MOONSHOT_API_KEY;
		const authStorage = {
			getApiKey: () => Promise.resolve(undefined),
			hasAuth: () => false,
		} as unknown as AuthStorage;

		await expect(
			searchMoonshot({
				query: "test",
				systemPrompt: "sys",
				authStorage,
			}),
		).rejects.toThrow(SearchProviderError);
	});

	it("classifies HTTP 401 errors using classifyProviderHttpError", async () => {
		const fetchImpl: FetchImpl = () =>
			Promise.resolve(new Response("Unauthorized key", { status: 401, headers: { "Content-Type": "text/plain" } }));

		const authStorage = {
			getApiKey: () => Promise.resolve("invalid-key"),
			hasAuth: () => true,
		} as unknown as AuthStorage;

		try {
			await searchMoonshot({
				query: "test 401",
				systemPrompt: "sys",
				authStorage,
				fetch: fetchImpl,
			});
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SearchProviderError);
			expect((err as SearchProviderError).status).toBe(401);
			expect((err as SearchProviderError).message).toContain("401 unauthorized");
		}
	});

	it("MoonshotProvider delegates isAvailable to authStorage.hasAuth('moonshot')", () => {
		const provider = new MoonshotProvider();
		const hasAuthMock = vi.fn((prov: string) => prov === "moonshot");
		const authStorage = { hasAuth: hasAuthMock } as unknown as AuthStorage;

		expect(provider.isAvailable(authStorage)).toBe(true);
		expect(hasAuthMock).toHaveBeenCalledWith("moonshot");
	});
});
