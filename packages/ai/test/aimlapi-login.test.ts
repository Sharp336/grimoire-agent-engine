import { describe, expect, test } from "bun:test";
import { loginAimlApi } from "../src/registry/oauth/aimlapi";
import type { OAuthAuthInfo, OAuthController } from "../src/registry/oauth/types";

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Fetch mock returning queued responses in order, recording every call. */
function queuedFetch(responses: Response[]): { fetch: typeof fetch; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		const next = responses.shift();
		if (!next) throw new Error("unexpected extra fetch call");
		return next;
	}) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

function makeCallbacks(fetchImpl: typeof fetch): {
	controller: OAuthController;
	auth: OAuthAuthInfo[];
	progress: string[];
} {
	const auth: OAuthAuthInfo[] = [];
	const progress: string[] = [];
	return {
		controller: {
			fetch: fetchImpl,
			onAuth: info => auth.push(info),
			onProgress: message => progress.push(message),
		},
		auth,
		progress,
	};
}

describe("loginAimlApi (device authorization)", () => {
	test("starts authorization, shows consent URL, returns the issued key", async () => {
		const { fetch: fetchImpl, calls } = queuedFetch([
			jsonResponse({ requestId: "req_123", deviceCode: "dev_456", interval: 1, expiresIn: 900 }),
			jsonResponse({ status: "ready", apiKey: "aiml-test-key" }),
		]);
		const { controller, auth, progress } = makeCallbacks(fetchImpl);

		const key = await loginAimlApi(controller);

		expect(key).toBe("aiml-test-key");

		// Consent URL is built from the verification base, carrying the requestId.
		expect(auth).toHaveLength(1);
		expect(auth[0]?.url).toContain("/agent/authorize?request=req_123");
		expect(progress.at(-1)).toBe("Your API key was successfully generated.");

		// Start hits the authorizations endpoint with partner attribution.
		const startCall = calls[0];
		expect(startCall?.url).toContain("/v3/agent-auth/authorizations");
		const startHeaders = startCall?.init.headers as Record<string, string>;
		expect(startHeaders["X-AIMLAPI-Source"]).toBe("agent/oh-my-pi");
		expect(startHeaders["X-AIMLAPI-Partner-ID"]).toBeTruthy();
		const startBody = JSON.parse(String(startCall?.init.body)) as Record<string, unknown>;
		expect(startBody.agentName).toBe("Oh My Pi");
		expect(startBody.partnerName).toBe("oh-my-pi");

		// Poll hits the token endpoint with the device-code grant.
		const pollCall = calls[1];
		expect(pollCall?.url).toContain("/v3/agent-auth/token");
		const pollBody = JSON.parse(String(pollCall?.init.body)) as Record<string, unknown>;
		expect(pollBody.deviceCode).toBe("dev_456");
		expect(pollBody.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
	});

	test("throws when the authorization is denied", async () => {
		const { fetch: fetchImpl } = queuedFetch([
			jsonResponse({ requestId: "req_1", deviceCode: "dev_1", interval: 1, expiresIn: 900 }),
			jsonResponse({ status: "denied" }),
		]);
		const { controller } = makeCallbacks(fetchImpl);

		await expect(loginAimlApi(controller)).rejects.toThrow(/denied/i);
	});

	test("throws when the start response is incomplete", async () => {
		const { fetch: fetchImpl } = queuedFetch([jsonResponse({ requestId: "req_1" })]);
		const { controller } = makeCallbacks(fetchImpl);

		await expect(loginAimlApi(controller)).rejects.toThrow(/incomplete/i);
	});
});
