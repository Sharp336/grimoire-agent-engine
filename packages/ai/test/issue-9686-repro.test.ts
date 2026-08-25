import { describe, expect, it } from "bun:test";
import {
	buildAnthropicClientOptions,
	buildAnthropicHeaders,
	streamAnthropic,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function makeModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "custom-proxy",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

describe("issue #9686 — Anthropic compat supportsContextManagement", () => {
	it("omits context_management and its beta when supportsContextManagement is false (API-key)", async () => {
		const model = makeModel({
			compat: { supportsContextManagement: false },
		});

		let capturedBeta: string | null = null;
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBeta = new Headers(init?.headers).get("anthropic-beta");
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const { promise, resolve } = Promise.withResolvers<unknown>();
		await streamAnthropic(
			model,
			{ systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{
				apiKey: "sk-ant-test",
				thinkingEnabled: true,
				fetch: fetchMock,
				onPayload: payload => resolve(payload),
			},
		).result();

		const payload = (await promise) as {
			thinking?: { type?: string };
			context_management?: unknown;
		};
		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.context_management).toBeUndefined();
		expect(capturedBeta ?? "").not.toContain("context-management-2025-06-27");
	});

	it("omits context_management beta from OAuth defaults when supportsContextManagement is false", async () => {
		const model = makeModel({
			compat: { supportsContextManagement: false },
		});

		const clientOptions = buildAnthropicClientOptions({
			model,
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			thinkingEnabled: true,
			stream: true,
		});
		expect(clientOptions.defaultHeaders["anthropic-beta"] ?? "").not.toContain("context-management-2025-06-27");

		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			supportsContextManagement: false,
		});
		expect(headers["anthropic-beta"] ?? "").not.toContain("context-management-2025-06-27");

		let capturedBeta: string | null = null;
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBeta = new Headers(init?.headers).get("anthropic-beta");
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const { promise, resolve } = Promise.withResolvers<unknown>();
		await streamAnthropic(
			model,
			{ systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{
				apiKey: "sk-ant-oat-test",
				isOAuth: true,
				thinkingEnabled: true,
				fetch: fetchMock,
				onPayload: payload => resolve(payload),
			},
		).result();

		const payload = (await promise) as {
			thinking?: { type?: string };
			context_management?: unknown;
		};
		expect(payload.context_management).toBeUndefined();
		expect(capturedBeta ?? "").not.toContain("context-management-2025-06-27");
	});

	it("sends context_management and its beta when supportsContextManagement is true (default)", async () => {
		const model = makeModel();

		let capturedBeta: string | null = null;
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBeta = new Headers(init?.headers).get("anthropic-beta");
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const { promise, resolve } = Promise.withResolvers<unknown>();
		await streamAnthropic(
			model,
			{ systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{
				apiKey: "sk-ant-test",
				thinkingEnabled: true,
				fetch: fetchMock,
				onPayload: payload => resolve(payload),
			},
		).result();

		const payload = (await promise) as {
			thinking?: { type?: string };
			context_management?: { edits?: Array<{ type?: string; keep?: string }> };
		};
		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.context_management).toEqual({
			edits: [{ type: "clear_thinking_20251015", keep: "all" }],
		});
		expect(capturedBeta ?? "").toContain("context-management-2025-06-27");
	});
});
