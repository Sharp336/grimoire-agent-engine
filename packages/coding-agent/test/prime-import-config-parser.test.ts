import { describe, expect, it } from "bun:test";
import { parsePrimeConfig } from "../src/import/prime/config-parser";
import type { PrimeConfigParserResult, PrimeImportSourceDiscovery, PrimeSourceFile } from "../src/import/prime/types";

function sourceFile(sourceRef: string, content: string, domain: PrimeSourceFile["domain"]): PrimeSourceFile {
	return {
		kind: "file",
		domain,
		sourceRef,
		canonicalPath: `/prime/${sourceRef}`,
		mode: 0o600,
		mtimeMs: 1,
		size: Buffer.byteLength(content),
		sha256: "0".repeat(64),
		contentBase64: Buffer.from(content, "utf8").toString("base64"),
	};
}

function discovery(files: readonly PrimeSourceFile[]): PrimeImportSourceDiscovery {
	return {
		snapshot: {
			schemaVersion: 1,
			snapshotId: "snapshot-1",
			sourceRoot: "/prime",
			cwd: "/project",
			sessionRoot: "/prime/sessions",
			maxFileBytes: 1_000_000,
			maxTotalBytes: 1_000_000,
			maxEntries: 100,
			files: files.map(({ contentBase64: _contentBase64, ...metadata }) => metadata),
			treeEntries: [],
		},
		inventory: { records: files, files, excluded: [] },
		losses: [],
	};
}

function parse(files: readonly PrimeSourceFile[]): PrimeConfigParserResult {
	return parsePrimeConfig(discovery(files));
}

function settings(sourceRef: string, value: string): PrimeSourceFile {
	return sourceFile(sourceRef, value, "settings");
}

function models(value: string): PrimeSourceFile {
	return sourceFile("global/models.json", value, "models");
}

function auth(sourceRef: string, value: string): PrimeSourceFile {
	return sourceFile(sourceRef, value, "credentials");
}

describe("parsePrimeConfig", () => {
	it("merges global and project settings with strict one-level nested precedence", () => {
		const result = parse([
			settings(
				"global/settings.json",
				JSON.stringify({
					queueMode: "all",
					compaction: { enabled: true, keepRecentTokens: 1000 },
					defaultThinkingLevel: "low",
					unknownPrimeField: true,
				}),
			),
			settings(
				"project/settings.json",
				JSON.stringify({
					steeringMode: "one-at-a-time",
					compaction: { keepRecentTokens: 2000 },
					defaultThinkingLevel: "high",
				}),
			),
		]);

		expect(result.settings).toEqual([
			{
				scope: "global",
				values: {
					steeringMode: "all",
					"compaction.enabled": true,
					"compaction.keepRecentTokens": 1000,
					defaultThinkingLevel: "low",
				},
				sourceRefs: ["global/settings.json"],
				kind: "settings",
			},
			{
				scope: "project",
				values: {
					steeringMode: "one-at-a-time",
					"compaction.keepRecentTokens": 2000,
					defaultThinkingLevel: "high",
				},
				sourceRefs: ["project/settings.json"],
				kind: "settings",
			},
		]);
		expect(result.effectiveSettings).toEqual({
			steeringMode: "one-at-a-time",
			"compaction.enabled": true,
			"compaction.keepRecentTokens": 2000,
			defaultThinkingLevel: "high",
		});
		expect(result.losses).toContainEqual(
			expect.objectContaining({ code: "config-unknown-field", path: "unknownPrimeField" }),
		);
	});

	it("applies Prime legacy settings migrations in memory without mutating input", () => {
		const raw = { queueMode: "all", websockets: true, skills: { enableSkillCommands: false } };
		const result = parse([settings("global/settings.json", JSON.stringify(raw))]);
		expect(result.settings[0]?.values).toMatchObject({
			steeringMode: "all",
			"skills.enableSkillCommands": false,
		});
		expect(result.losses).toContainEqual(
			expect.objectContaining({ code: "config-unsupported-field", path: "websockets" }),
		);
		expect(raw).toEqual({ queueMode: "all", websockets: true, skills: { enableSkillCommands: false } });
	});

	it("migrates legacy retry and telemetry fields into destination settings", () => {
		const result = parse([
			settings(
				"global/settings.json",
				JSON.stringify({
					retry: { provider: { maxRetryDelayMs: 1250 } },
					telemetry: true,
				}),
			),
		]);
		expect(result.settings[0]?.values).toMatchObject({ "retry.maxDelayMs": 1250 });
		expect(result.losses).toContainEqual(
			expect.objectContaining({ code: "config-unsupported-field", path: "telemetry" }),
		);
	});

	it("shadows a global provider retry delay when project provider settings replace it", () => {
		const result = parse([
			settings("global/settings.json", JSON.stringify({ retry: { provider: { maxRetryDelayMs: 1250 } } })),
			settings("project/settings.json", JSON.stringify({ retry: { provider: { maxRetries: 2 } } })),
		]);
		expect(result.settings[0]?.values).toEqual({ "retry.maxDelayMs": 1250 });
		expect(result.settings[1]?.values).toEqual({ "retry.maxDelayMs": 60_000 });
		expect(result.effectiveSettings).toEqual({ "retry.maxDelayMs": 60_000 });
		expect(result.losses).toContainEqual(
			expect.objectContaining({ code: "config-unsupported-field", path: "retry.provider.maxRetries" }),
		);
	});
	it("reports current Prime-only telemetry and skills shapes and invalid shell paths", () => {
		const result = parse([
			settings(
				"global/settings.json",
				JSON.stringify({ telemetry: { enabled: true }, skills: ["custom-skill"], shellPath: 42 }),
			),
		]);
		expect(result.settings[0]?.values).toEqual({});
		expect(result.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "config-unsupported-field", path: "telemetry" }),
				expect.objectContaining({ code: "config-unsupported-field", path: "skills" }),
				expect.objectContaining({ code: "config-invalid-value", path: "shellPath" }),
			]),
		);
	});

	it("reports malformed skipped legacy and unsupported settings", () => {
		const result = parse([
			settings(
				"global/settings.json",
				JSON.stringify({
					apiKeys: [],
					queueMode: 1,
					websockets: "yes",
					transport: "invalid",
					skills: { enableSkillCommands: "yes", customDirectories: "no", unexpected: true },
					telemetry: { enabled: "yes" },
				}),
			),
		]);
		expect(result.settings[0]?.values).toEqual({});
		expect(result.losses).toEqual(
			expect.arrayContaining(
				[
					"apiKeys",
					"queueMode",
					"websockets",
					"transport",
					"skills.enableSkillCommands",
					"skills.customDirectories",
					"telemetry",
				].map(path => expect.objectContaining({ code: "config-invalid-value", path })),
			),
		);
		expect(result.losses).toContainEqual(
			expect.objectContaining({ code: "config-unknown-field", path: "skills.unexpected" }),
		);
	});
	it("bounds structurally deep recognized settings values without dropping valid siblings", () => {
		const depth = 100_000;
		const nestedEnabledModels = `${"[".repeat(depth)}"model"${"]".repeat(depth)}`;
		const raw = `{"enabledModels":${nestedEnabledModels},"steeringMode":"all"}`;
		expect(Buffer.byteLength(raw)).toBeLessThan(1024 * 1024);

		let result: PrimeConfigParserResult | undefined;
		expect(() => {
			result = parse([settings("global/settings.json", raw)]);
		}).not.toThrow();
		expect(result).toBeDefined();
		if (result === undefined) return;

		expect(result.settings[0]?.values).toEqual({ steeringMode: "all" });
		expect(result.losses).toContainEqual(
			expect.objectContaining({
				code: "config-invalid-value",
				domain: "settings",
				sourceRef: "global/settings.json",
				path: "enabledModels",
			}),
		);
	});

	it("matches Prime models JSON comments and trailing-comma parsing while preserving strings", () => {
		const result = parse([
			models(`{
			// comment
			"providers": { "local": {
				"baseUrl": "https://example.test//keep",
				"api": "openai-completions",
				"apiKey": "sk-local",
				"models": [{ "id": "model//keep", "name": "x", }],
			}, },
		}`),
		]);
		expect(result.models).toHaveLength(1);
		expect(result.models[0]).toMatchObject({
			provider: "local",
			model: { id: "model//keep", baseUrl: "https://example.test//keep" },
		});
	});

	it("normalizes destination-representable provider/model fields and thinking maps", () => {
		const result = parse([
			models(
				JSON.stringify({
					providers: {
						local: {
							baseUrl: "https://example.test",
							api: "openai-completions",
							apiKey: "LOCAL_API_KEY",
							headers: { "X-Test": "value" },
							models: [
								{
									id: "model",
									name: "Display",
									reasoning: true,
									thinkingLevelMap: { off: null, low: "slow", medium: "balanced", high: "fast" },
									input: ["text", "image"],
									cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
									contextWindow: 8192,
									maxTokens: 1024,
								},
							],
						},
					},
				}),
			),
		]);
		const model = result.models[0];
		expect(model?.model).toMatchObject({
			id: "model",
			name: "Display",
			api: "openai-completions",
			baseUrl: "https://example.test",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
			contextWindow: 8192,
			maxTokens: 1024,
			thinking: {
				mode: "effort",
				efforts: ["minimal", "low", "medium", "high"],
				effortMap: { low: "slow", medium: "balanced", high: "fast" },
			},
		});
		expect(model?.providerApiKey).toEqual({ classification: "env_or_literal_ref" });
	});
	it("normalizes every header value without exposing command, env, or literal bytes", () => {
		const result = parse([
			models(
				JSON.stringify({
					providers: {
						provider: {
							api: "openai-completions",
							headers: { "X-Provider": "ordinary-provider" },
							models: [
								{
									id: "model",
									headers: {
										"X-Build": "!cat secret-file",
										"X-Env": "TOKEN_NAME",
										"X-Test": "ordinary-value",
									},
								},
							],
						},
					},
				}),
			),
		]);
		const model = result.models[0]?.model;
		expect(model?.headers).toEqual({
			"X-Test": { classification: "literal_api_key", secretOperationId: expect.any(String) },
		});
		const operationId = model?.headers?.["X-Test"]?.secretOperationId;
		expect(operationId).toBeDefined();
		expect(result.secretTable.get(operationId ?? "")).toBe("ordinary-value");
		expect(result.models[0]?.providerConfig?.headers).toEqual({
			"X-Provider": { classification: "literal_api_key", secretOperationId: expect.any(String) },
		});
		expect(result.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "credentials-command-ref", path: "headers.X-Build" }),
				expect.objectContaining({ code: "credentials-env-ref", path: "headers.X-Env" }),
			]),
		);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("secret-file");
		expect(serialized).not.toContain("TOKEN_NAME");
		expect(serialized).not.toContain("ordinary-value");
	});

	it("reports unsupported compat and routing fields instead of guessing", () => {
		const result = parse([
			models(
				JSON.stringify({
					providers: {
						openrouter: {
							baseUrl: "https://example.test",
							api: "openai-completions",
							compat: { openRouterRouting: { only: ["a"], order: ["b"], allow_fallbacks: true } },
							models: [
								{
									id: "m",
									compat: {
										supportsStore: true,
										supportsEagerToolInputStreaming: false,
										openRouterRouting: { only: ["a"], ignore: ["secret"] },
									},
								},
							],
						},
					},
				}),
			),
		]);
		expect(result.models[0]?.model.compat).toMatchObject({
			supportsStore: true,
			supportsEagerToolInputStreaming: false,
			openRouterRouting: { only: ["a"] },
		});
		expect(result.losses).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "models-unsupported-routing" })]),
		);
	});
	it("preserves provider and model compat at their original scopes", () => {
		const result = parse([
			models(
				JSON.stringify({
					providers: {
						p: {
							compat: { supportsDeveloperRole: false },
							models: [{ id: "m", compat: { supportsStore: true } }],
						},
					},
				}),
			),
		]);
		expect(result.models[0]?.model.compat).toEqual({
			supportsStore: true,
		});
		expect(result.models[0]?.providerConfig?.compat).toEqual({
			supportsDeveloperRole: false,
		});
	});
	it("validates compat enums and unsupported Prime compat keys", () => {
		const result = parse([
			models(
				JSON.stringify({
					providers: {
						p: {
							compat: {
								supportsStrictMode: "yes",
								maxTokensField: "bogus",
								thinkingFormat: "deepseek",
								requiresReasoningContentOnAssistantMessages: true,
								reasoningEffortMap: { bogus: "x" },
							},
							models: [{ id: "m", thinkingLevelMap: { low: "slow", bogus: "unsupported" } }],
						},
					},
				}),
			),
		]);
		expect(result.models[0]?.providerConfig?.compat).toBeUndefined();
		expect(result.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "models-invalid-value", path: "compat.supportsStrictMode" }),
				expect.objectContaining({ code: "models-unsupported-compat", path: "compat.maxTokensField" }),
				expect.objectContaining({ code: "models-unsupported-compat", path: "compat.thinkingFormat" }),
				expect.objectContaining({
					code: "models-unsupported-compat",
					path: "compat.requiresReasoningContentOnAssistantMessages",
				}),
				expect.objectContaining({ code: "models-unsupported-compat", path: "compat.reasoningEffortMap" }),
			]),
		);
	});

	it("normalizes override-only and mixed providers with partial override costs", () => {
		const result = parse([
			models(
				JSON.stringify({
					providers: {
						p: {
							baseUrl: "https://example.test",
							name: "Unsupported display name",
							authHeader: true,
							auth: "apiKey",
							modelOverrides: {
								"bundled:model": {
									cost: { input: 2 },
									headers: { "X-Key": "override-secret" },
									reasoning: true,
								},
							},
							models: [{ id: "custom", name: "Custom" }],
						},
					},
				}),
			),
		]);
		expect(result.models.map(item => item.modelKind)).toEqual(["definition", "override"]);
		const override = result.models.find(item => item.modelKind === "override");
		expect(override?.model).toMatchObject({ id: "bundled:model", cost: { input: 2 }, reasoning: true });
		expect(override?.providerConfig?.baseUrl).toBe("https://example.test");
		expect(override?.providerConfig).toMatchObject({
			baseUrl: "https://example.test",
			authHeader: true,
			auth: "apiKey",
		});
		expect(override?.model).not.toHaveProperty("baseUrl");
		expect(override?.providerConfig).not.toHaveProperty("name");
		const secretId = override?.model.headers?.["X-Key"]?.secretOperationId;
		expect(result.secretTable.get(secretId ?? "")).toBe("override-secret");
	});

	it("classifies literal, command, env-or-literal, OAuth, and ambient credentials without resolving them", () => {
		const result = parse([
			auth(
				"global/auth.json",
				JSON.stringify({
					literal: { type: "api_key", key: "sk-secret-value" },
					command: { type: "api_key", key: "!printf secret" },
					env: { type: "api_key", key: "PROVIDER_API_KEY" },
					oauth: { type: "oauth", access: "oauth-secret", refresh: "refresh-secret", expires: 123 },
					ambient: { type: "ambient" },
				}),
			),
		]);
		const credentials = Object.fromEntries(result.credentials.map(item => [item.provider, item]));
		expect(credentials.literal?.classification).toBe("literal_api_key");
		expect(credentials.literal?.secretOperationId).toMatch(/^credential-/);
		expect(credentials.command?.classification).toBe("command_ref");
		expect(credentials.env?.classification).toBe("env_or_literal_ref");
		expect(credentials.oauth?.classification).toBe("oauth_relogin");
		expect(credentials.ambient?.classification).toBe("ambient_dependency");
		expect(result.secretTable.get(credentials.literal?.secretOperationId ?? "")).toBe("sk-secret-value");
	});

	it("maps legacy oauth.json and settings.apiKeys with deterministic precedence", () => {
		const result = parse([
			settings(
				"global/settings.json",
				JSON.stringify({ apiKeys: { settingsOnly: "sk-settings", duplicate: "sk-old" } }),
			),
			auth(
				"global/oauth.json",
				JSON.stringify({ oauthOnly: { access: "token", refresh: "refresh" }, duplicate: { access: "a" } }),
			),
			auth("global/auth.json", JSON.stringify({ duplicate: { type: "api_key", key: "sk-new" } })),
		]);
		const credentials = Object.fromEntries(result.credentials.map(item => [item.provider, item]));
		expect(credentials.settingsOnly?.classification).toBe("literal_api_key");
		expect(credentials.oauthOnly?.classification).toBe("oauth_relogin");
		expect(credentials.duplicate?.classification).toBe("literal_api_key");
		expect(result.secretTable.get(credentials.duplicate?.secretOperationId ?? "")).toBe("sk-new");
	});
	it("selects project settings API keys before global settings keys", () => {
		const result = parse([
			settings("global/settings.json", JSON.stringify({ apiKeys: { shared: "global-key" } })),
			settings(
				"project/settings.json",
				JSON.stringify({ apiKeys: { projectOnly: "project-key", shared: "project-key" } }),
			),
		]);
		const credentials = Object.fromEntries(result.credentials.map(item => [item.provider, item]));
		expect(credentials.projectOnly?.classification).toBe("literal_api_key");
		expect(credentials.shared?.classification).toBe("literal_api_key");
		expect(result.secretTable.get(credentials.projectOnly?.secretOperationId ?? "")).toBe("project-key");
		expect(result.secretTable.get(credentials.shared?.secretOperationId ?? "")).toBe("project-key");
	});

	it("selects auth credentials before project settings API keys", () => {
		const result = parse([
			auth("global/auth.json", JSON.stringify({ provider: { type: "api_key", key: "auth-key" } })),
			settings("project/settings.json", JSON.stringify({ apiKeys: { provider: "project-key" } })),
			settings("global/settings.json", JSON.stringify({ apiKeys: { provider: "global-key" } })),
		]);
		const credential = result.credentials.find(item => item.provider === "provider");
		expect(credential?.classification).toBe("literal_api_key");
		expect(result.secretTable.get(credential?.secretOperationId ?? "")).toBe("auth-key");
	});

	it("rejects invalid credential providers without creating operations or secrets", () => {
		const invalidProviders = ["", " \t", "bad\u0000provider", "bad\nprovider"];
		const result = parse([
			settings(
				"project/settings.json",
				JSON.stringify({
					apiKeys: Object.fromEntries(invalidProviders.map((provider, index) => [provider, `secret-${index}`])),
				}),
			),
		]);
		expect(result.credentials).toEqual([]);
		expect(result.secretTable.toJSON()).toBeUndefined();
		expect(result.losses.filter(item => item.code === "credentials-unknown")).toHaveLength(invalidProviders.length);
		expect(
			result.losses
				.filter(item => item.code === "credentials-unknown")
				.every(item => item.sourceRef === "project/settings.json"),
		).toBe(true);
		const serialized = JSON.stringify(result);
		for (const secret of invalidProviders.map((_, index) => `secret-${index}`))
			expect(serialized).not.toContain(secret);
	});

	it("rejects ambiguous model providers before model or credential normalization", () => {
		const result = parse([
			models(
				JSON.stringify({
					providers: {
						"ambiguous:definition:provider": {
							apiKey: "model-secret",
							models: [{ id: "m", headers: { "X-Key": "header-secret" } }],
						},
						"ambiguous:override:provider": {
							modelOverrides: { m: { headers: { "X-Key": "override-secret" } } },
						},
					},
				}),
			),
		]);
		expect(result.models).toEqual([]);
		expect(result.credentials).toEqual([]);
		expect(result.losses.filter(item => item.code === "models-invalid-value")).toHaveLength(2);
		expect(
			result.losses
				.filter(item => item.code === "models-invalid-value")
				.every(item => item.sourceRef === "global/models.json"),
		).toBe(true);
		const serialized = JSON.stringify(result);
		for (const secret of ["model-secret", "header-secret", "override-secret"])
			expect(serialized).not.toContain(secret);
	});
	it("rejects prototype provider and override keys before model normalization", () => {
		const providers = parse([
			models(
				'{"providers":{"__proto__":{"apiKey":"pollute","models":[{"id":"proto"}]},"prototype":{"models":[{"id":"prototype"}]},"constructor":{"models":[{"id":"constructor"}]}}}',
			),
		]);
		expect(providers.models).toEqual([]);
		expect(providers.credentials).toEqual([]);
		expect(providers.losses.filter(item => item.code === "models-invalid-value")).toHaveLength(3);
		const overrides = parse([
			models(
				'{"providers":{"safe":{"modelOverrides":{"__proto__":{"headers":{"X-Key":"pollute"}},"prototype":{"name":"prototype"},"constructor":{"name":"constructor"}}}}}',
			),
		]);
		expect(overrides.models).toEqual([]);
		expect(overrides.losses.filter(item => item.code === "models-invalid-value")).toHaveLength(3);
		expect(Object.hasOwn(Object.prototype, "pollute")).toBe(false);
	});

	it("keeps nested prototype keys out of Object.prototype while normalizing models", () => {
		const result = parse([
			models(
				'{"providers":{"safe":{"headers":{"__proto__":"header-secret"},"compat":{"openRouterRouting":{"__proto__":["polluted"],"only":["safe"]}},"models":[{"id":"model","compat":{"openRouterRouting":{"order":["model"]}}}]}}}',
			),
		]);
		expect(result.models).toHaveLength(1);
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
		expect(Object.hasOwn(result.models[0]?.providerConfig?.headers ?? {}, "__proto__")).toBe(true);
		expect(result.models[0]?.providerConfig?.compat).toEqual({
			openRouterRouting: { only: ["safe"] },
		});
		expect(result.models[0]?.model.compat).toEqual({ openRouterRouting: { order: ["model"] } });
	});

	it("selects auth credentials before legacy settings and models fallback", () => {
		const result = parse([
			auth("global/auth.json", JSON.stringify({ provider: { type: "api_key", key: "auth-key" } })),
			settings("global/settings.json", JSON.stringify({ apiKeys: { provider: "settings-key" } })),
			models(
				JSON.stringify({
					providers: { provider: { apiKey: "models-key", api: "openai-completions", models: [{ id: "m" }] } },
				}),
			),
		]);
		const credential = result.credentials.find(item => item.provider === "provider");
		expect(credential?.classification).toBe("literal_api_key");
		expect(result.secretTable.get(credential?.secretOperationId ?? "")).toBe("auth-key");
		expect(result.models[0]?.providerApiKey?.secretOperationId).toBe(credential?.secretOperationId);
		expect(result.secretTable.get(result.models[0]?.providerApiKey?.secretOperationId ?? "")).toBe("auth-key");
	});

	it("keeps duplicate model header IDs distinct by array index", () => {
		const result = parse([
			models(
				JSON.stringify({
					providers: {
						"provider:colon": {
							api: "openai-completions",
							models: [
								{ id: "model:id", headers: { "X-Key": "first-header-secret" } },
								{ id: "model:id", headers: { "X-Key": "second-header-secret" } },
							],
						},
					},
				}),
			),
		]);
		const first = result.models[0]?.model.headers?.["X-Key"]?.secretOperationId;
		const second = result.models[1]?.model.headers?.["X-Key"]?.secretOperationId;
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).not.toBe(second);
		expect(result.secretTable.get(first ?? "")).toBe("first-header-secret");
		expect(result.secretTable.get(second ?? "")).toBe("second-header-secret");
		expect(() => result.secretTable.add(first ?? "", "rebind")).toThrow("duplicate secret operation id");
	});
	it("keeps structurally distinct delimiter-collision header identities separate", () => {
		const result = parse([
			models(
				JSON.stringify({
					providers: {
						x: { models: [{ id: "y:header:z:model:1:q", headers: { r: "first" } }] },
						"x:model:0:y:header:z": { models: [{ id: "q", headers: { r: "second" } }] },
					},
				}),
			),
		]);
		const first = result.models[0]?.model.headers?.r?.secretOperationId;
		const second = result.models[1]?.model.headers?.r?.secretOperationId;
		expect(first).not.toBe(second);
		expect(result.secretTable.get(first ?? "")).toBe("first");
		expect(result.secretTable.get(second ?? "")).toBe("second");
	});

	it("keeps definition and override header identities separate", () => {
		const result = parse([
			models(
				JSON.stringify({
					providers: {
						p: {
							models: [{ id: "same", headers: { "X-Key": "definition-secret" } }],
							modelOverrides: { same: { headers: { "X-Key": "override-secret" } } },
						},
					},
				}),
			),
		]);
		const definitionId = result.models.find(item => item.modelKind === "definition")?.model.headers?.["X-Key"]
			?.secretOperationId;
		const overrideId = result.models.find(item => item.modelKind === "override")?.model.headers?.["X-Key"]
			?.secretOperationId;
		expect(definitionId).not.toBe(overrideId);
		expect(result.secretTable.get(definitionId ?? "")).toBe("definition-secret");
		expect(result.secretTable.get(overrideId ?? "")).toBe("override-secret");
	});

	it("is deterministic when source inventory order changes", () => {
		const files = [
			settings(
				"global/settings.json",
				JSON.stringify({ defaultProvider: "p", defaultModel: "m", compaction: { enabled: true } }),
			),
			settings("project/settings.json", JSON.stringify({ defaultThinkingLevel: "high" })),
			models(
				JSON.stringify({
					providers: { p: { api: "openai-completions", models: [{ id: "m", headers: { "X-Test": "literal" } }] } },
				}),
			),
			auth("global/auth.json", JSON.stringify({ p: { type: "api_key", key: "literal-key" } })),
		];
		const first = JSON.stringify(parse(files));
		const second = JSON.stringify(parse([...files].reverse()));
		expect(second).toBe(first);
	});
	it("maps defaults to the contributing scope and strips Prime-only keys", () => {
		const globalOnly = parse([
			settings(
				"global/settings.json",
				JSON.stringify({ defaultProvider: "p", defaultModel: "m", defaultThinkingLevel: "off" }),
			),
			settings("project/settings.json", JSON.stringify({ shellPath: "/bin/sh" })),
		]);
		expect(globalOnly.settings[0]?.values).toEqual({ modelRoles: { default: "p/m:off" } });
		expect(globalOnly.settings[1]?.values).toEqual({ shellPath: "/bin/sh" });
		expect(globalOnly.effectiveSettings).toEqual({ shellPath: "/bin/sh", modelRoles: { default: "p/m:off" } });

		const split = parse([
			settings("global/settings.json", JSON.stringify({ defaultProvider: "p" })),
			settings("project/settings.json", JSON.stringify({ defaultModel: "m" })),
		]);
		expect(split.settings[1]?.values).toEqual({ modelRoles: { default: "p/m" } });
		expect(split.effectiveSettings).toEqual({ modelRoles: { default: "p/m" } });
	});

	it("scopes a project off default to the project model role", () => {
		const projectOff = parse([
			settings("global/settings.json", JSON.stringify({ defaultProvider: "p", defaultModel: "m" })),
			settings("project/settings.json", JSON.stringify({ defaultThinkingLevel: "off" })),
		]);
		expect(projectOff.settings[0]?.values).toEqual({});
		expect(projectOff.settings[1]?.values).toEqual({ modelRoles: { default: "p/m:off" } });
		expect(projectOff.effectiveSettings).toEqual({ modelRoles: { default: "p/m:off" } });
	});
	it("removes an overridden global thinking level when the project default is off", () => {
		const result = parse([
			settings(
				"global/settings.json",
				JSON.stringify({ defaultProvider: "p", defaultModel: "m", defaultThinkingLevel: "high" }),
			),
			settings("project/settings.json", JSON.stringify({ defaultThinkingLevel: "off" })),
		]);
		expect(result.settings[0]?.values).toEqual({});
		expect(result.settings[1]?.values).toEqual({ modelRoles: { default: "p/m:off" } });
		expect(result.effectiveSettings).toEqual({ modelRoles: { default: "p/m:off" } });
	});

	it("drops incomplete off defaults and reports the unsupported role", () => {
		const result = parse([settings("global/settings.json", JSON.stringify({ defaultThinkingLevel: "off" }))]);
		expect(result.settings[0]?.values).toEqual({});
		expect(result.effectiveSettings).toEqual({});
		expect(result.losses).toContainEqual(
			expect.objectContaining({ code: "config-unsupported-field", path: "modelRoles.default" }),
		);
	});

	it("reports malformed and unknown config items as stable typed losses", () => {
		const result = parse([
			settings("global/settings.json", "{ malformed"),
			models('{"providers": {"bad": {"models": [{"id": 3}]}}}'),
			auth("global/auth.json", "[]"),
		]);
		expect(result.losses.map(loss => loss.code)).toEqual(
			expect.arrayContaining(["config-malformed", "models-invalid-value", "credentials-malformed"]),
		);
	});

	it("keeps public results secret-free and safely serializable", () => {
		const result = parse([
			auth(
				"global/auth.json",
				JSON.stringify({
					provider: { type: "api_key", key: "sk-super-secret" },
					oauth: { type: "oauth", access: "oauth-secret", refresh: "refresh-secret" },
					env: { type: "api_key", key: "ENV_SECRET_NAME" },
				}),
			),
			models(
				JSON.stringify({
					providers: {
						p: {
							apiKey: "!cat secret-file",
							models: [{ id: "m", api: "openai-completions", baseUrl: "https://example.test" }],
						},
					},
				}),
			),
		]);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("sk-super-secret");
		expect(serialized).not.toContain("ENV_SECRET_NAME");
		expect(serialized).not.toContain("secret-file");
		expect(serialized).not.toContain("cat secret-file");
		expect(serialized).not.toContain("oauth-secret");
		expect(serialized).not.toContain("refresh-secret");
		expect(result.secretTable.toJSON()).toBeUndefined();
	});
});
