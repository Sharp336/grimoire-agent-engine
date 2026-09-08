import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { EngineProfileResolver } from "../src/engine/profile-resolver";
import { ProviderAdmissionClient } from "../src/engine/provider-admission";
import { ProviderExecutionClient } from "../src/engine/provider-execution";
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
	it("isolates same-account models, pins each credential, and follows explicit ordered profile slots", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-engine-ordered-account-"));
		const cache = path.join(root, "artifacts");
		await fs.mkdir(cache);
		const profileRef = "gctx:abababababababab";
		const accountRef = "gctx:cdcdcdcdcdcdcdcd";
		const routeRefs = ["gctx:efefefefefefefef", "gctx:ghghghghghghghgh", "gctx:jkjkjkjkjkjkjkjk"];
		const modelIds = ["gpt-5.6-terra", "gpt-5.6-sol", "plain-model"];
		const profile = {
			schema: "grimoire.agent_profile.v1",
			status: "active",
			models: routeRefs,
			allowSameModelProviderFallback: true,
			allowCrossModelFallback: true,
		};
		const pins = new Map<string, string>();
		const lookups: string[] = [];
		const execution = new ProviderExecutionClient(
			"http://127.0.0.1/provider-execution",
			"fixture-token",
			async (_url, init) => {
				const request = JSON.parse(String(init?.body));
				lookups.push(request.routeRef);
				const pin = pins.get(request.routeRef) ?? "a".repeat(64);
				if (request.executionPin !== undefined) expect(request.executionPin).toBe(pin);
				pins.set(request.routeRef, pin);
				return Response.json({
					...request,
					schema: "grimoire.provider_execution.result.v1",
					status: "ready",
					allowed: true,
					mode: "owner_local",
					executionPin: pin,
					providerRuntimeId: "one-shared-account",
					api: "openai-completions",
					baseUrl: "https://fixture.invalid/v1",
					credential: `secret-for-${request.routeRef}`,
				});
			},
		);
		const resolver = new EngineProfileResolver(
			cache,
			path.join(root, "credentials"),
			undefined,
			undefined,
			execution,
		);
		try {
			await artifact(cache, profileRef, "grimoire.agent_profile.v1", profile);
			await artifact(cache, accountRef, "grimoire.provider_account.v1", {
				schema: "grimoire.provider_account.v1",
				status: "active",
				providerId: "cheapai",
				api: "openai-completions",
				baseUrl: "https://fixture.invalid/v1",
				trusted: true,
				credential: { type: "api_key", key: `wincred://fixture.${"a".repeat(64)}` },
			});
			for (const [index, routeRef] of routeRefs.entries()) {
				await artifact(cache, routeRef, "grimoire.available_model_route.v1", {
					schema: "grimoire.available_model_route.v1",
					status: "active",
					providerAccountRef: accountRef,
					model: {
						modelIdentityId: modelIds[index],
						providerSurfaceId: "cheapai",
						modelId: modelIds[index],
						contextWindow: 32000 + index,
						maxOutputTokens: 8192,
						supportsReasoning: index < 2,
					},
				});
			}
			const launch = { spawns: "", profileDigest: hash(profileRef), launchProfileRef: profileRef };
			const resolved = await resolver.resolve(launch, root);
			try {
				expect(resolved.sameModelRouteFallback).toBeUndefined();
				expect(resolved.profileRoutes).toEqual({
					profileRef,
					primaryRouteRef: routeRefs[0],
					routes: routeRefs.map((routeRef, index) => ({
						routeRef,
						provider: `artel-route-${routeRef.slice(5)}`,
						modelId: modelIds[index],
					})),
				});
				expect(resolved.orderedRouteFallback?.selectors).toEqual(
					routeRefs.map((ref, index) => `artel-route-${ref.slice(5)}/${modelIds[index]}`),
				);
				for (const refresh of [false, true]) {
					if (refresh) await resolved.options.modelRegistry!.refresh("offline");
					for (const [index, routeRef] of routeRefs.entries()) {
						const model = resolved.options.modelRegistry!.find(
							`artel-route-${routeRef.slice(5)}`,
							modelIds[index]!,
						)!;
						expect(model.contextWindow).toBe(32000 + index);
						expect(await resolved.options.modelRegistry!.getApiKey(model)).toBe(`secret-for-${routeRef}`);
						expect(lookups.at(-1)).toBe(routeRef);
					}
				}
			} finally {
				resolved.dispose();
			}
			const selected = await resolver.resolve({ ...launch, selectedRouteRef: routeRefs[1] }, root);
			try {
				expect(selected.profileRoutes.primaryRouteRef).toBe(routeRefs[1]);
				expect(selected.profileRoutes.routes.map(route => route.routeRef)).toEqual(routeRefs.slice(1));
				expect(selected.orderedRouteFallback?.selectors).toEqual(
					routeRefs.slice(1).map((ref, index) => `artel-route-${ref.slice(5)}/${modelIds[index + 1]}`),
				);
			} finally {
				selected.dispose();
			}
			const high = await resolver.resolve(
				{ ...launch, thinkingLevel: ThinkingLevel.Max, minimumThinkingLevel: "high" },
				root,
			);
			try {
				expect(high.orderedRouteFallback?.selectors).toEqual(
					routeRefs.slice(0, 2).map((ref, index) => `artel-route-${ref.slice(5)}/${modelIds[index]}`),
				);
			} finally {
				high.dispose();
			}
			await artifact(cache, profileRef, "grimoire.agent_profile.v1", { ...profile, allowCrossModelFallback: false });
			const sameOnly = await resolver.resolve(launch, root);
			try {
				expect(sameOnly.orderedRouteFallback).toBeUndefined();
				expect(sameOnly.sameModelRouteFallback?.selectors).toEqual([
					`artel-route-${routeRefs[0]!.slice(5)}/${modelIds[0]}`,
				]);
			} finally {
				sameOnly.dispose();
			}
			await artifact(cache, profileRef, "grimoire.agent_profile.v1", {
				...profile,
				allowCrossModelFallback: "true",
			});
			const beforeInvalid = lookups.length;
			await expect(resolver.resolve(launch, root)).rejects.toThrow("allowCrossModelFallback must be boolean");
			expect(lookups.length).toBe(beforeInvalid);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

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
					...(index === 0 ? {} : { contextWindow: 200_000, maxOutputTokens: 32_000 }),
					supportsTools: true,
					supportsReasoning: provider !== "different",
				},
			});
			await artifact(cache, accountRef, "grimoire.provider_account.v1", {
				schema: "grimoire.provider_account.v1",
				status: "active",
				providerId: provider,
				api: index === 0 ? "openai_chat_completions" : index === 1 ? "anthropic_messages" : "anthropic-messages",
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
			expect(resolved.options.model?.api).toBe("openai-completions");
			expect(resolved.options.model?.contextWindow).toBe(1_000_000);
			expect(resolved.options.model?.maxTokens).toBe(128_000);
			expect(resolved.sameModelRouteFallback).toEqual({
				modelIdentityId: "claude-opus-5",
				selectors: [0, 1, 3].map(index => `artel-route-${routeRefs[index]!.slice(5)}/claude-opus-5`),
			});
			expect(
				resolved.options.modelRegistry?.find(`artel-route-${routeRefs[1]!.slice(5)}`, "claude-opus-5")?.baseUrl,
			).toBe("https://million.invalid");
			expect(
				resolved.options.modelRegistry?.find(`artel-route-${routeRefs[1]!.slice(5)}`, "claude-opus-5")?.api,
			).toBe("anthropic-messages");
			expect(
				resolved.options.modelRegistry?.find(`artel-route-${routeRefs[3]!.slice(5)}`, "claude-opus-5")?.baseUrl,
			).toBe("https://aiberm.invalid");
			expect(
				resolved.options.modelRegistry?.find(`artel-route-${routeRefs[2]!.slice(5)}`, "claude-opus-5"),
			).toBeUndefined();
			expect(
				resolved.options.modelRegistry?.find(`artel-route-${hiddenRouteRef.slice(5)}`, "claude-opus-5"),
			).toBeUndefined();
			expect(resolved.options.authStorage?.get("million")).toEqual({ type: "api_key", key: "million-key" });
		} finally {
			resolved.dispose();
		}
		const pinned = await resolver.resolve(
			{
				spawns: "",
				profileDigest: hash(profileRef),
				launchProfileRef: profileRef,
				selectedRouteRef: routeRefs[2],
			},
			root,
		);
		try {
			expect(pinned.options.model?.provider).toBe(`artel-route-${routeRefs[2]!.slice(5)}`);
			expect(pinned.sameModelRouteFallback?.selectors).toEqual([
				`artel-route-${routeRefs[2]!.slice(5)}/claude-opus-5`,
			]);
		} finally {
			pinned.dispose();
		}
		await expect(
			resolver.resolve(
				{
					spawns: "",
					profileDigest: hash(profileRef),
					launchProfileRef: profileRef,
					selectedRouteRef: routeRefs[2],
					thinkingLevel: ThinkingLevel.Max,
					minimumThinkingLevel: "high",
				},
				root,
			),
		).rejects.toThrow("minimum thinking level high");

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
			expect(startupFallback.options.model?.provider).toBe(`artel-route-${routeRefs[1]!.slice(5)}`);
			expect(startupFallback.options.model?.api).toBe("anthropic-messages");
			expect(startupFallback.sameModelRouteFallback?.selectors).toEqual([
				`artel-route-${routeRefs[1]!.slice(5)}/claude-opus-5`,
				`artel-route-${routeRefs[3]!.slice(5)}/claude-opus-5`,
			]);
		} finally {
			startupFallback.dispose();
		}
		await expect(
			resolver.resolve(
				{
					spawns: "",
					profileDigest: hash(profileRef),
					launchProfileRef: profileRef,
					selectedRouteRef: routeRefs[0],
				},
				root,
			),
		).rejects.toThrow("No usable AvailableModelRoute");
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
				`artel-route-${fallbackRouteRef.slice(5)}/gpt-5.6-sol`,
			]);
			const fallbackModel = resolved.options.modelRegistry?.find(
				`artel-route-${fallbackRouteRef.slice(5)}`,
				"gpt-5.6-sol",
			);
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

	it("resolves an opaque provider credential through the exact principal-bound transport without persistence", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-engine-provider-execution-"));
		const cache = path.join(root, "artifacts");
		await fs.mkdir(cache);
		const profileRef = "gctx:bbbbbbbbbbbbbbbb";
		const routeRef = "gctx:cccccccccccccccc";
		const accountRef = "gctx:dddddddddddddddd";
		const fallbackRouteRef = "gctx:eeeeeeeeeeeeeeee";
		const fallbackAccountRef = "gctx:ffffffffffffffff";
		await artifact(cache, profileRef, "grimoire.agent_profile.v1", {
			schema: "grimoire.agent_profile.v1",
			status: "active",
			models: [routeRef, fallbackRouteRef],
			allowSameModelProviderFallback: true,
		});
		await artifact(cache, routeRef, "grimoire.available_model_route.v1", {
			schema: "grimoire.available_model_route.v1",
			status: "active",
			providerAccountRef: accountRef,
			model: {
				modelIdentityId: "gpt-5.6-terra",
				providerSurfaceId: "cheapai",
				modelId: "gpt-5.6-terra",
				contextWindow: 1_050_000,
				maxOutputTokens: 128_000,
			},
		});
		await artifact(cache, accountRef, "grimoire.provider_account.v1", {
			schema: "grimoire.provider_account.v1",
			status: "active",
			providerId: "cheapai",
			api: "openai-completions",
			baseUrl: "https://cheapai.invalid/v1",
			accountBindingId: "account-1",
			trusted: true,
			credentialPlacement: { mode: "owner_local", status: "local_only" },
			credential: { type: "api_key", key: `wincred://grimoire.provider.${"a".repeat(64)}` },
		});
		await artifact(cache, fallbackRouteRef, "grimoire.available_model_route.v1", {
			schema: "grimoire.available_model_route.v1",
			status: "active",
			providerAccountRef: fallbackAccountRef,
			model: {
				modelIdentityId: "gpt-5.6-terra",
				providerSurfaceId: "cheapai",
				modelId: "gpt-5.6-terra",
				contextWindow: 1_050_000,
				maxOutputTokens: 128_000,
			},
		});
		await artifact(cache, fallbackAccountRef, "grimoire.provider_account.v1", {
			schema: "grimoire.provider_account.v1",
			status: "active",
			providerId: "cheapai",
			api: "openai-completions",
			baseUrl: "https://fallback.invalid/v1",
			accountBindingId: "account-2",
			trusted: true,
			credentialPlacement: { mode: "hosted_broker", status: "ready" },
			credential: { type: "api_key", key: `wincred://grimoire.provider.${"b".repeat(64)}` },
		});
		let mode: "owner_local" | "hosted_broker" = "owner_local";
		let calls = 0;
		const execution = new ProviderExecutionClient(
			"http://127.0.0.1/provider-execution",
			"local-token",
			async (_url, init) => {
				calls += 1;
				const request = JSON.parse(String(init?.body));
				if (init?.signal?.aborted) throw init.signal.reason;
				const isFallback = request.providerAccountRef === fallbackAccountRef;
				if (!isFallback) expect(request.executionPin).toBe(calls === 1 ? undefined : "a".repeat(64));
				return Response.json({
					...request,
					schema: "grimoire.provider_execution.result.v1",
					status: "ready",
					allowed: true,
					mode: isFallback ? "hosted_broker" : mode,
					...(!isFallback ? { executionPin: "a".repeat(64) } : {}),
					providerRuntimeId: `artel-${request.providerAccountRef.slice(5)}`,
					api: "openai-completions",
					baseUrl:
						!isFallback && mode === "owner_local"
							? "https://cheapai.invalid/v1"
							: "https://core.invalid/runtime/provider-broker/v1",
					credential:
						!isFallback && mode === "owner_local"
							? "owner-secret"
							: "gri_pbr_broker-token-value-abcdefghijklmnopqrstuvwxyz",
				});
			},
		);
		const credentialDb = path.join(root, "credentials", accountRef.slice(5), "credentials.sqlite");
		const resolver = new EngineProfileResolver(
			cache,
			path.join(root, "credentials"),
			undefined,
			undefined,
			execution,
		);
		const resolved = await resolver.resolve(
			{ spawns: "", profileDigest: hash(profileRef), launchProfileRef: profileRef },
			root,
		);
		try {
			const model = resolved.options.model!;
			expect(model.provider).toBe(`artel-route-${routeRef.slice(5)}`);
			expect(model.baseUrl).toBe("https://cheapai.invalid/v1");
			expect(await resolved.options.modelRegistry!.getApiKey(model)).toBe("owner-secret");
			const fallback = resolved.options.modelRegistry!.find(
				`artel-route-${fallbackRouteRef.slice(5)}`,
				"gpt-5.6-terra",
			)!;
			expect(fallback.baseUrl).toBe("https://core.invalid/runtime/provider-broker/v1");
			expect(await resolved.options.modelRegistry!.getApiKey(fallback)).toStartWith("gri_pbr_");
			expect(calls).toBe(4);
			await resolved.options.modelRegistry!.refresh("offline");
			expect(await resolved.options.modelRegistry!.getApiKey(model)).toBe("owner-secret");
			expect(await resolved.options.modelRegistry!.getApiKey(fallback)).toStartWith("gri_pbr_");
			mode = "hosted_broker";
			await expect(resolved.options.modelRegistry!.getApiKey(model)).rejects.toThrow("transport changed");
		} finally {
			resolved.dispose();
		}
		const reopened = await AuthStorage.create(credentialDb);
		try {
			await reopened.reload();
			expect(reopened.listStoredCredentials(`artel-route-${routeRef.slice(5)}`)).toHaveLength(0);
		} finally {
			reopened.close();
		}
	});

	it("stops primary and eager fallback material resolution when a pending launch is cancelled", async () => {
		for (const blockedStage of ["primary", "eager-fallback"] as const) {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-engine-provider-cancel-${blockedStage}-`));
			const cache = path.join(root, "artifacts");
			await fs.mkdir(cache);
			const profileRef = "gctx:abababababababab";
			const routeRefs = ["gctx:cdcdcdcdcdcdcdcd", "gctx:efefefefefefefef", "gctx:ghghghghghghghgh"];
			const accountRefs = ["gctx:jkjkjkjkjkjkjkjk", "gctx:mnmnmnmnmnmnmnmn", "gctx:pqpqpqpqpqpqpqpq"];
			await artifact(cache, profileRef, "grimoire.agent_profile.v1", {
				schema: "grimoire.agent_profile.v1",
				status: "active",
				models: routeRefs,
				allowSameModelProviderFallback: true,
			});
			for (const [index, routeRef] of routeRefs.entries()) {
				await artifact(cache, routeRef, "grimoire.available_model_route.v1", {
					schema: "grimoire.available_model_route.v1",
					status: "active",
					providerAccountRef: accountRefs[index],
					model: {
						modelIdentityId: "claude-opus-5",
						providerSurfaceId: `provider-${index}`,
						modelId: "claude-opus-5",
						contextWindow: 200_000,
						maxOutputTokens: 32_000,
					},
				});
				await artifact(cache, accountRefs[index]!, "grimoire.provider_account.v1", {
					schema: "grimoire.provider_account.v1",
					status: "active",
					providerId: `provider-${index}`,
					api: "anthropic-messages",
					baseUrl: `https://provider-${index}.invalid/v1`,
					trusted: true,
					credentialPlacement: { mode: "owner_local", status: "local_only" },
					credential: { type: "api_key", key: `wincred://grimoire.provider.${String(index).repeat(64)}` },
				});
			}
			const blockedCall = blockedStage === "primary" ? 1 : 2;
			const calls: string[] = [];
			const lookupStarted = Promise.withResolvers<void>();
			const execution = new ProviderExecutionClient(
				"http://127.0.0.1/provider-execution",
				"local-token",
				async (_url, init) => {
					const request = JSON.parse(String(init?.body));
					calls.push(request.providerAccountRef);
					if (calls.length === blockedCall) {
						if (!init?.signal) throw new Error("Expected pending launch signal");
						lookupStarted.resolve();
						const aborted = Promise.withResolvers<void>();
						init.signal.addEventListener("abort", () => aborted.reject(init.signal!.reason), { once: true });
						await aborted.promise;
					}
					return Response.json({
						...request,
						schema: "grimoire.provider_execution.result.v1",
						status: "ready",
						allowed: true,
						mode: "owner_local",
						executionPin: "a".repeat(64),
						providerRuntimeId: `runtime-${request.providerAccountRef.slice(5)}`,
						api: "anthropic-messages",
						baseUrl: "https://provider.invalid/v1",
						credential: "fixture-secret",
					});
				},
			);
			const resolver = new EngineProfileResolver(
				cache,
				path.join(root, "credentials"),
				undefined,
				undefined,
				execution,
			);
			const controller = new AbortController();
			const resolving = resolver.resolve(
				{ spawns: "", profileDigest: hash(profileRef), launchProfileRef: profileRef },
				root,
				controller.signal,
			);
			await lookupStarted.promise;
			controller.abort(new Error(`cancel ${blockedStage}`));
			await expect(resolving).rejects.toThrow(`cancel ${blockedStage}`);
			expect(calls).toEqual(accountRefs.slice(0, blockedCall));
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
			binding: { principal_id: "grimoire:user:test" },
			artifact: { owner_principal_id: "grimoire:user:test", effective_access_role: "owner" },
			content: JSON.stringify(content),
		}),
	);
}

function hash(ref: string): string {
	return `sha256:${ref.slice(5).padEnd(64, "0")}`;
}
