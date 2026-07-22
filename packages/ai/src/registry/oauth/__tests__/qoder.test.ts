import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { isDefinitiveOAuthFailure } from "../../../error";
import { getQoderCommonHeaders, loginQoder, refreshQoderToken, wrapQoderSseFetch } from "../qoder";

const CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
const POLL_URL = "https://openapi.qoder.sh/api/v1/deviceToken/poll";
const REFRESH_URL = "https://openapi.qoder.sh/api/v1/deviceToken/refresh";
const USERINFO_URL = "https://openapi.qoder.sh/api/v1/userinfo";

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

function tokenPollResponse(overrides: Record<string, unknown> = {}): Response {
	return jsonResponse({
		token: "access-token",
		refresh_token: "refresh-token",
		expires_at: 1_800_000_000_000 / 1000 + 3600,
		...overrides,
	});
}

function userinfoResponse(id = "qoder-user-1"): Response {
	return jsonResponse({ id });
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
			if (url === USERINFO_URL) {
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-token");
				return userinfoResponse("acct-42");
			}
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

		expect(requests).toHaveLength(3);
		const poll = new URL(requests[0]?.url ?? "");
		const verifier = poll.searchParams.get("verifier") ?? "";
		const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
		expect(authUrl.searchParams.get("challenge")).toBe(expectedChallenge);
		expect(poll.origin + poll.pathname).toBe(POLL_URL);
		expect(poll.searchParams.get("challenge_method")).toBe("S256");
		expect(poll.searchParams.get("verifier")).toMatch(/^[A-Za-z0-9_-]{86}$/);
		expect(requests.map(request => request.init?.method)).toEqual(["GET", "GET", "GET"]);
		expect(requests[2]?.url).toBe(USERINFO_URL);
		expect(credentials).toEqual({
			access: "access-token",
			refresh: "refresh-token",
			expires: now + 3_540_000,
			accountId: "acct-42",
		});
	});

	it("treats HTTP 202 as pending before parsing a body", async () => {
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		let polls = 0;
		const fetchMock: FetchImpl = async input => {
			const url = urlOf(input);
			if (url === USERINFO_URL) return userinfoResponse();
			polls += 1;
			if (polls === 1) {
				return new Response(JSON.stringify({ error: "authorization_pending" }), {
					status: 202,
					headers: { "Content-Type": "application/json" },
				});
			}
			return tokenPollResponse();
		};

		const credentials = await loginQoder({ fetch: fetchMock });

		expect(polls).toBe(2);
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
			accountId: "qoder-user-1",
		});
	});

	it("maps non-pending HTTP failures to polling errors", async () => {
		const fetchMock: FetchImpl = async () => new Response(null, { status: 500 });

		await expect(loginQoder({ fetch: fetchMock })).rejects.toMatchObject({
			name: "OAuthError",
			kind: "polling",
		});
	});

	it("maps invalid poll JSON to validation errors", async () => {
		const fetchMock: FetchImpl = async () => new Response("<html>", { status: 200 });

		await expect(loginQoder({ fetch: fetchMock })).rejects.toMatchObject({
			name: "OAuthError",
			kind: "validation",
			provider: "qoder",
		});
	});

	it("keeps polling after an empty access token", async () => {
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		let polls = 0;
		const fetchMock: FetchImpl = async input => {
			const url = urlOf(input);
			if (url === USERINFO_URL) return userinfoResponse();
			polls += 1;
			return polls === 1
				? jsonResponse({ token: "" })
				: jsonResponse({ token: "access-token", refresh_token: "refresh-token" });
		};

		const credentials = await loginQoder({ fetch: fetchMock });

		expect(polls).toBe(2);
		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(credentials.accountId).toBe("qoder-user-1");
	});

	it("rejects a token-only poll response instead of looping forever", async () => {
		const fetchMock: FetchImpl = async () => jsonResponse({ token: "access-token" });

		await expect(loginQoder({ fetch: fetchMock })).rejects.toMatchObject({
			name: "OAuthError",
			kind: "validation",
			provider: "qoder",
			message: expect.stringContaining("refresh_token"),
		});
	});

	it("fails login when userinfo is non-OK or missing a stable id", async () => {
		const missingId: FetchImpl = async input => {
			const url = urlOf(input);
			if (url.startsWith(POLL_URL)) return tokenPollResponse();
			if (url === USERINFO_URL) return jsonResponse({ name: "no-id" });
			throw new Error(`Unexpected URL: ${url}`);
		};
		await expect(loginQoder({ fetch: missingId })).rejects.toMatchObject({
			name: "OAuthError",
			kind: "validation",
			provider: "qoder",
			message: expect.stringContaining("account id"),
		});

		const unauthorized: FetchImpl = async input => {
			const url = urlOf(input);
			if (url.startsWith(POLL_URL)) return tokenPollResponse();
			if (url === USERINFO_URL) return new Response(null, { status: 401 });
			throw new Error(`Unexpected URL: ${url}`);
		};
		await expect(loginQoder({ fetch: unauthorized })).rejects.toMatchObject({
			name: "OAuthError",
			kind: "validation",
			provider: "qoder",
			status: 401,
		});
	});

	it("bounds an in-flight poll request, retries after its timeout, and then succeeds", async () => {
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const timeoutController = new AbortController();
		let timeoutCalls = 0;
		const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
			timeoutCalls += 1;
			// Only the first poll uses the aborted controller; later polls and
			// the userinfo fetch need a live timeout signal.
			return timeoutCalls === 1 ? timeoutController.signal : new AbortController().signal;
		});
		const response = Promise.withResolvers<Response>();
		let requestSignal: AbortSignal | undefined;
		let polls = 0;
		const fetchMock: FetchImpl = (input, init) => {
			const url = urlOf(input);
			if (url === USERINFO_URL) {
				return Promise.resolve(userinfoResponse());
			}
			polls += 1;
			if (polls > 1) {
				return Promise.resolve(tokenPollResponse());
			}
			requestSignal = init?.signal ?? undefined;
			requestSignal?.addEventListener("abort", () => response.reject(requestSignal?.reason), { once: true });
			return response.promise;
		};

		const result = loginQoder({ fetch: fetchMock }).then(
			credentials => credentials,
			error => error,
		);
		expect(requestSignal).toBe(timeoutController.signal);
		expect(timeout).toHaveBeenCalledWith(20_000);
		timeoutController.abort(new DOMException("timed out", "TimeoutError"));

		const credentials = await result;
		expect(polls).toBe(2);
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
			accountId: "qoder-user-1",
		});
	});

	it("maps in-flight poll cancellation to a login cancellation", async () => {
		const controller = new AbortController();
		const fetchMock: FetchImpl = async () => {
			controller.abort();
			throw new DOMException("aborted", "AbortError");
		};

		await expect(loginQoder({ fetch: fetchMock, signal: controller.signal })).rejects.toThrow("Login cancelled");
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
		expect(new Headers(requests[0]?.init?.headers).get("User-Agent")).toBe("qoder/1.1.2");
		expect(requests[0]?.init?.body).toBe(JSON.stringify({ refresh_token: "old-refresh" }));
	});

	it("prefers device_token over token when both are present", async () => {
		const fetchMock: FetchImpl = async () =>
			jsonResponse({
				token: "legacy-access",
				device_token: "device-access",
				refresh_token: "new-refresh",
			});

		const credentials = await refreshQoderToken("old-refresh", fetchMock);

		expect(credentials.access).toBe("device-access");
		expect(credentials.refresh).toBe("new-refresh");
	});

	it("accepts device_token alone as the refreshed access token", async () => {
		const fetchMock: FetchImpl = async () => jsonResponse({ device_token: "device-only-access" });

		const credentials = await refreshQoderToken("old-refresh", fetchMock);

		expect(credentials).toMatchObject({ access: "device-only-access", refresh: "old-refresh" });
	});

	it("bounds an in-flight refresh request", async () => {
		const timeoutController = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
		const response = Promise.withResolvers<Response>();
		let requestSignal: AbortSignal | undefined;
		const fetchMock: FetchImpl = (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			requestSignal?.addEventListener("abort", () => response.reject(requestSignal?.reason), { once: true });
			return response.promise;
		};
		const result = refreshQoderToken("old-refresh", fetchMock).then(
			() => null,
			error => error,
		);

		try {
			expect(requestSignal).toBe(timeoutController.signal);
			expect(timeout).toHaveBeenCalledWith(20_000);
		} finally {
			timeoutController.abort(new DOMException("timed out", "TimeoutError"));
		}
		await expect(result).resolves.toMatchObject({ name: "TimeoutError" });
	});
	it("includes a 400 invalid_grant body so the dead credential gets disabled", async () => {
		const fetchMock: FetchImpl = async () =>
			jsonResponse({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }, 400);

		const error = await refreshQoderToken("dead-refresh", fetchMock).then(
			() => {
				throw new Error("refresh must fail");
			},
			(thrown: unknown) => thrown,
		);

		expect(error).toMatchObject({ name: "OAuthError", kind: "token-refresh", provider: "qoder", status: 400 });
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("invalid_grant");
		expect(isDefinitiveOAuthFailure(message)).toBe(true);
	});

	it("keeps the HTTP status when the failure body cannot be read", async () => {
		const brokenBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error("stream exploded"));
			},
		});
		const fetchMock: FetchImpl = async () => new Response(brokenBody, { status: 500 });

		await expect(refreshQoderToken("old-refresh", fetchMock)).rejects.toMatchObject({
			name: "OAuthError",
			kind: "token-refresh",
			provider: "qoder",
			status: 500,
			message: expect.stringContaining("(500)"),
		});
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
			"Cosy-Version": "1.1.2",
			"Cosy-MachineOS": `${arch}_${process.platform}`,
			"Cosy-Data-Policy": "disagree",
		});
	});
});

describe("wrapQoderSseFetch", () => {
	it("repairs SSE bodies when the content-type MIME is mixed-case", async () => {
		const broken = ['data: {"choices"', ':[{"delta":{"content":"ok"},"index":0}]}', "", "data: [DONE]", ""].join(
			"\n",
		);
		const wrapped = wrapQoderSseFetch(
			async () =>
				new Response(broken, {
					status: 200,
					headers: { "Content-Type": "Text/Event-Stream; charset=utf-8" },
				}),
		);

		const response = await wrapped("https://example.test/sse");
		const text = await response.text();

		expect(text).toContain('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}');
		expect(text).toContain("data: [DONE]");
	});
});
