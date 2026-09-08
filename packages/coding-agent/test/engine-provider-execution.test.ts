import { describe, expect, it } from "bun:test";
import {
	ProviderExecutionClient,
	ProviderExecutionError,
	type ProviderExecutionIdentity,
} from "../src/engine/provider-execution";
import { safeEngineErrorDetail } from "../src/engine/public-error";

const identity: ProviderExecutionIdentity = {
	expectedPrincipalId: "grimoire:user:test",
	profileRef: "gctx:2222222222222222",
	profileContentHash: `sha256:${"2".repeat(64)}`,
	routeRef: "gctx:3333333333333333",
	routeContentHash: `sha256:${"3".repeat(64)}`,
	providerAccountRef: "gctx:4444444444444444",
	providerAccountContentHash: `sha256:${"4".repeat(64)}`,
	providerId: "cheapai",
	modelId: "gpt-5.6-terra",
};

describe("ProviderExecutionClient", () => {
	it("returns only an exact echoed route capability", async () => {
		const client = new ProviderExecutionClient(
			"http://127.0.0.1/provider-execution",
			"local-token",
			async (_url, init) => {
				expect(init?.headers).toEqual({
					Authorization: "Bearer local-token",
					"Content-Type": "application/json",
				});
				const request = JSON.parse(String(init?.body));
				return Response.json({
					...request,
					schema: "grimoire.provider_execution.result.v1",
					status: "ready",
					allowed: true,
					mode: "hosted_broker",
					providerRuntimeId: "artel-4444444444444444",
					api: "openai-completions",
					baseUrl: "https://core.invalid/runtime/provider-broker/v1",
					credential: `gri_pbr_${"a".repeat(48)}`,
					executionPin: "c".repeat(64),
				});
			},
		);
		expect(await client.resolve(identity)).toEqual({
			mode: "hosted_broker",
			providerRuntimeId: "artel-4444444444444444",
			api: "openai-completions",
			baseUrl: "https://core.invalid/runtime/provider-broker/v1",
			credential: `gri_pbr_${"a".repeat(48)}`,
			executionPin: "c".repeat(64),
		});
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
		expect(error.message).toBe("ProviderAccount must be explicitly trusted before it can run a full Agent session");
		expect(safeEngineErrorDetail(error)).toBe(error.message);
	});

	it("rejects capability material that could expose the credential over plaintext", async () => {
		const client = new ProviderExecutionClient("http://127.0.0.1/provider-execution", "local-token", async () =>
			Response.json({
				...identity,
				schema: "grimoire.provider_execution.result.v1",
				status: "ready",
				allowed: true,
				executionMode: "full_agent",
				mode: "owner_local",
				providerRuntimeId: "artel-4444444444444444",
				api: "openai-completions",
				baseUrl: "http://provider.invalid/v1",
				credential: "secret-value",
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
