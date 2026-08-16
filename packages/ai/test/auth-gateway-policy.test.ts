import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER,
	type AuthGatewayAuthorizationDecision,
	type AuthGatewayAuthorizationRequest,
	type AuthGatewayObservation,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage, type AuthStorageOptions, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { logger } from "@oh-my-pi/pi-utils";

interface PolicyStorageFixture {
	dir: string;
	storage: AuthStorage;
	credentialIds: number[];
	oauthSource?: string;
}

function oauthCredential(access: string) {
	return {
		type: "oauth" as const,
		access,
		refresh: `${access}-refresh`,
		expires: Date.now() + 60 * 60_000,
	};
}
async function createPolicyStorage(
	name: string,
	accesses: readonly string[],
	provider = "mock",
	refreshAccess?: (access: string) => string,
	options?: AuthStorageOptions,
): Promise<PolicyStorageFixture> {
	const oauthSource = provider === "mock" ? `auth-gateway-policy-${name}` : undefined;
	if (oauthSource) {
		registerOAuthProvider({
			id: provider,
			name: "Auth Gateway Policy Test",
			sourceId: oauthSource,
			async login() {
				return { access: "login", refresh: "login-refresh", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: refreshAccess?.(credentials.access) ?? credentials.access,
					expires: Date.now() + 60 * 60_000,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
	}
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	const store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
	const storage = new AuthStorage(store, options);
	await storage.set(provider, accesses.map(oauthCredential));
	const credentialIds = store.listAuthCredentials(provider).map(row => row.id);
	return { dir, storage, credentialIds, oauthSource };
}

async function closePolicyStorage(fixture: PolicyStorageFixture): Promise<void> {
	if (fixture.oauthSource) unregisterOAuthProviders(fixture.oauthSource);
	fixture.storage.close();
	await fs.rm(fixture.dir, { recursive: true, force: true });
}

function policyGrant(
	request: AuthGatewayAuthorizationRequest,
	resolvedModelId: string,
	sessionId: string,
	allowedOAuthCredentialIds: readonly number[],
) {
	return {
		authorized: true as const,
		authorizationId: `authorization:${request.requestId}`,
		requestedModelId: request.requestedModelId,
		resolvedModelId,
		sessionId,
		allowedOAuthCredentialIds,
	};
}

async function postOpenAIChat(url: string, model: string, extra?: Record<string, unknown>): Promise<Response> {
	return fetch(`${url}/v1/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: "Bearer gateway-token",
			[AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER]: "policy-input",
			"X-Client-Id": "caller-client",
			"X-Workspace-Id": "caller-workspace",
			"X-Stainless-Lang": "typescript",
			"Content-Type": "application/json",
			"OpenAI-Organization": "caller-org",
			"OpenAI-Project": "caller-project",
			"ChatGPT-Account-Id": "caller-account",
			Session_Id: "caller-header-session",
			"OpenAI-Beta": "responses=v1",
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "raw-policy-prompt" }],
			stream: false,
			prompt_cache_key: "caller-body-session",
			metadata: { account_id: "caller-metadata-account" },
			user: "caller-user",
			...extra,
		}),
	});
}

describe("auth-gateway policy hooks", () => {
	it("authorizes a provider-format request before model and credential access, then strips caller identity", async () => {
		registerMockApi();
		const fixture = await createPolicyStorage("gw-policy-order", ["oauth-a", "oauth-b"]);
		fixture.storage.setRuntimeApiKey("mock", "runtime-key-must-not-win");
		const allowedId = fixture.credentialIds[1]!;
		const order: string[] = [];
		const observations: AuthGatewayObservation[] = [];
		let authorizationRequest: AuthGatewayAuthorizationRequest | undefined;
		const originalAccess = fixture.storage.getOAuthApiKeyFromCredentialIds.bind(fixture.storage);
		const accessSpy = spyOn(fixture.storage, "getOAuthApiKeyFromCredentialIds").mockImplementation(
			async (provider, sessionId, allowedCredentialIds, options) => {
				order.push("credential");
				return originalAccess(provider, sessionId, allowedCredentialIds, options);
			},
		);
		const mock = createMockModel({
			provider: "mock",
			id: "resolved-model",
			handler: () => {
				order.push("upstream");
				return { content: ["ok"] };
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage: fixture.storage,
			authorizeRequest: request => {
				order.push("authorize");
				authorizationRequest = request;
				return policyGrant(request, "resolved-model", "workspace:authorized-session", [allowedId]);
			},
			observer: event => {
				observations.push(event);
			},
			resolveModel: selector => {
				order.push("model");
				return selector === "resolved-model" ? mock : undefined;
			},
		});
		try {
			const response = await postOpenAIChat(handle.url, "caller-model");
			expect(response.status).toBe(200);
			expect(order).toEqual(["authorize", "model", "credential", "upstream"]);
			expect(authorizationRequest?.requestedModelId).toBe("caller-model");
			expect(authorizationRequest?.authorization).toBe("policy-input");
			expect(authorizationRequest?.requestedSessionId).toBe("caller-body-session");
			expect(mock.calls).toHaveLength(1);
			const options = mock.calls[0]!.options;
			expect(options?.apiKey).toBe("oauth-b");
			expect(options?.sessionId).toBe("workspace:authorized-session");
			expect(options?.promptCacheKey).toBe("workspace:authorized-session");
			expect(options?.metadata).toBeUndefined();
			expect(options?.headers).toEqual({ "openai-beta": "responses=v1" });
			expect(observations.map(event => event.type)).toEqual(["authorization", "credential_selection", "terminal"]);
			const serializedObservations = JSON.stringify(observations);
			expect(serializedObservations).not.toContain("oauth-a");
			expect(serializedObservations).not.toContain("oauth-b");
			expect(serializedObservations).not.toContain("raw-policy-prompt");
		} finally {
			accessSpy.mockRestore();
			await handle.close();
			await closePolicyStorage(fixture);
			clearCustomApis();
		}
	});

	it("preserves provider-shaped OAuth authentication and policy grant insertion order", async () => {
		registerMockApi();
		const fixture = await createPolicyStorage(
			"gw-policy-structured-oauth",
			["structured-a", "structured-b"],
			"github-copilot",
		);
		fixture.storage.setRuntimeApiKey("github-copilot", "outside-static-key");
		let selectedToken: string | undefined;
		const mock = createMockModel({
			provider: "github-copilot",
			id: "structured-model",
			handler: (_context, options) => {
				const structured = JSON.parse(String(options?.apiKey)) as { token?: unknown };
				selectedToken = typeof structured.token === "string" ? structured.token : undefined;
				return { content: ["ok"] };
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage: fixture.storage,
			authorizeRequest: request =>
				policyGrant(request, "structured-model", "workspace:structured", [
					fixture.credentialIds[1]!,
					fixture.credentialIds[0]!,
				]),
			resolveModel: () => mock,
		});
		try {
			const response = await postOpenAIChat(handle.url, "structured-alias");
			expect(response.status).toBe(200);
			expect(selectedToken).toBe("structured-b");
			expect(mock.calls[0]!.options?.apiKey).not.toBe("outside-static-key");
		} finally {
			await handle.close();
			await closePolicyStorage(fixture);
			clearCustomApis();
		}
	});

	it("rejects denied and malformed policy decisions without model or credential access", async () => {
		registerMockApi();
		const fixture = await createPolicyStorage("gw-policy-denial", ["oauth-a"]);
		const accessSpy = spyOn(fixture.storage, "getOAuthApiKeyFromCredentialIds");
		let modelResolutions = 0;
		let authorizerCalls = 0;
		const observations: AuthGatewayObservation[] = [];
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage: fixture.storage,
			authorizeRequest: request => {
				authorizerCalls++;
				if (request.requestedModelId === "denied-model") {
					return { authorized: false, reasonCode: "account_not_allowed" };
				}
				return {
					authorized: true,
					authorizationId: "authorization:malformed",
					requestedModelId: request.requestedModelId,
					resolvedModelId: "resolved-model",
					sessionId: "workspace:malformed",
					allowedOAuthCredentialIds: [],
				} as AuthGatewayAuthorizationDecision;
			},
			observer: event => {
				observations.push(event);
			},
			resolveModel: () => {
				modelResolutions++;
				return undefined;
			},
		});
		try {
			const missingPolicyInput = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: "Bearer gateway-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "missing-policy-input",
					messages: [{ role: "user", content: "must not authorize" }],
					stream: false,
				}),
			});
			const denied = await postOpenAIChat(handle.url, "denied-model");
			const malformed = await postOpenAIChat(handle.url, "malformed-model");
			expect(missingPolicyInput.status).toBe(401);
			expect(authorizerCalls).toBe(2);
			expect(denied.status).toBe(403);
			expect(malformed.status).toBe(500);
			expect(modelResolutions).toBe(0);
			expect(accessSpy).toHaveBeenCalledTimes(0);
			expect(observations.map(event => (event.type === "authorization" ? event.outcome : event.type))).toEqual([
				"denied",
				"error",
			]);
			expect(await denied.text()).not.toContain("account_not_allowed");
		} finally {
			accessSpy.mockRestore();
			await handle.close();
			await closePolicyStorage(fixture);
			clearCustomApis();
		}
	});

	it("keeps usage-limit rotation inside the authorized OAuth row set", async () => {
		registerMockApi();
		const privateUsageError = "private token-endpoint response";
		const fixture = await createPolicyStorage(
			"gw-policy-rotation",
			["oauth-a", "oauth-b", "oauth-outside"],
			"mock",
			undefined,
			{
				usageProviderResolver: provider =>
					provider === "mock"
						? {
								id: "mock",
								async fetchUsage(_params, context) {
									context.logger?.warn("private usage provider diagnostic", {
										error: privateUsageError,
									});
									throw new Error(privateUsageError);
								},
							}
						: undefined,
				rankingStrategyResolver: provider =>
					provider === "mock"
						? {
								findWindowLimits() {
									return {};
								},
								windowDefaults: { primaryMs: 60_000, secondaryMs: 60_000 },
							}
						: undefined,
			},
		);
		const debugSpy = spyOn(logger, "debug");
		const allowedIds = fixture.credentialIds.slice(0, 2);
		const observations: AuthGatewayObservation[] = [];
		let attempts = 0;
		const mock = createMockModel({
			provider: "mock",
			id: "rotation-model",
			handler: () => {
				attempts++;
				if (attempts === 1) {
					throw new ProviderHttpError("quota reached", 429, { code: "insufficient_quota" });
				}
				return { content: ["ok"] };
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage: fixture.storage,
			authorizeRequest: request => policyGrant(request, "rotation-model", "workspace:rotation", allowedIds),
			observer: event => {
				observations.push(event);
			},
			resolveModel: () => mock,
		});
		try {
			const response = await postOpenAIChat(handle.url, "rotation-alias");
			expect(response.status).toBe(200);
			const attemptedKeys = mock.calls.map(call => call.options?.apiKey);
			expect(attemptedKeys).toHaveLength(2);
			expect(new Set(attemptedKeys).size).toBe(2);
			for (const key of attemptedKeys) {
				if (typeof key !== "string") throw new Error("expected OAuth API key");
				expect(["oauth-a", "oauth-b"]).toContain(key);
			}
			expect(attemptedKeys).not.toContain("oauth-outside");
			const rotation = observations.find(event => event.type === "credential_rotation");
			expect(rotation?.type).toBe("credential_rotation");
			if (rotation?.type !== "credential_rotation") throw new Error("expected credential rotation observation");
			expect(allowedIds).toContain(rotation.previousCredentialId);
			expect(allowedIds).toContain(rotation.credentialId);
			expect(JSON.stringify(observations)).not.toContain("oauth-outside");
			const diagnostics = JSON.stringify(debugSpy.mock.calls);
			expect(diagnostics).toContain("usage_fetch_failed");
			expect(diagnostics).not.toContain(privateUsageError);
		} finally {
			debugSpy.mockRestore();
			await handle.close();
			await closePolicyStorage(fixture);
			clearCustomApis();
		}
	});
	it("force-refreshes the same authorized OAuth row before rotating after an authentication failure", async () => {
		registerMockApi();
		const fixture = await createPolicyStorage(
			"gw-policy-force-refresh",
			["fresh-but-stale", "authorized-sibling"],
			"mock",
			access => `${access}-reminted`,
		);
		const observations: AuthGatewayObservation[] = [];
		let attempts = 0;
		const mock = createMockModel({
			provider: "mock",
			id: "force-refresh-model",
			handler: (_context, options) => {
				attempts++;
				if (attempts === 1) throw new ProviderHttpError("invalid credential", 401);
				return { content: [String(options?.apiKey)] };
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage: fixture.storage,
			authorizeRequest: request =>
				policyGrant(request, "force-refresh-model", "workspace:force-refresh", fixture.credentialIds),
			observer: event => {
				observations.push(event);
			},
			resolveModel: () => mock,
		});
		try {
			const response = await postOpenAIChat(handle.url, "force-refresh-alias");
			expect(response.status).toBe(200);
			expect(mock.calls.map(call => call.options?.apiKey)).toEqual(["fresh-but-stale", "fresh-but-stale-reminted"]);
			expect(
				observations.some(event => event.type === "credential_selection" && event.phase === "force_refresh"),
			).toBe(true);
			expect(observations.some(event => event.type === "credential_rotation")).toBe(false);
		} finally {
			await handle.close();
			await closePolicyStorage(fixture);
			clearCustomApis();
		}
	});

	it("withholds the streaming terminal frame when the terminal observer fails", async () => {
		registerMockApi();
		const fixture = await createPolicyStorage("gw-policy-stream-observer", ["oauth-a"]);
		const mock = createMockModel({
			provider: "mock",
			id: "stream-observer-model",
			handler: () => ({ content: ["visible output"] }),
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage: fixture.storage,
			authorizeRequest: request =>
				policyGrant(request, "stream-observer-model", "workspace:stream-observer", [fixture.credentialIds[0]!]),
			observer: event => {
				if (event.type === "terminal") throw new Error("terminal-observer-private-failure");
			},
			resolveModel: () => mock,
		});
		try {
			const response = await postOpenAIChat(handle.url, "stream-observer-alias", { stream: true });
			expect(response.status).toBe(200);
			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let received = "";
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				received += decoder.decode(chunk.value, { stream: true });
			}
			received += decoder.decode();
			expect(received).not.toContain("[DONE]");
			expect(received).not.toContain("terminal-observer-private-failure");
		} finally {
			await handle.close();
			await closePolicyStorage(fixture);
			clearCustomApis();
		}
	});

	it("strips pi-native overrides, refuses out-of-set policy selection, and preserves legacy resolution", async () => {
		registerMockApi();
		const fixture = await createPolicyStorage("gw-policy-pi", ["oauth-policy"]);
		fixture.storage.setRuntimeApiKey("mock", "legacy-runtime-key");
		const allowedId = fixture.credentialIds[0]!;
		const mock = createMockModel({
			provider: "mock",
			id: "pi-resolved",
			responses: [{ content: ["policy"] }, { content: ["legacy"] }],
		});
		const policyHandle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage: fixture.storage,
			authorizeRequest: request =>
				policyGrant(
					request,
					"pi-resolved",
					"workspace:pi-authorized",
					request.requestedModelId === "pi-missing" ? [999_999] : [allowedId],
				),
			resolveModel: () => mock,
		});
		try {
			const policyResponse = await fetch(`${policyHandle.url}/v1/pi/stream`, {
				method: "POST",
				headers: {
					Authorization: "Bearer gateway-token",
					"Content-Type": "application/json",
					[AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER]: "policy-input",
				},
				body: JSON.stringify({
					modelId: "pi-policy",
					context: { messages: [{ role: "user", content: "pi raw prompt", timestamp: 1 }] },
					stream: false,
					options: {
						sessionId: "caller-session",
						promptCacheKey: "caller-cache-key",
						metadata: { project: "caller-project" },
						initiatorOverride: "caller-provider-identity",
						openrouterVariant: "caller-provider-route",
						statefulResponses: true,
						headers: {
							Authorization: "caller-upstream-token",
							"chatgpt-account-id": "caller-account",
							"openai-project": "caller-project",
							session_id: "caller-header-session",
							"openai-beta": "responses=v1",
							"x-client-id": "caller-client",
							"x-user-id": "caller-user",
							"x-tenant-id": "caller-tenant",
							"x-workspace-id": "caller-workspace",
							"x-device-id": "caller-device",
							apikey: "caller-api-key",
							"x-auth": "caller-auth",
							"x-client-secret": "caller-secret",
						},
					},
				}),
			});
			expect(policyResponse.status).toBe(200);
			const policyOptions = mock.calls[0]!.options;
			expect(policyOptions?.apiKey).toBe("oauth-policy");
			expect(policyOptions?.sessionId).toBe("workspace:pi-authorized");
			expect(policyOptions?.promptCacheKey).toBe("workspace:pi-authorized");
			expect(policyOptions?.metadata).toBeUndefined();
			expect(policyOptions?.initiatorOverride).toBeUndefined();
			expect(policyOptions?.openrouterVariant).toBeUndefined();
			expect(policyOptions?.statefulResponses).toBeUndefined();
			expect(policyOptions?.headers).toEqual({ "openai-beta": "responses=v1" });

			const missingResponse = await fetch(`${policyHandle.url}/v1/pi/stream`, {
				method: "POST",
				headers: {
					Authorization: "Bearer gateway-token",
					"Content-Type": "application/json",
					[AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER]: "policy-input",
				},
				body: JSON.stringify({
					modelId: "pi-missing",
					context: { messages: [{ role: "user", content: "must not run", timestamp: 2 }] },
					stream: false,
				}),
			});
			expect(missingResponse.status).toBe(401);
			expect(mock.calls).toHaveLength(1);
		} finally {
			await policyHandle.close();
		}

		const legacyHandle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage: fixture.storage,
			resolveModel: () => mock,
		});
		try {
			const legacyResponse = await fetch(`${legacyHandle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer gateway-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: "pi-legacy",
					context: { messages: [{ role: "user", content: "legacy", timestamp: 3 }] },
					stream: false,
					options: { sessionId: "caller-legacy-session" },
				}),
			});
			expect(legacyResponse.status).toBe(200);
			expect(mock.calls[1]!.options?.apiKey).toBe("legacy-runtime-key");
			expect(mock.calls[1]!.options?.sessionId).toBe("caller-legacy-session");
		} finally {
			await legacyHandle.close();
			await closePolicyStorage(fixture);
			clearCustomApis();
		}
	});

	it("fails closed before model or credential access when the observer rejects authorization", async () => {
		registerMockApi();
		const fixture = await createPolicyStorage("gw-policy-observer", ["oauth-a"]);
		const accessSpy = spyOn(fixture.storage, "getOAuthApiKeyFromCredentialIds");
		let modelResolutions = 0;
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage: fixture.storage,
			authorizeRequest: request =>
				policyGrant(request, "pi-resolved", "workspace:observer", [fixture.credentialIds[0]!]),
			observer: () => {
				throw new Error("observer-private-failure");
			},
			resolveModel: () => {
				modelResolutions++;
				return undefined;
			},
		});
		try {
			const response = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: {
					Authorization: "Bearer gateway-token",
					"Content-Type": "application/json",
					[AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER]: "policy-input",
				},
				body: JSON.stringify({
					modelId: "pi-observer",
					context: { messages: [{ role: "user", content: "must stay private", timestamp: 1 }] },
					stream: false,
				}),
			});
			const responseText = await response.text();
			expect(response.status).toBe(503);
			expect(responseText).not.toContain("observer-private-failure");
			expect(responseText).not.toContain("must stay private");
			expect(modelResolutions).toBe(0);
			expect(accessSpy).toHaveBeenCalledTimes(0);
		} finally {
			accessSpy.mockRestore();
			await handle.close();
			await closePolicyStorage(fixture);
			clearCustomApis();
		}
	});
});
