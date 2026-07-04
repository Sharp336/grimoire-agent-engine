/**
 * Regression test for broker-backed MCP OAuth refresh.
 *
 * Broker snapshots redact refresh tokens as `__remote__`. When an expired MCP
 * credential carries that sentinel, `prepareConfig` must ask the auth broker to
 * refresh the row by id instead of sending the sentinel to the MCP token
 * endpoint. The config should use the broker's fresh access token while the
 * stored MCP refresh metadata remains available for future refreshes.
 */
import { expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { AuthStorage, REMOTE_REFRESH_SENTINEL } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const SERVER_URL = "https://mcp-broker-refresh.example.com/mcp";
const TOKEN_URL = "https://auth.example.com/oauth/token";
const CLIENT_ID = "broker-mcp-client";
const AUTHORIZATION_URL = "https://auth.example.com/oauth/authorize";
const RESOURCE = "https://api.example.com/mcp-resource";

function authorizationHeader(config: MCPServerConfig): string | undefined {
	if (config.type !== "http" && config.type !== "sse") return undefined;
	return config.headers?.Authorization;
}

test("broker-backed MCP OAuth refresh uses the broker row id instead of POSTing the sentinel", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-broker-refresh-"));
	let authStorage: AuthStorage | undefined;
	const credentialId = mcpOAuthCredentialId(SERVER_URL);
	const refreshCalls: Array<{ provider: string; id: number }> = [];
	let rowId = -1;
	try {
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"), {
			refreshOAuthCredential: async (provider, id, credential) => {
				expect(provider).toBe(credentialId);
				expect(id).toBe(rowId);
				refreshCalls.push({ provider, id });
				expect(credential).toMatchObject({
					type: "oauth",
					access: "expired-access",
					refresh: REMOTE_REFRESH_SENTINEL,
					tokenUrl: TOKEN_URL,
					clientId: CLIENT_ID,
					authorizationUrl: AUTHORIZATION_URL,
					resource: RESOURCE,
				});
				return {
					access: "broker-access",
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: Date.now() + 3_600_000,
				};
			},
		});
		await authStorage.set(credentialId, {
			type: "oauth",
			access: "expired-access",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: Date.now() - 60_000,
			tokenUrl: TOKEN_URL,
			clientId: CLIENT_ID,
			authorizationUrl: AUTHORIZATION_URL,
			resource: RESOURCE,
		} as MCPStoredOAuthCredential);

		const storedBefore = authStorage.listStoredCredentials(credentialId);
		expect(storedBefore).toHaveLength(1);
		rowId = storedBefore[0]!.id;

		const fetchMock: typeof globalThis.fetch = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				throw new Error(`unexpected direct token endpoint fetch: ${String(input)}`);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		const manager = new MCPManager(tempDir);
		manager.setAuthStorage(authStorage);

		const prepared = await manager.prepareConfig({ type: "http", url: SERVER_URL });

		expect(refreshCalls).toEqual([{ provider: credentialId, id: rowId }]);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(authorizationHeader(prepared)).toBe("Bearer broker-access");

		const storedAfter = authStorage.listStoredCredentials(credentialId);
		expect(storedAfter).toHaveLength(1);
		expect(storedAfter[0]!.id).toBe(rowId);
		expect(storedAfter[0]!.credential).toMatchObject({
			type: "oauth",
			refresh: REMOTE_REFRESH_SENTINEL,
			tokenUrl: TOKEN_URL,
			clientId: CLIENT_ID,
			authorizationUrl: AUTHORIZATION_URL,
			resource: RESOURCE,
		});
	} finally {
		authStorage?.close();
		vi.restoreAllMocks();
		await Bun.sleep(0);
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
