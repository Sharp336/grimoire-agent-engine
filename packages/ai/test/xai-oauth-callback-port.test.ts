import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { loginXAIGrokBuild } from "@oh-my-pi/pi-ai/registry/oauth/xai-oauth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const discoveryFetch: FetchImpl = async () =>
	new Response(
		JSON.stringify({
			authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
			token_endpoint: "https://auth.x.ai/oauth2/token",
			userinfo_endpoint: "https://auth.x.ai/oauth2/userinfo",
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);

function occupyLoopbackPort(): { port: number; release: () => void } {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
	const { port } = server;
	if (typeof port !== "number") {
		server.stop(true);
		throw new Error("Bun.serve({ port: 0 }) did not assign a numeric port");
	}
	return { port, release: () => server.stop(true) };
}

describe("Grok Build OAuth callback port", () => {
	it("fails fast when its registered callback port is occupied", async () => {
		const blocker = occupyLoopbackPort();
		let authStarted = false;
		try {
			const login = loginXAIGrokBuild(
				{
					onPrompt: async () => "",
					onAuth: () => {
						authStarted = true;
					},
					fetch: discoveryFetch,
				},
				blocker.port,
			);

			await expect(login).rejects.toMatchObject({
				name: "OAuthError",
				kind: "configuration",
				provider: "xai-grok-build",
				message: expect.stringContaining(`OAuth callback port ${blocker.port} is in use`),
				cause: expect.any(AIError.ConfigurationError),
			});
			expect(authStarted).toBe(false);
		} finally {
			blocker.release();
		}
	});

	it("advertises the configured registered callback port when it is available", async () => {
		const reservedPort = occupyLoopbackPort();
		const { port: callbackPort } = reservedPort;
		reservedPort.release();
		const abort = new AbortController();
		let redirectUri: string | undefined;

		const login = loginXAIGrokBuild(
			{
				onPrompt: async () => "",
				onAuth: info => {
					redirectUri = new URL(info.url).searchParams.get("redirect_uri") ?? undefined;
					abort.abort();
				},
				fetch: discoveryFetch,
				signal: abort.signal,
			},
			callbackPort,
		);

		await expect(login).rejects.toBeInstanceOf(AIError.LoginCancelledError);
		expect(redirectUri).toBe(`http://127.0.0.1:${callbackPort}/callback`);
	});
});
