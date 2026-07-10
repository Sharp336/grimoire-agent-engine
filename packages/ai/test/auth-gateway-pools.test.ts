import { afterEach, describe, expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { AuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import {
	closeGatewayHarness,
	createGatewayHarness,
	grantModelAccess,
	jsonHeaders,
	postChat,
	postPiNative,
	readJson,
	type GatewayHarness,
} from "./auth-gateway-step4-helpers";

function seededCredentials(): AuthCredential[] {
	return [
		{ type: "api_key", key: "key-a" },
		{ type: "api_key", key: "key-b" },
		{ type: "api_key", key: "outside-key" },
	];
}

async function responseText(response: Response): Promise<string> {
	const body = await readJson(response);
	if (!body || typeof body !== "object" || !("choices" in body)) return "";
	const choices = body.choices;
	if (!Array.isArray(choices)) return "";
	const first = choices[0];
	if (!first || typeof first !== "object" || !("message" in first)) return "";
	const message = first.message;
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	return typeof message.content === "string" ? message.content : "";
}

describe("auth-gateway credential pools", () => {
	let harness: GatewayHarness | undefined;

	afterEach(async () => {
		await closeGatewayHarness(harness);
		harness = undefined;
	});

	test("prefers exact model pools over provider-wide pools and passes the scoped policy to AuthStorage", async () => {
		const modelA = createMockModel({ provider: "mock", id: "model-a", handler: (_ctx, opts) => ({ content: [`used:${typeof opts?.apiKey === "string" ? opts.apiKey : "none"}`] }) });
		const modelB = createMockModel({ provider: "mock", id: "model-b", handler: (_ctx, opts) => ({ content: [`used:${typeof opts?.apiKey === "string" ? opts.apiKey : "none"}`] }) });
		harness = await createGatewayHarness({ models: [modelA, modelB], credentials: seededCredentials() });
		const [keyA, keyB] = harness.credentialStore.listAuthCredentials("mock");
		if (!keyA || !keyB) throw new Error("expected credential rows");
		const user = harness.accessStore.createUser({ name: "pooluser" });
		const providerPool = harness.accessStore.createPool({ name: "providerpool", provider: "mock" });
		const exactPool = harness.accessStore.createPool({ name: "exactpool", provider: "mock", model: "model-a" });
		harness.accessStore.addPoolCredential(providerPool.id, keyB.id);
		harness.accessStore.addPoolCredential(exactPool.id, keyA.id);
		harness.accessStore.addAclRule(user.user.id, { effect: "allow", kind: "route", pattern: "chat" });
		harness.accessStore.addAclRule(user.user.id, { effect: "allow", kind: "provider", pattern: "mock" });
		harness.accessStore.addAclRule(user.user.id, { effect: "allow", kind: "model", pattern: "mock/*" });
		harness.accessStore.bindUserPool(user.user.id, providerPool.id);
		harness.accessStore.bindUserPool(user.user.id, exactPool.id);

		let response = await postChat(harness.handle.url, user.token.value, "model-a");
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:key-a");
		response = await postChat(harness.handle.url, user.token.value, "model-b");
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:key-b");
	});

	test("applies sticky-session, round-robin, least-used, and failover strategies inside the bound pool", async () => {
		const seenKeys: string[] = [];
		const model = createMockModel({
			provider: "mock",
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				seenKeys.push(key);
				return { content: [`used:${key}`] };
			},
		});
		harness = await createGatewayHarness({ models: [model], credentials: seededCredentials() });
		const [keyA, keyB] = harness.credentialStore.listAuthCredentials("mock");
		if (!keyA || !keyB) throw new Error("expected credential rows");

		for (const strategy of ["sticky-session", "round-robin", "least-used", "failover"] as const) {
			const user = harness.accessStore.createUser({ name: strategy.replace("-", "") });
			const pool = harness.accessStore.createPool({ name: `${strategy.replace("-", "")}pool`, provider: "mock", strategy });
			harness.accessStore.addPoolCredential(pool.id, keyA.id);
			harness.accessStore.addPoolCredential(pool.id, keyB.id);
			await grantModelAccess(harness.accessStore, user.user.id, pool.id);
			const first = await postChat(harness.handle.url, user.token.value);
			expect(first.status).toBe(200);
			const second = await fetch(`${harness.handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: jsonHeaders(user.token.value),
				body: JSON.stringify({ model: "model-a", messages: [{ role: "user", content: "hello" }], prompt_cache_key: `session-${strategy}` }),
			});
			expect(second.status).toBe(200);
		}

		expect(seenKeys).toContain("key-a");
		expect(seenKeys).toContain("key-b");
	});

	test("does not retry outside the pool and rewrites exhausted pools to rate-limit errors", async () => {
		const model = createMockModel({
			provider: "mock",
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				if (key === "key-a") {
					const error = Object.assign(new Error("You have hit your ChatGPT usage limit. Try again later."), { status: 429 });
					return { throw: error };
				}
				return { content: [`used:${key}`] };
			},
		});
		harness = await createGatewayHarness({ models: [model], credentials: seededCredentials() });
		const [keyA, keyB, outside] = harness.credentialStore.listAuthCredentials("mock");
		if (!keyA || !keyB || !outside) throw new Error("expected credential rows");
		const user = harness.accessStore.createUser({ name: "failoveruser" });
		const pool = harness.accessStore.createPool({ name: "failoverpool", provider: "mock", strategy: "failover" });
		harness.accessStore.addPoolCredential(pool.id, keyA.id);
		harness.accessStore.addPoolCredential(pool.id, keyB.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		let response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:key-b");

		const exhaustedUser = harness.accessStore.createUser({ name: "exhausted" });
		const exhaustedPool = harness.accessStore.createPool({ name: "exhaustedpool", provider: "mock", strategy: "failover" });
		harness.accessStore.addPoolCredential(exhaustedPool.id, keyA.id);
		await grantModelAccess(harness.accessStore, exhaustedUser.user.id, exhaustedPool.id);
		response = await postChat(harness.handle.url, exhaustedUser.token.value);
		expect(response.status).toBe(429);
		const text = await response.text();
		expect(text).toContain("No eligible credential is available for this request");
		expect(text).not.toContain("outside-key");

		const piUser = harness.accessStore.createUser({ name: "piexhausted" });
		const piPool = harness.accessStore.createPool({ name: "piexhaustedpool", provider: "mock", strategy: "failover" });
		harness.accessStore.addPoolCredential(piPool.id, keyA.id);
		await grantModelAccess(harness.accessStore, piUser.user.id, piPool.id);
		response = await postPiNative(harness.handle.url, piUser.token.value);
		expect(response.status).toBe(429);
		const piText = await response.text();
		expect(piText).toContain("No eligible credential is available for this request");
		expect(piText).not.toContain("outside-key");
	});

	test("returns 503 when a bound pool has no live provider-matching members", async () => {
		harness = await createGatewayHarness({ credentials: [{ type: "api_key", key: "other" }] });
		const user = harness.accessStore.createUser({ name: "emptylive" });
		const pool = harness.accessStore.createPool({ name: "emptypool", provider: "mock" });
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);
		const response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("no_eligible_credential");
	});
});
