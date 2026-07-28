import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { InfisicalProvider } from "../secrets/broker/provider-infisical";

/**
 * Tier-3 Task 1: Infisical provider adapter.
 *
 * The provider resolves a {@link SecretHandle} to a {@link SecretValue} via the
 * Infisical REST API. These tests mock the API with a local `Bun.serve()`
 * HTTP server on a random port. Fail-closed (R2): resolve() throws on a wrong
 * provider name, malformed itemId, or non-OK response.
 */
describe("Tier-3 Task 1: InfisicalProvider", () => {
	let server: { stop: (force?: boolean) => void; port?: number };
	let baseUrl: string;

	beforeEach(() => {
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				// Health endpoint.
				if (url.pathname === "/health") {
					return new Response("OK", { status: 200 });
				}
				// Auth login: /v1/auth/universal-auth/login — return a deterministic token.
				if (url.pathname === "/v1/auth/universal-auth/login") {
					return new Response(JSON.stringify({ accessToken: "test-token", expiresIn: 3600 }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				// Secret endpoint: /v3/secrets/<key>?environment=<env>&workspaceId=<id>
				const match = url.pathname.match(/^\/v3\/secrets\/(.+)$/);
				if (match) {
					const key = decodeURIComponent(match[1]);
					const env = url.searchParams.get("environment");
					const workspaceId = url.searchParams.get("workspaceId");
					const auth = req.headers.get("authorization");
					if (auth !== "Bearer test-token") {
						return new Response(JSON.stringify({ message: "unauthorized" }), {
							status: 401,
							headers: { "Content-Type": "application/json" },
						});
					}
					// Return a deterministic secret value keyed on env+key.
					if (env === "prod" && key === "CF_DNS_API_TOKEN" && workspaceId === "ws-123") {
						return new Response(
							JSON.stringify({
								secretKey: key,
								secretValue: "cf-token-abc123-very-secret",
								environment: env,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					return new Response(JSON.stringify({ message: "not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		baseUrl = `http://localhost:${server.port}`;
	});

	afterEach(() => {
		server.stop(true);
	});

	it("resolve() returns SecretValue with the correct value from the API", async () => {
		const provider = new InfisicalProvider({
			apiUrl: baseUrl,
			clientId: "test",
			clientSecret: "test",
			workspaceId: "ws-123",
		});
		const result = await provider.resolve({
			provider: "infisical",
			itemId: "prod/CF_DNS_API_TOKEN",
		});
		expect(result.handle.itemId).toBe("prod/CF_DNS_API_TOKEN");
		expect(result.value).toBe("cf-token-abc123-very-secret");
	});

	it("resolve() splits itemId correctly into env + key (prod/CF_DNS_API_TOKEN)", async () => {
		// Verify the API received the correct env + key by using a unique pair
		// only the correct split would match.
		const provider = new InfisicalProvider({
			apiUrl: baseUrl,
			clientId: "test",
			clientSecret: "test",
			workspaceId: "ws-123",
		});
		const result = await provider.resolve({
			provider: "infisical",
			itemId: "prod/CF_DNS_API_TOKEN",
		});
		expect(result.value).toBe("cf-token-abc123-very-secret");
	});

	it("resolve() fails-closed (throws) on a 404 response", async () => {
		const provider = new InfisicalProvider({
			apiUrl: baseUrl,
			clientId: "test",
			clientSecret: "test",
			workspaceId: "ws-123",
		});
		expect(provider.resolve({ provider: "infisical", itemId: "prod/MISSING_KEY" })).rejects.toThrow(
			/404|InfisicalProvider/,
		);
	});

	it("resolve() fails-closed (throws) on a wrong provider name", async () => {
		const provider = new InfisicalProvider({
			apiUrl: baseUrl,
			clientId: "test",
			clientSecret: "test",
			workspaceId: "ws-123",
		});
		expect(provider.resolve({ provider: "bitwarden", itemId: "prod/CF_DNS_API_TOKEN" })).rejects.toThrow(
			/infisical/i,
		);
	});

	it("resolve() fails-closed (throws) on a malformed itemId (no slash)", async () => {
		const provider = new InfisicalProvider({
			apiUrl: baseUrl,
			clientId: "test",
			clientSecret: "test",
			workspaceId: "ws-123",
		});
		expect(provider.resolve({ provider: "infisical", itemId: "no-slash-here" })).rejects.toThrow(
			/itemId|InfisicalProvider/i,
		);
	});

	it("isAvailable() returns true when the health endpoint responds 200", async () => {
		const provider = new InfisicalProvider({
			apiUrl: baseUrl,
			clientId: "test",
			clientSecret: "test",
			workspaceId: "ws-123",
		});
		expect(await provider.isAvailable()).toBe(true);
	});

	it("isAvailable() returns false when the server is down", async () => {
		// Stop the server, then point at the now-dead port.
		const deadPort = server.port;
		server.stop(true);
		const provider = new InfisicalProvider({
			apiUrl: `http://localhost:${deadPort}`,
			clientId: "test",
			clientSecret: "test",
			workspaceId: "ws-123",
		});
		expect(await provider.isAvailable()).toBe(false);
	});

	it("name is 'infisical'", () => {
		const provider = new InfisicalProvider({
			apiUrl: baseUrl,
			clientId: "test",
			clientSecret: "test",
			workspaceId: "ws-123",
		});
		expect(provider.name).toBe("infisical");
	});
});

/**
 * S6 fix: InfisicalProvider.resolve() prefers the CLI (via SSH to the VPS
 * where `infisical` is installed and authenticated) over the REST API.
 *
 * Why: self-hosted Infisical v0.43.91 returns "Blind index not found" for the
 * REST v3 secrets endpoint with our query shape (`?environment=&workspaceId=`).
 * The CLI on the VPS works against the same backend, so we make CLI primary
 * and keep REST as a fallback for environments where the CLI is unreachable.
 *
 * These tests inject a mock `executor` to control CLI behaviour without
 * touching SSH, the VPS, or the infisical binary.
 */
describe("S6: InfisicalProvider CLI primary (resolve prefers CLI over REST)", () => {
	let server: { stop: (force?: boolean) => void; port?: number };
	let baseUrl: string;
	let cliCalls: { args: string[]; env?: Record<string, string> }[];

	beforeEach(() => {
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/health") return new Response("OK", { status: 200 });
				if (url.pathname === "/v1/auth/universal-auth/login") {
					return new Response(JSON.stringify({ accessToken: "test-token", expiresIn: 3600 }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url.pathname.match(/^\/v3\/secrets\//)) {
					return new Response(
						JSON.stringify({
							secretKey: "CF_DNS_API_TOKEN",
							secretValue: "rest-value-should-not-be-used",
							environment: "prod",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
		});
		baseUrl = `http://localhost:${server.port}`;
		cliCalls = [];
	});

	afterEach(() => {
		server.stop(true);
	});

	function makeProvider(
		executor: (
			args: string[],
			env?: Record<string, string>,
		) => Promise<{
			exitCode: number;
			stdout: string;
			stderr: string;
		}>,
	) {
		return new InfisicalProvider({
			apiUrl: baseUrl,
			clientId: "test-client-id",
			clientSecret: "test-client-secret",
			workspaceId: "ws-123",
			executor: async (args, env) => {
				cliCalls.push({ args, env });
				return executor(args, env);
			},
		});
	}

	it("resolve() returns the CLI value when CLI succeeds (REST is not consulted)", async () => {
		const provider = makeProvider(async () => ({
			exitCode: 0,
			stdout: "cli-value-very-secret\n",
			stderr: "",
		}));
		const result = await provider.resolve({
			provider: "infisical",
			itemId: "prod/CF_DNS_API_TOKEN",
		});
		expect(result.value).toBe("cli-value-very-secret");
		expect(cliCalls).toHaveLength(1);
	});

	it("resolve() builds the SSH + infisical CLI command with --env and --plain", async () => {
		const provider = makeProvider(async () => ({
			exitCode: 0,
			stdout: "value",
			stderr: "",
		}));
		await provider.resolve({
			provider: "infisical",
			itemId: "prod/CF_DNS_API_TOKEN",
		});
		// Default sshTarget is ["ssh", "ovh-vps6"]; CLI command shape is:
		// ssh ovh-vps6 infisical secrets get KEY --env=ENV --plain
		expect(cliCalls).toHaveLength(1);
		const args = cliCalls[0].args;
		expect(args[0]).toBe("ssh");
		expect(args[1]).toBe("ovh-vps6");
		expect(args).toContain("infisical");
		expect(args).toContain("secrets");
		expect(args).toContain("get");
		expect(args).toContain("CF_DNS_API_TOKEN");
		expect(args).toContain("--env=prod");
		expect(args).toContain("--plain");
	});

	it("resolve() falls back to REST when the CLI exits non-zero", async () => {
		const provider = makeProvider(async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "ssh: connect failed",
		}));
		const result = await provider.resolve({
			provider: "infisical",
			itemId: "prod/CF_DNS_API_TOKEN",
		});
		// REST mock returns "rest-value-should-not-be-used" so we know it was consulted.
		expect(result.value).toBe("rest-value-should-not-be-used");
		// CLI was attempted exactly once.
		expect(cliCalls).toHaveLength(1);
	});

	it("resolve() throws when both CLI and REST fail", async () => {
		const provider = makeProvider(async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "cli failed",
		}));
		// Stop the REST server too so REST also fails.
		server.stop(true);
		await expect(provider.resolve({ provider: "infisical", itemId: "prod/CF_DNS_API_TOKEN" })).rejects.toThrow(
			/InfisicalProvider/,
		);
		// CLI was attempted (proves CLI was tried before REST).
		expect(cliCalls.length).toBeGreaterThanOrEqual(1);
	});

	it("resolve() trims trailing whitespace from the CLI stdout", async () => {
		const provider = makeProvider(async () => ({
			exitCode: 0,
			stdout: "  secret-value  \n",
			stderr: "",
		}));
		const result = await provider.resolve({
			provider: "infisical",
			itemId: "prod/CF_DNS_API_TOKEN",
		});
		expect(result.value).toBe("secret-value");
	});

	it("resolve() never consults the CLI for a wrong provider name", async () => {
		const provider = makeProvider(async () => ({
			exitCode: 0,
			stdout: "should-not-be-used",
			stderr: "",
		}));
		await expect(provider.resolve({ provider: "bitwarden", itemId: "prod/CF_DNS_API_TOKEN" })).rejects.toThrow(
			/infisical/i,
		);
		expect(cliCalls).toHaveLength(0);
	});

	it("resolve() never consults the CLI for a malformed itemId", async () => {
		const provider = makeProvider(async () => ({
			exitCode: 0,
			stdout: "should-not-be-used",
			stderr: "",
		}));
		await expect(provider.resolve({ provider: "infisical", itemId: "no-slash" })).rejects.toThrow(
			/itemId|InfisicalProvider/i,
		);
		expect(cliCalls).toHaveLength(0);
	});
});
