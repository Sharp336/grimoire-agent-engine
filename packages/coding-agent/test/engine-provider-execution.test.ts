import { describe, expect, it } from "bun:test";
import {
	ProviderExecutionClient,
	ProviderExecutionError,
	type ProviderExecutionIdentity,
} from "../src/engine/provider-execution";
import { safeEngineErrorDetail } from "../src/engine/public-error";

const identity: ProviderExecutionIdentity = {
	expectedPrincipalId: "grimoire:user:test",
	agentInstanceRef: `grimoire://agents/~u/${"b".repeat(64)}/fixture`,
	attemptId: "fixture-attempt",
	bindingRevision: 1,
	installationId: `install_${"a".repeat(32)}`,
	dispatchRef: "gctx:2222222222222222",
	dispatchHash: `sha256:${"2".repeat(64)}`,
	executionDigest: `sha256:${"d".repeat(64)}`,
	originReceiptId: "origin-fixture",
	credentialGeneration: 1,
	routeRef: "gctx:3333333333333333",
	routeContentHash: `sha256:${"3".repeat(64)}`,
	providerAccountRef: "gctx:4444444444444444",
	providerAccountContentHash: `sha256:${"4".repeat(64)}`,
	providerId: "cheapai",
	modelId: "gpt-5.6-terra",
};

describe("ProviderExecutionClient", () => {
	it.each([
		{
			mode: "hosted_broker",
			api: "openai-completions",
			baseUrl: "https://core.invalid/runtime/provider-broker/v1",
		},
		{
			mode: "hosted_broker",
			api: "openai-completions",
			baseUrl: "http://10.42.71.145:18767/runtime/provider-broker/v1",
		},
		{
			mode: "hosted_broker",
			api: "openai-completions",
			baseUrl: "http://172.31.255.255/runtime/provider-broker/v1",
		},
		{
			mode: "hosted_broker",
			api: "openai-completions",
			baseUrl: "http://192.168.1.10/runtime/provider-broker/v1",
		},
		{ mode: "owner_local", api: "openai-responses", baseUrl: "https://provider.invalid/v1" },
		{ mode: "hosted_broker", api: "openai-responses", baseUrl: "https://core.invalid/runtime/provider-broker/v1" },
	])("resolves exact $mode $api material at $baseUrl", async ({ mode, api, baseUrl }) => {
		const credential = mode === "hosted_broker" ? `gri_pbr_${"a".repeat(48)}` : "fixture-secret";
		const client = new ProviderExecutionClient(
			"http://127.0.0.1/provider-execution",
			"local-token",
			async (_url, init) => {
				const request = JSON.parse(String(init?.body));
				return Response.json({
					...request,
					schema: "grimoire.provider_execution.result.v1",
					status: "ready",
					allowed: true,
					mode,
					providerRuntimeId: "artel-4444444444444444",
					api,
					baseUrl,
					credential,
					executionPin: "c".repeat(64),
				});
			},
		);
		expect(await client.resolve(identity)).toEqual({
			mode,
			providerRuntimeId: "artel-4444444444444444",
			api,
			baseUrl,
			credential,
			executionPin: "c".repeat(64),
		});
	});

	it("never accepts provider material from a descriptor and keeps a billing proposal typed without material", async () => {
		const proposal = {
			from: { model_id: identity.modelId, route_ref: identity.routeRef, account_ref: identity.providerAccountRef,
				effort: "high", service_tier: "standard", billing_pool_id: "included", billing_pool_basis: "expected" },
			to: { model_id: identity.modelId, route_ref: identity.routeRef, account_ref: identity.providerAccountRef,
				effort: "high", service_tier: "standard", billing_pool_id: "paid", billing_pool_basis: "expected" },
			from_execution_digest: `sha256:${"d".repeat(64)}`,
			reason: "billing_pool_exhausted",
		};
		const bodies: Record<string, unknown>[] = [];
		const client = new ProviderExecutionClient("http://127.0.0.1/provider-execution", "local-token",
			async (_url, init) => {
				const request = JSON.parse(String(init?.body));
				bodies.push(request);
				if (request.descriptorOnly)
					return Response.json({ ...request, schema: "grimoire.provider_execution.result.v1", status: "ready",
						allowed: true, secrets_returned: false, provider_credentials_returned: false,
						mode: "owner_local", providerRuntimeId: "artel-4444444444444444",
						api: "openai-completions", baseUrl: "https://provider.invalid/v1",
						credential: "must-not-leak" });
				return Response.json({ schema: "grimoire.provider_execution.result.v1", allowed: false,
					status: "billing_pool_changed", secrets_returned: false, billing: proposal });
			});
		expect(await client.describe(identity).then(() => null, error => error))
			.toMatchObject({ code: "provider_execution_invalid_response" });
		const denied = await client.resolve(identity).then(() => null, error => error);
		expect(denied).toBeInstanceOf(ProviderExecutionError);
		expect(denied).toMatchObject({ code: "billing_pool_changed", billing: proposal });
		expect(denied).not.toHaveProperty("credential");
		expect(bodies.map(body => [body.descriptorOnly === true, "materialOnly" in body]))
			.toEqual([[true, false], [false, false]]);
	});

	it("refuses the obsolete bare-pool proposal without yielding execution material", async () => {
		const client = new ProviderExecutionClient("http://127.0.0.1/provider-execution", "local-token", async () =>
			Response.json({ schema: "grimoire.provider_execution.result.v1", allowed: false, status: "billing_pool_changed",
				billing: { from: "included", to: "paid", from_execution_digest: identity.executionDigest, reason: "billing_pool_exhausted" } }));
		const error = await client.resolve(identity).then(() => null, reason => reason);
		expect(error).toBeInstanceOf(ProviderExecutionError);
		if (!(error instanceof ProviderExecutionError)) throw new Error("Expected a typed provider refusal");
		expect(error.code).toBe("billing_pool_changed");
		expect(error.billing).toBeUndefined();
		expect(error).not.toHaveProperty("credential");
	});

	it("surfaces fixed actionable trust text without reflecting a server message", async () => {
		const client = new ProviderExecutionClient("http://127.0.0.1/provider-execution", "local-token", async () =>
			Response.json({
				schema: "grimoire.provider_execution.result.v1",
				status: "provider_trust_required_for_full_agent",
				allowed: false,
				message: "raw untrusted server detail",
			}),
		);
		const error = await client.resolve(identity).catch(value => value);
		expect(error).toBeInstanceOf(ProviderExecutionError);
		expect(error.code).toBe("provider_trust_required_for_full_agent");
		expect(error.message).not.toContain("raw untrusted server detail");
		expect(safeEngineErrorDetail(error)).toBe(error.message);
	});

	it.each([
		{ mode: "owner_local", api: "openai-completions", baseUrl: "http://provider.invalid/v1" },
		{
			mode: "owner_local",
			api: "openai-responses",
			baseUrl: "http://10.42.71.145:18767/runtime/provider-broker/v1",
		},
		{ mode: "hosted_broker", api: "openai-completions", baseUrl: "http://10.42.71.145:18767/v1" },
		{
			mode: "hosted_broker",
			api: "openai-completions",
			baseUrl: "http://172.32.0.1/runtime/provider-broker/v1",
		},
		{
			mode: "hosted_broker",
			api: "openai-completions",
			baseUrl: "http://provider.invalid/runtime/provider-broker/v1",
		},
	])("rejects unsupported $mode $api transport at $baseUrl", async ({ mode, api, baseUrl }) => {
		const client = new ProviderExecutionClient("http://127.0.0.1/provider-execution", "local-token", async () =>
			Response.json({
				...identity,
				schema: "grimoire.provider_execution.result.v1",
				status: "ready",
				allowed: true,
				executionMode: "full_agent",
				mode,
				providerRuntimeId: "artel-4444444444444444",
				api,
				baseUrl,
				credential: mode === "hosted_broker" ? `gri_pbr_${"a".repeat(48)}` : "secret-value",
				executionPin: "a".repeat(64),
			}),
		);
		const error = await client.resolve(identity).catch(value => value);
		expect(error).toBeInstanceOf(ProviderExecutionError);
		expect(error.code).toBe("provider_execution_invalid_response");
	});

	it.each(["owner_local", "hosted_broker"])("rejects missing, malformed or replaced %s execution pins", async mode => {
		let pin: unknown;
		const client = new ProviderExecutionClient("http://127.0.0.1/provider-execution", "local-token", async () =>
			Response.json({
				...identity,
				schema: "grimoire.provider_execution.result.v1",
				status: "ready",
				allowed: true,
				executionMode: "full_agent",
				mode,
				providerRuntimeId: "local-provider",
				api: "openai-completions",
				baseUrl: "https://provider.invalid/v1",
				credential: mode === "hosted_broker" ? `gri_pbr_${"a".repeat(48)}` : "fixture-secret",
				executionPin: pin,
			}),
		);
		await expect(client.resolve(identity)).rejects.toThrow("incomplete material");
		pin = "malformed";
		await expect(client.resolve(identity)).rejects.toThrow("incomplete material");
		pin = "a".repeat(64);
		await expect(client.resolve(identity, undefined, "b".repeat(64))).rejects.toThrow("incomplete material");
	});

	it("aborts the local capability lookup with the model request", async () => {
		let observedSignal: AbortSignal | undefined;
		const client = new ProviderExecutionClient(
			"http://127.0.0.1/provider-execution",
			"local-token",
			async (_url, init) => {
				observedSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
				});
			},
		);
		const controller = new AbortController();
		const pending = client.resolve(identity, controller.signal);
		controller.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
		expect(observedSignal?.aborted).toBeTrue();
	});
});
