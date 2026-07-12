import { afterEach, describe, expect, test } from "bun:test";
import { type AuthCredential, REMOTE_REFRESH_SENTINEL, type StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import {
	closeGatewayHarness,
	createGatewayHarness,
	expectObject,
	type GatewayHarness,
	jsonHeaders,
	readJson,
} from "./auth-gateway-integration-helpers";

type RemoteUpsertStore = GatewayHarness["credentialStore"] & {
	upsertAuthCredentialRemote?: (provider: string, credential: AuthCredential) => Promise<StoredAuthCredential[]>;
};

type RefreshPatchedStorage = GatewayHarness["storage"] & {
	refreshCredentialById: GatewayHarness["storage"]["refreshCredentialById"];
};

async function requestJson(
	baseUrl: string,
	method: string,
	path: string,
	token: string | undefined,
	body?: unknown,
): Promise<Response> {
	return fetch(`${baseUrl}${path}`, {
		method,
		headers: jsonHeaders(token),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe("auth-gateway management HTTP", () => {
	let harness: GatewayHarness | undefined;

	afterEach(async () => {
		await closeGatewayHarness(harness);
		harness = undefined;
	});

	test("requires an authenticated admin principal and rejects invalid management input", async () => {
		harness = await createGatewayHarness({ bearerTokens: [] });
		let response = await requestJson(harness.handle.url, "GET", "/v1/users", undefined);
		expect(response.status).toBe(403);
		expect(await readJson(response)).toEqual({
			error: { code: "management_auth_required", message: "Management routes require an authenticated admin token" },
		});
		await closeGatewayHarness(harness);

		harness = await createGatewayHarness();
		const regular = harness.accessStore.createUser({ name: "regular" });
		response = await requestJson(harness.handle.url, "GET", "/v1/users", regular.token.value);
		expect(response.status).toBe(403);
		expect(await readJson(response)).toEqual({
			error: { code: "forbidden", message: "Management routes require an admin token" },
		});

		response = await fetch(`${harness.handle.url}/v1/users`, {
			method: "POST",
			headers: jsonHeaders("legacy-token"),
			body: "{",
		});
		expect(response.status).toBe(400);
		expect(await readJson(response)).toEqual({ error: { code: "invalid_request", message: "Malformed JSON body" } });

		response = await requestJson(harness.handle.url, "POST", "/v1/users", "legacy-token", {
			name: "valid",
			unexpected: true,
		});
		expect(response.status).toBe(400);
	});

	test("implements users, one-time tokens, ACLs, pool bindings, usage, and audit pagination", async () => {
		harness = await createGatewayHarness();
		let response = await requestJson(harness.handle.url, "POST", "/v1/users", "legacy-token", {
			name: "alice",
			description: "first",
			owner: "team-a",
		});
		expect(response.status).toBe(201);
		let body = expectObject(await readJson(response));
		const user = expectObject(body.user);
		const userId = Number(user.id);
		const firstToken = expectObject(body.token);
		expect(typeof firstToken.value).toBe("string");
		expect(String(firstToken.value).startsWith("omp_gw_")).toBe(true);

		response = await requestJson(harness.handle.url, "POST", "/v1/users", "legacy-token", { name: "alice" });
		expect(response.status).toBe(409);
		response = await requestJson(harness.handle.url, "GET", `/v1/users/${userId}`, "legacy-token");
		expect(response.status).toBe(200);
		body = expectObject(await readJson(response));
		expect(body.tokens).toBeArray();
		expect(JSON.stringify(body.tokens)).not.toContain(String(firstToken.value));

		response = await requestJson(harness.handle.url, "PATCH", `/v1/users/${userId}`, "legacy-token", {
			enabled: false,
			role: "user",
			owner: null,
		});
		expect(response.status).toBe(200);
		expect(expectObject(expectObject(await readJson(response)).user).enabled).toBe(false);
		response = await requestJson(harness.handle.url, "POST", `/v1/users/${userId}/tokens`, "legacy-token", {
			label: "replacement",
		});
		expect(response.status).toBe(201);
		body = expectObject(await readJson(response));
		expect(typeof expectObject(body.token).value).toBe("string");
		response = await requestJson(harness.handle.url, "POST", `/v1/users/${userId}/tokens/rotate`, "legacy-token", {});
		expect(response.status).toBe(200);
		body = expectObject(await readJson(response));
		expect(typeof expectObject(body.token).value).toBe("string");

		response = await requestJson(harness.handle.url, "POST", `/v1/users/${userId}/acl`, "legacy-token", {
			effect: "allow",
			kind: "route",
			pattern: "chat",
		});
		expect(response.status).toBe(201);
		body = expectObject(await readJson(response));
		const aclId = Number(expectObject(body.rule).id);
		response = await requestJson(harness.handle.url, "POST", `/v1/users/${userId}/acl`, "legacy-token", {
			effect: "allow",
			kind: "route",
			pattern: "chat",
		});
		expect(response.status).toBe(200);
		response = await requestJson(harness.handle.url, "GET", `/v1/users/${userId}/acl`, "legacy-token");
		expect(response.status).toBe(200);
		response = await requestJson(harness.handle.url, "DELETE", `/v1/users/${userId}/acl/${aclId}`, "legacy-token");
		expect(response.status).toBe(204);

		response = await requestJson(harness.handle.url, "GET", `/v1/users/${userId}/usage?since=0`, "legacy-token");
		expect(response.status).toBe(200);
		expect(expectObject(await readJson(response))).toHaveProperty("usage");

		response = await requestJson(harness.handle.url, "GET", "/v1/audit?limit=1", "legacy-token");
		expect(response.status).toBe(200);
		body = expectObject(await readJson(response));
		expect(body.events).toBeArray();
		expect(body.nextBefore === null || typeof body.nextBefore === "number").toBe(true);

		response = await requestJson(harness.handle.url, "DELETE", `/v1/users/${userId}/tokens/999999`, "legacy-token");
		expect(response.status).toBe(404);
		response = await requestJson(harness.handle.url, "DELETE", `/v1/users/${userId}`, "legacy-token");
		expect(response.status).toBe(204);
		response = await requestJson(harness.handle.url, "GET", `/v1/users/${userId}`, "legacy-token");
		expect(response.status).toBe(404);
	});

	test("implements pool CRUD and validates live credential/provider pool members", async () => {
		harness = await createGatewayHarness({ credentials: [{ type: "api_key", key: "mock-key" }] });
		const [credential] = harness.credentialStore.listAuthCredentials("mock");
		if (!credential) throw new Error("expected credential row");

		let response = await requestJson(harness.handle.url, "POST", "/v1/pools", "legacy-token", {
			name: "mainpool",
			provider: "mock",
			model: "model-a",
			strategy: "round-robin",
		});
		expect(response.status).toBe(201);
		const body = expectObject(await readJson(response));
		const poolId = Number(expectObject(body.pool).id);
		response = await requestJson(harness.handle.url, "POST", "/v1/pools", "legacy-token", {
			name: "mainpool",
			provider: "mock",
		});
		expect(response.status).toBe(409);

		response = await requestJson(harness.handle.url, "GET", "/v1/pools", "legacy-token");
		expect(response.status).toBe(200);
		expect(expectObject(await readJson(response)).pools).toBeArray();
		response = await requestJson(harness.handle.url, "GET", `/v1/pools/${poolId}`, "legacy-token");
		expect(response.status).toBe(200);
		response = await requestJson(harness.handle.url, "PATCH", `/v1/pools/${poolId}`, "legacy-token", {
			name: "renamed",
			strategy: "failover",
		});
		expect(response.status).toBe(200);

		response = await requestJson(harness.handle.url, "POST", `/v1/pools/${poolId}/members`, "legacy-token", {
			credentialId: credential.id,
		});
		expect(response.status).toBe(201);
		response = await requestJson(harness.handle.url, "POST", `/v1/pools/${poolId}/members`, "legacy-token", {
			credentialId: credential.id,
		});
		expect(response.status).toBe(200);
		response = await requestJson(harness.handle.url, "POST", `/v1/pools/${poolId}/members`, "legacy-token", {
			credentialId: 999999,
		});
		expect(response.status).toBe(400);
		response = await requestJson(
			harness.handle.url,
			"DELETE",
			`/v1/pools/${poolId}/members/${credential.id}`,
			"legacy-token",
		);
		expect(response.status).toBe(204);

		const user = harness.accessStore.createUser({ name: "bindinguser" });
		response = await requestJson(harness.handle.url, "POST", `/v1/users/${user.user.id}/pools`, "legacy-token", {
			poolId,
		});
		expect(response.status).toBe(201);
		response = await requestJson(harness.handle.url, "POST", `/v1/users/${user.user.id}/pools`, "legacy-token", {
			poolId,
		});
		expect(response.status).toBe(200);
		response = await requestJson(
			harness.handle.url,
			"DELETE",
			`/v1/users/${user.user.id}/pools/${poolId}`,
			"legacy-token",
		);
		expect(response.status).toBe(204);

		response = await requestJson(harness.handle.url, "DELETE", `/v1/pools/${poolId}`, "legacy-token");
		expect(response.status).toBe(204);
		response = await requestJson(harness.handle.url, "GET", `/v1/pools/${poolId}`, "legacy-token");
		expect(response.status).toBe(404);
	});

	test("implements admin status, auth envelopes, and redacted credential lifecycle", async () => {
		harness = await createGatewayHarness({
			credentials: [
				{ type: "api_key", key: "seed-api-key-secret" },
				{
					type: "oauth",
					access: "seed-oauth-access-secret",
					refresh: "seed-oauth-refresh-secret",
					expires: 1_900_000_000_000,
					email: "alice@example.com",
					accountId: "acct-1",
					projectId: "proj-1",
					enterpriseUrl: "https://enterprise.example.com",
					apiEndpoint: "https://api.example.com",
				},
			],
		});
		const admin = harness.accessStore.createUser({ name: "admin", role: "admin" });
		const regular = harness.accessStore.createUser({ name: "regular" });

		let response = await requestJson(harness.handle.url, "GET", "/v1/admin/status", undefined);
		expect(response.status).toBe(401);
		expect(await readJson(response)).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });

		response = await requestJson(harness.handle.url, "GET", "/v1/chat/completions", undefined);
		expect(response.status).toBe(401);
		expect(await readJson(response)).toEqual({ error: "unauthorized" });

		response = await requestJson(harness.handle.url, "GET", "/v1/admin/status", regular.token.value);
		expect(response.status).toBe(403);
		expect(await readJson(response)).toEqual({
			error: { code: "forbidden", message: "Management routes require an admin token" },
		});

		response = await requestJson(harness.handle.url, "GET", "/v1/admin/status", admin.token.value);
		expect(response.status).toBe(200);
		let body = expectObject(await readJson(response));
		const status = expectObject(body.status);
		expect(status.ok).toBe(true);
		expect(status.version).toBe("dev");
		expect(status.serverTime).toBeNumber();
		expect(status.principal).toEqual({
			kind: "managed",
			userId: admin.user.id,
			name: "admin",
			role: "admin",
			tokenId: admin.token.id,
		});
		expect(status.counts).toMatchObject({ users: 2, activeTokens: 2, pools: 0, credentials: 2 });

		response = await requestJson(harness.handle.url, "GET", "/v1/admin/credentials", admin.token.value);
		expect(response.status).toBe(200);
		body = expectObject(await readJson(response));
		expect(body.credentials).toBeArray();
		const serialized = JSON.stringify(body);
		expect(serialized).toContain("alice@example.com");
		expect(serialized).not.toContain("seed-api-key-secret");
		expect(serialized).not.toContain("seed-oauth-access-secret");
		expect(serialized).not.toContain("seed-oauth-refresh-secret");
		expect(serialized).not.toContain(REMOTE_REFRESH_SENTINEL);

		let uploadCalled = false;
		const currentHarness = harness;
		if (!currentHarness) throw new Error("expected gateway harness");
		const remoteStore = currentHarness.credentialStore as RemoteUpsertStore;
		remoteStore.upsertAuthCredentialRemote = async (provider, credential) => {
			uploadCalled = true;
			return currentHarness.credentialStore.upsertAuthCredentialForProvider(provider, credential);
		};
		response = await requestJson(currentHarness.handle.url, "POST", "/v1/admin/credentials", admin.token.value, {
			provider: "mock",
			credential: { type: "api_key", key: "uploaded-api-key-secret" },
		});
		expect(response.status).toBe(200);
		expect(uploadCalled).toBe(true);
		body = expectObject(await readJson(response));
		expect(body.credentials).toBeArray();
		expect(JSON.stringify(body)).not.toContain("uploaded-api-key-secret");

		remoteStore.upsertAuthCredentialRemote = async () => {
			throw new Error("uploaded-api-key-secret should not leak");
		};
		response = await requestJson(harness.handle.url, "POST", "/v1/admin/credentials", admin.token.value, {
			provider: "mock",
			credential: { type: "api_key", key: "failing-api-key-secret" },
		});
		expect(response.status).toBe(502);
		expect(await readJson(response)).toEqual({
			error: { code: "credential_upload_failed", message: "Credential upload failed" },
		});
		response = await requestJson(harness.handle.url, "POST", "/v1/admin/credentials", admin.token.value, {
			provider: "mock",
			credential: { type: "api_key", key: "" },
		});
		expect(response.status).toBe(400);
		expect(await readJson(response)).toEqual({
			error: { code: "invalid_request", message: "Invalid credential payload" },
		});

		const rows = harness.credentialStore.listAuthCredentials("mock");
		const oauthRow = rows.find(row => row.credential.type === "oauth");
		const apiKeyRow = rows.find(row => row.credential.type === "api_key");
		if (!oauthRow || !apiKeyRow) throw new Error("expected seeded credential rows");
		const refreshStorage = harness.storage as RefreshPatchedStorage;
		refreshStorage.refreshCredentialById = async id => ({
			id,
			provider: "mock",
			identityKey: "mock:alice@example.com",
			credential: {
				type: "oauth",
				access: "refreshed-oauth-access-secret",
				refresh: REMOTE_REFRESH_SENTINEL,
				expires: 1_950_000_000_000,
				email: "alice@example.com",
				accountId: "acct-1",
				projectId: "proj-1",
				enterpriseUrl: "https://enterprise.example.com",
				apiEndpoint: "https://api.example.com",
			},
		});
		response = await requestJson(
			harness.handle.url,
			"POST",
			`/v1/admin/credentials/${oauthRow.id}/refresh`,
			admin.token.value,
			{},
		);
		expect(response.status).toBe(200);
		body = expectObject(await readJson(response));
		expect(expectObject(body.credential).id).toBe(oauthRow.id);
		expect(JSON.stringify(body)).not.toContain("refreshed-oauth-access-secret");
		expect(JSON.stringify(body)).not.toContain(REMOTE_REFRESH_SENTINEL);

		response = await requestJson(
			harness.handle.url,
			"POST",
			`/v1/admin/credentials/${apiKeyRow.id}/refresh`,
			admin.token.value,
			{},
		);
		expect(response.status).toBe(400);
		expect(await readJson(response)).toEqual({
			error: { code: "credential_not_refreshable", message: "API-key credentials cannot be refreshed" },
		});
		response = await requestJson(
			harness.handle.url,
			"POST",
			"/v1/admin/credentials/999999/refresh",
			admin.token.value,
			{},
		);
		expect(response.status).toBe(404);
		expect(await readJson(response)).toEqual({ error: { code: "not_found", message: "credential not found" } });

		const pool = harness.accessStore.createPool({ name: "protected", provider: "mock" });
		harness.accessStore.addPoolCredential(pool.id, apiKeyRow.id);
		response = await requestJson(
			harness.handle.url,
			"DELETE",
			`/v1/admin/credentials/${apiKeyRow.id}`,
			admin.token.value,
		);
		expect(response.status).toBe(409);
		expect(await readJson(response)).toEqual({
			error: {
				code: "credential_in_use",
				message: `Credential ${apiKeyRow.id} is assigned to pool(s): protected`,
				details: { credentialId: apiKeyRow.id, pools: [{ id: pool.id, name: "protected" }] },
			},
		});
		expect(harness.storage.listStoredCredentialsByIds([apiKeyRow.id])).toHaveLength(1);

		response = await requestJson(
			harness.handle.url,
			"DELETE",
			`/v1/pools/${pool.id}/members/${apiKeyRow.id}`,
			admin.token.value,
		);
		expect(response.status).toBe(204);
		response = await requestJson(
			harness.handle.url,
			"DELETE",
			`/v1/admin/credentials/${apiKeyRow.id}`,
			admin.token.value,
		);
		expect(response.status).toBe(204);
		expect(harness.storage.listStoredCredentialsByIds([apiKeyRow.id])).toHaveLength(0);

		response = await requestJson(harness.handle.url, "DELETE", "/v1/admin/credentials/999999", admin.token.value);
		expect(response.status).toBe(404);
		expect(await readJson(response)).toEqual({ error: { code: "not_found", message: "credential not found" } });
	});

	test("implements ordered pool membership, pool users, and token rotation labels over HTTP", async () => {
		harness = await createGatewayHarness({
			credentials: [
				{ type: "api_key", key: "key-a" },
				{ type: "api_key", key: "key-b" },
				{ type: "api_key", key: "key-c" },
			],
		});
		const admin = harness.accessStore.createUser({ name: "admin", role: "admin" });
		const member = harness.accessStore.createUser({ name: "member" });
		const rows = harness.credentialStore.listAuthCredentials("mock");
		const [first, second, third] = rows;
		if (!first || !second || !third) throw new Error("expected credential rows");
		const pool = harness.accessStore.createPool({ name: "ordered", provider: "mock" });
		harness.accessStore.addPoolCredential(pool.id, first.id);
		harness.accessStore.addPoolCredential(pool.id, second.id);
		harness.accessStore.addPoolCredential(pool.id, third.id);

		let response = await requestJson(harness.handle.url, "PATCH", `/v1/pools/${pool.id}/members`, admin.token.value, {
			credentialIds: [third.id, first.id, second.id],
		});
		expect(response.status).toBe(200);
		let body = expectObject(await readJson(response));
		expect(expectObject(body.pool).members).toMatchObject([
			{ credentialId: third.id, position: 0 },
			{ credentialId: first.id, position: 1 },
			{ credentialId: second.id, position: 2 },
		]);

		for (const credentialIds of [
			[third.id, third.id, second.id],
			[third.id, first.id],
			[third.id, first.id, second.id, 999999],
			[third.id, first.id, "bad"],
		]) {
			response = await requestJson(harness.handle.url, "PATCH", `/v1/pools/${pool.id}/members`, admin.token.value, {
				credentialIds,
			});
			expect(response.status).toBe(400);
			expect(harness.accessStore.getPool(pool.id)?.members.map(memberRow => memberRow.credentialId)).toEqual([
				third.id,
				first.id,
				second.id,
			]);
		}

		const otherProviderRow = harness.credentialStore.upsertAuthCredentialForProvider("other", {
			type: "api_key",
			key: "wrong-provider-secret",
		})[0];
		if (!otherProviderRow) throw new Error("expected other provider credential row");
		harness.accessStore.addPoolCredential(pool.id, otherProviderRow.id);
		response = await requestJson(harness.handle.url, "PATCH", `/v1/pools/${pool.id}/members`, admin.token.value, {
			credentialIds: [third.id, first.id, second.id, otherProviderRow.id],
		});
		expect(response.status).toBe(400);
		expect(harness.accessStore.getPool(pool.id)?.members.map(memberRow => memberRow.credentialId)).toEqual([
			third.id,
			first.id,
			second.id,
			otherProviderRow.id,
		]);

		response = await requestJson(harness.handle.url, "POST", `/v1/users/${member.user.id}/pools`, admin.token.value, {
			poolId: pool.id,
		});
		expect(response.status).toBe(201);
		response = await requestJson(harness.handle.url, "GET", `/v1/pools/${pool.id}/users`, admin.token.value);
		expect(response.status).toBe(200);
		body = expectObject(await readJson(response));
		expect(body.users).toMatchObject([{ id: member.user.id, name: "member" }]);

		response = await requestJson(
			harness.handle.url,
			"POST",
			`/v1/users/${member.user.id}/tokens/rotate`,
			admin.token.value,
			{ label: "console rotate" },
		);
		expect(response.status).toBe(200);
		body = expectObject(await readJson(response));
		expect(expectObject(body.token).label).toBe("console rotate");
	});
});
