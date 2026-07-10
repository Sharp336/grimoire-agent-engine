import { afterEach, describe, expect, test } from "bun:test";
import type { AuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import {
	closeGatewayHarness,
	createGatewayHarness,
	type GatewayHarness,
	grantModelAccess,
	jsonHeaders,
	postChat,
	postPiNative,
	readJson,
} from "./auth-gateway-integration-helpers";

const OAUTH_SOURCE = "auth-gateway-pools-test";

function farExpiry(): number {
	return Date.now() + 60 * 60_000;
}

function oauthCredential(label: string): AuthCredential {
	return {
		type: "oauth",
		access: label,
		refresh: `refresh-${label}`,
		expires: farExpiry(),
		accountId: `account-${label}`,
		email: `${label}@example.com`,
	};
}

function registerMockOAuthProvider(): void {
	registerOAuthProvider({
		id: "mock",
		name: "Gateway Pool Mock OAuth",
		sourceId: OAUTH_SOURCE,
		async login() {
			return { access: "login", refresh: "login", expires: farExpiry() };
		},
		async refreshToken(credentials: OAuthCredentials) {
			return credentials;
		},
		getApiKey(credentials: OAuthCredentials) {
			return credentials.access;
		},
	});
}

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

async function collectStreamText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let out = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value, { stream: true });
	}
	return out + decoder.decode();
}

describe("auth-gateway credential pools", () => {
	let harness: GatewayHarness | undefined;

	afterEach(async () => {
		unregisterOAuthProviders(OAUTH_SOURCE);
		await closeGatewayHarness(harness);
		harness = undefined;
	});

	test("prefers exact model pools over provider-wide pools and passes the scoped policy to AuthStorage", async () => {
		const modelA = createMockModel({
			provider: "mock",
			id: "model-a",
			handler: (_ctx, opts) => ({ content: [`used:${typeof opts?.apiKey === "string" ? opts.apiKey : "none"}`] }),
		});
		const modelB = createMockModel({
			provider: "mock",
			id: "model-b",
			handler: (_ctx, opts) => ({ content: [`used:${typeof opts?.apiKey === "string" ? opts.apiKey : "none"}`] }),
		});
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

	test("round-robin pools advance in member order across new sessions", async () => {
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
		const user = harness.accessStore.createUser({ name: "roundrobin" });
		const pool = harness.accessStore.createPool({
			name: "roundrobinpool",
			provider: "mock",
			strategy: "round-robin",
		});
		harness.accessStore.addPoolCredential(pool.id, keyA.id);
		harness.accessStore.addPoolCredential(pool.id, keyB.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		for (const session of ["rr-a", "rr-b", "rr-c"]) {
			const response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: jsonHeaders(user.token.value),
				body: JSON.stringify({
					model: "model-a",
					messages: [{ role: "user", content: "hello" }],
					prompt_cache_key: session,
				}),
			});
			expect(response.status).toBe(200);
		}

		expect(seenKeys).toEqual(["key-a", "key-b", "key-a"]);
	});

	test("round-robin mixed pools advance across OAuth and API-key members", async () => {
		registerMockOAuthProvider();
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
		harness = await createGatewayHarness({
			models: [model],
			credentials: [oauthCredential("oauth-a"), { type: "api_key", key: "api-b" }],
		});
		const [oauthRow, apiRow] = harness.credentialStore.listAuthCredentials("mock");
		if (!oauthRow || !apiRow) throw new Error("expected mixed rows");
		const user = harness.accessStore.createUser({ name: "mixedrr" });
		const pool = harness.accessStore.createPool({ name: "mixedrrpool", provider: "mock", strategy: "round-robin" });
		harness.accessStore.addPoolCredential(pool.id, apiRow.id);
		harness.accessStore.addPoolCredential(pool.id, oauthRow.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		for (const session of ["mixed-rr-a", "mixed-rr-b", "mixed-rr-c"]) {
			const response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: jsonHeaders(user.token.value),
				body: JSON.stringify({
					model: "model-a",
					messages: [{ role: "user", content: "hello" }],
					prompt_cache_key: session,
				}),
			});
			expect(response.status).toBe(200);
		}

		expect(seenKeys).toEqual(["api-b", "oauth-a", "api-b"]);
	});

	test("sticky-session pools reuse the same member for the same prompt cache key", async () => {
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
		const user = harness.accessStore.createUser({ name: "stickyuser" });
		const pool = harness.accessStore.createPool({ name: "stickypool", provider: "mock", strategy: "sticky-session" });
		harness.accessStore.addPoolCredential(pool.id, keyA.id);
		harness.accessStore.addPoolCredential(pool.id, keyB.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		for (let index = 0; index < 2; index += 1) {
			const response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: jsonHeaders(user.token.value),
				body: JSON.stringify({
					model: "model-a",
					messages: [{ role: "user", content: "hello" }],
					prompt_cache_key: "same-sticky-session",
				}),
			});
			expect(response.status).toBe(200);
		}

		expect(seenKeys).toHaveLength(2);
		expect(seenKeys[1]).toBe(seenKeys[0]);
	});

	test("least-used API-key pools keep configured order when no usage signal exists", async () => {
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
		const user = harness.accessStore.createUser({ name: "leastapi" });
		const pool = harness.accessStore.createPool({ name: "leastapipool", provider: "mock", strategy: "least-used" });
		harness.accessStore.addPoolCredential(pool.id, keyA.id);
		harness.accessStore.addPoolCredential(pool.id, keyB.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		for (const session of ["least-a", "least-b"]) {
			const response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: jsonHeaders(user.token.value),
				body: JSON.stringify({
					model: "model-a",
					messages: [{ role: "user", content: "hello" }],
					prompt_cache_key: session,
				}),
			});
			expect(response.status).toBe(200);
		}

		expect(seenKeys).toEqual(["key-a", "key-a"]);
	});

	test("failover pools use configured order and switch only after block", async () => {
		const seenKeys: string[] = [];
		const model = createMockModel({
			provider: "mock",
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				seenKeys.push(key);
				if (key === "key-a" && seenKeys.length > 1) {
					return { throw: Object.assign(new Error("usage limit reached: failover-a"), { status: 429 }) };
				}
				return { content: [`used:${key}`] };
			},
		});
		harness = await createGatewayHarness({ models: [model], credentials: seededCredentials() });
		const [keyA, keyB] = harness.credentialStore.listAuthCredentials("mock");
		if (!keyA || !keyB) throw new Error("expected credential rows");
		const user = harness.accessStore.createUser({ name: "failoverorder" });
		const pool = harness.accessStore.createPool({
			name: "failoverorderpool",
			provider: "mock",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(pool.id, keyA.id);
		harness.accessStore.addPoolCredential(pool.id, keyB.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		let response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:key-a");
		response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
			method: "POST",
			headers: jsonHeaders(user.token.value),
			body: JSON.stringify({
				model: "model-a",
				messages: [{ role: "user", content: "hello" }],
				prompt_cache_key: "failover-after-block",
			}),
		});
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:key-b");
		expect(seenKeys).toEqual(["key-a", "key-a", "key-b"]);
	});

	test("does not retry outside the pool and rewrites exhausted pools to rate-limit errors", async () => {
		const model = createMockModel({
			provider: "mock",
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				if (key === "key-a") {
					const error = Object.assign(new Error("You have hit your ChatGPT usage limit. Try again later."), {
						status: 429,
					});
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
		const exhaustedPool = harness.accessStore.createPool({
			name: "exhaustedpool",
			provider: "mock",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(exhaustedPool.id, keyA.id);
		await grantModelAccess(harness.accessStore, exhaustedUser.user.id, exhaustedPool.id);
		response = await postChat(harness.handle.url, exhaustedUser.token.value);
		expect(response.status).toBe(429);
		const text = await response.text();
		expect(text).toContain("No eligible credential is available for this request");
		expect(text).toContain("rate_limit_error");
		expect(text).not.toContain("outside-key");

		const piUser = harness.accessStore.createUser({ name: "piexhausted" });
		const piPool = harness.accessStore.createPool({
			name: "piexhaustedpool",
			provider: "mock",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(piPool.id, keyA.id);
		await grantModelAccess(harness.accessStore, piUser.user.id, piPool.id);
		response = await postPiNative(harness.handle.url, piUser.token.value);
		expect(response.status).toBe(429);
		const piText = await response.text();
		expect(piText).toContain("No eligible credential is available for this request");
		expect(piText).toContain("rate_limit_error");
		expect(piText).not.toContain("outside-key");
	});

	test("mixed OAuth usage-limit retries with the next API-key member", async () => {
		registerMockOAuthProvider();
		const seenKeys: string[] = [];
		const model = createMockModel({
			provider: "mock",
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				seenKeys.push(key);
				if (key === "oauth-limited") {
					return { throw: Object.assign(new Error("usage limit reached: oauth-limited"), { status: 429 }) };
				}
				return { content: [`used:${key}`] };
			},
		});
		harness = await createGatewayHarness({
			models: [model],
			credentials: [oauthCredential("oauth-limited"), { type: "api_key", key: "api-healthy" }],
		});
		const [oauthRow, apiRow] = harness.credentialStore.listAuthCredentials("mock");
		if (!oauthRow || !apiRow) throw new Error("expected mixed rows");
		const user = harness.accessStore.createUser({ name: "mixedlimit" });
		const pool = harness.accessStore.createPool({ name: "mixedlimitpool", provider: "mock", strategy: "failover" });
		harness.accessStore.addPoolCredential(pool.id, oauthRow.id);
		harness.accessStore.addPoolCredential(pool.id, apiRow.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		const response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:api-healthy");
		expect(seenKeys).toEqual(["oauth-limited", "api-healthy"]);
	});

	test("legacy retry failures keep their upstream error", async () => {
		const usageModel = createMockModel({
			provider: "mock",
			id: "usage-model",
			handler: () => ({
				throw: Object.assign(new Error("usage limit reached: legacy-usage-sentinel"), { status: 429 }),
			}),
		});
		const authModel = createMockModel({
			provider: "mock",
			id: "auth-model",
			handler: () => ({
				throw: Object.assign(new Error("401 invalid_api_key legacy-auth-sentinel"), { status: 401 }),
			}),
		});
		harness = await createGatewayHarness({
			models: [usageModel, authModel],
			credentials: [{ type: "api_key", key: "legacy-key" }],
		});

		let response = await postChat(harness.handle.url, "legacy-token", "usage-model");
		let text = await response.text();
		expect(text).toContain("legacy-usage-sentinel");
		expect(text).not.toContain("No eligible credential is available for this request");

		await closeGatewayHarness(harness);
		harness = await createGatewayHarness({
			models: [usageModel, authModel],
			credentials: [{ type: "api_key", key: "legacy-key" }],
		});
		response = await postChat(harness.handle.url, "legacy-token", "auth-model");
		text = await response.text();
		expect(text).toContain("legacy-auth-sentinel");
		expect(text).not.toContain("No eligible credential is available for this request");
	});

	test("explicit invalidation with no remaining member is 503", async () => {
		const model = createMockModel({
			provider: "mock",
			id: "model-a",
			handler: () => ({
				throw: Object.assign(new Error("401 invalid_api_key selected-sentinel"), { status: 401 }),
			}),
		});
		harness = await createGatewayHarness({
			models: [model],
			credentials: [{ type: "api_key", key: "selected-key" }],
		});
		const [row] = harness.credentialStore.listAuthCredentials("mock");
		if (!row) throw new Error("expected credential row");
		const user = harness.accessStore.createUser({ name: "selectedinvalid" });
		const pool = harness.accessStore.createPool({
			name: "selectedinvalidpool",
			provider: "mock",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(pool.id, row.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		const response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(503);
		const body = await readJson(response);
		expect(body).toMatchObject({
			error: {
				type: "no_eligible_credential",
				message: "No eligible credential is available for this request",
			},
		});
	});

	test("stream audit distinguishes no eligible credential from usage limit", async () => {
		const model = createMockModel({
			provider: "mock",
			id: "model-a",
			handler: () => ({
				throw: Object.assign(new Error("401 invalid_api_key selected-stream-sentinel"), { status: 401 }),
			}),
		});
		harness = await createGatewayHarness({
			models: [model],
			credentials: [{ type: "api_key", key: "selected-key" }],
		});
		const [row] = harness.credentialStore.listAuthCredentials("mock");
		if (!row) throw new Error("expected credential row");
		const user = harness.accessStore.createUser({ name: "streaminvalid" });
		const pool = harness.accessStore.createPool({
			name: "streaminvalidpool",
			provider: "mock",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(pool.id, row.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		const response = await postChat(harness.handle.url, user.token.value, "model-a", true);
		expect(response.status).toBe(200);
		expect(await collectStreamText(response)).toContain("No eligible credential is available for this request");
		const audit = harness.accessStore.listAudit({ userId: user.user.id, limit: 5 }).events[0];
		expect(audit).toMatchObject({
			outcome: "no_eligible_credential",
			statusCode: 503,
			errorCode: "no_eligible_credential",
		});
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
