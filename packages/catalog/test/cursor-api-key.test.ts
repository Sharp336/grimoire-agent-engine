import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	__resetCursorApiKeyCache,
	isRawCursorApiKey,
	resolveCursorBearerToken,
} from "@oh-my-pi/pi-catalog/discovery/cursor";

function jwtWithExp(expSeconds: number): string {
	const payload = Buffer.from(JSON.stringify({ exp: expSeconds }), "utf8").toString("base64url");
	return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

afterEach(() => {
	__resetCursorApiKeyCache();
	vi.restoreAllMocks();
});

describe("catalog Cursor dashboard API key exchange", () => {
	test("detects raw dashboard keys", () => {
		expect(isRawCursorApiKey("crsr_abc")).toBe(true);
		expect(isRawCursorApiKey("cursor_abc")).toBe(true);
		expect(isRawCursorApiKey(jwtWithExp(Math.floor(Date.now() / 1000) + 3600))).toBe(false);
	});

	test("passes session tokens through without fetching", async () => {
		const token = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
		const fetchImpl = vi.fn(() => {
			throw new Error("should not exchange a session token");
		});
		await expect(resolveCursorBearerToken(token, { fetch: fetchImpl })).resolves.toBe(token);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	test("exchanges a dashboard key once and caches the session JWT", async () => {
		const access = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toContain("/auth/exchange_user_api_key");
			return new Response(JSON.stringify({ accessToken: access }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const first = await resolveCursorBearerToken("crsr_testkey", { fetch: fetchImpl });
		const second = await resolveCursorBearerToken("crsr_testkey", { fetch: fetchImpl });
		expect(first).toBe(access);
		expect(second).toBe(access);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	test("trims dashboard keys before exchanging them", async () => {
		const access = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer crsr_testkey");
			return new Response(JSON.stringify({ accessToken: access }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		await expect(resolveCursorBearerToken("  crsr_testkey\n", { fetch: fetchImpl })).resolves.toBe(access);
	});

	test("aborts a hung exchange when timeoutMs elapses", async () => {
		const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => {
				reject(init.signal?.reason ?? new Error("aborted"));
			});
			return promise;
		});

		await expect(
			resolveCursorBearerToken("crsr_testkey", { fetch: fetchImpl, timeoutMs: 20 }),
		).rejects.toBeTruthy();
	});
});
