import { afterEach, describe, expect, it } from "bun:test";
import { type AuthStorage, Effort } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { GeminiProvider, searchGemini } from "@oh-my-pi/pi-coding-agent/web/search/providers/gemini";

const SSE_RESPONSE =
	'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini answer"}]}}],"modelVersion":"gemini-2.5-flash"}}\n\n';
const DEVELOPER_SSE_RESPONSE =
	'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Developer answer"}]},"groundingMetadata":{"webSearchQueries":["latest Bun version"],"groundingChunks":[{"web":{"uri":"https://bun.sh","title":"Bun"}}],"groundingSupports":[{"segment":{"text":"Developer answer"},"groundingChunkIndices":[0]}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7},"modelVersion":"gemini-2.5-flash"}\n\n';
const DEVELOPER_SSE_RESPONSE_WITHOUT_MODEL =
	'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Developer answer"}]},"groundingMetadata":{"webSearchQueries":["latest Bun version"],"groundingChunks":[{"web":{"uri":"https://bun.sh","title":"Bun"}}],"groundingSupports":[{"segment":{"text":"Developer answer"},"groundingChunkIndices":[0]}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7}}\n\n';
const ORIGINAL_GEMINI_SEARCH_MODEL = Bun.env.GEMINI_SEARCH_MODEL;
const ORIGINAL_GEMINI_SEARCH_EFFORT = Bun.env.GEMINI_SEARCH_EFFORT;

const GEMINI_CLI_FLASH_MODEL = buildModel({
	id: "gemini-3.5-flash",
	requestModelId: "gemini-3.5-flash-extra-low",
	name: "Gemini 3.5 Flash",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://cloudcode-pa.googleapis.com",
	reasoning: true,
	thinking: {
		mode: "google-level",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		effortRouting: {
			off: "gemini-3.5-flash-extra-low",
			[Effort.Minimal]: "gemini-3-flash-agent",
			[Effort.Low]: "gemini-3.5-flash-extra-low",
			[Effort.Medium]: "gemini-3.5-flash-extra-low",
			[Effort.High]: "gemini-3.5-flash-low",
		},
		suppressWhenOff: true,
	},
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
} satisfies ModelSpec<"google-gemini-cli">);

const GEMINI_CLI_MODEL_REGISTRY = {
	find(provider: string, modelId: string) {
		return provider === "google-gemini-cli" && modelId === GEMINI_CLI_FLASH_MODEL.id
			? GEMINI_CLI_FLASH_MODEL
			: undefined;
	},
} as unknown as ModelRegistry;

type CapturedRequest = {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | null;
};

describe("searchGemini tools serialization", () => {
	let capturedRequest: CapturedRequest | null = null;

	const fakeAuthStorage = {
		async getOAuthAccess() {
			return {
				accessToken: "test-access-token",
				projectId: "test-project",
			};
		},
		hasOAuth() {
			return true;
		},
	} as unknown as AuthStorage;

	const antigravityAuthStorage = {
		async getOAuthAccess(provider: string) {
			if (provider !== "google-antigravity") return undefined;
			return {
				accessToken: "test-antigravity-access-token",
				projectId: "test-antigravity-project",
			};
		},
		hasOAuth(provider: string) {
			return provider === "google-antigravity";
		},
	} as unknown as AuthStorage;

	const apiKeyAuthStorage = {
		async getOAuthAccess() {
			return undefined;
		},
		hasOAuth() {
			return false;
		},
		hasAuth(provider: string) {
			return provider === "google";
		},
		async getApiKey(provider: string) {
			return provider === "google" ? "test-gemini-api-key" : undefined;
		},
	} as unknown as AuthStorage;

	function mockGeminiFetch(responseText = SSE_RESPONSE): FetchImpl {
		capturedRequest = null;
		return (url, init) => {
			const headers = new Headers(init?.headers);
			capturedRequest = {
				url: String(url),
				headers: Object.fromEntries(headers.entries()),
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};
			return Promise.resolve(
				new Response(responseText, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};
	}

	afterEach(() => {
		capturedRequest = null;
		if (ORIGINAL_GEMINI_SEARCH_MODEL === undefined) {
			delete Bun.env.GEMINI_SEARCH_MODEL;
		} else {
			Bun.env.GEMINI_SEARCH_MODEL = ORIGINAL_GEMINI_SEARCH_MODEL;
		}
		if (ORIGINAL_GEMINI_SEARCH_EFFORT === undefined) {
			delete Bun.env.GEMINI_SEARCH_EFFORT;
		} else {
			Bun.env.GEMINI_SEARCH_EFFORT = ORIGINAL_GEMINI_SEARCH_EFFORT;
		}
	});

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Gemini test prompt",
		} as const;
	}

	it("treats a standard Google developer API key as available", () => {
		const provider = new GeminiProvider();
		expect(provider.isAvailable(apiKeyAuthStorage)).toBe(true);
	});

	it("routes API key auth through the developer API with Google Search grounding", async () => {
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE);
		const response = await searchGemini({
			...makeParams("developer api"),
			authStorage: apiKeyAuthStorage,
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
		expect(capturedRequest?.headers["x-goog-api-key"]).toBe("test-gemini-api-key");
		expect(capturedRequest?.body).toMatchObject({
			tools: [{ googleSearch: {} }],
		});
		expect(response).toMatchObject({
			answer: "Developer answer",
			sources: [{ title: "Bun", url: "https://bun.sh" }],
			searchQueries: ["latest Bun version"],
			usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
		});
	});

	it("uses configured developer API model and reports it when modelVersion is absent", async () => {
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE_WITHOUT_MODEL);
		const response = await searchGemini({
			...makeParams("developer api configured"),
			authStorage: apiKeyAuthStorage,
			geminiModel: "gemini-3.5-flash",
			fetch: fetchMock,
		});

		expect(capturedRequest?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
		);
		expect(response.model).toBe("gemini-3.5-flash");
		expect(capturedRequest?.body).not.toHaveProperty("generationConfig");
	});

	it("uses configured OAuth model in the Cloud Code request body", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("oauth configured"),
			geminiModel: "gemini-3.5-flash",
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-3.5-flash",
		});
	});

	it("routes an Antigravity logical model without exposing its request model id", async () => {
		const fetchMock = mockGeminiFetch();
		const response = await searchGemini({
			...makeParams("antigravity configured"),
			authStorage: antigravityAuthStorage,
			geminiModel: "gemini-3.1-pro",
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-3.1-pro-low",
		});
		expect(capturedRequest?.body?.request).not.toHaveProperty("generationConfig");
		expect(response.model).toBe("gemini-3.1-pro");
	});

	it("uses Antigravity's verified budget route for explicit Flash effort", async () => {
		const fetchMock = mockGeminiFetch();
		const response = await searchGemini({
			...makeParams("antigravity medium"),
			authStorage: antigravityAuthStorage,
			geminiModel: "gemini-3.5-flash",
			geminiEffort: "medium",
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-3.5-flash-low",
			request: {
				generationConfig: {
					thinkingConfig: {
						includeThoughts: false,
						thinkingBudget: 4000,
					},
				},
			},
		});
		expect(response.model).toBe("gemini-3.5-flash");
	});

	it("uses Gemini CLI's level route for explicit Flash effort", async () => {
		const fetchMock = mockGeminiFetch();
		const response = await searchGemini({
			...makeParams("gemini cli medium"),
			geminiModel: "gemini-3.5-flash",
			geminiEffort: "medium",
			modelRegistry: GEMINI_CLI_MODEL_REGISTRY,
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-3.5-flash-extra-low",
			request: {
				generationConfig: {
					thinkingConfig: {
						includeThoughts: false,
						thinkingLevel: "MEDIUM",
					},
				},
			},
		});
		expect(response.model).toBe("gemini-3.5-flash");
	});

	it("uses Developer API thinking levels without changing the public model id", async () => {
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE_WITHOUT_MODEL);
		const response = await searchGemini({
			...makeParams("developer medium"),
			authStorage: apiKeyAuthStorage,
			geminiModel: "gemini-3.5-flash",
			geminiEffort: "medium",
			fetch: fetchMock,
		});

		expect(capturedRequest?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
		);
		expect(capturedRequest?.body).toMatchObject({
			generationConfig: {
				thinkingConfig: {
					includeThoughts: false,
					thinkingLevel: "MEDIUM",
				},
			},
		});
		expect(response.model).toBe("gemini-3.5-flash");
	});

	it("rejects unsupported effort before sending the request", async () => {
		const fetchMock = mockGeminiFetch();
		await expect(
			searchGemini({
				...makeParams("antigravity unsupported"),
				authStorage: antigravityAuthStorage,
				geminiModel: "gemini-3.1-pro",
				geminiEffort: "medium",
				fetch: fetchMock,
			}),
		).rejects.toThrow(
			"Thinking effort medium is not supported by google-antigravity/gemini-3.1-pro. Supported efforts: low, high",
		);
		expect(capturedRequest).toBeNull();
	});

	it("lets GEMINI_SEARCH_EFFORT override configured Gemini effort", async () => {
		Bun.env.GEMINI_SEARCH_EFFORT = "high";
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("env effort"),
			authStorage: antigravityAuthStorage,
			geminiModel: "gemini-3.5-flash",
			geminiEffort: "low",
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-3-flash-agent",
			request: {
				generationConfig: {
					thinkingConfig: {
						includeThoughts: false,
						thinkingBudget: 10000,
					},
				},
			},
		});
	});

	it("preserves an explicitly configured Antigravity request model id", async () => {
		const fetchMock = mockGeminiFetch(SSE_RESPONSE.replace("gemini-2.5-flash", "gemini-3.1-pro-low"));
		const response = await searchGemini({
			...makeParams("antigravity wire configured"),
			authStorage: antigravityAuthStorage,
			geminiModel: "gemini-3.1-pro-low",
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-3.1-pro-low",
		});
		expect(response.model).toBe("gemini-3.1-pro-low");
	});

	it("rejects explicit effort for a raw request model id before dispatch", async () => {
		const fetchMock = mockGeminiFetch();
		await expect(
			searchGemini({
				...makeParams("antigravity raw effort"),
				authStorage: antigravityAuthStorage,
				geminiModel: "gemini-3.1-pro-low",
				geminiEffort: "high",
				fetch: fetchMock,
			}),
		).rejects.toThrow('Cannot set Gemini web-search effort "high" for google-antigravity/gemini-3.1-pro-low.');
		expect(capturedRequest).toBeNull();
	});

	it("rejects explicit effort for an unknown model before dispatch", async () => {
		const fetchMock = mockGeminiFetch();
		await expect(
			searchGemini({
				...makeParams("antigravity unknown effort"),
				authStorage: antigravityAuthStorage,
				geminiModel: "gemini-4-flash-preview",
				geminiEffort: "high",
				fetch: fetchMock,
			}),
		).rejects.toThrow('Cannot set Gemini web-search effort "high" for google-antigravity/gemini-4-flash-preview.');
		expect(capturedRequest).toBeNull();
	});

	it("lets GEMINI_SEARCH_MODEL override the configured Gemini model", async () => {
		Bun.env.GEMINI_SEARCH_MODEL = "gemini-2.5-pro";
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("env configured"),
			geminiModel: "gemini-3.5-flash",
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-2.5-pro",
		});
	});
	it("sends default googleSearch tool when no passthrough payloads are provided", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({ ...makeParams("default tools"), fetch: fetchMock });

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }],
		});
		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-2.5-flash",
		});
	});

	it("passes through googleSearch payload into googleSearch tool", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("google payload"),
			google_search: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } },
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } } }],
		});
	});

	it("includes codeExecution and urlContext tools when provided", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("extended tools"),
			code_execution: {},
			url_context: { allowedDomains: ["example.com"] },
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }, { codeExecution: {} }, { urlContext: { allowedDomains: ["example.com"] } }],
		});
	});
});
