import { describe, expect, test, vi } from "bun:test";
import { loginFreePI } from "../src/registry/freepi";
import { getOAuthProviders } from "../src/registry/oauth";
import type { FetchImpl } from "../src/types";

const FREEPI_BASE_URL = "https://sponsored-api-pilot-production.up.railway.app/api/v1";
const FREEPI_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

describe("FreePI login", () => {
	test("registers FreePI as an available API-key provider", () => {
		const provider = getOAuthProviders().find(item => item.id === "freepi");
		expect(provider).toMatchObject({ id: "freepi", name: "FreePI", available: true });
	});

	test("discloses retention and validates the key against protected inference", async () => {
		const requests: Array<{
			url: string;
			method: string | undefined;
			authorization: string | null;
			body: unknown;
		}> = [];
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				method: init?.method,
				authorization: headers.get("authorization"),
				body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
			});
			return Response.json({ choices: [{ message: { role: "assistant", content: "pong" } }] });
		});

		const apiKey = await loginFreePI({
			onAuth: info => authEvents.push(info),
			onPrompt: async () => "  ak_test-key  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("ak_test-key");
		expect(authEvents).toHaveLength(1);
		expect(authEvents[0]?.url).toBe("https://freepi.ai/account");
		expect(authEvents[0]?.instructions).toContain("raw traces may be retained indefinitely");
		expect(authEvents[0]?.instructions).toContain("do not send secrets or private code");
		expect(requests).toEqual([
			{
				url: `${FREEPI_BASE_URL}/chat/completions`,
				method: "POST",
				authorization: "Bearer ak_test-key",
				body: {
					model: FREEPI_DEFAULT_MODEL,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
					temperature: 0,
				},
			},
		]);
	});

	test("rejects a key rejected by FreePI", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => Response.json({ error: "Unauthorized" }, { status: 401 }));

		await expect(
			loginFreePI({
				onPrompt: async () => "invalid-freepi-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("FreePI API key validation failed (401)");
	});
});
