import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelOverrideWithAuthFallback } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runExtensionSetModel } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/compact-handler";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function modelKey(model: Model): string {
	return `${model.provider}/${model.id}`;
}

const IMAGE_PROVIDER_ENV_KEYS = [
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"XAI_API_KEY",
	"XAI_OAUTH_TOKEN",
] as const;

async function withoutImageProviderEnv<T>(run: () => Promise<T>): Promise<T> {
	const originalValues = new Map<string, string | undefined>();
	for (const key of IMAGE_PROVIDER_ENV_KEYS) {
		originalValues.set(key, Bun.env[key]);
		delete Bun.env[key];
	}
	try {
		return await run();
	} finally {
		for (const [key, value] of originalValues) {
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	}
}

describe("model scope enforcement", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-model-scope-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
	});

	function requireModel(provider: string, id: string): Model {
		const model = modelRegistry.find(provider, id);
		if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
		return model;
	}

	function createScopedSession(options?: { modelRoles?: Record<string, string> }): AgentSession {
		const scopedModel = requireModel("openai", "gpt-4o-mini");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: provider => `${provider}-test-key`,
				initialState: { model: scopedModel, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"contextPromotion.enabled": false,
				modelRoles: options?.modelRoles ?? {},
			}),
			modelRegistry,
			scopedModels: [{ model: scopedModel }],
		});
		return session;
	}

	it("leaves model selection unrestricted when no scope is configured", async () => {
		const initialModel = requireModel("openai", "gpt-4o-mini");
		const otherModel = requireModel("anthropic", "claude-sonnet-4-5");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: provider => `${provider}-test-key`,
				initialState: { model: initialModel, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});

		expect(session.getAvailableModels().map(modelKey)).toContain(modelKey(otherModel));
		await session.setModel(otherModel);
		expect(session.model ? modelKey(session.model) : undefined).toBe(modelKey(otherModel));
	});

	it("filters available models and rejects direct switches outside scope", async () => {
		const scopedModel = requireModel("openai", "gpt-4o-mini");
		const outOfScopeModel = requireModel("anthropic", "claude-sonnet-4-5");
		const scopedSession = createScopedSession();

		expect(scopedSession.getAvailableModels().map(modelKey)).toEqual([modelKey(scopedModel)]);
		await expect(scopedSession.setModel(outOfScopeModel)).rejects.toThrow("outside active model scope");
		expect(modelKey(scopedSession.model!)).toBe(modelKey(scopedModel));
	});

	it("does not resolve role models outside scope", () => {
		const scopedSession = createScopedSession({
			modelRoles: { plan: "anthropic/claude-sonnet-4-5" },
		});

		const resolved = scopedSession.resolveRoleModelWithThinking("plan");

		expect(resolved.model).toBeUndefined();
	});

	it("uses the scoped model instead of a default role outside scope during startup", async () => {
		const scopedModel = requireModel("openai", "gpt-4o-mini");
		const outOfScopeModel = requireModel("anthropic", "claude-sonnet-4-5");
		const settings = Settings.isolated({
			modelRoles: { default: modelKey(outOfScopeModel) },
		});

		const result = await createAgentSession({
			cwd: tempDir.path(),
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			scopedModels: [{ model: scopedModel }],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;

		expect(session.model ? modelKey(session.model) : undefined).toBe(modelKey(scopedModel));
		expect(session.getAvailableModels().map(modelKey)).toEqual([modelKey(scopedModel)]);
	});

	it("registers image generation tools after deferred CLI scope selection", async () => {
		const scopedModel = requireModel("openai", "gpt-4o-mini");

		await withoutImageProviderEnv(async () => {
			const result = await createAgentSession({
				cwd: tempDir.path(),
				authStorage,
				modelRegistry,
				settings: Settings.isolated({}),
				sessionManager: SessionManager.inMemory(),
				modelScopePatterns: [modelKey(scopedModel)],
				preferScopedModelOrder: true,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			session = result.session;

			expect(session.model ? modelKey(session.model) : undefined).toBe(modelKey(scopedModel));
			expect(session.getAllToolNames()).toContain("generate_image");
			expect(session.getActiveToolNames()).toContain("generate_image");
		});
	});

	it("keeps OpenRouter route-suffix scope clones available without broadening to the base model", async () => {
		const baseModel: Model = {
			id: "z-ai/glm-4.7",
			name: "GLM 4.7",
			api: "anthropic-messages",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			thinking: {
				mode: "budget",
				minLevel: Effort.Minimal,
				maxLevel: Effort.High,
			},
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => [baseModel]);
		vi.spyOn(modelRegistry, "getAll").mockImplementation(() => [baseModel]);

		const result = await createAgentSession({
			cwd: tempDir.path(),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({}),
			sessionManager: SessionManager.inMemory(),
			modelScopePatterns: ["openrouter/z-ai/glm-4.7-20251222:nitro"],
			preferScopedModelOrder: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;

		expect(session.model ? modelKey(session.model) : undefined).toBe("openrouter/z-ai/glm-4.7-20251222:nitro");
		expect(session.getAvailableModels().map(modelKey)).toEqual(["openrouter/z-ai/glm-4.7-20251222:nitro"]);
		await expect(session.setModel(baseModel)).rejects.toThrow("outside active model scope");
	});

	it("restores saved scoped models after deferred CLI scope credentials are applied", async () => {
		const firstScopedModel = requireModel("openai", "gpt-4o-mini");
		const savedModel = requireModel("openai", "gpt-5");
		authStorage.removeRuntimeApiKey("openai");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		sessionManager.appendModelChange(modelKey(savedModel));

		await withoutImageProviderEnv(async () => {
			const result = await createAgentSession({
				cwd: tempDir.path(),
				authStorage,
				modelRegistry,
				settings: Settings.isolated({}),
				sessionManager,
				modelScopePatterns: [modelKey(firstScopedModel), modelKey(savedModel)],
				modelScopeApiKey: "openai-cli-key",
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			session = result.session;

			expect(session.model ? modelKey(session.model) : undefined).toBe(modelKey(savedModel));
			expect(result.modelFallbackMessage).toBeUndefined();
		});
	});

	it("applies CLI runtime API keys to provider-qualified glob scopes", async () => {
		authStorage.removeRuntimeApiKey("openai");

		await withoutImageProviderEnv(async () => {
			const result = await createAgentSession({
				cwd: tempDir.path(),
				authStorage,
				modelRegistry,
				settings: Settings.isolated({}),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				modelScopePatterns: ["openai/*"],
				modelScopeApiKey: "openai-cli-key",
				preferScopedModelOrder: true,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			session = result.session;

			const selectedModel = session.model;
			expect(selectedModel?.provider).toBe("openai");
			if (!selectedModel) throw new Error("Expected session to select an OpenAI scoped model");
			expect(await modelRegistry.getApiKey(selectedModel)).toBe("openai-cli-key");
			expect([...new Set(session.scopedModels.map(scoped => scoped.model.provider))]).toEqual(["openai"]);
		});
	});

	it("preserves explicit scoped models before credentials are available", async () => {
		const scopedModel = requireModel("openai", "gpt-4o-mini");
		authStorage.removeRuntimeApiKey("openai");

		await withoutImageProviderEnv(async () => {
			const result = await createAgentSession({
				cwd: tempDir.path(),
				authStorage,
				modelRegistry,
				settings: Settings.isolated({}),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				model: scopedModel,
				modelScopePatterns: [modelKey(scopedModel)],
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			session = result.session;

			expect(session.model ? modelKey(session.model) : undefined).toBe(modelKey(scopedModel));
			expect(result.modelFallbackMessage).toBeUndefined();
		});
	});

	it("treats a configured empty scope as no usable model", async () => {
		const result = await createAgentSession({
			cwd: tempDir.path(),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({}),
			sessionManager: SessionManager.inMemory(),
			scopedModels: [],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;

		expect(session.model).toBeUndefined();
		expect(session.getAvailableModels()).toEqual([]);
		expect(result.modelFallbackMessage).toContain("active model scope (no models)");
	});

	it("re-resolves settings enabledModels after model availability changes", async () => {
		const scopedModel = requireModel("openai", "gpt-4o-mini");
		let scopedModelAvailable = false;
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => (scopedModelAvailable ? [scopedModel] : []));

		const result = await createAgentSession({
			cwd: tempDir.path(),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				enabledModels: [modelKey(scopedModel)],
			}),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;

		expect(session.hasModelScope).toBe(true);
		expect(session.getAvailableModels()).toEqual([]);

		scopedModelAvailable = true;
		await modelRegistry.refresh("offline");

		expect(session.getAvailableModels().map(modelKey)).toEqual([modelKey(scopedModel)]);
		await session.setModel(scopedModel);
		expect(session.model ? modelKey(session.model) : undefined).toBe(modelKey(scopedModel));
	});

	it("preserves enabledModels order during startup fallback", async () => {
		const firstScopedModel = requireModel("openai", "gpt-4o-mini");
		const secondScopedModel = requireModel("anthropic", "claude-sonnet-4-5");

		const result = await createAgentSession({
			cwd: tempDir.path(),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				enabledModels: [modelKey(firstScopedModel), modelKey(secondScopedModel)],
			}),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;

		expect(session.model ? modelKey(session.model) : undefined).toBe(modelKey(firstScopedModel));
		expect(session.getAvailableModels().map(modelKey)).toEqual([
			modelKey(firstScopedModel),
			modelKey(secondScopedModel),
		]);
	});

	it("applies scoped thinking when fallback selects an enabledModels model", async () => {
		const scopedModel = requireModel("anthropic", "claude-sonnet-4-5");

		const result = await createAgentSession({
			cwd: tempDir.path(),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				defaultThinkingLevel: Effort.High,
				enabledModels: [`${modelKey(scopedModel)}:low`],
			}),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;

		expect(session.model ? modelKey(session.model) : undefined).toBe(modelKey(scopedModel));
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("keeps retry fallback chains inside scope", async () => {
		const scopedModel = requireModel("openai", "gpt-4o-mini");
		const outOfScopeFallback = requireModel("anthropic", "claude-sonnet-4-5");
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const mock = createMockModel();
		let attempts = 0;

		session = new AgentSession({
			agent: new Agent({
				getApiKey: provider => `${provider}-test-key`,
				initialState: { model: scopedModel, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (requestedModel, context, options) => {
					requestedModels.push(modelKey(requestedModel));
					if (attempts === 0) {
						attempts += 1;
						mock.push({ throw: "overloaded_error: provider returned error 503" });
					} else {
						mock.push({ content: ["Recovered in scope"] });
					}
					return mock.stream(requestedModel, context, options);
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"contextPromotion.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxRetries": 1,
				"retry.fallbackChains": { default: [modelKey(outOfScopeFallback)] },
				modelRoles: { default: modelKey(scopedModel) },
			}),
			modelRegistry,
			scopedModels: [{ model: scopedModel }],
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Retry without leaving scope");
		await session.waitForIdle();

		expect(requestedModels).toEqual([modelKey(scopedModel), modelKey(scopedModel)]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(session.model ? modelKey(session.model) : undefined).toBe(modelKey(scopedModel));
	});

	it("falls back task model resolution to the scoped parent model", async () => {
		const scopedModel = requireModel("openai", "gpt-4o-mini");
		const outOfScopeTaskModel = requireModel("anthropic", "claude-sonnet-4-5");

		const result = await resolveModelOverrideWithAuthFallback(
			[modelKey(outOfScopeTaskModel)],
			modelKey(scopedModel),
			modelRegistry,
			Settings.isolated({}),
			[{ model: scopedModel }],
		);

		expect(result.fallbackReason).toBe("scope");
		expect(result.model ? modelKey(result.model) : undefined).toBe(modelKey(scopedModel));
	});

	it("does not fall back misspelled task model overrides to the scoped parent model", async () => {
		const scopedModel = requireModel("openai", "gpt-4o-mini");

		const result = await resolveModelOverrideWithAuthFallback(
			["anthropic/not-a-real-model"],
			modelKey(scopedModel),
			modelRegistry,
			Settings.isolated({}),
			[{ model: scopedModel }],
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.fallbackReason).toBeUndefined();
		expect(result.model).toBeUndefined();
	});

	it("returns false for extension model switches outside scope", async () => {
		const scopedModel = requireModel("openai", "gpt-4o-mini");
		const outOfScopeModel = requireModel("anthropic", "claude-sonnet-4-5");
		const getApiKey = vi.fn(async (_model: Model) => "sk-test-token");
		const setModel = vi.fn(async (_model: Model) => {});

		const result = await runExtensionSetModel(
			{
				getAvailableModels: () => [scopedModel],
				modelRegistry: { getApiKey },
				setModel,
			},
			outOfScopeModel,
		);

		expect(result).toBe(false);
		expect(getApiKey).not.toHaveBeenCalled();
		expect(setModel).not.toHaveBeenCalled();
	});
});
