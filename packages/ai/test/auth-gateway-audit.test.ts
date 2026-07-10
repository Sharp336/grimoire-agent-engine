import { afterEach, describe, expect, test } from "bun:test";
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
	readJson,
} from "./auth-gateway-integration-helpers";

function testCredentials(): AuthCredential[] {
	return [
		{ type: "api_key", key: "secret-query-token" },
		{
			type: "oauth",
			access: "oauth-access-secret",
			refresh: "oauth-refresh-secret",
			expires: Date.now() + 60_000,
			accountId: "acct-secret",
			projectId: "project-secret",
			email: "secret@example.com",
		},
	];
}

async function collectStreamText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let out = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		out += decoder.decode(value, { stream: true });
	}
	return out + decoder.decode();
}

describe("auth-gateway audit", () => {
	let harness: GatewayHarness | undefined;

	afterEach(async () => {
		await closeGatewayHarness(harness);
		harness = undefined;
	});

	test("records success, denial, upstream error, and abort outcomes without request secrets", async () => {
		const abortStarted = Promise.withResolvers<void>();
		let callIndex = 0;
		const model = createMockModel({
			provider: "mock",
			id: "model-a",
			handler: async (_ctx, opts) => {
				callIndex += 1;
				if (callIndex === 1)
					return {
						content: ["ok"],
						usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, totalTokens: 10, cost: { total: 0.12 } },
					};
				if (callIndex === 2)
					return {
						throw: Object.assign(new Error("upstream raw secret oauth-access-secret exploded"), { status: 502 }),
					};
				if (callIndex === 3)
					return {
						content: ["stream-ok"],
						usage: { input: 5, output: 6, totalTokens: 11, cost: { total: 0.34 } },
					};
				abortStarted.resolve();
				const signal = opts?.signal;
				if (!signal) throw new Error("missing abort signal");
				await new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("client aborted")), { once: true });
				});
				throw new Error("unreachable abort wait completed");
			},
		});
		harness = await createGatewayHarness({ models: [model], credentials: testCredentials() });
		const [apiKeyRow] = harness.credentialStore.listAuthCredentials("mock");
		if (!apiKeyRow) throw new Error("expected credential row");
		const user = harness.accessStore.createUser({ name: "audited" });
		const pool = harness.accessStore.createPool({ name: "auditpool", provider: "mock" });
		harness.accessStore.addPoolCredential(pool.id, apiKeyRow.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		let response = await fetch(
			`${harness.handle.url}/v1/chat/completions?token=secret-query-token#oauth-access-secret`,
			{
				method: "POST",
				headers: jsonHeaders(user.token.value),
				body: JSON.stringify({
					model: "model-a",
					messages: [{ role: "user", content: "body has oauth-refresh-secret" }],
				}),
			},
		);
		expect(response.status).toBe(200);

		const denied = harness.accessStore.createUser({ name: "denied" });
		response = await postChat(harness.handle.url, denied.token.value);
		expect(response.status).toBe(403);

		response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBeGreaterThanOrEqual(500);

		response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
			method: "POST",
			headers: jsonHeaders(user.token.value),
			body: JSON.stringify({ model: "model-a", stream: true, messages: [{ role: "user", content: "stream" }] }),
		});
		expect(response.status).toBe(200);
		expect(await collectStreamText(response)).toContain("stream-ok");

		const controller = new AbortController();
		const abortResponse = await fetch(`${harness.handle.url}/v1/chat/completions`, {
			method: "POST",
			headers: jsonHeaders(user.token.value),
			body: JSON.stringify({ model: "model-a", stream: true, messages: [{ role: "user", content: "abort" }] }),
			signal: controller.signal,
		});
		const abortBody = collectStreamText(abortResponse).catch(() => "");
		await abortStarted.promise;
		controller.abort();
		await abortBody;

		const page = harness.accessStore.listAudit({ limit: 10 });
		const outcomes = page.events.map(event => event.outcome);
		expect(outcomes).toContain("success");
		expect(outcomes).toContain("denied_by_acl");
		expect(outcomes).toContain("upstream_error");
		expect(outcomes).toContain("request_aborted");
		const success = page.events.find(event => event.outcome === "success" && event.totalTokens === 10);
		expect(success).toMatchObject({
			inputTokens: 3,
			outputTokens: 4,
			cacheReadTokens: 1,
			cacheWriteTokens: 2,
			costUsd: 0.12,
		});
		const streamSuccess = page.events.find(event => event.outcome === "success" && event.totalTokens === 11);
		expect(streamSuccess).toMatchObject({ inputTokens: 5, outputTokens: 6, costUsd: 0.34 });

		const persisted = JSON.stringify(page.events);
		expect(persisted).not.toContain("secret-query-token");
		expect(persisted).not.toContain("oauth-access-secret");
		expect(persisted).not.toContain("oauth-refresh-secret");
		expect(persisted).not.toContain("acct-secret");
		expect(persisted).not.toContain("project-secret");
		expect(persisted).not.toContain("secret@example.com");
	});

	test("returns scoped usage summaries, redacted credential checks, and newest-first audit pagination", async () => {
		harness = await createGatewayHarness({
			credentials: [
				{ type: "api_key", key: "out-of-pool-secret" },
				{ type: "api_key", key: "in-pool-secret" },
			],
		});
		const [, oauthRow] = harness.credentialStore.listAuthCredentials("mock");
		if (!oauthRow) throw new Error("expected second credential row");
		const user = harness.accessStore.createUser({ name: "summaryuser" });
		const pool = harness.accessStore.createPool({ name: "summarypool", provider: "mock" });
		harness.accessStore.addPoolCredential(pool.id, oauthRow.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		let response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(200);
		response = await fetch(`${harness.handle.url}/v1/usage?since=0`, { headers: jsonHeaders(user.token.value) });
		expect(response.status).toBe(200);
		let body = expectObject(await readJson(response));
		const usage = expectObject(body.usage);
		expect(usage.userId).toBe(user.user.id);
		expect(expectObject(usage.totals).requests).toBeGreaterThanOrEqual(1);

		response = await fetch(`${harness.handle.url}/v1/credentials/check`, { headers: jsonHeaders(user.token.value) });
		expect(response.status).toBe(200);
		body = expectObject(await readJson(response));
		const credentials = body.credentials as Array<Record<string, unknown>>;
		expect(credentials).toBeArrayOfSize(1);
		expect(credentials[0]?.member).toBe(1);
		expect(credentials[0]).not.toHaveProperty("id");
		const serialized = JSON.stringify(body);
		expect(serialized).toContain("member");
		expect(serialized).not.toContain("secret-query-token");
		expect(serialized).not.toContain("secret@example.com");
		expect(serialized).not.toContain("acct-secret");
		expect(serialized).not.toContain("project-secret");
		expect(serialized).not.toContain("oauth-access-secret");

		response = await fetch(`${harness.handle.url}/v1/audit?userId=${user.user.id}&limit=1`, {
			headers: jsonHeaders("legacy-token"),
		});
		expect(response.status).toBe(200);
		body = expectObject(await readJson(response));
		expect(body.events).toBeArrayOfSize(1);
		const nextBefore = body.nextBefore;
		expect(typeof nextBefore === "number" || nextBefore === null).toBe(true);
		if (typeof nextBefore === "number") {
			response = await fetch(
				`${harness.handle.url}/v1/audit?userId=${user.user.id}&limit=100&before=${nextBefore}`,
				{ headers: jsonHeaders("legacy-token") },
			);
			expect(response.status).toBe(200);
			const nextPage = expectObject(await readJson(response));
			expect(nextPage.events).toBeArray();
		}
	});
});
