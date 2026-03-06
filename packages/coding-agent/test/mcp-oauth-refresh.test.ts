import { afterEach, describe, expect, it, mock } from "bun:test";
import { refreshMCPOAuthToken, sanitizeTokenError, validateTokenUrl } from "../src/mcp/oauth-refresh";

// ─────────────────────────────────────────────────────────────────────────────
// validateTokenUrl
// ─────────────────────────────────────────────────────────────────────────────

describe("validateTokenUrl", () => {
	it("accepts HTTPS URLs with matching server origin", () => {
		expect(() => {
			validateTokenUrl("https://auth.example.com/token", "https://auth.example.com");
		}).not.toThrow();
	});

	it("accepts HTTPS URLs with matching auth server origin", () => {
		expect(() => {
			validateTokenUrl(
				"https://auth.provider.com/oauth/token",
				"https://api.example.com",
				"https://auth.provider.com",
			);
		}).not.toThrow();
	});

	it("allows HTTP for localhost", () => {
		expect(() => {
			validateTokenUrl("http://localhost:3000/token", "http://localhost:3000");
		}).not.toThrow();
	});

	it("allows HTTP for 127.0.0.1", () => {
		expect(() => {
			validateTokenUrl("http://127.0.0.1:8080/token", "http://127.0.0.1:8080");
		}).not.toThrow();
	});

	it("rejects HTTP for non-localhost", () => {
		expect(() => {
			validateTokenUrl("http://auth.example.com/token", "http://auth.example.com");
		}).toThrow(/HTTPS/);
	});

	it("rejects origin mismatch", () => {
		expect(() => {
			validateTokenUrl("https://evil.com/token", "https://auth.example.com");
		}).toThrow(/does not match/);
	});

	it("rejects origin mismatch even with auth server origin", () => {
		expect(() => {
			validateTokenUrl("https://evil.com/token", "https://api.example.com", "https://auth.example.com");
		}).toThrow(/does not match/);
	});

	it("rejects invalid URL", () => {
		expect(() => {
			validateTokenUrl("not-a-url", "https://example.com");
		}).toThrow(/Invalid token URL/);
	});

	// SSRF denylist
	it("rejects 10.x.x.x private IPs", () => {
		expect(() => {
			validateTokenUrl("https://10.0.0.1/token", "https://10.0.0.1");
		}).toThrow(/private/);
	});

	it("rejects 172.16-31.x.x private IPs", () => {
		expect(() => {
			validateTokenUrl("https://172.16.0.1/token", "https://172.16.0.1");
		}).toThrow(/private/);
	});

	it("rejects 192.168.x.x private IPs", () => {
		expect(() => {
			validateTokenUrl("https://192.168.1.1/token", "https://192.168.1.1");
		}).toThrow(/private/);
	});

	it("rejects 169.254.x.x link-local IPs", () => {
		expect(() => {
			validateTokenUrl("https://169.254.169.254/token", "https://169.254.169.254");
		}).toThrow(/private/);
	});

	it("rejects 0.0.0.0", () => {
		expect(() => {
			validateTokenUrl("https://0.0.0.0/token", "https://0.0.0.0");
		}).toThrow(/private/);
	});

	it("rejects IPv6 loopback ::1", () => {
		expect(() => {
			validateTokenUrl("https://[::1]/token", "https://[::1]");
		}).toThrow(/private/);
	});

	it("rejects fd00:: unique local addresses", () => {
		expect(() => {
			validateTokenUrl("https://[fd00::1]/token", "https://[fd00::1]");
		}).toThrow(/private/);
	});

	it("rejects fe80:: link-local addresses", () => {
		expect(() => {
			validateTokenUrl("https://[fe80::1]/token", "https://[fe80::1]");
		}).toThrow(/private/);
	});

	it("allows 172.15.x.x (not in private range)", () => {
		expect(() => {
			validateTokenUrl("https://172.15.0.1/token", "https://172.15.0.1");
		}).not.toThrow();
	});

	it("allows 172.32.x.x (not in private range)", () => {
		expect(() => {
			validateTokenUrl("https://172.32.0.1/token", "https://172.32.0.1");
		}).not.toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeTokenError
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizeTokenError", () => {
	it("extracts error and error_description from JSON", () => {
		const body = JSON.stringify({ error: "invalid_grant", error_description: "Token expired" });
		expect(sanitizeTokenError(body)).toBe("error: invalid_grant, description: Token expired");
	});

	it("extracts error only when no description", () => {
		const body = JSON.stringify({ error: "server_error" });
		expect(sanitizeTokenError(body)).toBe("error: server_error, description: none");
	});

	it("returns truncated body for non-JSON", () => {
		const body = "x".repeat(300);
		const result = sanitizeTokenError(body);
		expect(result.length).toBe(200);
		expect(result).toBe("x".repeat(200));
	});

	it("returns full body for short non-JSON", () => {
		const body = "Bad request";
		expect(sanitizeTokenError(body)).toBe("Bad request");
	});

	it("returns truncated body for JSON without recognized fields", () => {
		const body = JSON.stringify({ message: "something went wrong", details: "x".repeat(300) });
		const result = sanitizeTokenError(body);
		expect(result.length).toBeLessThanOrEqual(200);
	});

	it("handles empty body", () => {
		expect(sanitizeTokenError("")).toBe("");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// refreshMCPOAuthToken
// ─────────────────────────────────────────────────────────────────────────────

describe("refreshMCPOAuthToken", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("performs refresh_token grant and returns new credentials", async () => {
		const mockResponse = {
			ok: true,
			json: async () => ({
				access_token: "new-access-token",
				refresh_token: "new-refresh-token",
				expires_in: 7200,
			}),
		};
		globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as unknown as typeof fetch;

		const result = await refreshMCPOAuthToken({
			refreshToken: "old-refresh",
			tokenUrl: "https://auth.example.com/token",
			clientId: "my-client",
			scopes: "read write",
		});

		expect(result.access).toBe("new-access-token");
		expect(result.refresh).toBe("new-refresh-token");
		expect(result.scopes).toBe("read write");
		expect(result.expires).toBeGreaterThan(Date.now());

		// Verify the fetch was called correctly
		const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe("https://auth.example.com/token");
		expect(options.method).toBe("POST");
		expect(options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

		const body = new URLSearchParams(options.body);
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("old-refresh");
		expect(body.get("client_id")).toBe("my-client");
		expect(body.get("scope")).toBe("read write");
	});

	it("preserves original refresh token when server does not rotate", async () => {
		const mockResponse = {
			ok: true,
			json: async () => ({
				access_token: "new-access",
				// No refresh_token in response
				expires_in: 3600,
			}),
		};
		globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as unknown as typeof fetch;

		const result = await refreshMCPOAuthToken({
			refreshToken: "original-refresh",
			tokenUrl: "https://auth.example.com/token",
		});

		expect(result.access).toBe("new-access");
		expect(result.refresh).toBe("original-refresh");
	});

	it("defaults expires_in to 3600 when not provided", async () => {
		const before = Date.now();
		const mockResponse = {
			ok: true,
			json: async () => ({
				access_token: "new-access",
			}),
		};
		globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as unknown as typeof fetch;

		const result = await refreshMCPOAuthToken({
			refreshToken: "refresh",
			tokenUrl: "https://auth.example.com/token",
		});

		expect(result.expires).toBeGreaterThanOrEqual(before + 3600 * 1000);
		expect(result.expires).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
	});

	it("throws with sanitized error on failure", async () => {
		const mockResponse = {
			ok: false,
			status: 400,
			text: async () => JSON.stringify({ error: "invalid_grant", error_description: "Refresh token revoked" }),
		};
		globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as unknown as typeof fetch;

		await expect(
			refreshMCPOAuthToken({
				refreshToken: "bad-refresh",
				tokenUrl: "https://auth.example.com/token",
			}),
		).rejects.toThrow(/invalid_grant/);
	});

	it("does not send client_id/client_secret/scope when not provided", async () => {
		const mockResponse = {
			ok: true,
			json: async () => ({ access_token: "tok" }),
		};
		globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as unknown as typeof fetch;

		await refreshMCPOAuthToken({
			refreshToken: "refresh",
			tokenUrl: "https://auth.example.com/token",
		});

		const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
		const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
		expect(body.has("client_id")).toBe(false);
		expect(body.has("client_secret")).toBe(false);
		expect(body.has("scope")).toBe(false);
	});
});
