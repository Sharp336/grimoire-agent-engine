/**
 * ClinePass `/login` validation.
 *
 * ClinePass routes runtime requests through `max_completion_tokens`, and its
 * reasoning models return a 5xx `empty response content` when a 1-token budget
 * leaves no room after thinking. The generic validator's default probe
 * (`max_tokens: 1`) would therefore risk rejecting a valid key on the ClinePass
 * endpoint, so ClinePass validation overrides the probe to use the runtime
 * token field with a real budget.
 */
import { describe, expect, it } from "bun:test";

import { loginClinepass } from "@oh-my-pi/pi-ai/registry/clinepass";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

function makeController(fetchImpl: FetchImpl): Parameters<typeof loginClinepass>[0] {
	return {
		fetch: fetchImpl,
		onPrompt: async () => "sk_TESTKEY",
		onAuth: () => {},
		onProgress: () => {},
	};
}

describe("loginClinepass", () => {
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

		const key = await loginClinepass(makeController(fetchImpl));

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

	it("surfaces upstream auth failures with status and body", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response('{"error":"Invalid API key.","success":false}', { status: 401, statusText: "Unauthorized" });

		await expect(loginClinepass(makeController(fetchImpl))).rejects.toThrow(
			/ClinePass API key validation failed \(401\)/,
		);
	});
});
