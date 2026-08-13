import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	__resetCursorApiKeyCache,
	isRawCursorApiKey,
	resolveCursorAccessToken,
} from "@oh-my-pi/pi-ai/oauth/cursor";

function jwtWithExp(expSeconds: number): string {
	const payload = Buffer.from(JSON.stringify({ exp: expSeconds }), "utf8").toString("base64url");
	return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

afterEach(() => {
	__resetCursorApiKeyCache();
});

describe("isRawCursorApiKey", () => {
	it("detects dashboard keys from either documented prefix", () => {
		expect(isRawCursorApiKey("crsr_abc")).toBe(true);
		expect(isRawCursorApiKey("cursor_abc")).toBe(true);
		expect(isRawCursorApiKey("  crsr_abc")).toBe(true);
	});

	it("leaves session JWTs and other credentials alone", () => {
		expect(isRawCursorApiKey(jwtWithExp(Math.floor(Date.now() / 1000) + 3600))).toBe(false);
		expect(isRawCursorApiKey("sk-ant-api03-...")).toBe(false);
		expect(isRawCursorApiKey("")).toBe(false);
	});
});

describe("resolveCursorAccessToken", () => {
	it("passes session tokens through without fetching", async () => {
		const token = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
		const fetchImpl = mock(() => {
			throw new Error("should not exchange a session token");
		}) as unknown as typeof fetch;
		await expect(resolveCursorAccessToken(token, fetchImpl)).resolves.toBe(token);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("exchanges a dashboard key and reuses the cached session JWT", async () => {
		const access = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
		let calls = 0;
		const fetchImpl = mock(async () => {
			calls += 1;
			return new Response(JSON.stringify({ accessToken: access, refreshToken: "rt" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const first = await resolveCursorAccessToken("crsr_testkey", fetchImpl);
		const second = await resolveCursorAccessToken("crsr_testkey", fetchImpl);
		expect(first).toBe(access);
		expect(second).toBe(access);
		expect(calls).toBe(1);
	});

	it("exchanges a whitespace-padded dashboard key instead of sending it raw", async () => {
		const access = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
		const fetchImpl = mock(async (_input, init) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBe("Bearer crsr_testkey");
			return new Response(JSON.stringify({ accessToken: access }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await expect(resolveCursorAccessToken("  crsr_testkey\n", fetchImpl)).resolves.toBe(access);
	});

	it("single-flights concurrent exchanges for the same key", async () => {
		const access = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
		let calls = 0;
		const { promise, resolve } = Promise.withResolvers<Response>();
		const fetchImpl = mock(() => {
			calls += 1;
			return promise;
		}) as unknown as typeof fetch;

		const pending = [
			resolveCursorAccessToken("crsr_parallel", fetchImpl),
			resolveCursorAccessToken("crsr_parallel", fetchImpl),
		];
		resolve(
			new Response(JSON.stringify({ accessToken: access }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		expect(await Promise.all(pending)).toEqual([access, access]);
		expect(calls).toBe(1);
	});
});
