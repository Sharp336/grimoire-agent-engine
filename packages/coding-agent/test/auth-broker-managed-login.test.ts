import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

const SOURCE = "managed-login-test";
const originalAgentDir = getAgentDir();
let tempRoot: string | undefined;

afterEach(async () => {
	unregisterOAuthProviders(SOURCE);
	setAgentDir(originalAgentDir);
	if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
	tempRoot = undefined;
});

describe("auth-broker managed OAuth login", () => {
	test("reports a managed provider failure without exposing its raw credential-bearing error", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-login-"));
		setAgentDir(path.join(tempRoot, "agent"));
		const statusFile = path.join(tempRoot, "private", "oauth-status.json");
		registerOAuthProvider({
			id: "fixture-failed-oauth",
			name: "Fixture failed OAuth",
			sourceId: SOURCE,
			login: async () => {
				throw new Error("Authorization rejected: fixture-secret-token");
			},
		});
		await expect(
			runAuthBrokerCommand({ action: "login", flags: { json: true, provider: "fixture-failed-oauth", statusFile } }),
		).rejects.toThrow("oauth_login_failed");
		const wire = await fs.readFile(statusFile, "utf8");
		expect(JSON.parse(wire)).toMatchObject({ status: "failed", errorCode: "oauth_login_failed" });
		expect(wire).not.toContain("fixture-secret-token");
	});

	test("publishes only safe authorization and exact stored-row identity", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-login-"));
		setAgentDir(path.join(tempRoot, "agent"));
		const statusFile = path.join(tempRoot, "private", "oauth-status.json");
		registerOAuthProvider({
			id: "fixture-managed-oauth",
			name: "Fixture managed OAuth",
			sourceId: SOURCE,
			login: async callbacks => {
				callbacks.onAuth({
					url: "https://auth.openai.com/codex/device",
					instructions: "Enter code: ABCD-EFGH",
				});
				return {
					access: "fixture-access-token",
					refresh: "fixture-refresh-token",
					expires: Date.now() + 60_000,
					accountId: "fixture-account",
					email: "owner@example.test",
				};
			},
		});

		await runAuthBrokerCommand({
			action: "login",
			flags: {
				json: true,
				provider: "fixture-managed-oauth",
				statusFile,
			},
		});

		const wire = await fs.readFile(statusFile, "utf8");
		const status = JSON.parse(wire);
		expect(status).toMatchObject({
			schema: "omp.oauth_login_status.v1",
			status: "connected",
			loginProviderId: "fixture-managed-oauth",
			credentialProviderId: "fixture-managed-oauth",
			account: { accountId: "fixture-account", email: "owner@example.test" },
		});
		expect(status.account.credentialId).toBeInteger();
		expect(wire).not.toContain("fixture-access-token");
		expect(wire).not.toContain("fixture-refresh-token");
	});

	test("managed anthropic login stays authorization_required until the loopback callback arrives", async () => {
		// Regression for the live smoke failure (gctx:xekpacr8zqrhs69a): the real
		// `anthropic` provider is registered with `pasteCodeFlow: true` while its
		// flow is a loopback PKCE callback on port 54545. In managed mode the CLI
		// has no interactive readline, so the default manual-paste prompt that
		// `AuthStorage.login` synthesizes for paste-code providers rejects
		// immediately (`oauth_provider_requires_interactive_prompt`), loses the
		// race against the callback, and fails the whole login into `failed`. The
		// fix keeps the flow waiting on the callback instead, so the status file
		// must hold `authorization_required` until the real callback lands, then
		// reach `connected`.
		//
		// The real anthropic flow runs end-to-end: a real loopback callback server
		// (ephemeral port is read back from the authorization URL's redirect_uri)
		// and a stubbed global fetch answering only the token exchange.
		const tokenResponse = {
			access_token: "fixture-access-token",
			refresh_token: "fixture-refresh-token",
			expires_in: 3600,
			account: { uuid: "fixture-account-id", email_address: "owner@example.test" },
			organization: { uuid: "fixture-org-id", name: "Fixture Org" },
		};
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			if (url.startsWith("https://api.anthropic.com/v1/oauth/token")) {
				return new Response(JSON.stringify(tokenResponse), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch from anthropic flow: ${url}`);
		}) as typeof fetch;

		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-anthropic-"));
		setAgentDir(path.join(tempRoot, "agent"));
		const statusFile = path.join(tempRoot, "private", "oauth-status.json");

		try {
			const login = runAuthBrokerCommand({
				action: "login",
				flags: {
					json: true,
					provider: "anthropic",
					statusFile,
				},
			});
			// The login rejects quickly on the old code (the synthesized prompt
			// throws on its first awaited microtask); mark the rejection handled so
			// it cannot surface as an unhandled rejection before `await login`.
			void login.catch(() => undefined);

			// Await the status file, not a guessed sleep: its atomic write is the
			// signal that the CLI reached `onAuth`. Yield to the event loop between
			// reads so the concurrent login can make progress. Skip the initial
			// `pending` write; the first interesting state is `authorization_required`.
			let status: { status?: string; authorizationUrl?: string } | undefined;
			for (let attempts = 0; !status?.status && attempts < 1000; attempts++) {
				await Bun.sleep(0);
				try {
					status = JSON.parse(await fs.readFile(statusFile, "utf8")) as typeof status;
				} catch {
					status = undefined;
				}
				if (status?.status === "pending") status = undefined;
			}
			expect(status?.status).toBe("authorization_required");
			expect(status?.authorizationUrl).toStartWith("https://claude.ai/oauth/authorize");

			// Complete the flow through the real loopback callback endpoint. The
			// redirect target (actual bound port) and the CSRF state both come from
			// the authorization URL; a state mismatch would answer 500 without
			// resolving the flow. On the old code the login has already rejected by
			// now, so the `await login` below fails the test deterministically.
			const authRequest = new URL(status!.authorizationUrl!);
			const callbackUrl = new URL(authRequest.searchParams.get("redirect_uri")!);
			callbackUrl.searchParams.set("code", "fixture-callback-code");
			callbackUrl.searchParams.set("state", authRequest.searchParams.get("state") ?? "");
			const response = await originalFetch(callbackUrl);
			expect(response.status).toBe(200);

			await login;

			const wire = await fs.readFile(statusFile, "utf8");
			const final = JSON.parse(wire);
			expect(final).toMatchObject({
				schema: "omp.oauth_login_status.v1",
				status: "connected",
				loginProviderId: "anthropic",
				credentialProviderId: "anthropic",
				account: {
					accountId: "fixture-account-id",
					email: "owner@example.test",
					orgId: "fixture-org-id",
					orgName: "Fixture Org",
				},
			});
			expect(final.account.credentialId).toBeInteger();
			expect(wire).not.toContain("fixture-access-token");
			expect(wire).not.toContain("fixture-refresh-token");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
