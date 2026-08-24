import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { PROVIDER_CALL_ORIGIN_MANIFEST, UnixProviderCallGateway } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { createProviderCallGatewayRuntimeFromEnv, indexModelsByRequestId } from "../src/cli/auth-gateway-cli";

function expectedDynamicsJson(configIds: readonly string[]): string {
	return JSON.stringify(
		Object.fromEntries(
			configIds.map(configId => [
				configId,
				{
					capability_generation: "capability-generation-20260823",
					credential_generation: "generation-1",
					source_release_digest: `sha256:${"a".repeat(64)}`,
					restricted_proxy_policy_sha256: `sha256:${"b".repeat(64)}`,
				},
			]),
		),
	);
}

const GPT_MODEL = buildModel({
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	api: "openai-completions",
	provider: "gpt-proxy",
	baseUrl: "https://not-a-generic-provider-route.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 64_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ModelSpec<"openai-completions">);

const KIMI_MODEL = buildModel({
	id: "k3",
	name: "Kimi K3",
	api: "openai-completions",
	provider: "kimi-code",
	baseUrl: "https://api.kimi.com/coding/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 262_144,
	maxTokens: 32_768,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ModelSpec<"openai-completions">);

describe("production auth-gateway provider-call runtime", () => {
	it("constructs one Unix gateway from only the reviewed nonsecret socket and immutable binding", () => {
		const configIds = ["kimi-k3-high", "sol-low"];
		const forbiddenReads: string[] = [];
		const values: Record<string, string> = {
			OMP_PROVIDER_CALL_GATEWAY_SOCKET: "/run/omp/provider-call-worker.sock",
			OMP_PROVIDER_CALL_EXPECTED_DYNAMICS_JSON: expectedDynamicsJson(configIds),
		};
		const allowed = new Set(Object.keys(values));
		const env = new Proxy(values, {
			get(target, property, receiver) {
				const name = String(property);
				if (!allowed.has(name)) {
					forbiddenReads.push(name);
					throw new Error(`unreviewed environment read is forbidden: ${name}`);
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const runtime = createProviderCallGatewayRuntimeFromEnv(env);
		expect(runtime?.gateway).toBeInstanceOf(UnixProviderCallGateway);
		expect(Object.keys(runtime?.expectedDynamics ?? {}).sort()).toEqual(configIds.sort());
		expect(forbiddenReads).toEqual([]);
	});

	it("returns no runtime when neither reviewed nonsecret input is configured", () => {
		expect(createProviderCallGatewayRuntimeFromEnv({})).toBeUndefined();
	});

	it("fails closed for partial, relative, duplicate-key, or unknown binding configuration", () => {
		expect(() =>
			createProviderCallGatewayRuntimeFromEnv({
				OMP_PROVIDER_CALL_GATEWAY_SOCKET: "/run/omp/provider-call-worker.sock",
			}),
		).toThrow(/incomplete provider-call gateway configuration/i);
		expect(() =>
			createProviderCallGatewayRuntimeFromEnv({
				OMP_PROVIDER_CALL_GATEWAY_SOCKET: "relative.sock",
				OMP_PROVIDER_CALL_EXPECTED_DYNAMICS_JSON: expectedDynamicsJson(["kimi-k3-high"]),
			}),
		).toThrow(/absolute.*socket/i);
		expect(() =>
			createProviderCallGatewayRuntimeFromEnv({
				OMP_PROVIDER_CALL_GATEWAY_SOCKET: "/run/omp/provider-call-worker.sock",
				OMP_PROVIDER_CALL_EXPECTED_DYNAMICS_JSON: '{"kimi-k3-high":{},"kimi-k3-high":{}}',
			}),
		).toThrow(/duplicate/i);
		expect(() =>
			createProviderCallGatewayRuntimeFromEnv({
				OMP_PROVIDER_CALL_GATEWAY_SOCKET: "/run/omp/provider-call-worker.sock",
				OMP_PROVIDER_CALL_EXPECTED_DYNAMICS_JSON: expectedDynamicsJson(["unknown-config"]),
			}),
		).toThrow(/unknown-config|unknown config/i);
	});

	it("indexes governed generic and all frozen GPT routes without broker provider credentials", () => {
		const bindings = PROVIDER_CALL_ORIGIN_MANIFEST.routes.filter(route => route.provider === "gpt-proxy");
		expect(
			indexModelsByRequestId([GPT_MODEL] as readonly Model<"openai-completions">[], new Set(["gpt-proxy"]), false)
				.size,
		).toBe(0);
		const index = indexModelsByRequestId(
			[GPT_MODEL, KIMI_MODEL] as readonly Model<"openai-completions">[],
			new Set(),
			true,
		);
		expect(bindings).toHaveLength(20);
		expect(bindings.filter(binding => index.get(binding.configId) === GPT_MODEL)).toHaveLength(20);
		expect(index.get("kimi-code/k3")).toBe(KIMI_MODEL);
		expect(index.get("k3")).toBe(KIMI_MODEL);
		expect(index.size).toBe(22);
		expect(index.has(GPT_MODEL.id)).toBe(false);
		expect(index.has(`${GPT_MODEL.provider}/${GPT_MODEL.id}`)).toBe(false);
	});
});
