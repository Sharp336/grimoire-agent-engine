/**
 * ClinePass API-key `/login` validation (the manual paste path).
 *
 * ClinePass routes runtime requests through `max_completion_tokens`, and its
 * reasoning models return a 5xx `empty response content` when a 1-token budget
 * leaves no room after thinking. The generic validator's default probe
 * (`max_tokens: 1`) would therefore risk rejecting a valid key on the ClinePass
 * endpoint, so ClinePass validation overrides the probe to use the runtime
 * token field with a real budget.
 *
 * These tests target `loginClinepassApiKey` directly (the paste flow);
 * `loginClinepass` is the dispatcher that tries the Cline CLI WorkOS creds
 * first — covered in clinepass-oauth.test.ts.
 */
import { describe, expect, it } from "bun:test";

import { loginClinepass, loginClinepassApiKey } from "@oh-my-pi/pi-ai/registry/clinepass";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

function makeController(fetchImpl: FetchImpl): Parameters<typeof loginClinepassApiKey>[0] {
	return {
		fetch: fetchImpl,
		onPrompt: async () => "sk_TESTKEY",
		onAuth: () => {},
		onProgress: () => {},
	};
}

describe("loginClinepassApiKey", () => {
	it("probes chat completions with the runtime token field and a real budget", async () => {
		let capturedUrl = "";
		let capturedAuth = "";
		let capturedBody: Record<string, unknown> = {};
		const fetchImpl: FetchImpl = async (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
			capturedBody = init?.body ? JSON.parse(init.body as string) : {};
			return new Response(JSON.stringify({ success: true, data: { choices: [] } }), { status: 200 });
		};

		const key = await loginClinepassApiKey(makeController(fetchImpl));

		expect(key).toBe("sk_TESTKEY");
		const url = new URL(capturedUrl);
		expect(url.host).toBe("api.cline.bot");
		expect(url.pathname).toBe("/api/v1/chat/completions");
		expect(capturedAuth).toBe("Bearer sk_TESTKEY");
		expect(capturedBody.model).toBe("cline-pass/glm-5.2");
		// The runtime field + a budget that survives reasoning — NOT `max_tokens: 1`.
		expect(capturedBody.max_completion_tokens).toBe(256);
		expect(capturedBody.max_tokens).toBeUndefined();
		// The probe reads only the response status, so it must not open an SSE stream.
		expect(capturedBody.stream).toBe(false);
	});

	it("falls back to a static key when Cline CLI token refresh fails", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(JSON.stringify({ success: true, data: { choices: [] } }), { status: 200 });

		const key = await loginClinepass(makeController(fetchImpl), {
			loginFromCli: async () => {
				throw new Error("refresh token revoked");
			},
		});

		expect(key).toBe("sk_TESTKEY");
	});

	it("surfaces upstream auth failures with status and body", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response('{"error":"Invalid API key.","success":false}', { status: 401, statusText: "Unauthorized" });

		await expect(loginClinepassApiKey(makeController(fetchImpl))).rejects.toThrow(
			/ClinePass API key validation failed \(401\)/,
		);
	});
});

describe("loginClinepass", () => {
	it("accepts an imported WorkOS token that probes ClinePass successfully", async () => {
		const workosCreds = { access: "workos:eyJFAKE", refresh: "RefreshFake", expires: Date.now() + 3_600_000 };
		const fetchImpl: FetchImpl = async (_input, init) => {
			// The imported WorkOS token is probed against the ClinePass gateway.
			expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer workos:eyJFAKE");
			return new Response(JSON.stringify({ success: true, data: { choices: [] } }), { status: 200 });
		};
		const result = await loginClinepass(makeController(fetchImpl), {
			loginFromCli: async () => workosCreds,
		});
		expect(result).toBe(workosCreds);
	});

	it("falls back to a static key when the WorkOS token has no ClinePass subscription", async () => {
		const workosCreds = { access: "workos:eyJFAKE", refresh: "RefreshFake", expires: Date.now() + 3_600_000 };
		let probes = 0;
		const fetchImpl: FetchImpl = async (_input, init) => {
			probes++;
			const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
			if (auth.startsWith("Bearer workos:")) {
				// Cline usage-billing token — ClinePass rejects it (no subscription).
				return new Response('{"error":"No active ClinePass subscription","success":false}', {
					status: 403,
				});
			}
			// The static-key path validates the pasted key normally.
			return new Response(JSON.stringify({ success: true, data: { choices: [] } }), { status: 200 });
		};
		const result = await loginClinepass(makeController(fetchImpl), {
			loginFromCli: async () => workosCreds,
		});
		expect(result).toBe("sk_TESTKEY");
		expect(probes).toBe(2); // WorkOS probe rejected, then the static-key probe accepted
	});
});
