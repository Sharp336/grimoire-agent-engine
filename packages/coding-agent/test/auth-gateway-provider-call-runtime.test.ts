import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { PROVIDER_CALL_ORIGIN_MANIFEST, UnixProviderCallGateway } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { getConfigRootDir, refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import {
	createProviderCallGatewayRuntimeFromEnv,
	indexModelsByRequestId,
	runAuthGatewayCommand,
} from "../src/cli/auth-gateway-cli";

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

const KIMI_API_COLLISION = buildModel({
	id: "k3",
	name: "Kimi K3 API Collision",
	api: "openai-responses",
	provider: "kimi-code",
	baseUrl: "https://api.kimi.com/coding/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 262_144,
	maxTokens: 32_768,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ModelSpec<"openai-responses">);

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

	it("validates provider-call runtime before broker resolution or default token creation", async () => {
		const envKeys = [
			"PI_CONFIG_DIR",
			"OMP_AUTH_BROKER_URL",
			"OMP_AUTH_BROKER_TOKEN",
			"OMP_PROVIDER_CALL_GATEWAY_SOCKET",
			"OMP_PROVIDER_CALL_EXPECTED_DYNAMICS_JSON",
		] as const;
		const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
		process.env.PI_CONFIG_DIR = `.omp-provider-call-validation-${randomUUID()}`;
		process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:1";
		delete process.env.OMP_AUTH_BROKER_TOKEN;
		process.env.OMP_PROVIDER_CALL_GATEWAY_SOCKET = "/run/omp/provider-call-worker.sock";
		delete process.env.OMP_PROVIDER_CALL_EXPECTED_DYNAMICS_JSON;
		refreshDirsFromEnv();
		const configRoot = getConfigRootDir();
		const tokenPath = join(configRoot, "auth-gateway.token");
		try {
			await expect(runAuthGatewayCommand({ action: "serve", flags: {} })).rejects.toThrow(
				/incomplete provider-call gateway configuration/i,
			);
			expect(await Bun.file(tokenPath).exists()).toBe(false);

			process.env.OMP_AUTH_BROKER_TOKEN = "configured-broker-token";
			await expect(runAuthGatewayCommand({ action: "serve", flags: {} })).rejects.toThrow(
				/incomplete provider-call gateway configuration/i,
			);
			expect(await Bun.file(tokenPath).exists()).toBe(false);
		} finally {
			for (const key of envKeys) {
				const value = originalEnv[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			refreshDirsFromEnv();
			await rm(configRoot, { recursive: true, force: true });
		}
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
		expect(index.get(`${GPT_MODEL.provider}/${GPT_MODEL.id}`)).toBe(GPT_MODEL);
		expect(index.size).toBe(23);
		expect(index.has(GPT_MODEL.id)).toBe(false);
		const collisionIndex = indexModelsByRequestId([GPT_MODEL, KIMI_API_COLLISION], new Set(), true);
		expect(collisionIndex.has(`${KIMI_API_COLLISION.provider}/${KIMI_API_COLLISION.id}`)).toBe(false);
	});
});
