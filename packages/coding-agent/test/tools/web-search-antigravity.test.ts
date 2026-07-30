import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { getAntigravityUserAgent } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { searchAntigravity } from "@oh-my-pi/pi-coding-agent/web/search/providers/antigravity";
import { searchGemini } from "@oh-my-pi/pi-coding-agent/web/search/providers/gemini";
import { SEARCH_PROVIDER_OPTIONS } from "@oh-my-pi/pi-coding-agent/web/search/types";
import fixture from "../fixtures/antigravity-search-generate-content.json" with { type: "json" };

const originalModel = Bun.env.ANTIGRAVITY_SEARCH_MODEL;

type CapturedRequest = { url: string; headers: Headers; body: Record<string, unknown> };

function oauthStorage(availableProviders: readonly string[], requested: string[]): AuthStorage {
	return {
		async getOAuthAccess(provider: string) {
			requested.push(provider);
			return availableProviders.includes(provider)
				? { accessToken: "antigravity-token", projectId: "project-id" }
				: undefined;
		},
		hasOAuth(provider: string) {
			return availableProviders.includes(provider);
		},
	} as AuthStorage;
}

function capture(response: Response, captured: CapturedRequest[]): FetchImpl {
	return (url, init) => {
		captured.push({
			url: String(url),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		});
		return Promise.resolve(response);
	};
}

afterEach(() => {
	if (originalModel === undefined) delete Bun.env.ANTIGRAVITY_SEARCH_MODEL;
	else Bun.env.ANTIGRAVITY_SEARCH_MODEL = originalModel;
});

describe("Antigravity web search", () => {
	it("is independently selectable with its own model setting", () => {
		expect(SEARCH_PROVIDER_OPTIONS.some(option => option.value === "antigravity")).toBe(true);
		expect(SETTINGS_SCHEMA["providers.webSearchAntigravityModel"]?.default).toBeUndefined();
	});

	it("uses the captured daily generateContent envelope and preserves grounded citations", async () => {
		const requests: CapturedRequest[] = [];
		const response = await searchAntigravity({
			query: "captured query",
			systemPrompt: "test instruction",
			authStorage: oauthStorage(["google-antigravity"], []),
			fetch: capture(new Response(JSON.stringify(fixture.response), { status: 200 }), requests),
		});

		const request = requests[0];
		expect(request?.url).toBe(fixture.request.url);
		expect(request?.headers.get("authorization")).toBe("Bearer antigravity-token");
		expect(request?.headers.get("content-type")).toBe(fixture.request.headers["content-type"]);
		expect(request?.headers.get("accept-encoding")).toBe(fixture.request.headers["accept-encoding"]);
		expect(request?.headers.get("user-agent")).toBe(getAntigravityUserAgent());
		expect(Object.keys(request?.body ?? {}).sort()).toEqual([
			"model",
			"project",
			"request",
			"requestType",
			"userAgent",
		]);
		const nestedRequest = request?.body.request;
		if (!nestedRequest || typeof nestedRequest !== "object")
			throw new Error("captured Antigravity request is missing its nested request");
		expect(Object.keys(nestedRequest).sort()).toEqual(["contents", "generationConfig", "systemInstruction", "tools"]);
		expect(request?.body).toMatchObject({
			model: "gemini-3.6-flash-low",
			project: "project-id",
			requestType: "agent",
			userAgent: "antigravity",
			request: {
				systemInstruction: { role: "user" },
				contents: [{ role: "user", parts: [{ text: "captured query" }] }],
				generationConfig: { candidateCount: 1 },
				tools: [{ googleSearch: { enhancedContent: { imageSearch: { maxResultCount: 5 } } } }],
			},
		});
		expect(request?.body).not.toHaveProperty("request.generationConfig.thinkingConfig");
		expect(response).toMatchObject({
			answer: "Grounded answer.",
			sources: [{ title: "Source title", url: "https://example.test/source" }],
			citations: [{ citedText: "Grounded answer.", title: "Source title", url: "https://example.test/source" }],
			searchQueries: ["<redacted>"],
		});
	});

	it("forwards generation controls", async () => {
		const requests: CapturedRequest[] = [];
		await searchAntigravity({
			query: "captured query",
			maxOutputTokens: 1234,
			temperature: 0.25,
			authStorage: oauthStorage(["google-antigravity"], []),
			fetch: capture(new Response(JSON.stringify(fixture.response), { status: 200 }), requests),
		});

		expect(requests[0]?.body).toMatchObject({
			request: { generationConfig: { candidateCount: 1, maxOutputTokens: 1234, temperature: 0.25 } },
		});
	});

	it("keeps Antigravity and Gemini OAuth credential selection isolated", async () => {
		const antigravityRequested: string[] = [];
		await searchAntigravity({
			query: "q",
			authStorage: oauthStorage(["google-antigravity"], antigravityRequested),
			fetch: capture(new Response(JSON.stringify(fixture.response), { status: 200 }), []),
		});
		expect(antigravityRequested).toEqual(["google-antigravity"]);

		const geminiRequested: string[] = [];
		await searchGemini({
			query: "q",
			authStorage: oauthStorage(["google-gemini-cli"], geminiRequested),
			fetch: capture(
				new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', { status: 200 }),
				[],
			),
		});
		expect(geminiRequested).toEqual(["google-gemini-cli"]);
	});

	it("uses only its own setting and environment model precedence", async () => {
		const requests: CapturedRequest[] = [];
		await searchAntigravity({
			query: "q",
			antigravityModel: "setting-model",
			authStorage: oauthStorage(["google-antigravity"], []),
			fetch: capture(new Response(JSON.stringify(fixture.response), { status: 200 }), requests),
		});
		expect(requests[0]?.body.model).toBe("setting-model");

		Bun.env.ANTIGRAVITY_SEARCH_MODEL = "env-model";
		await searchAntigravity({
			query: "q",
			antigravityModel: "setting-model",
			authStorage: oauthStorage(["google-antigravity"], []),
			fetch: capture(new Response(JSON.stringify(fixture.response), { status: 200 }), requests),
		});
		expect(requests[1]?.body.model).toBe("env-model");
	});

	it("decodes gzip JSON when the fetch implementation leaves the response compressed", async () => {
		const compressed = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(fixture.response)));
		const response = await searchAntigravity({
			query: "q",
			authStorage: oauthStorage(["google-antigravity"], []),
			fetch: capture(new Response(compressed, { status: 200, headers: { "content-encoding": "gzip" } }), []),
		});
		expect(response.answer).toBe("Grounded answer.");
	});

	for (const [name, payload, message] of [
		["empty", {}, "empty response"],
		["non-grounded", { candidates: [{ content: { parts: [{ text: "answer" }] } }] }, "no Google Search grounding"],
		["provider error", { error: { message: "backend error" } }, "backend error"],
		[
			"overflow",
			{
				candidates: [
					{ finishReason: "MAX_TOKENS", groundingMetadata: fixture.response.candidates[0].groundingMetadata },
				],
			},
			"overflowed",
		],
	] as const) {
		it(`rejects ${name} responses without fabricating citations`, async () => {
			await expect(
				searchAntigravity({
					query: "q",
					authStorage: oauthStorage(["google-antigravity"], []),
					fetch: capture(new Response(JSON.stringify(payload), { status: 200 }), []),
				}),
			).rejects.toThrow(message);
		});
	}

	it("never tries sandbox when the daily endpoint fails", async () => {
		const urls: string[] = [];
		await expect(
			searchAntigravity({
				query: "q",
				authStorage: oauthStorage(["google-antigravity"], []),
				fetch: url => {
					urls.push(String(url));
					return Promise.resolve(
						new Response("daily unavailable", { status: 503, headers: { "retry-after": "3600" } }),
					);
				},
			}),
		).rejects.toThrow("503");
		expect(urls).toHaveLength(1);
		expect(urls.every(url => url === fixture.request.url)).toBe(true);
	});

	it("propagates caller cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			searchAntigravity({
				query: "q",
				signal: controller.signal,
				authStorage: oauthStorage(["google-antigravity"], []),
				fetch: () => Promise.reject(new DOMException("Aborted", "AbortError")),
			}),
		).rejects.toThrow();
	});
});
