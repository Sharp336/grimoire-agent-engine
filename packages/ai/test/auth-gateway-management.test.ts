import { afterEach, describe, expect, test } from "bun:test";
import {
	closeGatewayHarness,
	createGatewayHarness,
	expectObject,
	type GatewayHarness,
	jsonHeaders,
	readJson,
} from "./auth-gateway-integration-helpers";

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
});
