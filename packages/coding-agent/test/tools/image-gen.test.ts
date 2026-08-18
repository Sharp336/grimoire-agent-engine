import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	getImageGenTools,
	getImageGenToolsWithRegistry,
	imageGenTool,
	setImageProviderOrder,
} from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { removeWithRetries, USER_AGENT } from "@oh-my-pi/pi-utils";

const originalOpenRouterKey = Bun.env.OPENROUTER_API_KEY;
const generatedImagePaths: string[] = [];

afterAll(async () => {
	await Promise.all(generatedImagePaths.map(imagePath => removeWithRetries(imagePath)));
});

afterEach(() => {
	if (originalOpenRouterKey === undefined) {
		delete Bun.env.OPENROUTER_API_KEY;
	} else {
		Bun.env.OPENROUTER_API_KEY = originalOpenRouterKey;
	}
	setImageProviderOrder([]);
});

function createAntigravityXAIContext(model: Model | undefined, fetchMock: typeof fetch): CustomToolContext {
	const antigravityCredentials = JSON.stringify({ token: "test-antigravity-token", projectId: "test-project" });
	return {
		fetch: fetchMock,
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "test-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry: {
			getApiKey: async () => undefined,
			getApiKeyForProvider: async (provider: string) => {
				if (provider === "google-antigravity") return antigravityCredentials;
				if (provider === "xai-oauth") return "test-xai-token";
				return undefined;
			},
			getProviderBaseUrl: () => undefined,
			getAll: () => [],
			authStorage: {
				hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
				rotateSessionCredential: async () => false,
			},
			resolver: (provider: string) => async () =>
				provider === "google-antigravity" ? antigravityCredentials : "test-xai-token",
		} as unknown as ModelRegistry,
		model,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

describe("imageGenTool", () => {
	it("registers without resolving image provider credentials", async () => {
		const modelRegistry = {
			getApiKey: async () => {
				throw new Error("active model credentials should not be resolved during registration");
			},
			getApiKeyForProvider: async () => {
				throw new Error("provider credentials should not be resolved during registration");
			},
		} as unknown as ModelRegistry;

		expect(await getImageGenTools(modelRegistry, undefined)).toEqual([imageGenTool]);
		expect(await getImageGenToolsWithRegistry(modelRegistry, undefined)).toEqual([imageGenTool]);
	});

	it("resolves image provider credentials on execution", async () => {
		setImageProviderOrder(["antigravity"]);
		const ctx: CustomToolContext = {
			fetch: async () => new Response(null),
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => undefined,
				getApiKeyForProvider: async () => {
					throw new Error("provider credentials resolved during execution");
				},
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		await expect(imageGenTool.execute("call-registration", { subject: "a cat" }, undefined, ctx)).rejects.toThrow(
			"provider credentials resolved during execution",
		);
	});

	it("e2e writes OpenAI Responses image_generation WebP output to a temp file", async () => {
		let requestUrl: string | undefined;
		let requestBody: unknown;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("fake-webp").toString("base64"),
							revised_prompt: "A crisp tabby cat portrait.",
							status: "completed",
						},
					],
					usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async () => undefined,
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => "test-openai-key",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-1", { subject: "a cat", aspect_ratio: "16:9" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.openai.com/v1/responses");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [{ type: "image_generation", output_format: "webp", size: "1536x1024", action: "generate" }],
			tool_choice: { type: "image_generation" },
			store: false,
		});
		expect(result.details?.provider).toBe("openai");
		expect(result.details?.imageCount).toBe(1);
		expect(result.details?.images[0]?.mimeType).toBe("image/webp");
		expect(result.details?.revisedPrompt).toBe("A crisp tabby cat portrait.");
		expect(result.details?.imagePaths).toHaveLength(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(savedPath.endsWith(".webp")).toBe(true);
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-webp"));
	});

	it("routes OpenAI Images edits through the Responses image tool", async () => {
		setImageProviderOrder(["openai"]);
		let requestUrl: string | undefined;
		let requestBody: Record<string, unknown> | undefined;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("edited-webp").toString("base64"),
							status: "completed",
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async (provider: string) => (provider === "openai" ? "test-openai-key" : undefined),
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => "test-openai-key",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute(
			"call-openai-edit",
			{
				subject: "a cat",
				changes: ["make the reference noir"],
				input: [{ data: Buffer.from("reference").toString("base64"), mime_type: "image/png" }],
			},
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.openai.com/v1/responses");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [{ type: "image_generation", output_format: "webp", action: "edit" }],
		});
		const input = requestBody?.input as Array<{ content?: Array<Record<string, unknown>> }> | undefined;
		const content = input?.[0]?.content ?? [];
		expect(content.some(part => part.type === "input_image")).toBe(true);
		expect(result.details?.provider).toBe("openai");
		expect(result.details?.imageCount).toBe(1);
	});

	it("routes image generation through a connected Codex (ChatGPT) subscription when the active model is not OpenAI", async () => {
		setImageProviderOrder(["openai-codex"]);
		let requestUrl: string | undefined;
		let accountHeader: string | null | undefined;
		let requestBody: Record<string, unknown> | undefined;

		// A fake Codex JWT (header.payload.signature) so getCodexAccountId can read
		// chatgpt_account_id from the base64 payload claim.
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-codex-1" } }),
		).toString("base64");
		const codexToken = `header.${payload}.signature`;

		const sse = `data: ${JSON.stringify({
			type: "response.completed",
			response: {
				output: [
					{
						type: "image_generation_call",
						result: Buffer.from("codex-webp").toString("base64"),
						revised_prompt: "A neon skyline.",
						status: "completed",
					},
				],
				usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
			},
		})}\n\n`;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			accountHeader = new Headers(init?.headers).get("chatgpt-account-id");
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;

		const codexModel = {
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5.5",
			name: "GPT-5.5",
			baseUrl: "https://chatgpt.com/backend-api",
		} as Model;
		// Active model is Claude — proves the codex subscription path is independent of it.
		const activeModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-opus-4",
			name: "Claude",
		} as Model;

		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				find: (provider: string, id: string) =>
					provider === "openai-codex" && id === "gpt-5.5" ? codexModel : undefined,
				getAll: () => [codexModel],
				getApiKey: async () => codexToken,
				getApiKeyForProvider: async (provider: string) => (provider === "openai-codex" ? codexToken : undefined),
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => codexToken,
			} as unknown as ModelRegistry,
			model: activeModel,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute(
			"call-codex",
			{ subject: "a neon skyline", aspect_ratio: "1:1" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(accountHeader).toBe("acct-codex-1");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [{ type: "image_generation", output_format: "webp", size: "1024x1024", action: "generate" }],
			stream: true,
		});
		expect(result.details?.provider).toBe("openai-codex");
		expect(result.details?.model).toBe("gpt-5.5");
		expect(result.details?.imageCount).toBe(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("codex-webp"));
	});

	it("falls back when an openai-codex API key lacks a subscription account claim", async () => {
		const antigravityCredentials = JSON.stringify({ token: "test-antigravity-token", projectId: "test-project" });
		let requestUrl: string | undefined;
		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			requestUrl = input.toString();
			return new Response(
				`data: ${JSON.stringify({
					response: {
						candidates: [
							{
								content: {
									parts: [
										{
											inlineData: {
												data: Buffer.from("fallback-image").toString("base64"),
												mimeType: "image/png",
											},
										},
									],
								},
							},
						],
					},
				})}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "plain-openai-key",
				getApiKeyForProvider: async (provider: string) => {
					if (provider === "openai-codex") return "plain-openai-key";
					if (provider === "google-antigravity") return antigravityCredentials;
					return undefined;
				},
				authStorage: { rotateSessionCredential: async () => false },
				resolver: (provider: string) => async () =>
					provider === "google-antigravity" ? antigravityCredentials : "plain-openai-key",
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-codex-key-fallback", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(result.details?.provider).toBe("antigravity");
		expect(result.details?.imageCount).toBe(1);
	});

	it("honors a per-request provider override over the providers.imageOrder setting", async () => {
		// Setting selects Codex and a Codex subscription IS connected...
		setImageProviderOrder(["openai-codex"]);
		let requestUrl: string | undefined;
		const captured: { authorization: string | null } = { authorization: null };

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			captured.authorization = new Headers(init?.headers).get("authorization");
			return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("override-xai").toString("base64") }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				// Both Codex (the setting) and xAI credentials exist; the per-request
				// `provider: "xai"` override must still win over the setting.
				getApiKeyForProvider: async (provider: string) =>
					provider === "xai-oauth" || provider === "openai-codex" ? "test-token" : undefined,
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
					rotateSessionCredential: async () => false,
				},
				resolver: () => async () => "test-xai-token",
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-override", { subject: "a cat", provider: "xai" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		// Routed to xAI (the override), NOT the Codex subscription the setting selects.
		expect(requestUrl).toBe("https://api.x.ai/v1/images/generations");
		expect(captured.authorization).toBe("Bearer test-xai-token");
		expect(result.details?.provider).toBe("xai");
	});
	it("sends Codex hosted image requests with opaque proxy bearer keys", async () => {
		let requestUrl: string | undefined;
		let requestHeaders: Headers | undefined;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestHeaders = new Headers(init?.headers);
			return new Response(
				[
					"event: response.output_item.done",
					`data: ${JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "image_generation_call",
							result: Buffer.from("fake-codex-webp").toString("base64"),
							status: "completed",
						},
					})}`,
					"",
					"event: response.completed",
					`data: ${JSON.stringify({
						type: "response.completed",
						response: { output: [], status: "completed", error: null },
					})}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;

		const model = {
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5.5-codex",
			name: "GPT Codex",
			baseUrl: "https://example-proxy.invalid/backend-api",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "opaque-proxy-key",
				getApiKeyForProvider: async () => undefined,
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => "opaque-proxy-key",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-codex-opaque", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://example-proxy.invalid/backend-api/codex/responses");
		expect(requestHeaders?.get("authorization")).toBe("Bearer opaque-proxy-key");
		expect(requestHeaders?.has("chatgpt-account-id")).toBe(false);
		expect(requestHeaders?.get("OpenAI-Beta")).toBe("responses=experimental");
		expect(requestHeaders?.get("originator")).toBe("pi");
		expect(result.details?.provider).toBe("openai-codex");
		expect(result.details?.imageCount).toBe(1);
	});

	it("adds Codex account headers when the bearer token exposes an account id", async () => {
		let requestHeaders: Headers | undefined;
		const tokenPayload = Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "acc_test" },
			}),
		).toString("base64");
		const codexJwt = `header.${tokenPayload}.signature`;

		const fetchMock: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			requestHeaders = new Headers(init?.headers);
			return new Response(
				[
					"event: response.output_item.done",
					`data: ${JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "image_generation_call",
							result: Buffer.from("fake-codex-jwt-webp").toString("base64"),
							status: "completed",
						},
					})}`,
					"",
					"event: response.completed",
					`data: ${JSON.stringify({
						type: "response.completed",
						response: { output: [], status: "completed", error: null },
					})}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;

		const model = {
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5.5-codex",
			name: "GPT Codex",
			baseUrl: "https://example-proxy.invalid/backend-api",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => codexJwt,
				getApiKeyForProvider: async () => undefined,
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => codexJwt,
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-codex-jwt", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestHeaders?.get("authorization")).toBe(`Bearer ${codexJwt}`);
		expect(requestHeaders?.get("chatgpt-account-id")).toBe("acc_test");
		expect(result.details?.imageCount).toBe(1);
	});
	it("routes xAI image generation with xAI-only aspect ratios", async () => {
		setImageProviderOrder(["xai"]);
		let requestUrl: string | undefined;
		let requestBody: Record<string, unknown> | undefined;
		const captured: { authorization: string | null; userAgent: string | null } = {
			authorization: null,
			userAgent: null,
		};

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const headers = new Headers(init?.headers);
			captured.authorization = headers.get("authorization");
			captured.userAgent = headers.get("user-agent");
			return new Response(
				JSON.stringify({
					data: [{ b64_json: Buffer.from("fake-xai-image").toString("base64") }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKeyForProvider: async (provider: string) => (provider === "xai-oauth" ? "test-xai-token" : undefined),
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
					rotateSessionCredential: async () => false,
				},
				resolver: () => async () => "test-xai-token",
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-xai", { subject: "a cat", aspect_ratio: "3:2" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.x.ai/v1/images/generations");
		expect(captured.authorization).toBe("Bearer test-xai-token");
		expect(captured.userAgent).toBe(USER_AGENT);
		expect(requestBody).toMatchObject({
			model: "grok-imagine-image",
			prompt: "a cat.",
			aspect_ratio: "3:2",
			resolution: "1k",
			n: 1,
			response_format: "b64_json",
		});
		expect(result.details?.provider).toBe("xai");
		expect(result.details?.model).toBe("grok-imagine-image");
		expect(result.details?.imageCount).toBe(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-xai-image"));
	});

	it("prefers the active xAI provider over unrelated credentialed providers", async () => {
		const requestUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (!url.startsWith("https://api.x.ai/")) {
				throw new Error(`Unexpected provider request: ${url}`);
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("active-xai-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const model = {
			api: "openai-completions",
			provider: "xai-oauth",
			id: "grok-4.5",
			name: "Grok 4.5",
			baseUrl: "https://api.x.ai/v1",
		} as Model;
		const ctx = createAntigravityXAIContext(model, fetchMock);

		const result = await imageGenTool.execute("call-active-xai", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual(["https://api.x.ai/v1/images/generations"]);
		expect(result.details?.provider).toBe("xai");
	});

	it("falls back to xAI after the active OpenAI provider HTTP failure", async () => {
		const requestUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url.startsWith("https://api.openai.com/")) {
				return new Response(JSON.stringify({ error: { message: "model unavailable" } }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("openai-fallback-xai-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async (provider: string) => (provider === "xai-oauth" ? "test-xai-token" : undefined),
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
					rotateSessionCredential: async () => false,
				},
				resolver: () => async () => "test-openai-key",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-openai-fallback-xai", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual(["https://api.openai.com/v1/responses", "https://api.x.ai/v1/images/generations"]);
		expect(result.details?.provider).toBe("xai");
	});

	it("falls back to xAI after an earlier provider HTTP failure", async () => {
		const requestUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url.includes("streamGenerateContent")) {
				return new Response(JSON.stringify({ error: { message: "image endpoint unavailable" } }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("fallback-xai-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const ctx = createAntigravityXAIContext(undefined, fetchMock);

		const result = await imageGenTool.execute("call-fallback-xai", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			"https://api.x.ai/v1/images/generations",
		]);
		expect(result.details?.provider).toBe("xai");
	});
	it("skips active providers that do not support the requested aspect ratio", async () => {
		const requestUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (!url.startsWith("https://api.x.ai/")) {
				throw new Error(`Unexpected provider request: ${url}`);
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("xai-aspect-ratio-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const model = {
			api: "google-generative-ai",
			provider: "google",
			id: "gemini-3-pro-image-preview",
			name: "Gemini 3 Pro Image",
			baseUrl: "https://generativelanguage.googleapis.com",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => undefined,
				getApiKeyForProvider: async (provider: string) => {
					if (provider === "google") return "test-gemini-token";
					if (provider === "xai-oauth") return "test-xai-token";
					return undefined;
				},
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
					rotateSessionCredential: async () => false,
				},
				resolver: (provider: string) => async () =>
					provider === "google" ? "test-gemini-token" : "test-xai-token",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute(
			"call-gemini-aspect-ratio-fallback",
			{ subject: "a cat", aspect_ratio: "3:2" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual(["https://api.x.ai/v1/images/generations"]);
		expect(result.details?.provider).toBe("xai");
	});

	function createBFLContext(fetchMock: typeof fetch, extraProviders: Record<string, string> = {}): CustomToolContext {
		const providerKeys: Record<string, string> = { bfl: "test-bfl-key", ...extraProviders };
		return {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => undefined,
				getApiKeyForProvider: async (provider: string) => providerKeys[provider],
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: (provider: string) => provider in providerKeys,
					rotateSessionCredential: async () => false,
				},
				resolver: (provider: string) => async () => providerKeys[provider] ?? "test-bfl-key",
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};
	}

	it("generates a BFL image via submit, poll, and signed sample download", async () => {
		setImageProviderOrder(["bfl"]);
		const requestUrls: string[] = [];
		let submitBody: Record<string, unknown> | undefined;
		let pollCount = 0;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url === "https://api.bfl.ai/v1/flux-2-pro") {
				submitBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(
					JSON.stringify({ id: "task-1", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=task-1" }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url === "https://api.eu.bfl.ai/v1/get_result?id=task-1") {
				pollCount += 1;
				if (pollCount === 1) {
					return new Response(JSON.stringify({ status: "Pending" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({ status: "Ready", result: { sample: "https://delivery.bfl.ai/sample.png" } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url === "https://delivery.bfl.ai/sample.png") {
				return new Response(Buffer.from("fake-bfl-image"), {
					status: 200,
					headers: { "content-type": "image/png" },
				});
			}
			throw new Error(`Unexpected request: ${url}`);
		}) as unknown as typeof fetch;

		const ctx = createBFLContext(fetchMock);
		const result = await imageGenTool.execute("call-bfl", { subject: "a fox", aspect_ratio: "4:3" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual([
			"https://api.bfl.ai/v1/flux-2-pro",
			"https://api.eu.bfl.ai/v1/get_result?id=task-1",
			"https://api.eu.bfl.ai/v1/get_result?id=task-1",
			"https://delivery.bfl.ai/sample.png",
		]);
		// flux-2-pro ignores aspect_ratio: the ratio must arrive as explicit dimensions.
		expect(submitBody).toEqual({ prompt: "a fox.", width: 1152, height: 864 });
		expect(result.details?.provider).toBe("bfl");
		expect(result.details?.model).toBe("flux-2-pro");
		expect(result.details?.imageCount).toBe(1);
		expect(result.details?.images?.[0]?.data).toBe(Buffer.from("fake-bfl-image").toBase64());
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-bfl-image"));
	}, 15_000);

	it("authenticates BFL submit and poll requests with the x-key header, never Authorization", async () => {
		setImageProviderOrder(["bfl"]);
		const captured: { xKey: string | null; authorization: string | null } = { xKey: null, authorization: null };
		const pollCaptured: { xKey: string | null; authorization: string | null } = { xKey: null, authorization: null };

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url === "https://api.bfl.ai/v1/flux-2-pro") {
				const headers = new Headers(init?.headers);
				captured.xKey = headers.get("x-key");
				captured.authorization = headers.get("authorization");
				return new Response(
					JSON.stringify({ id: "task-2", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=task-2" }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url === "https://api.eu.bfl.ai/v1/get_result?id=task-2") {
				const headers = new Headers(init?.headers);
				pollCaptured.xKey = headers.get("x-key");
				pollCaptured.authorization = headers.get("authorization");
				return new Response(
					JSON.stringify({ status: "Ready", result: { sample: "https://delivery.bfl.ai/sample2.png" } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(Buffer.from("bfl-wire-image"), {
				status: 200,
				headers: { "content-type": "image/png" },
			});
		}) as unknown as typeof fetch;

		const ctx = createBFLContext(fetchMock);
		const result = await imageGenTool.execute("call-bfl-wire", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(captured.xKey).toBe("test-bfl-key");
		expect(captured.authorization).toBeNull();
		// The regional polling URL is authenticated the same way as the submit.
		expect(pollCaptured.xKey).toBe("test-bfl-key");
		expect(pollCaptured.authorization).toBeNull();
		expect(result.details?.provider).toBe("bfl");
	});

	it("maps xAI-only ratios to explicit BFL dimensions instead of skipping the provider", async () => {
		setImageProviderOrder(["bfl"]);
		let submitBody: Record<string, unknown> | undefined;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url === "https://api.bfl.ai/v1/flux-2-pro") {
				submitBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(
					JSON.stringify({ id: "task-5", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=task-5" }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url === "https://api.eu.bfl.ai/v1/get_result?id=task-5") {
				return new Response(
					JSON.stringify({ status: "Ready", result: { sample: "https://delivery.bfl.ai/sample5.png" } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(Buffer.from("bfl-ratio-image"), {
				status: 200,
				headers: { "content-type": "image/png" },
			});
		}) as unknown as typeof fetch;

		const ctx = createBFLContext(fetchMock);
		const result = await imageGenTool.execute(
			"call-bfl-ratio",
			{ subject: "a cat", aspect_ratio: "3:2" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(submitBody).toEqual({ prompt: "a cat.", width: 1248, height: 832 });
		expect(result.details?.provider).toBe("bfl");
	});

	it("falls through to the next credentialed provider on a BFL HTTP failure", async () => {
		setImageProviderOrder(["bfl", "xai"]);
		const requestUrls: string[] = [];

		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url.startsWith("https://api.bfl.ai/")) {
				return new Response(JSON.stringify({ detail: "Not authenticated" }), {
					status: 403,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("bfl-fallback-xai-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const ctx = createBFLContext(fetchMock, { "xai-oauth": "test-xai-token" });
		const result = await imageGenTool.execute("call-bfl-fallback", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual(["https://api.bfl.ai/v1/flux-2-pro", "https://api.x.ai/v1/images/generations"]);
		expect(result.details?.provider).toBe("xai");
	});

	it("routes BFL edits to flux-kontext-pro with the source image in the body", async () => {
		setImageProviderOrder(["bfl"]);
		let submitUrl: string | undefined;
		let submitBody: Record<string, unknown> | undefined;
		const sourceImage = Buffer.from("bfl-source-image").toString("base64");

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url.startsWith("https://api.bfl.ai/v1/flux-")) {
				submitUrl = url;
				submitBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(
					JSON.stringify({ id: "task-3", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=task-3" }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url === "https://api.eu.bfl.ai/v1/get_result?id=task-3") {
				return new Response(
					JSON.stringify({ status: "Ready", result: { sample: "https://delivery.bfl.ai/sample3.png" } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(Buffer.from("bfl-edited-image"), {
				status: 200,
				headers: { "content-type": "image/png" },
			});
		}) as unknown as typeof fetch;

		const ctx = createBFLContext(fetchMock);
		const result = await imageGenTool.execute(
			"call-bfl-edit",
			{
				subject: "a cat",
				changes: ["make it wear a hat"],
				aspect_ratio: "4:3",
				input: [{ data: sourceImage, mime_type: "image/png" }],
			},
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(submitUrl).toBe("https://api.bfl.ai/v1/flux-kontext-pro");
		// Kontext honors aspect_ratio directly; no width/height mapping on the edit path.
		expect(submitBody).toEqual({
			prompt: "a cat.\n\nChanges:\n- make it wear a hat",
			aspect_ratio: "4:3",
			input_image: sourceImage,
		});
		expect(result.details?.provider).toBe("bfl");
		expect(result.details?.model).toBe("flux-kontext-pro");
	});

	it("falls through to the next credentialed provider when a BFL poll ends terminal-non-ready", async () => {
		setImageProviderOrder(["bfl", "xai"]);
		const requestUrls: string[] = [];

		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url === "https://api.bfl.ai/v1/flux-2-pro") {
				return new Response(
					JSON.stringify({ id: "task-4", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=task-4" }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url === "https://api.eu.bfl.ai/v1/get_result?id=task-4") {
				return new Response(JSON.stringify({ status: "Content Moderated" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("bfl-moderated-xai-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const ctx = createBFLContext(fetchMock, { "xai-oauth": "test-xai-token" });
		const result = await imageGenTool.execute("call-bfl-moderated", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual([
			"https://api.bfl.ai/v1/flux-2-pro",
			"https://api.eu.bfl.ai/v1/get_result?id=task-4",
			"https://api.x.ai/v1/images/generations",
		]);
		expect(result.details?.provider).toBe("xai");
	});

	it("falls through past BFL when an edit supplies more than one reference image", async () => {
		setImageProviderOrder(["bfl", "xai"]);
		const requestUrls: string[] = [];
		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url.startsWith("https://api.bfl.ai/")) {
				throw new Error(`BFL must not be called for multi-image edits: ${url}`);
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("bfl-multi-xai-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const sourceImage = Buffer.from("bfl-source-image").toString("base64");

		const ctx = createBFLContext(fetchMock, { "xai-oauth": "test-xai-token" });
		const result = await imageGenTool.execute(
			"call-bfl-multi-input",
			{
				subject: "a cat",
				changes: ["make it wear a hat"],
				input: [
					{ data: sourceImage, mime_type: "image/png" },
					{ data: sourceImage, mime_type: "image/png" },
				],
			},
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual(["https://api.x.ai/v1/images/edits"]);
		expect(result.details?.provider).toBe("xai");
	});

	it("falls through to the next credentialed provider when BFL returns malformed JSON", async () => {
		setImageProviderOrder(["bfl", "xai"]);
		const requestUrls: string[] = [];
		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url.startsWith("https://api.bfl.ai/")) {
				return new Response("<html>gateway error</html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("bfl-malformed-xai-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const ctx = createBFLContext(fetchMock, { "xai-oauth": "test-xai-token" });
		const result = await imageGenTool.execute("call-bfl-malformed", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual(["https://api.bfl.ai/v1/flux-2-pro", "https://api.x.ai/v1/images/generations"]);
		expect(result.details?.provider).toBe("xai");
	});

	it("falls through to the next credentialed provider when the BFL sample download fails", async () => {
		setImageProviderOrder(["bfl", "xai"]);
		const requestUrls: string[] = [];
		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url === "https://api.bfl.ai/v1/flux-2-pro") {
				return new Response(
					JSON.stringify({ id: "task-6", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=task-6" }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url === "https://api.eu.bfl.ai/v1/get_result?id=task-6") {
				return new Response(
					JSON.stringify({ status: "Ready", result: { sample: "https://delivery.bfl.ai/sample6.png" } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url === "https://delivery.bfl.ai/sample6.png") {
				return new Response("expired signature", { status: 403 });
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("bfl-download-xai-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const ctx = createBFLContext(fetchMock, { "xai-oauth": "test-xai-token" });
		const result = await imageGenTool.execute("call-bfl-download-fail", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual([
			"https://api.bfl.ai/v1/flux-2-pro",
			"https://api.eu.bfl.ai/v1/get_result?id=task-6",
			"https://delivery.bfl.ai/sample6.png",
			"https://api.x.ai/v1/images/generations",
		]);
		expect(result.details?.provider).toBe("xai");
	});
});
