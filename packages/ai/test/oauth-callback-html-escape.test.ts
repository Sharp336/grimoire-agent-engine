import { describe, expect, it } from "bun:test";
import { OAuthCallbackFlow } from "../src/utils/oauth/callback-server";
import type { OAuthController, OAuthCredentials } from "../src/utils/oauth/types";

/**
 * End-to-end test for the OAuth callback HTML response builder. Spins up a
 * real local server via OAuthCallbackFlow.login(), captures the ephemeral
 * port via the captured redirectUri, sends a request with attacker-controlled
 * `error` / `error_description` query params, and asserts the rendered HTML
 * cannot escape the `<script type="application/json">` embedding block.
 *
 * Regression for: reflected XSS in oauth.html via JSON.stringify of error
 * fields embedded without `<` escaping.
 */
class HarnessFlow extends OAuthCallbackFlow {
	capturedRedirectUri?: string;
	override async generateAuthUrl(_state: string, redirectUri: string): Promise<{ url: string }> {
		this.capturedRedirectUri = redirectUri;
		return { url: "https://example.test/authorize" };
	}
	override async exchangeToken(): Promise<OAuthCredentials> {
		throw new Error("not reached: this test exercises the error path");
	}
}

async function probeCallback(query: string): Promise<{ body: string; status: number }> {
	let resolveAuthSeen!: () => void;
	const authSeen = new Promise<void>(resolve => {
		resolveAuthSeen = resolve;
	});
	const ctrl: OAuthController = {
		onAuth: () => resolveAuthSeen(),
	};

	const flow = new HarnessFlow(ctrl, 0); // port 0 = ephemeral
	const loginPromise = flow.login().catch((error: unknown) => error);
	await authSeen;

	const redirectUri = flow.capturedRedirectUri;
	if (!redirectUri) throw new Error("redirectUri was not captured");

	const res = await fetch(`${redirectUri}?${query}`);
	const body = await res.text();
	await loginPromise; // drain the promise (rejects on error path)
	return { body, status: res.status };
}

function extractServerStateJson(body: string): string {
	const scriptOpen = '<script id="server-state" type="application/json">';
	const start = body.indexOf(scriptOpen);
	if (start < 0) throw new Error(`oauth.html template missing ${scriptOpen}`);
	const end = body.indexOf("</script>", start + scriptOpen.length);
	if (end < 0) throw new Error("missing closing </script> for server-state block");
	return body.slice(start + scriptOpen.length, end).trim();
}

describe("OAuth callback HTML — XSS defense for reflected query params", () => {
	it("escapes </script> in error_description so it cannot close the JSON script block", async () => {
		const malicious = "</script><img src=x onerror=alert(1)>";
		const { body } = await probeCallback(`error=foo&error_description=${encodeURIComponent(malicious)}`);

		const jsonBlock = extractServerStateJson(body);

		// `</script>` must be unicode-escaped, not embedded verbatim.
		expect(jsonBlock.includes("</script>")).toBe(false);
		expect(jsonBlock.includes("\\u003c/script>")).toBe(true);

		// And the JSON still parses and round-trips the original payload.
		const parsed = JSON.parse(jsonBlock) as { ok: boolean; error?: string };
		expect(parsed.ok).toBe(false);
		expect(parsed.error).toContain(malicious);
	});

	it("escapes </script> in the bare `error` param (no error_description path)", async () => {
		const malicious = "</script><svg onload=alert(2)>";
		const { body } = await probeCallback(`error=${encodeURIComponent(malicious)}`);

		const jsonBlock = extractServerStateJson(body);
		expect(jsonBlock.includes("</script>")).toBe(false);
		expect(jsonBlock.includes("\\u003c/script>")).toBe(true);
		const parsed = JSON.parse(jsonBlock) as { ok: boolean; error?: string };
		expect(parsed.ok).toBe(false);
	});
});
