import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type FetchImpl,
	type Model,
	PROVIDER_CALL_ORIGIN_MANIFEST,
	type ProviderCallCodexAuthorityContext,
	type ProviderCallContext,
	type ProviderCallOriginAssignment,
	type ProviderCallReserveRequest,
	resolveProviderCallOriginBinding,
} from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import {
	createCodexAuthorityRuntimeFromEnv,
	createProviderCallRuntimeFromEnv,
	indexModelsByRequestId,
} from "../src/cli/auth-gateway-cli";

const CAPACITY_ASSIGNMENT_SHA256 = `sha256:${"f".repeat(64)}`;

function originAssignment(credentialGeneration: string, configId = "kimi-k3-high"): ProviderCallOriginAssignment {
	const binding = resolveProviderCallOriginBinding(configId, 0);
	return {
		...binding.frozenStaticAssignment,
		capability_generation: "capability-generation-20260823",
		credential_generation: credentialGeneration,
		source_release_digest: `sha256:${"a".repeat(64)}`,
		restricted_proxy_policy_sha256: `sha256:${"b".repeat(64)}`,
		origin_descriptor: structuredClone(binding.originDescriptor.preimage),
		route_binding_descriptor: structuredClone(binding.bindingDescriptor.preimage),
	};
}

function expectedDynamicsJson(configIds: readonly string[], credentialGeneration: string): string {
	return JSON.stringify(
		Object.fromEntries(
			configIds.map(configId => [
				configId,
				{
					capability_generation: "capability-generation-20260823",
					credential_generation: credentialGeneration,
					source_release_digest: `sha256:${"a".repeat(64)}`,
					restricted_proxy_policy_sha256: `sha256:${"b".repeat(64)}`,
				},
			]),
		),
	);
}

function context(overrides: Partial<ProviderCallContext> = {}): ProviderCallContext {
	const value = {
		mode: "strict",
		configId: "kimi-k3-high",
		taskReservationId: "11111111-1111-4111-8111-111111111111",
		providerRouteAssignmentId: "11111111-1111-4111-8111-111111111112",
		executionBindingId: "22222222-2222-4222-8222-222222222222",
		podUid: "pod-uid",
		callSequence: "1",
		idempotencyKey: "44444444-4444-4444-8444-444444444444",
		apiFamily: "openai-completions",
		provider: "kimi-code",
		accountId: "account-kimi",
		modelId: "k3",
		credentialGeneration: "generation-kimi-1",
		capabilityId: "55555555-5555-4555-8555-555555555555",
		snapshotId: "66666666-6666-4666-8666-666666666666",
		assignmentSha256: CAPACITY_ASSIGNMENT_SHA256,
		tokenizerContractSha256: `sha256:${"1".repeat(64)}`,
		inputTokens: "1",
		maxOutputTokens: "16",
		expectedDimensions: [
			{ dimension: "concurrency", windowId: "-", amount: "1", unitScale: "0", windowStart: null, windowEnd: null },
		],
		...overrides,
	} satisfies Omit<ProviderCallContext, "originAssignment"> & Partial<Pick<ProviderCallContext, "originAssignment">>;
	return {
		...value,
		originAssignment: value.originAssignment ?? originAssignment(value.credentialGeneration, value.configId),
	};
}

function reserveRequest(ctx: ProviderCallContext): ProviderCallReserveRequest {
	const body = new TextEncoder().encode("{}");
	return {
		context: ctx,
		provider: ctx.provider,
		model: ctx.modelId,
		apiFamily: ctx.apiFamily,
		httpMethod: "POST",
		credentialFreeUrl: "https://api.kimi.com/coding/v1/chat/completions",
		contentType: "application/json",
		headers: [["content-type", "application/json"]],
		payload: {},
		body,
		canonicalRequest: body,
		requestSha256: `sha256:${"2".repeat(64)}`,
		requestBodyBytes: String(body.byteLength),
	};
}

describe("production auth-gateway provider-call runtime", () => {
	it("constructs authority, durable journal, and exact credential binding from projected environment", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-call-runtime-"));
		try {
			const gatewayTokenPath = path.join(root, "gateway.token");
			const executionTokenPath = path.join(root, "execution.token");
			await fs.writeFile(gatewayTokenPath, "gateway-projected-token", { mode: 0o600 });
			await fs.writeFile(executionTokenPath, "execution-projected-token", { mode: 0o600 });
			const observedHeaders: Headers[] = [];
			const authorityFetch = Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					observedHeaders.push(new Headers(init?.headers));
					return Response.json({ error: "capacity" }, { status: 400 });
				},
				{ preconnect: fetch.preconnect },
			) satisfies FetchImpl;
			const runtime = createProviderCallRuntimeFromEnv(
				{
					OMP_PROVIDER_CALL_AUTHORITY_URL: "https://authority.example.test",
					OMP_PROVIDER_CALL_AUTHORITY_GATEWAY_TOKEN: gatewayTokenPath,
					OMP_PROVIDER_CALL_EXECUTION_TOKEN: executionTokenPath,
					OMP_PROVIDER_CALL_POD_UID: "pod-uid",
					OMP_PROVIDER_CALL_CREDENTIAL_BINDINGS_JSON: JSON.stringify({
						"kimi-k3-high": {
							account_id: "account-kimi",
							credential_generation: "generation-kimi-1",
						},
					}),
					OMP_PROVIDER_CALL_EXPECTED_DYNAMICS_JSON: expectedDynamicsJson(["kimi-k3-high"], "generation-kimi-1"),
					KIMI_API_KEY: "kimi-provider-secret",
				},
				{ journalPath: path.join(root, "journal.json"), fetch: authorityFetch },
			);
			if (!runtime) throw new Error("expected provider-call runtime");
			const credential = await runtime.resolveCredential(context());
			expect(credential).toEqual({
				accountId: "account-kimi",
				credentialGeneration: "generation-kimi-1",
				apiKey: "kimi-provider-secret",
				bearerToken: "kimi-provider-secret",
			});
			await expect(runtime.resolveCredential(context({ accountId: "other-account" }))).rejects.toThrow(
				/credential account mismatch/i,
			);
			await expect(runtime.resolveCredential(context({ credentialGeneration: "other-generation" }))).rejects.toThrow(
				/dynamic mismatch.*credential_generation/i,
			);
			await expect(
				runtime.resolveCredential(
					context({
						configId: "sol-low",
						provider: "gpt-proxy",
						modelId: "gpt-5.6-sol",
						credentialGeneration: "gpt-generation-1",
						originAssignment: originAssignment("gpt-generation-1", "sol-low"),
					}),
				),
			).rejects.toThrow(/dedicated Codex authority backend/i);
			await expect(runtime.authority.reserve(reserveRequest(context()))).rejects.toThrow(/HTTP 400/i);
			await fs.writeFile(gatewayTokenPath, "gateway-rotated-token", { mode: 0o600 });
			await fs.writeFile(executionTokenPath, "execution-rotated-token", { mode: 0o600 });
			await expect(runtime.authority.reserve(reserveRequest(context()))).rejects.toThrow(/HTTP 400/i);
			expect(observedHeaders.map(headers => headers.get("authorization"))).toEqual([
				"Bearer gateway-projected-token",
				"Bearer gateway-rotated-token",
			]);
			expect(observedHeaders.map(headers => headers.get("x-terminal-bench-execution-token"))).toEqual([
				"execution-projected-token",
				"execution-rotated-token",
			]);
			await runtime.journal.close();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects symlinked and unsafe-mode projected authority token files before controller contact", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-call-runtime-token-"));
		try {
			const gatewayTokenPath = path.join(root, "gateway.token");
			const gatewayAliasPath = path.join(root, "gateway.alias");
			const executionTokenPath = path.join(root, "execution.token");
			await fs.writeFile(gatewayTokenPath, "gateway-projected-token", { mode: 0o600 });
			await fs.symlink(gatewayTokenPath, gatewayAliasPath);
			await fs.writeFile(executionTokenPath, "execution-projected-token", { mode: 0o600 });
			let controllerCalls = 0;
			const authorityFetch = Object.assign(
				async () => {
					controllerCalls++;
					return Response.json({}, { status: 400 });
				},
				{ preconnect: fetch.preconnect },
			) satisfies FetchImpl;
			const makeRuntime = (gatewayTokenFile: string) =>
				createProviderCallRuntimeFromEnv(
					{
						OMP_PROVIDER_CALL_AUTHORITY_URL: "https://authority.example.test",
						OMP_PROVIDER_CALL_AUTHORITY_GATEWAY_TOKEN: gatewayTokenFile,
						OMP_PROVIDER_CALL_EXECUTION_TOKEN: executionTokenPath,
						OMP_PROVIDER_CALL_POD_UID: "pod-uid",
						OMP_PROVIDER_CALL_CREDENTIAL_BINDINGS_JSON: JSON.stringify({
							"kimi-k3-high": {
								account_id: "account-kimi",
								credential_generation: "generation-kimi-1",
							},
						}),
						OMP_PROVIDER_CALL_EXPECTED_DYNAMICS_JSON: expectedDynamicsJson(["kimi-k3-high"], "generation-kimi-1"),
					},
					{
						journalPath: path.join(root, `journal-${path.basename(gatewayTokenFile)}.json`),
						fetch: authorityFetch,
					},
				);
			const symlinkRuntime = makeRuntime(gatewayAliasPath);
			if (!symlinkRuntime) throw new Error("expected provider-call runtime");
			await expect(symlinkRuntime.authority.reserve(reserveRequest(context()))).rejects.toThrow(/symlink|alias/i);
			await symlinkRuntime.journal.close();

			await fs.chmod(gatewayTokenPath, 0o644);
			const unsafeModeRuntime = makeRuntime(gatewayTokenPath);
			if (!unsafeModeRuntime) throw new Error("expected provider-call runtime");
			await expect(unsafeModeRuntime.authority.reserve(reserveRequest(context()))).rejects.toThrow(/mode|0600/i);
			await unsafeModeRuntime.journal.close();
			expect(controllerCalls).toBe(0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects partial authority/token configuration instead of silently serving an unusable strict path", () => {
		expect(() =>
			createProviderCallRuntimeFromEnv({
				OMP_PROVIDER_CALL_AUTHORITY_URL: "https://authority.example.test",
			}),
		).toThrow(/incomplete provider-call authority configuration/i);
	});

	it("requires backend-owned expected dynamics whenever the generic authority runtime is configured", () => {
		expect(() =>
			createProviderCallRuntimeFromEnv({
				OMP_PROVIDER_CALL_AUTHORITY_URL: "https://authority.example.test",
				OMP_PROVIDER_CALL_AUTHORITY_GATEWAY_TOKEN: "/projected/gateway-token",
				OMP_PROVIDER_CALL_EXECUTION_TOKEN: "/projected/execution-token",
				OMP_PROVIDER_CALL_POD_UID: "pod-uid",
				OMP_PROVIDER_CALL_CREDENTIAL_BINDINGS_JSON: "{}",
			}),
		).toThrow(/expected dynamics|incomplete provider-call authority configuration/i);
	});

	it("indexes and delegates every frozen GPT config without a generic GPT credential", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-authority-runtime-"));
		try {
			const files = {
				ca: path.join(root, "ca.pem"),
				cert: path.join(root, "client-cert.pem"),
				key: path.join(root, "client-key.pem"),
				token: path.join(root, "execution.token"),
			};
			await Promise.all([
				fs.writeFile(files.ca, "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n", { mode: 0o600 }),
				fs.writeFile(files.cert, "-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----\n", {
					mode: 0o600,
				}),
				fs.writeFile(files.key, "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n", { mode: 0o600 }),
				fs.writeFile(files.token, "execution-projected-token", { mode: 0o600 }),
			]);
			const bindings = PROVIDER_CALL_ORIGIN_MANIFEST.routes.filter(route => route.provider === "gpt-proxy");
			const manifests = Object.fromEntries(
				bindings.map(binding => [
					binding.configId,
					{
						schema: "terminal-bench/provider-delegation-manifest/v1",
						config_id: binding.configId,
						incoming_semantic_api_family: "openai-completions",
						physical_api_family: "openai-responses",
						translation_contract_sha256: `sha256:${"d".repeat(64)}`,
						logical_model_selector: binding.modelSelector,
						physical_model_id: "gpt-5.6-sol",
					},
				]),
			);
			const observed: Array<{ url: string; init: RequestInit; envelope: Record<string, unknown> }> = [];
			let responseMode: "sse" | "redirect" | "open-error" = "sse";
			const authorityFetch = Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					observed.push({
						url: String(input),
						init: init ?? {},
						envelope: JSON.parse(String(init?.body)) as Record<string, unknown>,
					});
					if (responseMode === "redirect") {
						return new Response(null, { status: 307, headers: { location: "https://forbidden.invalid/replay" } });
					}
					if (responseMode === "open-error") {
						return Response.json({ error: { message: "closed fields missing" }, extra: true }, { status: 503 });
					}
					return new Response('data: {"choices":[]}\\n\\ndata: [DONE]\\n\\n', {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				},
				{ preconnect: fetch.preconnect },
			) satisfies FetchImpl;
			const runtime = createCodexAuthorityRuntimeFromEnv(
				{
					OMP_CODEX_AUTHORITY_URL:
						"https://terminal-bench-codex-authority.linkedin-bench-authority.svc.cluster.local:8443/v1/authority/openai-completions",
					OMP_CODEX_AUTHORITY_TLS_CA_FILE: files.ca,
					OMP_CODEX_AUTHORITY_TLS_CLIENT_CERT_FILE: files.cert,
					OMP_CODEX_AUTHORITY_TLS_CLIENT_KEY_FILE: files.key,
					OMP_CODEX_AUTHORITY_TLS_SERVER_NAME:
						"terminal-bench-codex-authority.linkedin-bench-authority.svc.cluster.local",
					OMP_PROVIDER_CALL_EXECUTION_TOKEN: files.token,
					OMP_CODEX_AUTHORITY_DELEGATION_MANIFESTS_JSON: JSON.stringify(manifests),
					OMP_PROVIDER_CALL_EXPECTED_DYNAMICS_JSON: expectedDynamicsJson(
						bindings.map(binding => binding.configId),
						"gpt-generation-1",
					),
				},
				{ fetch: authorityFetch },
			);
			if (!runtime) throw new Error("expected Codex authority runtime");
			const gptModel = buildModel({
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
			expect(
				indexModelsByRequestId([gptModel] as readonly Model<"openai-completions">[], new Set(["gpt-proxy"]), false)
					.size,
			).toBe(0);
			const index = indexModelsByRequestId([gptModel] as readonly Model<"openai-completions">[], new Set(), true);
			expect(bindings).toHaveLength(20);
			expect(bindings.filter(binding => index.get(binding.configId) === gptModel)).toHaveLength(20);
			expect(index.size).toBe(20);
			expect(index.has(gptModel.id)).toBe(false);
			expect(index.has(`${gptModel.provider}/${gptModel.id}`)).toBe(false);
			let replay: (() => Promise<Response>) | undefined;
			for (const binding of bindings) {
				const assignment = originAssignment("gpt-generation-1", binding.configId);
				const logicalBody = JSON.stringify({
					model: binding.modelSelector,
					messages: [{ role: "user", content: "hello" }],
					stream: true,
				});
				const codexAuthority = {
					providerRouteAssignmentId: "77777777-7777-4777-8777-777777777777",
					capabilitySetId: "88888888-8888-4888-8888-888888888888",
					translationContractSha256: `sha256:${"d".repeat(64)}`,
					solverEpoch: "1",
					assignedAt: "2026-08-23T00:00:00.000000Z",
					logicalContentType: "application/json",
					logicalHeaders: { accept: "text/event-stream", "content-type": "application/json" },
					logicalBodyBase64: Buffer.from(logicalBody).toString("base64"),
				} satisfies ProviderCallCodexAuthorityContext;
				const ctx = context({
					configId: binding.configId,
					provider: "gpt-proxy",
					modelId: "gpt-5.6-sol",
					accountId: "gpt0",
					credentialGeneration: "gpt-generation-1",
					originAssignment: assignment,
					codexAuthority,
				});
				const rawRequestBody = JSON.stringify({
					modelId: gptModel.id,
					context: { systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 0 }] },
					options: { providerCallContext: ctx },
					stream: true,
				});
				replay = () =>
					runtime.delegate({
						authorityOwner: "dedicated-codex-backend",
						assignment,
						model: gptModel,
						parsed: {
							modelId: gptModel.id,
							context: { systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 0 }] },
							options: { providerCallContext: ctx },
							stream: true,
						},
						rawRequestBody,
					});
				const response = await replay();
				expect(response.status).toBe(200);
			}
			expect(observed).toHaveLength(20);
			for (const [index, call] of observed.entries()) {
				const binding = bindings[index]!;
				expect(call.url).toBe(
					"https://terminal-bench-codex-authority.linkedin-bench-authority.svc.cluster.local:8443/v1/authority/openai-completions",
				);
				expect(call.init).toMatchObject({ method: "POST", redirect: "manual" });
				expect(new Headers(call.init.headers).get("x-terminal-bench-execution-token")).toBe(
					"execution-projected-token",
				);
				const tls = (
					call.init as RequestInit & {
						tls?: { rejectUnauthorized?: boolean; serverName?: string; ca?: string; cert?: string; key?: string };
					}
				).tls;
				expect(tls).toMatchObject({
					rejectUnauthorized: true,
					serverName: "terminal-bench-codex-authority.linkedin-bench-authority.svc.cluster.local",
				});
				expect(call.envelope).toMatchObject({
					schema: "terminal-bench/codex-authority-worker-call/v1",
					config_id: binding.configId,
					model_selector: binding.modelSelector,
					capability_generation: "capability-generation-20260823",
					credential_generation: "gpt-generation-1",
					source_release_digest: `sha256:${"a".repeat(64)}`,
					restricted_proxy_policy_sha256: `sha256:${"b".repeat(64)}`,
					assignment_sha256: CAPACITY_ASSIGNMENT_SHA256,
					origin_descriptor: binding.originDescriptor.preimage,
					route_binding_descriptor: binding.bindingDescriptor.preimage,
				});
			}
			if (!replay) throw new Error("expected a captured GPT delegation");
			responseMode = "redirect";
			await expect(replay()).rejects.toThrow(/redirect/i);
			expect(observed).toHaveLength(21);
			responseMode = "open-error";
			await expect(replay()).rejects.toThrow(/invalid error envelope/i);
			expect(observed).toHaveLength(22);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("fails Codex production startup closed when any URL, mTLS, identity, manifest, token, or dynamics input is absent", () => {
		const complete = {
			OMP_CODEX_AUTHORITY_URL: "https://codex-authority.example.test/v1/authority/openai-completions",
			OMP_CODEX_AUTHORITY_TLS_CA_FILE: "/projected/ca",
			OMP_CODEX_AUTHORITY_TLS_CLIENT_CERT_FILE: "/projected/cert",
			OMP_CODEX_AUTHORITY_TLS_CLIENT_KEY_FILE: "/projected/key",
			OMP_CODEX_AUTHORITY_TLS_SERVER_NAME: "codex-authority.example.test",
			OMP_PROVIDER_CALL_EXECUTION_TOKEN: "/projected/token",
			OMP_CODEX_AUTHORITY_DELEGATION_MANIFESTS_JSON: "{}",
			OMP_PROVIDER_CALL_EXPECTED_DYNAMICS_JSON: "{}",
		};
		for (const name of Object.keys(complete)) {
			expect(() => createCodexAuthorityRuntimeFromEnv({ ...complete, [name]: "" }), name).toThrow(
				/incomplete Codex authority configuration/i,
			);
		}
	});
});
