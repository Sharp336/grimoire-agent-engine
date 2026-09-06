import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { EngineProfileResolver } from "../src/engine/profile-resolver";
import { ProviderAdmissionClient } from "../src/engine/provider-admission";
import { AuthStorage } from "../src/session/auth-storage";

const refs = {
	profile: "gctx:2222222222222222",
	childProfile: "gctx:aaaaaaaaaaaaaaaa",
	untrustedRoute: "gctx:3333333333333333",
	trustedRoute: "gctx:4444444444444444",
	untrustedAccount: "gctx:5555555555555555",
	trustedAccount: "gctx:6666666666666666",
};

describe("EngineProfileResolver", () => {
	it("builds an ordered runtime chain only from configured routes with the same model identity", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-engine-profile-routes-"));
		const cache = path.join(root, "artifacts");
		await fs.mkdir(cache);
		const profileRef = "gctx:bbbbbbbbbbbbbbbb";
		const routeRefs = [
			"gctx:cccccccccccccccc",
			"gctx:dddddddddddddddd",
			"gctx:hhhhhhhhhhhhhhhh",
			"gctx:jjjjjjjjjjjjjjjj",
		];
		const hiddenRouteRef = "gctx:kkkkkkkkkkkkkkkk";
		const providers = ["cheapai", "million", "different", "aiberm"];
		await artifact(cache, profileRef, "grimoire.agent_profile.v1", {
			schema: "grimoire.agent_profile.v1",
			status: "active",
			models: routeRefs,
			allowSameModelProviderFallback: true,
		});
		for (const [index, routeRef] of [...routeRefs, hiddenRouteRef].entries()) {
			const provider = index === routeRefs.length ? "hidden" : providers[index];
			const accountRef = `gctx:${String(index + 2).repeat(16)}`;
			await artifact(cache, routeRef, "grimoire.available_model_route.v1", {
				schema: "grimoire.available_model_route.v1",
				status: "active",
				providerAccountRef: accountRef,
				model: {
					modelIdentityId: provider === "different" ? "claude-sonnet-5" : "claude-opus-5",
					providerSurfaceId: provider,
					modelId: "claude-opus-5",
					contextWindow: 200_000,
					maxOutputTokens: 32_000,
					supportsTools: true,
				},
			});
			await artifact(cache, accountRef, "grimoire.provider_account.v1", {
				schema: "grimoire.provider_account.v1",
				status: "active",
				providerId: provider,
				api: "anthropic-messages",
				baseUrl: `https://${provider}.invalid`,
				trusted: true,
				credential: { type: "api_key", key: `${provider}-key` },
			});
		}

		const resolver = new EngineProfileResolver(cache, path.join(root, "credentials"));
		const resolved = await resolver.resolve(
			{ spawns: "", profileDigest: hash(profileRef), launchProfileRef: profileRef },
			root,
		);
		try {
			expect(resolved.sameModelRouteFallback).toEqual({
				modelIdentityId: "claude-opus-5",
				selectors: ["cheapai/claude-opus-5", "million/claude-opus-5", "aiberm/claude-opus-5"],
			});
			expect(resolved.options.modelRegistry?.find("million", "claude-opus-5")?.baseUrl).toBe(
				"https://million.invalid",
			);
			expect(resolved.options.modelRegistry?.find("aiberm", "claude-opus-5")?.baseUrl).toBe(
				"https://aiberm.invalid",
			);
			expect(resolved.options.modelRegistry?.find("different", "claude-opus-5")).toBeUndefined();
			expect(resolved.options.modelRegistry?.find("hidden", "claude-opus-5")).toBeUndefined();
			expect(resolved.options.authStorage?.get("million")).toEqual({ type: "api_key", key: "million-key" });
		} finally {
			resolved.dispose();
		}

		await artifact(cache, "gctx:2222222222222222", "grimoire.provider_account.v1", {
			schema: "grimoire.provider_account.v1",
			status: "disabled",
			providerId: "cheapai",
			api: "anthropic-messages",
			baseUrl: "https://cheapai.invalid",
			trusted: true,
			credential: { type: "api_key", key: "cheapai-key" },
		});
		const startupFallback = await resolver.resolve(
			{ spawns: "", profileDigest: hash(profileRef), launchProfileRef: profileRef },
			root,
		);
		try {
			expect(startupFallback.options.model?.provider).toBe("million");
			expect(startupFallback.sameModelRouteFallback?.selectors).toEqual([
				"million/claude-opus-5",
				"aiberm/claude-opus-5",
			]);
		} finally {
			startupFallback.dispose();
		}
	});

	it("resolves an exact trusted fallback without ambient model or credentials", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-engine-profile-"));
		const cache = path.join(root, "artifacts");
		await fs.mkdir(cache);
		await artifact(cache, refs.profile, "grimoire.agent_profile.v1", {
			schema: "grimoire.agent_profile.v1",
			status: "active",
			displayName: "Trusted fallback",
			models: [refs.untrustedRoute, refs.trustedRoute],
			requireTrustedProvider: true,
			tools: { mode: "unrestricted" },
			childProfiles: [refs.childProfile],
			maxSpawnDepth: 1,
			maxChildren: 6,
		});
		await artifact(cache, refs.childProfile, "grimoire.agent_profile.v1", {
			schema: "grimoire.agent_profile.v1",
			status: "active",
			displayName: "Pinned child",
			models: [refs.trustedRoute],
			childProfiles: [],
			maxSpawnDepth: 0,
			maxChildren: 0,
		});
		for (const [ref, accountRef] of [
			[refs.untrustedRoute, refs.untrustedAccount],
			[refs.trustedRoute, refs.trustedAccount],
		] as const) {
			await artifact(cache, ref, "grimoire.available_model_route.v1", {
				schema: "grimoire.available_model_route.v1",
				status: "active",
				displayName: "Test",
				providerAccountRef: accountRef,
				model: {
					modelIdentityId: ref === refs.trustedRoute ? "trusted-model-v1" : "untrusted-model-v1",
					providerSurfaceId: ref.slice(5),
					modelId: ref === refs.trustedRoute ? "trusted-model" : "untrusted-model",
					name: "Test",
					contextWindow: 100_000,
					maxOutputTokens: 4_096,
					inputModalities: ["text"],
					supportsReasoning: true,
				},
			});
		}
		await artifact(cache, refs.untrustedAccount, "grimoire.provider_account.v1", {
			schema: "grimoire.provider_account.v1",
			status: "active",
			providerId: "anthropic",
			providerKind: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://untrusted.invalid",
			accountBindingId: "untrusted",
			trusted: false,
			credential: { type: "api_key", key: "untrusted-key" },
		});
		await artifact(cache, refs.trustedAccount, "grimoire.provider_account.v1", {
			schema: "grimoire.provider_account.v1",
			status: "active",
			providerId: "anthropic",
			providerKind: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://trusted.invalid",
			accountBindingId: "trusted",
			trusted: true,
			credential: { type: "api_key", key: "trusted-key" },
		});

		const resolver = new EngineProfileResolver(cache, path.join(root, "credentials"));
		const resolved = await resolver.resolve(
			{
				spawns: "*",
				profileDigest: hash(refs.profile),
				launchProfileRef: refs.profile,
				maxSpawnDepth: 1,
				maxChildren: 6,
				childProfileRefs: [refs.childProfile],
			},
			root,
		);
		try {
			expect(resolved.options.model?.id).toBe("trusted-model");
			expect(resolved.childProfiles).toEqual([{ profileRef: refs.childProfile, displayName: "Pinned child" }]);
			expect(resolved.options.model?.baseUrl).toBe("https://trusted.invalid");
			expect(resolved.options.restrictToolNames).toBe(false);
			expect(resolved.options.enableMCP).toBe(true);
			expect(resolved.options.enableLsp).toBe(true);
			expect(resolved.options.maxSpawnDepth).toBe(1);
			expect(resolved.options.authStorage?.get("anthropic")).toEqual({ type: "api_key", key: "trusted-key" });
			await resolved.options.authStorage?.set("anthropic", { type: "api_key", key: "rotated-key" });
			const writeback = path.join(root, "credential-writeback", `${refs.trustedAccount.slice(5)}.json`);
			for (let attempt = 0; attempt < 50; attempt++) {
				if (
					await fs.access(writeback).then(
						() => true,
						() => false,
					)
				)
					break;
				await Bun.sleep(10);
			}
			expect(JSON.parse(await fs.readFile(writeback, "utf8"))).toMatchObject({
				schema: "grimoire.engine_credential_writeback.v1",
				artifactRef: refs.trustedAccount,
				baseRevision: 1,
				baseCredentialHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
				credential: { type: "api_key", key: "rotated-key" },
			});
		} finally {
			resolved.dispose();
		}
		await expect(
			resolver.resolve(
				{
					spawns: "*",
					profileDigest: hash(refs.profile),
					launchProfileRef: refs.profile,
					maxSpawnDepth: 1,
					maxChildren: 6,
					childProfileRefs: [refs.profile],
				},
				root,
			),
		).rejects.toThrow("does not match the pinned AgentProfile");

		const reopened = await resolver.resolve(
			{
				spawns: "*",
				profileDigest: hash(refs.profile),
				launchProfileRef: refs.profile,
				maxSpawnDepth: 1,
				maxChildren: 6,
				childProfileRefs: [refs.childProfile],
			},
			root,
		);
		try {
			expect(reopened.options.authStorage?.get("anthropic")).toEqual({
				type: "api_key",
				key: "rotated-key",
			});
		} finally {
			reopened.dispose();
		}

		const launch = {
			spawns: "*",
			profileDigest: hash(refs.profile),
			launchProfileRef: refs.profile,
			maxSpawnDepth: 1,
			maxChildren: 6,
			childProfileRefs: [refs.childProfile],
		};
		const beforeDependencyChange = await resolver.continuationDigest(launch, root);
		const accountPath = path.join(cache, `${refs.trustedAccount.slice(5)}.json`);
		const cachedAccount = JSON.parse(await fs.readFile(accountPath, "utf8"));
		cachedAccount.content_hash = `sha256:${"f".repeat(64)}`;
		await fs.writeFile(accountPath, JSON.stringify(cachedAccount));
		expect(await resolver.continuationDigest(launch, root)).not.toBe(beforeDependencyChange);
	});

	it("shares one OAuth refresh lease and repairs writeback from the credential store", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-engine-profile-oauth-"));
		const cache = path.join(root, "artifacts");
		const profileRef = "gctx:7777777777777777";
		const routeRef = "gctx:8888888888888888";
		const accountRef = "gctx:9999999999999999";
		const provider = "unit-engine-oauth";
		const sourceId = "engine-profile-resolver-test";
		let refreshCalls = 0;
		await fs.mkdir(cache);
		await artifact(cache, profileRef, "grimoire.agent_profile.v1", {
			schema: "grimoire.agent_profile.v1",
			status: "active",
			models: [routeRef],
		});
		await artifact(cache, routeRef, "grimoire.available_model_route.v1", {
			schema: "grimoire.available_model_route.v1",
			status: "active",
			providerAccountRef: accountRef,
			model: {
				modelIdentityId: "unit-engine-model-v1",
				providerSurfaceId: "unit-engine-provider",
				modelId: "unit-engine-model",
				contextWindow: 100_000,
				maxOutputTokens: 4_096,
			},
		});
		await artifact(cache, accountRef, "grimoire.provider_account.v1", {
			schema: "grimoire.provider_account.v1",
			status: "active",
			providerId: provider,
			api: "anthropic-messages",
			baseUrl: "https://oauth.invalid",
			trusted: true,
			credential: {
				type: "oauth",
				access: "access-old",
				refresh: "refresh-old",
				expires: Date.now() - 60_000,
			},
		});
		registerOAuthProvider({
			id: provider,
			name: "Unit Engine OAuth",
			sourceId,
			async login() {
				throw new Error("not used");
			},
			async refreshToken(credential) {
				refreshCalls += 1;
				await Bun.sleep(50);
				return {
					...credential,
					access: "access-rotated",
					refresh: "refresh-rotated",
					expires: Date.now() + 3_600_000,
				};
			},
			getApiKey: credential => credential.access,
		});

		const resolver = new EngineProfileResolver(cache, path.join(root, "credentials"));
		const launch = { spawns: "" as const, profileDigest: hash(profileRef), launchProfileRef: profileRef };
		const [first, second] = await Promise.all([resolver.resolve(launch, root), resolver.resolve(launch, root)]);
		try {
			expect(
				await Promise.all([
					first.options.authStorage?.getApiKey(provider, "session-first"),
					second.options.authStorage?.getApiKey(provider, "session-second"),
				]),
			).toEqual(["access-rotated", "access-rotated"]);
			expect(refreshCalls).toBe(1);
			const writeback = path.join(root, "credential-writeback", `${accountRef.slice(5)}.json`);
			for (let attempt = 0; attempt < 50; attempt++) {
				const value = await fs.readFile(writeback, "utf8").catch(() => "");
				if (value.includes("access-rotated")) break;
				await Bun.sleep(10);
			}
			expect(JSON.parse(await fs.readFile(writeback, "utf8"))).toMatchObject({
				artifactRef: accountRef,
				baseCredentialHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
				credential: { type: "oauth", access: "access-rotated", refresh: "refresh-rotated" },
			});
		} finally {
			first.dispose();
			second.dispose();
			unregisterOAuthProviders(sourceId);
		}
	});

	it("runs a local OMP binding on the exact selected OAuth account", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-engine-local-account-"));
		const cache = path.join(root, "artifacts");
		const localDb = path.join(root, "agent.db");
		const profileRef = "gctx:eeeeeeeeeeeeeeee";
		const routeRef = "gctx:ffffffffffffffff";
		const accountRef = "gctx:gggggggggggggggg";
		const fallbackRouteRef = "gctx:hhhhhhhhhhhhhhhh";
		const fallbackAccountRef = "gctx:jjjjjjjjjjjjjjjj";
		const foreignSubscriptionRouteRef = "gctx:kkkkkkkkkkkkkkkk";
		const foreignSubscriptionAccountRef = "gctx:mmmmmmmmmmmmmmmm";
		await fs.mkdir(cache);
		const source = await AuthStorage.create(localDb);
		await source.set("openai-codex", [
			{
				type: "oauth",
				access: "wrong-account-token",
				refresh: "wrong-account-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "account-a",
			},
			{
				type: "oauth",
				access: "selected-account-token",
				refresh: "selected-account-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "account-b",
			},
		]);
		const selectedCredentialId = source
			.listOAuthAccounts("openai-codex")
			.find(account => account.accountId === "account-b")?.credentialId;
		expect(selectedCredentialId).toBeInteger();
		source.close();
		await artifact(cache, profileRef, "grimoire.agent_profile.v1", {
			schema: "grimoire.agent_profile.v1",
			status: "active",
			models: [routeRef, fallbackRouteRef, foreignSubscriptionRouteRef],
			allowSameModelProviderFallback: true,
			childProfiles: [],
			maxSpawnDepth: 0,
			maxChildren: 0,
		});
		await artifact(cache, routeRef, "grimoire.available_model_route.v1", {
			schema: "grimoire.available_model_route.v1",
			status: "active",
			providerAccountRef: accountRef,
			model: {
				modelIdentityId: "openai:gpt-5.6-sol",
				providerSurfaceId: "openai-codex:account-b",
				modelId: "gpt-5.6-sol",
				contextWindow: 1_000_000,
				maxOutputTokens: 128_000,
				supportsReasoning: true,
			},
		});
		await artifact(cache, accountRef, "grimoire.provider_account.v1", {
			schema: "grimoire.provider_account.v1",
			status: "active",
			providerId: "openai-codex",
			providerKind: "openai_codex_subscription",
			accountBindingId: "account-b",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			trusted: true,
			credentialBinding: { source: "local_omp", accountId: "account-b", credentialId: selectedCredentialId },
		});
		await artifact(cache, fallbackRouteRef, "grimoire.available_model_route.v1", {
			schema: "grimoire.available_model_route.v1",
			status: "active",
			providerAccountRef: fallbackAccountRef,
			model: {
				modelIdentityId: "openai:gpt-5.6-sol",
				providerSurfaceId: "cheapai-account-1",
				modelId: "gpt-5.6-sol",
				contextWindow: 1_000_000,
				maxOutputTokens: 128_000,
				supportsReasoning: true,
			},
		});
		await artifact(cache, fallbackAccountRef, "grimoire.provider_account.v1", {
			schema: "grimoire.provider_account.v1",
			status: "active",
			providerId: "cheapai-account-1",
			providerKind: "api_key",
			api: "openai-responses",
			baseUrl: "https://cheapai.invalid/v1",
			trusted: true,
			credential: { type: "api_key", key: "fallback-key" },
		});
		await artifact(cache, foreignSubscriptionRouteRef, "grimoire.available_model_route.v1", {
			schema: "grimoire.available_model_route.v1",
			status: "active",
			providerAccountRef: foreignSubscriptionAccountRef,
			model: {
				modelIdentityId: "openai:gpt-5.6-sol",
				providerSurfaceId: "openai-codex:account-a",
				modelId: "gpt-5.6-sol",
				contextWindow: 1_000_000,
				maxOutputTokens: 128_000,
				supportsReasoning: true,
			},
		});
		await artifact(cache, foreignSubscriptionAccountRef, "grimoire.provider_account.v1", {
			schema: "grimoire.provider_account.v1",
			status: "active",
			providerId: "openai-codex",
			providerKind: "openai_codex_subscription",
			accountBindingId: "account-a",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			trusted: true,
			credentialBinding: { source: "local_omp", accountId: "account-a" },
		});

		const resolver = new EngineProfileResolver(
			cache,
			path.join(root, "credentials"),
			localDb,
			new ProviderAdmissionClient("http://127.0.0.1/admission", "test-token"),
		);
		const resolved = await resolver.resolve(
			{ spawns: "", profileDigest: hash(profileRef), launchProfileRef: profileRef },
			root,
		);
		try {
			expect(await resolved.options.authStorage?.getApiKey("openai-codex", "attempt-1")).toBe(
				"selected-account-token",
			);
			expect(resolved.options.authStorage?.listStoredCredentials("openai-codex")).toHaveLength(1);
			expect(resolved.options.settings?.get("providers.openaiWebsockets")).toBe("off");
			expect(resolved.sameModelRouteFallback?.selectors).toEqual([
				"openai-codex/gpt-5.6-sol",
				"cheapai-account-1/gpt-5.6-sol",
			]);
			const fallbackModel = resolved.options.modelRegistry?.find("cheapai-account-1", "gpt-5.6-sol");
			expect(fallbackModel).toBeDefined();
			expect(await resolved.options.modelRegistry?.getApiKey(fallbackModel!)).toBe("fallback-key");
			let fallbackCalls = 0;
			const fallbackFetch = resolved.options.providerRequestHook?.wrapFetch(fallbackModel!, async () => {
				fallbackCalls += 1;
				return new Response("ok");
			});
			expect(await fallbackFetch?.("https://cheapai.invalid/v1/responses")).toMatchObject({ status: 200 });
			expect(fallbackCalls).toBe(1);
		} finally {
			resolved.dispose();
		}
		const reopenedSource = await AuthStorage.create(localDb);
		try {
			await reopenedSource.reload();
			expect(reopenedSource.listStoredCredentials("cheapai-account-1")).toHaveLength(0);
			expect(reopenedSource.listStoredCredentials("openai-codex")).toHaveLength(2);
		} finally {
			reopenedSource.close();
		}
	});
});

async function artifact(cache: string, ref: string, kind: string, content: object): Promise<void> {
	await fs.writeFile(
		path.join(cache, `${ref.slice(5)}.json`),
		JSON.stringify({
			schema: "grimoire.client_cached_artifact.v1",
			artifact_ref: ref,
			revision: 1,
			content_hash: hash(ref),
			kind,
			content: JSON.stringify(content),
		}),
	);
}

function hash(ref: string): string {
	return `sha256:${ref.slice(5).padEnd(64, "0")}`;
}
