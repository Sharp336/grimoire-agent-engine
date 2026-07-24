/**
 * ClinePass WorkOS OAuth flow — credential reuse, token refresh, and the
 * auto-login-vs-paste selection.
 *
 * The WorkOS contract (credential shape, `/auth/refresh` returning a bare JWT,
 * the `workos:` bearer prefix) was verified live against api.cline.bot.
 */
import { describe, expect, it } from "bun:test";

import {
	isWorkosToken,
	loginFromClineCli,
	readClineAuthCredentials,
	refreshWorkosToken,
} from "@oh-my-pi/pi-ai/registry/oauth/clinepass";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/** A providers.json with a WorkOS `auth` block under the given provider key. */
function providersJson(providerKey: string, expiresAt: number | string): string {
	return JSON.stringify({
		version: 1,
		providers: {
			[providerKey]: {
				settings: {
					provider: "cline",
					auth: {
						accessToken: "workos:eyJhbGciFAKE",
						refreshToken: "RefreshTokenOpaque25chars",
						expiresAt,
						accountId: "usr-01TEST",
					},
				},
				tokenSource: "oauth",
			},
		},
	});
}

function fileReader(content: string | undefined) {
	return {
		home: "/home/tester",
		readFile: () => {
			if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return content;
		},
	};
}

/** A fetch that fails the test if called — the fresh-token path must not refresh. */
const unusableFetch: FetchImpl = async () => {
	throw new Error("fetch must not be called on the fresh-token path");
};

describe("readClineAuthCredentials", () => {
	it("reads WorkOS creds from the `cline` provider key", async () => {
		const rec = await readClineAuthCredentials(fileReader(providersJson("cline", 1_783_274_705_000)));
		expect(rec).toBeDefined();
		expect(rec?.accessToken).toBe("workos:eyJhbGciFAKE");
		expect(rec?.refreshToken).toBe("RefreshTokenOpaque25chars");
		expect(rec?.expiresAt).toBe(1_783_274_705_000);
		expect(rec?.accountId).toBe("usr-01TEST");
	});

	it("also reads the legacy `cline-pass` provider key", async () => {
		const rec = await readClineAuthCredentials(fileReader(providersJson("cline-pass", 1_783_274_705_000)));
		expect(rec?.accessToken).toBe("workos:eyJhbGciFAKE");
	});

	it("returns undefined when the credential file is absent", async () => {
		expect(await readClineAuthCredentials(fileReader(undefined))).toBeUndefined();
	});

	it("returns undefined when there is no auth block (static-key-only install)", async () => {
		const json = JSON.stringify({ providers: { cline: { settings: { provider: "cline", apiKey: "sk_x" } } } });
		expect(await readClineAuthCredentials(fileReader(json))).toBeUndefined();
	});
	it("treats a non-numeric expiresAt as already expired (0) so refresh fires", async () => {
		const rec = await readClineAuthCredentials(fileReader(providersJson("cline", "not-a-number")));
		expect(rec?.expiresAt).toBe(0);
	});
});

describe("refreshWorkosToken", () => {
	it("re-adds the workos: prefix to the bare JWT the endpoint returns", async () => {
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> = {};
		const fetchImpl: FetchImpl = async (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedBody = init?.body ? JSON.parse(init.body as string) : {};
			// The live endpoint returns a BARE JWT (no workos: prefix) + ISO expiresAt.
			return new Response(
				JSON.stringify({
					data: {
						accessToken: "eyJhbGciREFRESHED",
						refreshToken: "NewRefresh25charsOpaqueXX",
						expiresAt: "2026-07-05T18:05:39Z",
					},
				}),
				{ status: 200 },
			);
		};

		const next = await refreshWorkosToken(
			{ access: "workos:eyJhbGciOLD", refresh: "OldRefresh", expires: 0 },
			{ fetch: fetchImpl },
		);

		expect(capturedUrl).toBe("https://api.cline.bot/api/v1/auth/refresh");
		expect(capturedBody.granttype).toBe("refresh_token");
		expect(capturedBody.refreshToken).toBe("OldRefresh");
		expect(next.access).toBe("workos:eyJhbGciREFRESHED");
		expect(next.refresh).toBe("NewRefresh25charsOpaqueXX");
		expect(next.expires).toBeGreaterThan(Date.now());
	});

	it("surfaces a refresh failure with status", async () => {
		const fetchImpl: FetchImpl = async () => new Response("invalid_grant", { status: 401 });
		await expect(
			refreshWorkosToken({ access: "workos:x", refresh: "bad", expires: 0 }, { fetch: fetchImpl }),
		).rejects.toThrow(/ClinePass token refresh failed \(401\)/);
	});
});

describe("loginFromClineCli", () => {
	const now = 1_783_000_000_000;

	it("returns stored WorkOS creds verbatim when the token is still fresh (no refresh)", async () => {
		const fresh = now + 60 * 60 * 1000; // 1h out — well past the refresh margin
		const creds = await loginFromClineCli({
			now,
			fetch: unusableFetch,
			...fileReader(providersJson("cline", fresh)),
		});
		expect(creds?.access).toBe("workos:eyJhbGciFAKE");
		expect(creds?.refresh).toBe("RefreshTokenOpaque25chars");
	});

	it("refreshes when the stored token is at/near expiry", async () => {
		let refreshed = false;
		const fetchImpl: FetchImpl = async () => {
			refreshed = true;
			return new Response(
				JSON.stringify({ data: { accessToken: "eyJhbGciNEW", refreshToken: "NewRefresh25charsOpaqueXX" } }),
				{ status: 200 },
			);
		};
		const creds = await loginFromClineCli({
			now,
			fetch: fetchImpl,
			...fileReader(providersJson("cline", now + 1000)), // ~expired vs the 5-min margin
		});
		expect(refreshed).toBe(true);
		expect(creds?.access).toBe("workos:eyJhbGciNEW");
	});
	it("refreshes when the stored expiry metadata is invalid (forces refresh)", async () => {
		let refreshed = false;
		const fetchImpl: FetchImpl = async () => {
			refreshed = true;
			return new Response(
				JSON.stringify({ data: { accessToken: "eyJhbGciNEW", refreshToken: "NewRefresh25charsOpaqueXX" } }),
				{ status: 200 },
			);
		};
		const creds = await loginFromClineCli({
			now,
			fetch: fetchImpl,
			...fileReader(providersJson("cline", "garbage")), // non-numeric → treated as expired
		});
		expect(refreshed).toBe(true);
		expect(creds?.access).toBe("workos:eyJhbGciNEW");
	});

	it("returns undefined when the Cline CLI is not logged in (caller falls back to paste)", async () => {
		const creds = await loginFromClineCli({ now, fetch: unusableFetch, ...fileReader(undefined) });
		expect(creds).toBeUndefined();
	});

	it("isWorkosToken distinguishes OAuth tokens from static keys", () => {
		expect(isWorkosToken("workos:eyJ...")).toBe(true);
		expect(isWorkosToken("sk_0e13abc")).toBe(false);
	});
});
