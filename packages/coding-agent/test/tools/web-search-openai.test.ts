import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchOpenAI } from "@oh-my-pi/pi-coding-agent/web/search/providers/openai";

type CapturedRequest = {
	url: string;
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
};

const model = {
	provider: "pindo",
	id: "pindo-search-model",
	requestModelId: "pindo-wire-model",
	api: "openai-responses",
	baseUrl: "https://proxy.example/v1",
	headers: {
		"X-Model-Header": "model-value",
		Authorization: "Bearer model-header-must-not-win",
		"chatgpt-account-id": "acct-must-not-leak",
	},
} as unknown as Model<"openai-responses">;

function makeSseResponse(): string {
	const answer = "Pindo found the hosted result.";
	const citationStart = answer.indexOf("hosted result");
	return [
		`data: ${JSON.stringify({ type: "response.web_search_call.completed", item_id: "ws_pindo" })}`,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "web_search_call",
				action: { sources: [{ url: "https://example.com/pindo?utm_source=openai", title: "Pindo source" }] },
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: answer,
						annotations: [
							{
								type: "url_citation",
								url: "https://example.com/pindo?utm_source=openai",
								title: "Pindo source",
								start_index: citationStart,
								end_index: citationStart + "hosted result".length,
							},
						],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_pindo",
				model: "pindo-wire-model",
				usage: { input_tokens: 11, output_tokens: 8, total_tokens: 19 },
			},
		})}`,
		"",
	].join("\n");
}

describe("searchOpenAI Hosted Responses transport", () => {
	let capturedRequest: CapturedRequest | null = null;

	const authStorage = {
		resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }) {
			expect(provider).toBe("pindo");
			expect(options).toEqual({
				sessionId: "pindo-search-session",
				baseUrl: "https://proxy.example/v1",
				modelId: "pindo-search-model",
			});
			return async () => "pindo-api-key";
		},
	} as unknown as AuthStorage;
	const modelRegistry = {
		find(provider: string, modelId: string) {
			expect(provider).toBe("pindo");
			expect(modelId).toBe("pindo-search-model");
			return model;
		},
		getProviderHeaders(provider: string) {
			expect(provider).toBe("pindo");
			return {
				Authorization: "Bearer provider-header-must-not-win",
				Accept: "application/json",
				"Content-Type": "text/plain",
				"X-Provider-Header": "provider-value",
			};
		},
		resolver() {
			return async () => "registry-api-key";
		},
	} as unknown as ModelRegistry;

	function makeSearchParams(fetch: FetchImpl): SearchParams {
		return {
			query: "latest Pindo web search",
			systemPrompt: "Answer with sources.",
			authStorage,
			modelRegistry,
			sessionId: "pindo-search-session",
			openaiProvider: "pindo",
			openaiModel: "pindo-search-model",
			fetch,
		};
	}

	it("uses standard /responses, provider API key, Hosted tool, and shared SSE parsing", async () => {
		const fetchMock: FetchImpl = (url, init) => {
			capturedRequest = {
				url: typeof url === "string" ? url : url.toString(),
				headers: init?.headers,
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};
			return Promise.resolve(
				new Response(makeSseResponse(), {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};

		const result = await searchOpenAI(makeSearchParams(fetchMock));

		expect(capturedRequest?.url).toBe("https://proxy.example/v1/responses");
		expect(capturedRequest?.url).not.toContain("/codex/responses");
		const headers = new Headers(capturedRequest?.headers);
		expect(headers.get("authorization")).toBe("Bearer pindo-api-key");
		expect(headers.get("accept")).toBe("text/event-stream");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("x-provider-header")).toBe("provider-value");
		expect(headers.get("x-model-header")).toBe("model-value");
		expect(headers.has("chatgpt-account-id")).toBe(false);
		expect(capturedRequest?.body).toEqual(
			expect.objectContaining({
				model: "pindo-wire-model",
				stream: true,
				tools: [{ type: "web_search", search_context_size: "high" }],
				tool_choice: { type: "web_search" },
			}),
		);
		expect(result).toMatchObject({
			provider: "openai",
			answer: "Pindo found the hosted result.",
			model: "pindo-wire-model",
			requestId: "resp_pindo",
			usage: { inputTokens: 11, outputTokens: 8, totalTokens: 19 },
		});
		expect(result.sources).toEqual([
			{ title: "Pindo source", url: "https://example.com/pindo", snippet: "Pindo found the hosted result." },
		]);
		expect(result.citations).toEqual([
			{ title: "Pindo source", url: "https://example.com/pindo", citedText: "Pindo found the hosted result." },
		]);
	});

	it("rejects a selected model that is not an openai-responses model", async () => {
		const invalidRegistry = {
			...modelRegistry,
			find() {
				return { ...model, api: "openai-completions" };
			},
		} as unknown as ModelRegistry;
		await expect(
			searchOpenAI({
				...makeSearchParams(() => Promise.reject(new Error("fetch must not run"))),
				modelRegistry: invalidRegistry,
			}),
		).rejects.toThrow("requires api: openai-responses");
	});
});
