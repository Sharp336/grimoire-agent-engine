import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fetchModels, login, mapCatalogEntry, pickVendor, validateKey } from "./index";

// Every test that stubs the network does so via spyOn, and this hook restores
// the original fetch afterwards — a leaked mock would poison later tests in
// the same Bun worker.
afterEach(() => {
	mock.restore();
});
/** Build a vendor entry like Gateway's GET /models schema. */
function vendor(overrides: Record<string, unknown> = {}) {
	return {
		context_window: 200_000,
		max_output_tokens: 32_000,
		availability_status: "available",
		capabilities: {
			input: ["text"],
			output: ["text", "tool_use"],
			supports_tool_calling: true,
			supports_reasoning: false,
		},
		pricing: { input_per_million: 1, output_per_million: 2 },
		...overrides,
	};
}

function entry(model: string, vendors: Record<string, unknown>, displayName?: string) {
	return { model, display_name: displayName, vendors };
}

/** A fetch that returns one page of the given data (envelope). */
function singlePage(data: unknown[], hasMore = false, cursor: string | null = null) {
	return JSON.stringify({ object: "list", data, has_more: hasMore, next_cursor: cursor });
}

/**
 * Stub globalThis.fetch for one test; restored by the afterEach above. The
 * cast trims Bun's preconnect extension — the Gateway client only ever calls
 * fetch(url, init).
 */
function stubFetch(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	return spyOn(globalThis, "fetch").mockImplementation(impl as unknown as typeof fetch);
}

describe("pickVendor", () => {
	test("prefers the owner vendor when available", () => {
		const picked = pickVendor(
			entry("anthropic/claude-opus", {
				anthropic: vendor(),
				bedrock: vendor({ pricing: { input_per_million: 99, output_per_million: 99 } }),
			}) as never,
		);
		expect(picked!.id).toBe("anthropic");
		expect(picked!.vendor.pricing!.input_per_million).toBe(1);
	});

	test("falls back to another available vendor", () => {
		const picked = pickVendor(entry("anthropic/claude-bedrock", { bedrock: vendor() }) as never);
		expect(picked!.id).toBe("bedrock");
	});
});

describe("mapCatalogEntry", () => {
	test("keeps a tool-calling text model and maps fields", () => {
		const mapped = mapCatalogEntry(
			entry("openai/gpt-5.2", {
				openai: vendor({
					capabilities: {
						input: ["text", "image"],
						output: ["text", "tool_use"],
						supports_tool_calling: true,
						supports_reasoning: true,
					},
				}),
			}) as never,
		);
		expect(mapped).not.toBeNull();
		expect(mapped!.id).toBe("openai/gpt-5.2");
		expect(mapped!.reasoning).toBe(true);
		expect(mapped!.input).toEqual(["text", "image"]);
		expect(mapped!.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
	});

	test("drops a model whose vendor lacks tool calling (embeddings)", () => {
		const mapped = mapCatalogEntry(
			entry("openai/text-embedding", {
				openai: vendor({ capabilities: { input: ["text"], output: ["text"], supports_tool_calling: false } }),
			}) as never,
		);
		expect(mapped).toBeNull();
	});

	test("drops a model whose output excludes text (image generation)", () => {
		const mapped = mapCatalogEntry(
			entry("openai/dall-e", {
				openai: vendor({ capabilities: { input: ["text"], output: ["image"], supports_tool_calling: true } }),
			}) as never,
		);
		expect(mapped).toBeNull();
	});

	test("pins first-party anthropic routes to the Anthropic wire", () => {
		const mapped = mapCatalogEntry(entry("anthropic/claude", { anthropic: vendor() }) as never);
		expect(mapped!.api).toBe("anthropic-messages");
		expect(mapped!.baseUrl).toBe("https://api-gateway.merge.dev");
		expect(mapped!.compat).toBeUndefined();
	});

	test("serves bedrock-backed anthropic models over the OpenAI wire", () => {
		const mapped = mapCatalogEntry(entry("anthropic/claude-bedrock", { bedrock: vendor() }) as never);
		expect(mapped).not.toBeNull();
		expect(mapped!.api).toBeUndefined();
		expect(mapped!.baseUrl).toBe("https://api-gateway.merge.dev/v1/openai");
		expect(mapped!.compat).toEqual({ supportsReasoningEffort: false });
	});
});

describe("fetchModels", () => {
	test("returns no discovery when unauthenticated", async () => {
		stubFetch(async () => {
			throw new Error("should not fetch without a key");
		});
		expect(await fetchModels(undefined)).toBeNull();
	});

	test("pages through the catalog and maps wire overrides", async () => {
		const calls: string[] = [];
		const fetchMock = stubFetch(async input => {
			const url = String(input);
			calls.push(url);
			if (url.includes("cursor=next")) {
				return new Response(singlePage([entry("google/gemini", { google: vendor() })]), { status: 200 });
			}
			return new Response(
				singlePage(
					[
						entry("openai/gpt-5.2", { openai: vendor() }),
						entry("anthropic/claude", { anthropic: vendor() }),
						entry("openai/text-embedding", {
							openai: vendor({
								capabilities: { input: ["text"], output: ["text"], supports_tool_calling: false },
							}),
						}),
					],
					true,
					"next",
				),
				{ status: 200 },
			);
		});

		const result = await fetchModels("mg_key");
		if (!result) throw new Error("expected discovery to return models");
		expect(calls[0]).toContain("limit=500");
		expect(calls[1]).toContain("cursor=next");
		expect(result.map(m => m.id)).toEqual(["openai/gpt-5.2", "anthropic/claude", "google/gemini"]);
		// Wire overrides survive the round trip.
		const claude = result.find(m => m.id === "anthropic/claude")!;
		expect(claude.api).toBe("anthropic-messages");
		expect(claude.baseUrl).toBe("https://api-gateway.merge.dev");
		// Bearer header sent
		const init = fetchMock.mock.calls[0][1];
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer mg_key");
	});

	test("surfaces SDK-typed rate limit errors", async () => {
		stubFetch(async () => new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 }));
		await expect(fetchModels("mg_key")).rejects.toThrow(
			/Merge Gateway model discovery failed: RateLimitError: quota exceeded/,
		);
	});

	test("reports uncapped pagination through the warn sink", async () => {
		let page = 0;
		stubFetch(async () => {
			page++;
			return new Response(singlePage([entry(`openai/m${page}`, { openai: vendor() })], true, `c${page}`), {
				status: 200,
			});
		});

		const warnings: string[] = [];
		const result = await fetchModels("mg_key", m => warnings.push(m));
		expect(warnings.some(w => w.includes("exceeded 20 pages"))).toBe(true);
		expect(result).toHaveLength(20);
	});
});

describe("validateKey / login", () => {
	test("rejects 401 with the gateway-specific message", async () => {
		stubFetch(async () => new Response("Unauthorized", { status: 401 }));
		await expect(validateKey("  mg_bad  ")).rejects.toThrow("Invalid Merge Gateway API key");
	});

	test("maps budget exhaustion to a distinct message", async () => {
		stubFetch(async () => new Response("{}", { status: 402 }));
		await expect(validateKey("mg_key")).rejects.toThrow(/budget exhausted \(HTTP 402\)/);
	});

	test("honors the injected fetch seam and trims the pasted key", async () => {
		const seen: string[] = [];
		const seam = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			seen.push(String(input));
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer mg_good");
			return new Response(singlePage([]), { status: 200 });
		};
		const key = await login({
			onAuth: () => {},
			onPrompt: async () => "  mg_good  ",
			fetch: seam,
		});
		expect(key).toBe("mg_good");
		expect(seen[0]).toContain("/models?limit=1");
	});

	test("aborts an in-flight probe when the login flow is cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		stubFetch(async () => new Response("", { status: 599 }));
		// Node/bun abort semantics: fetch rejects once the signal is already aborted.
		await expect(
			login({ onAuth: () => {}, onPrompt: async () => "mg_key", signal: controller.signal }),
		).rejects.toThrow();
	});

	test("times out a stalled probe with a clear message", async () => {
		stubFetch(
			async (_input, init): Promise<Response> =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
				}),
		);
		await expect(validateKey("mg_key")).rejects.toThrow(/timed out after 15s/);
	}, 20_000);

	test("rejects an empty paste before any network call", async () => {
		await expect(login({ onPrompt: async () => "   " } as never)).rejects.toThrow("No API key provided");
	});
});
