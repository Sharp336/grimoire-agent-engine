import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import {
	closeGatewayHarness,
	createGatewayHarness,
	expectObject,
	type GatewayHarness,
	grantModelAccess,
	jsonHeaders,
	postChat,
	postPiNative,
	readJson,
} from "./auth-gateway-integration-helpers";

function credentials(keys: string[]): AuthCredential[] {
	return keys.map(key => ({ type: "api_key", key }));
}

describe("auth-gateway managed users", () => {
	let harness: GatewayHarness | undefined;

	afterEach(async () => {
		await closeGatewayHarness(harness);
		harness = undefined;
	});

	test("preserves legacy bearer and no-auth compatibility, including the old 401 shape", async () => {
		harness = await createGatewayHarness({ bearerTokens: ["legacy-token"] });
		let response = await postChat(harness.handle.url, "legacy-token");
		expect(response.status).toBe(200);
		response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
			method: "POST",
			headers: { ...jsonHeaders(), authorization: "bearer   legacy-token" },
			body: JSON.stringify({ model: "model-a", messages: [{ role: "user", content: "hello" }] }),
		});
		expect(response.status).toBe(200);
		expect(harness.models.get("model-a")?.calls).toHaveLength(2);

		response = await postChat(harness.handle.url, "wrong-token");
		expect(response.status).toBe(401);
		expect(await response.text()).toBe(JSON.stringify({ error: "unauthorized" }));

		await closeGatewayHarness(harness);
		harness = await createGatewayHarness({ bearerTokens: [] });
		response = await postChat(harness.handle.url, undefined);
		expect(response.status).toBe(200);
		expect(harness.models.get("model-a")?.calls).toHaveLength(1);

		response = await fetch(`${harness.handle.url}/v1/users`, { headers: jsonHeaders() });
		expect(response.status).toBe(403);
		expect(await readJson(response)).toEqual({
			error: { code: "management_auth_required", message: "Management routes require an authenticated admin token" },
		});
	});

	test("isolates managed users when a token is revoked or a user is disabled", async () => {
		harness = await createGatewayHarness({ credentials: credentials(["key-a", "key-b"]) });
		const alice = harness.accessStore.createUser({ name: "alice" });
		const bob = harness.accessStore.createUser({ name: "bob" });
		const pool = harness.accessStore.createPool({ name: "mockpool", provider: "mock" });
		harness.accessStore.addPoolCredential(pool.id, harness.credentialStore.listAuthCredentials("mock")[0]!.id);
		await grantModelAccess(harness.accessStore, alice.user.id, pool.id);
		await grantModelAccess(harness.accessStore, bob.user.id, pool.id);

		let response = await postChat(harness.handle.url, alice.token.value);
		expect(response.status).toBe(200);
		response = await postChat(harness.handle.url, bob.token.value);
		expect(response.status).toBe(200);

		expect(harness.accessStore.revokeUserToken(alice.user.id, alice.token.id)).toBe(true);
		response = await postChat(harness.handle.url, alice.token.value);
		expect(response.status).toBe(401);
		expect(await response.text()).toBe(JSON.stringify({ error: "unauthorized" }));

		response = await postChat(harness.handle.url, bob.token.value);
		expect(response.status).toBe(200);
		harness.accessStore.updateUser(bob.user.id, { enabled: false });
		response = await postChat(harness.handle.url, bob.token.value);
		expect(response.status).toBe(401);
	});

	test("enforces route/provider/model ACLs before upstream and fail-closes missing pools", async () => {
		const modelA = createMockModel({ provider: "mock", id: "model-a", handler: () => ({ content: ["a"] }) });
		const modelB = createMockModel({ provider: "mock", id: "model-b", handler: () => ({ content: ["b"] }) });
		harness = await createGatewayHarness({ models: [modelA, modelB] });
		const managed = harness.accessStore.createUser({ name: "carol" });

		let response = await postChat(harness.handle.url, managed.token.value);
		expect(response.status).toBe(403);
		expect(await readJson(response)).toEqual({
			error: { message: "Access denied by gateway policy", type: "permission_error" },
		});
		expect(modelA.calls).toHaveLength(0);

		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "route", pattern: "chat" });
		response = await postChat(harness.handle.url, managed.token.value);
		expect(response.status).toBe(403);
		expect(modelA.calls).toHaveLength(0);

		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "provider", pattern: "mock" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "model", pattern: "mock/model-a" });
		response = await postChat(harness.handle.url, managed.token.value);
		expect(response.status).toBe(403);
		expect(modelA.calls).toHaveLength(0);

		const knownHidden = await postChat(harness.handle.url, managed.token.value, "model-b");
		const randomHidden = await postChat(harness.handle.url, managed.token.value, "definitely-random-model");
		expect(knownHidden.status).toBe(403);
		expect(randomHidden.status).toBe(403);
		expect(await knownHidden.text()).toBe(await randomHidden.text());
	});

	test("applies managed ACL and pool checks to pi-native requests", async () => {
		const modelA = createMockModel({ provider: "mock", id: "model-a", handler: () => ({ content: ["pi-a"] }) });
		harness = await createGatewayHarness({ models: [modelA], credentials: credentials(["key-a"]) });
		const managed = harness.accessStore.createUser({ name: "pinativeuser" });

		let response = await postPiNative(harness.handle.url, managed.token.value);
		expect(response.status).toBe(403);
		expect(modelA.calls).toHaveLength(0);

		const pool = harness.accessStore.createPool({ name: "pinativepool", provider: "mock" });
		harness.accessStore.addPoolCredential(pool.id, harness.credentialStore.listAuthCredentials("mock")[0]!.id);
		await grantModelAccess(harness.accessStore, managed.user.id, pool.id);
		response = await postPiNative(harness.handle.url, managed.token.value);
		expect(response.status).toBe(200);
		expect(modelA.calls).toHaveLength(1);
		const events = harness.accessStore.listAudit({ userId: managed.user.id, limit: 10 }).events;
		expect(events.some(event => event.routeFamily === "pi-native" && event.outcome === "success")).toBe(true);
	});

	test("filters /v1/models by ACL, pool binding, and live matching pool members", async () => {
		const modelA = createMockModel({ provider: "mock", id: "model-a" });
		const modelB = createMockModel({ provider: "mock", id: "model-b" });
		harness = await createGatewayHarness({ models: [modelA, modelB], credentials: credentials(["key-a"]) });
		const managed = harness.accessStore.createUser({ name: "dana" });
		const pool = harness.accessStore.createPool({ name: "modelapool", provider: "mock", model: "model-a" });
		harness.accessStore.addPoolCredential(pool.id, harness.credentialStore.listAuthCredentials("mock")[0]!.id);
		await grantModelAccess(harness.accessStore, managed.user.id, pool.id, "mock/model-a");

		const response = await fetch(`${harness.handle.url}/v1/models`, { headers: jsonHeaders(managed.token.value) });
		expect(response.status).toBe(200);
		const body = expectObject(await readJson(response));
		const data = body.data;
		expect(Array.isArray(data)).toBe(true);
		expect((data as Array<{ id: string }>).map(model => model.id)).toEqual(["model-a"]);
	});

	test("lists managed models from one access snapshot per request", async () => {
		const modelA = createMockModel({ provider: "mock", id: "model-a" });
		const modelB = createMockModel({ provider: "mock", id: "model-b" });
		const modelC = createMockModel({ provider: "mock", id: "model-c" });
		harness = await createGatewayHarness({ models: [modelA, modelB, modelC], credentials: credentials(["key-a"]) });
		const managed = harness.accessStore.createUser({ name: "modelcache" });
		const pool = harness.accessStore.createPool({ name: "modelcachepool", provider: "mock" });
		harness.accessStore.addPoolCredential(pool.id, harness.credentialStore.listAuthCredentials("mock")[0]!.id);
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "route", pattern: "models" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "provider", pattern: "mock" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "model", pattern: "mock/*" });
		harness.accessStore.bindUserPool(managed.user.id, pool.id);

		const listAclRules = spyOn(harness.accessStore, "listAclRules");
		const listUserPools = spyOn(harness.accessStore, "listUserPools");
		const listStoredCredentials = spyOn(harness.storage, "listStoredCredentials");
		try {
			const response = await fetch(`${harness.handle.url}/v1/models`, { headers: jsonHeaders(managed.token.value) });
			expect(response.status).toBe(200);
			const body = expectObject(await readJson(response));
			const data = body.data as Array<{ id: string }>;
			expect(data.map(model => model.id)).toEqual(["model-a", "model-b", "model-c"]);
			expect(listAclRules).toHaveBeenCalledTimes(1);
			expect(listUserPools).toHaveBeenCalledTimes(1);
			expect(listStoredCredentials).toHaveBeenCalledTimes(1);
			expect(listStoredCredentials).toHaveBeenCalledWith("mock");
		} finally {
			listAclRules.mockRestore();
			listUserPools.mockRestore();
			listStoredCredentials.mockRestore();
		}
	});
});
