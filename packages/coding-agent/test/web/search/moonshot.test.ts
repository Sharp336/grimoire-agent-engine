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
	it("executes the Formula fiber loop and returns normalized SearchResponse", async () => {
		const capturedRequests: CapturedRequest[] = [];
		let chatStep = 0;
		const encryptedOutput = "----MOONSHOT ENCRYPTED BEGIN----protected----MOONSHOT ENCRYPTED END----";
		const toolDeclaration = {
			type: "function",
			function: {
				name: "web_search",
				description: "Search the web for information",
				parameters: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			},
		};

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

			if (url.endsWith("/tools")) {
				return Promise.resolve(Response.json({ object: "list", tools: [toolDeclaration] }));
			}
			if (url.endsWith("/fibers")) {
				return Promise.resolve(
					Response.json({
						status: "succeeded",
						context: { encrypted_output: encryptedOutput },
					}),
				);
			}

			chatStep++;
			if (chatStep === 1) {
				return Promise.resolve(
					Response.json({
						id: "chatcmpl-step1",
						model: "kimi-k3",
						choices: [
							{
								index: 0,
								finish_reason: "tool_calls",
								message: {
									role: "assistant",
									content: "",
									reasoning_content: "Thinking about searching Moonshot caching...",
									tool_calls: [
										{
											id: "call_search_1",
											type: "function",
											function: {
												name: "web_search",
												arguments: JSON.stringify({ query: "Moonshot AI Context Caching" }),
											},
										},
									],
								},
							},
						],
						usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
					}),
				);
			}

			return Promise.resolve(
				Response.json({
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
			temperature: 0,
		});

		expect(capturedRequests.map(request => `${request.method} ${request.url}`)).toEqual([
			"GET https://api.moonshot.ai/v1/formulas/moonshot/web-search:latest/tools",
			"POST https://api.moonshot.ai/v1/chat/completions",
			"POST https://api.moonshot.ai/v1/formulas/moonshot/web-search:latest/fibers",
			"POST https://api.moonshot.ai/v1/chat/completions",
		]);
		expect(capturedRequests[0]?.headers.get("Authorization")).toBe("Bearer sk-moonshot-test-key");
		expect(capturedRequests[1]?.body.model).toBe("kimi-k3");
		expect(capturedRequests[1]?.body.tools).toEqual([toolDeclaration]);
		expect(capturedRequests[1]?.body.reasoning_effort).toBe("low");
		expect(capturedRequests[1]?.body.temperature).toBeUndefined();
		expect(capturedRequests[2]?.body).toEqual({
			name: "web_search",
			arguments: JSON.stringify({ query: "Moonshot AI Context Caching" }),
		});

		const step2Messages = capturedRequests[3]?.body.messages as Array<Record<string, unknown>>;
		expect(step2Messages).toHaveLength(4);
		expect(step2Messages[2]?.reasoning_content).toBe("Thinking about searching Moonshot caching...");
		expect(step2Messages[2]?.tool_calls).toEqual([
			{
				id: "call_search_1",
				type: "function",
				function: {
					name: "web_search",
					arguments: JSON.stringify({ query: "Moonshot AI Context Caching" }),
				},
			},
		]);
		expect(step2Messages[3]).toEqual({
			role: "tool",
			tool_call_id: "call_search_1",
			content: encryptedOutput,
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
		expect(response.requestId).toBe("chatcmpl-step2");
	});

	it("honors MOONSHOT_BASE_URL and MOONSHOT_SEARCH_MODEL overrides", async () => {
		Bun.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1/";
		Bun.env.MOONSHOT_SEARCH_MODEL = "kimi-k2.6";

		const capturedUrls: string[] = [];
		let capturedBody: Record<string, unknown> | undefined;
		const fetchImpl: FetchImpl = (input, init) => {
			const url = typeof input === "string" ? input : input.toString();
			capturedUrls.push(url);
			if (url.endsWith("/tools")) {
				return Promise.resolve(
					Response.json({
						tools: [{ type: "function", function: { name: "web_search" } }],
					}),
				);
			}
			const bodyText = typeof init?.body === "string" ? init.body : "";
			capturedBody = JSON.parse(bodyText) as Record<string, unknown>;
			return Promise.resolve(
				Response.json({
					model: "kimi-k2.6",
					choices: [{ finish_reason: "stop", message: { content: "Done" } }],
				}),
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

		expect(capturedUrls).toEqual([
			"https://api.moonshot.cn/v1/formulas/moonshot/web-search:latest/tools",
			"https://api.moonshot.cn/v1/chat/completions",
		]);
		expect(capturedBody?.model).toBe("kimi-k2.6");
		expect(capturedBody?.reasoning_effort).toBeUndefined();
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
