/**
 * Contract: the OpenAI Codex / ChatGPT OAuth SSE transport honors
 * `rateLimitRotation` exactly like the OpenAI-wire seam (postOpenAIStream). A
 * long transient 429 (RATE_LIMIT_EXCEEDED body) with a usable sibling is
 * surfaced through the marker formatter before the CODEX_RATE_LIMIT_BUDGET_MS
 * sleep, so the `streamSimple` auth-retry driver rotates to a sibling key.
 * Without the seam the transport backoff is behavior-identical to baseline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type ApiKeyResolveContext, type FetchImpl, streamSimple } from "@oh-my-pi/pi-ai";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";

const { getAgentDir, setAgentDir, TempDir } = piUtils;

const originalAgentDir = getAgentDir();
const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

// Real OpenAI rate-limit wire shape (matches openai-rate-limit-rotation.test.ts):
// `code: "rate_limit_exceeded"` + the verbose TPM message. `parseRateLimitReason`
// keys on the "rate limit" substring, so the gate classifies RATE_LIMIT_EXCEEDED.
const RATE_LIMIT_BODY = JSON.stringify({
	error: {
		message:
			"Rate limit reached for gpt-5 in organization org-XXX on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 2s.",
		type: "tokens",
		param: null,
		code: "rate_limit_exceeded",
	},
});

function createCodexTestToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(): Model<"openai-codex-responses"> {
	return {
		...buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		}),
		// Force the SSE transport (mockable via `fetch`) instead of websockets.
		preferWebsockets: false,
	};
}

function createContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function codexSseResponse(text: string): Response {
	const events = [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	const payload = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function bearerOf(init: RequestInit | undefined): string {
	const value = new Headers(init?.headers).get("authorization") ?? "";
	return value.replace(/^Bearer /, "");
}

let tempDir: ReturnType<typeof TempDir.createSync>;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-codex-rotation-");
	setAgentDir(tempDir.path());
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	setAgentDir(originalAgentDir);
	vi.restoreAllMocks();
});

describe("openai-codex rate-limit rotation", () => {
	it("surfaces the 429 before sleeping and completes on the sibling key", async () => {
		const tokenA = createCodexTestToken("acc_a");
		const tokenB = createCodexTestToken("acc_b");
		const attemptsByKey = new Map<string, number>();
		const retryContexts: ApiKeyResolveContext[] = [];
		const onRotated = vi.fn();
		const fetchMock: FetchImpl = async (_input, init) => {
			const key = bearerOf(init);
			attemptsByKey.set(key, (attemptsByKey.get(key) ?? 0) + 1);
			if (key === tokenA) {
				return new Response(RATE_LIMIT_BODY, { status: 429, headers: { "retry-after": "30" } });
			}
			return codexSseResponse("Hi");
		};

		const stream = streamSimple(createCodexTestModel(), createContext(), {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryContexts.push(ctx);
				return ctx.error === undefined ? tokenA : tokenB;
			},
			fetch: fetchMock,
			rateLimitRotation: {
				enabled: true,
				provider: "openai-codex",
				minSleepMs: 2_000,
				hasUsableSibling: () => true,
				onRotated,
			},
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hi");
		// Exactly ONE 429 on token A: the transport surfaced instead of retrying.
		expect(attemptsByKey.get(tokenA)).toBe(1);
		expect(attemptsByKey.get(tokenB)).toBe(1);
		// Direct rotation with the marker + hint visible to the resolver.
		expect(retryContexts.map(ctx => ctx.lastChance)).toEqual([true]);
		expect((retryContexts[0]!.error as Error).message).toContain(
			"; rate limit surfaced for rotation; retry-after-ms: 30000ms",
		);
		expect(onRotated).toHaveBeenCalledTimes(1);
	});

	it("keeps the transport backoff when rotation is off (behavior-identical baseline)", async () => {
		const token = createCodexTestToken("acc_a");
		let attempts = 0;
		const retryResolves: ApiKeyResolveContext[] = [];
		const fetchMock: FetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) {
				return new Response(RATE_LIMIT_BODY, { status: 429, headers: { "retry-after": "0" } });
			}
			return codexSseResponse("Hi");
		};

		const stream = streamSimple(createCodexTestModel(), createContext(), {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryResolves.push(ctx);
				return token;
			},
			fetch: fetchMock,
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		// fetchWithRetry slept the hint and recovered on the SAME token — no rotation.
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hi");
		expect(attempts).toBe(2);
		expect(retryResolves).toEqual([]);
	});
});
