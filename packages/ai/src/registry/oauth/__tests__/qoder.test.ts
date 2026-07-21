import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { getQoderCommonHeaders, loginQoder, refreshQoderToken } from "../qoder";

const CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
const POLL_URL = "https://openapi.qoder.sh/api/v1/deviceToken/poll";
const REFRESH_URL = "https://openapi.qoder.sh/api/v1/deviceToken/refresh";

type RecordedRequest = {
	url: string;
	init: RequestInit | undefined;
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function urlOf(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("loginQoder", () => {
	it("opens a PKCE browser URL and polls from 404 through a token response", async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const requests: RecordedRequest[] = [];
		let polls = 0;
		const fetchMock: FetchImpl = async (input, init) => {
			const url = urlOf(input);
			requests.push({ url, init });
			if (!url.startsWith(POLL_URL)) throw new Error(`Unexpected URL: ${url}`);
			polls += 1;
			return polls === 1
				? new Response(null, { status: 404 })
				: jsonResponse({ token: "access-token", refresh_token: "refresh-token", expires_at: now / 1000 + 3600 });
		};
		const auth = vi.fn();

		const credentials = await loginQoder({ fetch: fetchMock, onAuth: auth });

		expect(auth).toHaveBeenCalledTimes(1);
		const authUrl = new URL(auth.mock.calls[0]?.[0].url);
		expect(authUrl.origin + authUrl.pathname).toBe("https://qoder.com/device/selectAccounts");
		expect(authUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(authUrl.searchParams.get("challenge_method")).toBe("S256");
		expect(authUrl.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(authUrl.searchParams.get("nonce")).toMatch(/^[0-9a-f-]{36}$/);
		expect(authUrl.searchParams.get("machine_id")).toMatch(/^[0-9a-f-]{36}$/);

		expect(requests).toHaveLength(2);
		const poll = new URL(requests[0]?.url ?? "");
		const verifier = poll.searchParams.get("verifier") ?? "";
		const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
		expect(authUrl.searchParams.get("challenge")).toBe(expectedChallenge);
		expect(poll.origin + poll.pathname).toBe(POLL_URL);
		expect(poll.searchParams.get("challenge_method")).toBe("S256");
		expect(poll.searchParams.get("verifier")).toMatch(/^[A-Za-z0-9_-]{86}$/);
		expect(requests.map(request => request.init?.method)).toEqual(["GET", "GET"]);
		expect(credentials).toEqual({ access: "access-token", refresh: "refresh-token", expires: now + 3_540_000 });
	});
});

describe("refreshQoderToken", () => {
	it("parses a refreshed token and retains the old refresh token when omitted", async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const requests: RecordedRequest[] = [];
		const fetchMock: FetchImpl = async (input, init) => {
			requests.push({ url: urlOf(input), init });
			return jsonResponse({ token: "new-access", expires_at: "1800003600" });
		};

		const credentials = await refreshQoderToken("old-refresh", fetchMock);

		expect(credentials).toEqual({ access: "new-access", refresh: "old-refresh", expires: now + 3_540_000 });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(REFRESH_URL);
		expect(requests[0]?.init?.method).toBe("POST");
		expect(new Headers(requests[0]?.init?.headers).get("User-Agent")).toBe("qoder/1.1.1");
		expect(requests[0]?.init?.body).toBe(JSON.stringify({ refresh_token: "old-refresh" }));
	});

	it("rejects an empty access token returned by refresh", async () => {
		const fetchMock: FetchImpl = async () => jsonResponse({ token: "" });

		await expect(refreshQoderToken("old-refresh", fetchMock)).rejects.toMatchObject({
			name: "OAuthError",
			kind: "validation",
			provider: "qoder",
		});
	});

	it("rejects an empty refresh token before making a request", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			throw new Error("fetch must not be called");
		};

		await expect(refreshQoderToken("", fetchMock)).rejects.toMatchObject({
			name: "OAuthError",
			kind: "validation",
			provider: "qoder",
		});
		expect(calls).toBe(0);
	});
});

describe("getQoderCommonHeaders", () => {
	it("memoizes the frozen Qoder client headers", () => {
		const first = getQoderCommonHeaders();
		const second = getQoderCommonHeaders();
		const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;

		expect(first).toBe(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(first).toEqual({
			"Cosy-ClientType": "5",
			"Cosy-Version": "1.1.1",
			"Cosy-MachineOS": `${arch}_${process.platform}`,
		});
	});
});
