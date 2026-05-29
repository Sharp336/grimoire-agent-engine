import { describe, expect, it } from "bun:test";
import {
	loginCommandCode,
	sanitizeCommandCodeApiKey,
	startCommandCodeAuthServer,
} from "../src/utils/oauth/commandcode";

async function waitUntilAuthUrl(getUrl: () => string, timeoutMs = 1_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let url = getUrl();
	while (!url) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for Command Code auth URL");
		await Bun.sleep(1);
		url = getUrl();
	}
	return url;
}

describe("Command Code browser-assisted login", () => {
	it("accepts the browser callback and returns its API key", async () => {
		let authUrl = "";
		const loginPromise = loginCommandCode(
			{
				onAuth: info => {
					authUrl = info.url;
				},
				onPrompt: async () => {
					throw new Error("manual prompt should not be used");
				},
			},
			{ startAuthServer: () => startCommandCodeAuthServer({ startPort: 0 }) },
		);

		const url = new URL(await waitUntilAuthUrl(() => authUrl));
		const callback = new URL(url.searchParams.get("callback") ?? "");
		const state = url.searchParams.get("state") ?? "";
		expect(callback.hostname).toBe("127.0.0.1");
		const response = await fetch(callback, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
			body: JSON.stringify({ apiKey: "user_browser_key", state }),
		});

		expect(response.status).toBe(200);
		expect(await loginPromise).toBe("user_browser_key");
	});

	it("falls back to sanitized manual key input when callback transfer times out", async () => {
		const key = await loginCommandCode(
			{ onPrompt: async () => "\u001b[200~ user_manual_key\n\u001b[201~" },
			{
				authTimeoutMs: 1,
				startAuthServer: () => startCommandCodeAuthServer({ startPort: 0 }),
			},
		);

		expect(key).toBe("user_manual_key");
	});

	it("serves the CORS preflight expected by the Command Code browser page", async () => {
		const authServer = await startCommandCodeAuthServer({ startPort: 0 });
		try {
			const response = await fetch(`http://127.0.0.1:${authServer.port}/callback`, {
				method: "OPTIONS",
				headers: {
					Origin: "https://commandcode.ai",
					"Access-Control-Request-Headers": "content-type,x-requested-with",
				},
			});
			expect(response.status).toBe(204);
			expect(response.headers.get("access-control-allow-origin")).toBe("https://commandcode.ai");
			expect(response.headers.get("access-control-allow-private-network")).toBe("true");
		} finally {
			authServer.server.stop(true);
		}
	});

	it("sanitizes bracketed paste API keys", () => {
		expect(sanitizeCommandCodeApiKey("\u001b[200~ user_key \n\u001b[201~")).toBe("user_key");
	});
});
