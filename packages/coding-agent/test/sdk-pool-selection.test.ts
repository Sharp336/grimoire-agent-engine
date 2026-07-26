import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type ModelUsageHealth } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions as buildCliSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Startup pool selection. The role `task` lists two candidates, so weighted
 * selection draws one of them from `pool:<session id>`. Session ids here are
 * fixed, so every expected model below is a pinned value, not a distribution.
 *
 * hashPoolSeed("pool:pool-session-past-cut") / 2^32 = 0.8988, which lands past
 * the halfway cut of two equal-weight candidates and picks the second one.
 * hashPoolSeed("pool:pool-session-before-cut") / 2^32 = 0.1498, which picks the
 * first.
 */
describe("createAgentSession model pool selection", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-pool-selection-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const authStorage of authStoragesToClose) {
			authStorage.close();
		}
		authStoragesToClose.length = 0;
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider("runtime-provider", {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [
				{
					id: "runtime-model",
					name: "Runtime Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
				{
					id: "runtime-reasoning-model",
					name: "Runtime Reasoning Model",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};

	/** A second provider, so a test can disable one of the two pool candidates. */
	const secondProviderExtension: ExtensionFactory = pi => {
		pi.registerProvider("runtime-provider-b", {
			baseUrl: "https://runtime-b.example.com/v1",
			apiKey: "RUNTIME_KEY_B",
			api: "openai-completions",
			models: [
				{
					id: "runtime-model-b",
					name: "Runtime Model B",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};

	// Explicit ModelRegistry so createAgentSession skips its background model
	// discovery pass; both candidates come from the inline extension provider.
	async function buildSessionOptions(sessionId: string, label: string) {
		const authStorage = await AuthStorage.create(path.join(tempDir, `${label}-auth.db`));
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, `${label}-models.yml`));
		const sessionManager = SessionManager.inMemory();
		vi.spyOn(sessionManager, "getSessionId").mockReturnValue(sessionId);
		return {
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			hasUI: false,
			modelPattern: "task",
		};
	}

	function poolSettings(overrides: Record<string, unknown> = {}): Settings {
		const settings = Settings.isolated(overrides);
		settings.setModelRole("task", "runtime-provider/runtime-model,runtime-provider/runtime-reasoning-model");
		return settings;
	}

	test("starts on the first candidate when pool selection is unconfigured", async () => {
		const { session } = await createAgentSession({
			...(await buildSessionOptions("pool-session-past-cut", "control")),
			settings: poolSettings(),
		});
		try {
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("weighted selection draws the second candidate for a session id that lands past the cut", async () => {
		const { session } = await createAgentSession({
			...(await buildSessionOptions("pool-session-past-cut", "weighted")),
			settings: poolSettings({ "retry.poolSelection": "weighted" }),
		});
		try {
			expect(session.model?.id).toBe("runtime-reasoning-model");
		} finally {
			await session.dispose();
		}
	});

	test("weighted selection keeps the first candidate for a session id that lands before the cut", async () => {
		const { session } = await createAgentSession({
			...(await buildSessionOptions("pool-session-before-cut", "weighted-first")),
			settings: poolSettings({ "retry.poolSelection": "weighted" }),
		});
		try {
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("the same session id draws the same candidate every time", async () => {
		const picks: Array<string | undefined> = [];
		for (const label of ["resume-first", "resume-second"]) {
			const { session } = await createAgentSession({
				...(await buildSessionOptions("pool-session-past-cut", label)),
				settings: poolSettings({ "retry.poolSelection": "weighted" }),
			});
			picks.push(session.model?.id);
			await session.dispose();
		}
		expect(picks).toEqual(["runtime-reasoning-model", "runtime-reasoning-model"]);
	});

	/** Writes a one-turn session file whose persisted default model is `modelId`. */
	async function writeResumableSession(label: string, modelId: string) {
		const sessionFile = path.join(tempDir, `${label}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: label, timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: `runtime-provider/${modelId}`,
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return await SessionManager.open(sessionFile, path.join(tempDir, `${label}-sessions`));
	}

	test("resume without --model restores the persisted model and never consults health", async () => {
		// No model pattern means no deferred patterns, so the block hosting the draw
		// is unreachable. The session id is pinned to one that would draw
		// runtime-model, so a restore that silently fell through to the first
		// available model would land on the other model.
		const options = await buildSessionOptions("pool-session-past-cut", "resume-persisted");
		const sessionManager = await writeResumableSession("resume-persisted", "runtime-reasoning-model");
		vi.spyOn(sessionManager, "getSessionId").mockReturnValue("pool-session-before-cut");
		const healthSpy = vi.spyOn(options.authStorage, "getModelUsageHealth");
		const { session } = await createAgentSession({
			...options,
			sessionManager,
			modelPattern: undefined,
			settings: poolSettings({ "retry.poolSelection": "weighted", "retry.usageAwareFallback": true }),
		});
		try {
			expect(session.model?.id).toBe("runtime-reasoning-model");
			expect(healthSpy).not.toHaveBeenCalled();
		} finally {
			await session.dispose();
		}
	});

	test("resume with --model redraws the same candidate the seed picked", async () => {
		// An explicit pattern skips the persisted-model restore, so the draw runs
		// again. The persisted model is the one the seed does not pick, so a draw
		// that used anything but the session id would land on it.
		const options = await buildSessionOptions("pool-session-past-cut", "resume-redraw");
		const sessionManager = await writeResumableSession("resume-redraw", "runtime-model");
		vi.spyOn(sessionManager, "getSessionId").mockReturnValue("pool-session-past-cut");
		const { session } = await createAgentSession({
			...options,
			sessionManager,
			settings: poolSettings({ "retry.poolSelection": "weighted" }),
		});
		try {
			expect(session.model?.id).toBe("runtime-reasoning-model");
		} finally {
			await session.dispose();
		}
	});

	test("a weight of zero keeps a candidate out of the draw", async () => {
		const { session } = await createAgentSession({
			...(await buildSessionOptions("pool-session-past-cut", "zero-weight")),
			settings: poolSettings({
				"retry.poolSelection": "weighted",
				"retry.poolWeights": { "runtime-provider/runtime-reasoning-model": 0 },
			}),
		});
		try {
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("a depleted candidate is excluded from the draw and never prompts", async () => {
		const options = await buildSessionOptions("pool-session-past-cut", "depleted");
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, healthOptions) =>
			healthOptions.modelId === "runtime-reasoning-model"
				? { state: "depleted", accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }] }
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] },
		);
		const { session } = await createAgentSession({
			...options,
			settings: poolSettings({
				"retry.poolSelection": "weighted",
				"retry.usageAwareFallback": true,
				"retry.usageReservePolicy": "confirm",
			}),
		});
		try {
			// Without the health gate this session id draws runtime-reasoning-model.
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("unknown health participates in the draw at full weight", async () => {
		const options = await buildSessionOptions("pool-session-past-cut", "unknown-health");
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockResolvedValue({ state: "unknown", accounts: [] });
		const { session } = await createAgentSession({
			...options,
			settings: poolSettings({
				"retry.poolSelection": "weighted",
				"retry.usageAwareFallback": true,
			}),
		});
		try {
			expect(session.model?.id).toBe("runtime-reasoning-model");
		} finally {
			await session.dispose();
		}
	});

	test("all candidates depleted leaves the configured order to the shipped preflight", async () => {
		const options = await buildSessionOptions("pool-session-past-cut", "all-depleted");
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockResolvedValue({
			state: "depleted",
			accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }],
		});
		const { session } = await createAgentSession({
			...options,
			settings: poolSettings({
				"retry.poolSelection": "weighted",
				"retry.usageAwareFallback": true,
				"retry.usageReservePolicy": "auto",
			}),
		});
		try {
			// The draw is skipped, so the startup preflight walks the configured
			// order and lands on the last candidate exactly as it does today.
			expect(session.model?.id).toBe("runtime-reasoning-model");
		} finally {
			await session.dispose();
		}
	});

	test("a single-candidate role never draws", async () => {
		// The health gate is deliberately on: without the single-candidate fast
		// path the draw would fan out usage lookups here.
		const settings = Settings.isolated({
			"retry.poolSelection": "weighted",
			"retry.usageAwareFallback": true,
		});
		settings.setModelRole("task", "runtime-provider/runtime-reasoning-model");
		const options = await buildSessionOptions("pool-session-past-cut", "single");
		const healthSpy = vi.spyOn(options.authStorage, "getModelUsageHealth");
		const { session } = await createAgentSession({
			...options,
			settings,
		});
		try {
			expect(session.model?.id).toBe("runtime-reasoning-model");
			expect(healthSpy).not.toHaveBeenCalled();
		} finally {
			await session.dispose();
		}
	});

	test("a candidate without configured credentials is skipped by the draw", async () => {
		const options = await buildSessionOptions("pool-session-past-cut", "unauthenticated");
		// Both models come from the same extension provider, so credentials are
		// stubbed per model. Only the candidate this session id would draw loses
		// its credentials, which also pins the auth lookup to the right index.
		vi.spyOn(options.modelRegistry, "hasConfiguredAuth").mockImplementation(
			candidate => candidate.id !== "runtime-reasoning-model",
		);
		const { session } = await createAgentSession({
			...options,
			settings: poolSettings({ "retry.poolSelection": "weighted" }),
		});
		try {
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("a candidate whose provider is disabled is skipped by the draw", async () => {
		// Candidates resolve against getAll(), which keeps disabled providers, and
		// hasConfiguredAuth does not filter them either. Without the eligibility
		// check the draw promotes the disabled provider to index 0 and the session
		// starts on it, which ordered selection never does.
		const twoProviderRole = "runtime-provider/runtime-model,runtime-provider-b/runtime-model-b";
		const control = await buildSessionOptions("pool-session-past-cut", "two-provider-control");
		const controlSettings = Settings.isolated({ "retry.poolSelection": "weighted" });
		controlSettings.setModelRole("task", twoProviderRole);
		const controlSession = await createAgentSession({
			...control,
			extensions: [providerExtension, secondProviderExtension],
			settings: controlSettings,
		});
		try {
			expect(controlSession.session.model?.id).toBe("runtime-model-b");
		} finally {
			await controlSession.session.dispose();
		}

		const options = await buildSessionOptions("pool-session-past-cut", "two-provider-disabled");
		const settings = Settings.isolated({
			"retry.poolSelection": "weighted",
			disabledProviders: ["runtime-provider-b"],
		});
		settings.setModelRole("task", twoProviderRole);
		const { session } = await createAgentSession({
			...options,
			extensions: [providerExtension, secondProviderExtension],
			settings,
		});
		try {
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("an unusable candidate is never promoted ahead of a spent but usable one", async () => {
		// The reserve candidate is the only one with credentials, so nothing is
		// drawable and the configured order has to survive. The pattern loop that
		// resolves the primary does not auth-check it, so promoting the
		// credential-less candidate would start the session on a provider it cannot
		// call.
		const options = await buildSessionOptions("pool-session-past-cut", "reserve-vs-unauthenticated");
		vi.spyOn(options.modelRegistry, "hasConfiguredAuth").mockImplementation(
			candidate => candidate.id !== "runtime-reasoning-model",
		);
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, healthOptions) =>
			healthOptions.modelId === "runtime-model"
				? { state: "reserve", accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve" }] }
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] },
		);
		const { session } = await createAgentSession({
			...options,
			settings: poolSettings({
				"retry.poolSelection": "weighted",
				"retry.usageAwareFallback": true,
				"retry.usageReservePolicy": "confirm",
			}),
		});
		try {
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("weighted selection starts on the drawn candidate under a fail-closed reserve policy", async () => {
		// The draw runs before the startup reserve preflight, so fail-closed only
		// ever sees the drawn candidate. This session id draws the first candidate
		// when both are healthy, so reaching the second proves the depleted one was
		// dropped by the draw rather than by the preflight.
		const options = await buildSessionOptions("pool-session-before-cut", "fail-closed-weighted");
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, healthOptions) =>
			healthOptions.modelId === "runtime-model"
				? { state: "depleted", accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }] }
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] },
		);
		const { session } = await createAgentSession({
			...options,
			settings: poolSettings({
				"retry.poolSelection": "weighted",
				"retry.usageAwareFallback": true,
				"retry.usageReservePolicy": "fail-closed",
			}),
		});
		try {
			expect(session.model?.id).toBe("runtime-reasoning-model");
		} finally {
			await session.dispose();
		}
	});

	test("ordered selection still refuses to start under a fail-closed reserve policy", async () => {
		// Same config as the test above with only poolSelection flipped back, so the
		// behavior difference documented in docs/settings.md is pinned.
		const options = await buildSessionOptions("pool-session-before-cut", "fail-closed-ordered");
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, healthOptions) =>
			healthOptions.modelId === "runtime-model"
				? { state: "depleted", accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }] }
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] },
		);
		await expect(
			createAgentSession({
				...options,
				settings: poolSettings({
					"retry.usageAwareFallback": true,
					"retry.usageReservePolicy": "fail-closed",
				}),
			}),
		).rejects.toThrow("Usage depleted for runtime-provider/runtime-model; reserve policy is fail-closed.");
	});

	test("an undrawable pool refuses under fail-closed exactly as ordered selection does", async () => {
		// The first candidate is in reserve and the only healthy one weighs 0, so
		// nothing is drawable. The configured order then has to stand untouched:
		// hoisting the zero-weight candidate to the front would show the preflight a
		// healthy model and start a session fail-closed was configured to refuse.
		const expected = "Usage reserve reached for runtime-provider/runtime-model; reserve policy is fail-closed.";
		const health = async (_provider: string, healthOptions: { modelId?: string }): Promise<ModelUsageHealth> =>
			healthOptions.modelId === "runtime-model"
				? { state: "reserve", accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve" }] }
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] };

		const weighted = await buildSessionOptions("pool-session-past-cut", "undrawable-weighted");
		vi.spyOn(weighted.authStorage, "getModelUsageHealth").mockImplementation(health);
		await expect(
			createAgentSession({
				...weighted,
				settings: poolSettings({
					"retry.poolSelection": "weighted",
					"retry.usageAwareFallback": true,
					"retry.usageReservePolicy": "fail-closed",
					"retry.poolWeights": { "runtime-provider/runtime-reasoning-model": 0 },
				}),
			}),
		).rejects.toThrow(expected);

		const ordered = await buildSessionOptions("pool-session-past-cut", "undrawable-ordered");
		vi.spyOn(ordered.authStorage, "getModelUsageHealth").mockImplementation(health);
		await expect(
			createAgentSession({
				...ordered,
				settings: poolSettings({
					"retry.usageAwareFallback": true,
					"retry.usageReservePolicy": "fail-closed",
					"retry.poolWeights": { "runtime-provider/runtime-reasoning-model": 0 },
				}),
			}),
		).rejects.toThrow(expected);
	});

	test("a drawn candidate's explicit thinking level outranks the resumed session's level", async () => {
		// Ordered `--model <role>` resolves in main.ts, which puts the role's
		// explicit `:high` on options.thinkingLevel, above the persisted level. The
		// weighted draw resolves later, so the suffix has to be applied here too;
		// otherwise the same config and the same drawn model start at different
		// levels depending on which selection mode resolved them.
		const options = await buildSessionOptions("pool-session-past-cut", "thinking-suffix");
		const sessionFile = path.join(tempDir, "thinking-suffix.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "thinking-suffix", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "runtime-provider/runtime-reasoning-model",
					role: "default",
				},
				{
					type: "thinking_level_change",
					id: "thinking-low",
					parentId: "default-model",
					timestamp,
					thinkingLevel: "low",
					configured: "low",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "thinking-suffix-sessions"));
		vi.spyOn(sessionManager, "getSessionId").mockReturnValue("pool-session-past-cut");
		const settings = Settings.isolated({ "retry.poolSelection": "weighted" });
		settings.setModelRole("task", "runtime-provider/runtime-model,runtime-provider/runtime-reasoning-model:high");
		const { session } = await createAgentSession({ ...options, sessionManager, settings });
		try {
			expect(session.model?.id).toBe("runtime-reasoning-model");
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
		} finally {
			await session.dispose();
		}
	});

	test("an explicit thinking level outranks the drawn candidate's suffix", async () => {
		// `--thinking low` puts a level on options.thinkingLevel, the top precedence
		// tier. A drawn candidate's `:high` suffix sits below it, exactly as it does
		// when main.ts resolves an ordered `--model <role>`.
		const options = await buildSessionOptions("pool-session-past-cut", "thinking-explicit");
		const settings = Settings.isolated({ "retry.poolSelection": "weighted" });
		settings.setModelRole("task", "runtime-provider/runtime-model,runtime-provider/runtime-reasoning-model:high");
		const { session } = await createAgentSession({ ...options, settings, thinkingLevel: Effort.Low });
		try {
			expect(session.model?.id).toBe("runtime-reasoning-model");
			expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		} finally {
			await session.dispose();
		}
	});

	test("createAgentSession does not write the drawn thinking level into the caller's options", async () => {
		// createAgentSession is a public entry point and an embedder may reuse one
		// options object across sessions. If the draw wrote its `:high` suffix onto
		// options.thinkingLevel, the second session would inherit it and outrank its
		// own persisted level.
		const settings = Settings.isolated({ "retry.poolSelection": "weighted" });
		settings.setModelRole("task", "runtime-provider/runtime-model,runtime-provider/runtime-reasoning-model:high");
		const shared: CreateAgentSessionOptions = {
			...(await buildSessionOptions("pool-session-past-cut", "thinking-shared")),
			settings,
		};
		const { session } = await createAgentSession(shared);
		try {
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
		} finally {
			await session.dispose();
		}
		expect(shared.thinkingLevel).toBeUndefined();
	});

	test("a measured-depleted candidate is demoted behind the healthy ones in the installed chain", async () => {
		// The tail of the reordered list becomes the retry fallback chain, and the
		// chain walk does not consult usage health. Leaving the depleted candidate
		// ahead of a healthy one burns a retry attempt on a model this startup
		// already measured as out of quota.
		const options = await buildSessionOptions("pool-session-before-cut", "chain-demotion");
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, healthOptions) =>
			healthOptions.modelId === "runtime-model-b"
				? { state: "depleted", accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }] }
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] },
		);
		const settings = Settings.isolated({
			"retry.poolSelection": "weighted",
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		settings.setModelRole(
			"task",
			"runtime-provider/runtime-model,runtime-provider-b/runtime-model-b,runtime-provider/runtime-reasoning-model",
		);
		const { session } = await createAgentSession({
			...options,
			extensions: [providerExtension, secondProviderExtension],
			settings,
			modelPatternFallbackRole: "pool-chain",
		});
		try {
			expect(session.model?.id).toBe("runtime-model");
			expect(settings.get("retry.fallbackChains")?.["pool-chain"]).toEqual([
				"runtime-provider/runtime-reasoning-model",
				"runtime-provider-b/runtime-model-b",
			]);
		} finally {
			await session.dispose();
		}
	});

	test("--model on a weighted multi-candidate role defers resolution so the draw runs", async () => {
		// Regression: main.ts resolved the role itself whenever its first candidate
		// was available, which set options.model and skipped the deferred block
		// that hosts the draw. Every session then started on candidate 0.
		const first = getBundledModel("openai", "gpt-4o-mini");
		const second = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!first || !second) {
			throw new Error("Expected bundled test models to exist");
		}
		const authStorage = await AuthStorage.create(path.join(tempDir, "cli-auth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey(first.provider, "first-test-key");
		authStorage.setRuntimeApiKey(second.provider, "second-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "cli-models.yml"));
		const roleValue = `${first.provider}/${first.id},${second.provider}/${second.id}`;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const orderedSettings = Settings.isolated();
			orderedSettings.setModelRole("task", roleValue);
			const orderedOptions = await buildCliSessionOptions(
				parseArgs(["--model", "task"]),
				[],
				SessionManager.inMemory(),
				modelRegistry,
				orderedSettings,
			);
			// Control: ordered selection still resolves at the CLI, unchanged, and
			// retargets the default role to the model it picked.
			expect(orderedOptions.model?.id).toBe(first.id);
			expect(orderedOptions.modelPattern).toBeUndefined();
			expect(orderedSettings.getModelRole("default")).toBe(`${first.provider}/${first.id}`);

			const settings = Settings.isolated({ "retry.poolSelection": "weighted" });
			settings.setModelRole("task", roleValue);
			const cliOptions = await buildCliSessionOptions(
				parseArgs(["--model", "task"]),
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.model).toBeUndefined();
			expect(cliOptions.modelPattern).toBe("task");

			const sessionManager = SessionManager.inMemory();
			vi.spyOn(sessionManager, "getSessionId").mockReturnValue("pool-session-past-cut");
			const { session } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				sessionManager,
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				hasUI: false,
			});
			try {
				// This session id lands past the halfway cut of two equal weights.
				expect(session.model?.id).toBe(second.id);
				// The deferred draw retargets the default role the same way the CLI
				// does, so consumers falling through to `default` follow the session.
				expect(settings.getModelRole("default")).toBe(`${second.provider}/${second.id}`);
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("--model default draws over the default role instead of collapsing it", async () => {
		// Regression: the deferred CLI branch retargeted modelRoles.default to the
		// model it had already resolved, so prewalk and plan-yolo saw the right
		// model. When the deferred role is default itself, that rewrote the very
		// role the draw re-reads, leaving one candidate, so `omp --model default`
		// silently started on candidate 0 with no warning.
		const first = getBundledModel("openai", "gpt-4o-mini");
		const second = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!first || !second) {
			throw new Error("Expected bundled test models to exist");
		}
		const authStorage = await AuthStorage.create(path.join(tempDir, "default-role-auth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey(first.provider, "first-test-key");
		authStorage.setRuntimeApiKey(second.provider, "second-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "default-role-models.yml"));
		const roleValue = `${first.provider}/${first.id},${second.provider}/${second.id}`;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			for (const flag of ["default", "@default", "*"]) {
				const settings = Settings.isolated({ "retry.poolSelection": "weighted" });
				settings.setModelRole("default", roleValue);
				const cliOptions = await buildCliSessionOptions(
					parseArgs(["--model", flag]),
					[],
					SessionManager.inMemory(),
					modelRegistry,
					settings,
				);
				expect(cliOptions.model).toBeUndefined();
				expect(cliOptions.modelPattern).toBe(flag);
				// Both candidates have to survive the CLI, or the deferred block reads
				// a one-entry role and skips the draw.
				expect(settings.getModelRole("default")).toBe(roleValue);

				const sessionManager = SessionManager.inMemory();
				vi.spyOn(sessionManager, "getSessionId").mockReturnValue("pool-session-past-cut");
				const { session } = await createAgentSession({
					...cliOptions,
					cwd: tempDir,
					agentDir: tempDir,
					authStorage,
					modelRegistry,
					sessionManager,
					settings,
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					hasUI: false,
				});
				try {
					// This session id lands past the halfway cut of two equal weights.
					expect(session.model?.id).toBe(second.id);
					expect(settings.getModelRole("default")).toBe(`${second.provider}/${second.id}`);
				} finally {
					await session.dispose();
				}
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("deferring a weighted role still retargets the default role for prewalk and plan-yolo", async () => {
		// Regression: the deferred branch only set options.modelPattern, so the
		// prewalk and plan-yolo blocks that run right after it expanded their role
		// alias against the un-retargeted modelRoles.default. With a default that has
		// no credentials, `--plan-yolo` threw "No API key" and `--prewalk` armed on
		// the wrong model, both only under weighted selection.
		const first = getBundledModel("openai", "gpt-4o-mini");
		const second = getBundledModel("anthropic", "claude-sonnet-4-5");
		const staleDefault = getBundledModel("google", "gemini-2.5-flash");
		if (!first || !second || !staleDefault) {
			throw new Error("Expected bundled test models to exist");
		}
		const authStorage = await AuthStorage.create(path.join(tempDir, "prewalk-auth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey(first.provider, "first-test-key");
		authStorage.setRuntimeApiKey(second.provider, "second-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "prewalk-models.yml"));
		const roleValue = `${first.provider}/${first.id},${second.provider}/${second.id}`;
		const args = ["--model", "task", "--prewalk-into", "@default", "--plan-yolo", "--plan-yolo-into", "@default"];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const orderedSettings = Settings.isolated();
			orderedSettings.setModelRole("task", roleValue);
			// The stale default has no credentials, so plan-yolo throws on it.
			orderedSettings.setModelRole("default", `${staleDefault.provider}/${staleDefault.id}`);
			const orderedOptions = await buildCliSessionOptions(
				parseArgs(args),
				[],
				SessionManager.inMemory(),
				modelRegistry,
				orderedSettings,
			);
			expect(orderedOptions.prewalk?.target.id).toBe(first.id);
			expect(orderedOptions.planYolo?.target.id).toBe(first.id);

			const settings = Settings.isolated({ "retry.poolSelection": "weighted" });
			settings.setModelRole("task", roleValue);
			settings.setModelRole("default", `${staleDefault.provider}/${staleDefault.id}`);
			const cliOptions = await buildCliSessionOptions(
				parseArgs(args),
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			// Model resolution is still deferred to the draw, but the CLI-side
			// options are built against the same default the ordered path saw.
			expect(cliOptions.model).toBeUndefined();
			expect(cliOptions.modelPattern).toBe("task");
			expect(cliOptions.prewalk?.target.id).toBe(first.id);
			expect(cliOptions.planYolo?.target.id).toBe(first.id);
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("a bare candidate id resolves to a provider the session has credentials for", async () => {
		// A bare id carried by several providers is ranked by usage order and then
		// modelProviderOrder, never by auth, so both candidates can resolve to a
		// provider with no credentials. Nothing is drawable then, the raw patterns
		// reach the startup loop, and that loop does not auth-check a primary, so
		// the session starts on a provider it cannot call and the usage preflight
		// measures the wrong one.
		const authStorage = await AuthStorage.create(path.join(tempDir, "bare-id-auth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "bare-id-models.yml"));
		const settings = Settings.isolated({
			"retry.poolSelection": "weighted",
			modelProviderOrder: ["aimlapi", "openai"],
		});
		// aimlapi carries both ids and has no credentials here, and it outranks
		// openai, so an auth-blind resolution picks it for both candidates.
		settings.setModelRole("task", "gpt-4o-mini,gpt-4o");
		const sessionManager = SessionManager.inMemory();
		vi.spyOn(sessionManager, "getSessionId").mockReturnValue("pool-session-past-cut");
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			hasUI: false,
			modelPattern: "task",
		});
		try {
			// This session id lands past the halfway cut, so it draws the second
			// candidate, and the model it draws is the model that starts.
			expect(session.model?.provider).toBe("openai");
			expect(session.model?.id).toBe("gpt-4o");
			expect(settings.getModelRole("default")).toBe("openai/gpt-4o");
		} finally {
			await session.dispose();
		}
	});

	test("a weighted draw rebinds the prewalk and plan-yolo hand-off to the drawn model", async () => {
		// `--prewalk-into @default` expands its alias in main.ts, before the draw
		// runs, and role expansion takes the first candidate. Once the draw picks
		// candidate 2, prewalk would switch the session to a model it never
		// started on at the first edit.
		const first = getBundledModel("openai", "gpt-4o-mini");
		const second = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!first || !second) {
			throw new Error("Expected bundled test models to exist");
		}
		const authStorage = await AuthStorage.create(path.join(tempDir, "rebind-auth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey(first.provider, "first-test-key");
		authStorage.setRuntimeApiKey(second.provider, "second-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "rebind-models.yml"));
		const roleValue = `${first.provider}/${first.id},${second.provider}/${second.id}`;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			for (const handoffAlias of ["@default", "@task"]) {
				const settings = Settings.isolated({ "retry.poolSelection": "weighted" });
				settings.setModelRole("task", roleValue);
				const cliOptions = await buildCliSessionOptions(
					parseArgs([
						"--model",
						"task",
						"--prewalk-into",
						handoffAlias,
						"--plan-yolo",
						"--plan-yolo-into",
						handoffAlias,
					]),
					[],
					SessionManager.inMemory(),
					modelRegistry,
					settings,
				);
				// The CLI still resolves the alias eagerly, which is what the session
				// falls back on when nothing was drawn.
				expect(cliOptions.prewalk?.target.id).toBe(first.id);
				expect(cliOptions.planYolo?.target.id).toBe(first.id);

				const sessionManager = SessionManager.inMemory();
				vi.spyOn(sessionManager, "getSessionId").mockReturnValue("pool-session-past-cut");
				const { session } = await createAgentSession({
					...cliOptions,
					cwd: tempDir,
					agentDir: tempDir,
					authStorage,
					modelRegistry,
					sessionManager,
					settings,
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					hasUI: false,
				});
				try {
					expect(session.model?.id).toBe(second.id);
					expect(session.getPrewalkState()?.target.id).toBe(second.id);
					// Both aliases address the drawn candidate list, so both are recorded
					// for the session to re-resolve. `@task` is recorded as the default
					// alias because the draw retargets exactly that role.
					expect(cliOptions.prewalk?.pattern).toBe("@default");
					expect(cliOptions.planYolo?.pattern).toBe("@default");
				} finally {
					await session.dispose();
				}
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("a hand-off alias that stops resolving disarms prewalk and refuses plan-yolo", async () => {
		// The re-resolution keeps main.ts's asymmetry: prewalk is an optional
		// optimization and warns off, plan-yolo was asked for explicitly and fails
		// the session (issue #6064).
		const stale = getBundledModel("openai", "gpt-4o-mini");
		if (!stale) {
			throw new Error("Expected bundled test models to exist");
		}
		const unresolvable = "no-such-provider/no-such-model";
		const disarmed = await createAgentSession({
			...(await buildSessionOptions("pool-session-past-cut", "rebind-unresolvable")),
			settings: poolSettings({ "retry.poolSelection": "weighted" }),
			prewalk: { target: stale, pattern: unresolvable },
		});
		try {
			expect(disarmed.session.model?.id).toBe("runtime-reasoning-model");
			expect(disarmed.session.getPrewalkState()).toBeUndefined();
		} finally {
			await disarmed.session.dispose();
		}

		await expect(
			createAgentSession({
				...(await buildSessionOptions("pool-session-past-cut", "rebind-refused")),
				settings: poolSettings({ "retry.poolSelection": "weighted" }),
				planYolo: { target: stale, pattern: unresolvable },
			}),
		).rejects.toThrow(unresolvable);
	});

	test("--api-key keeps eager CLI resolution instead of deferring to the draw", async () => {
		// The runtime key is provider-scoped and is registered against the model
		// the CLI resolves. Deferring would let the draw move the session to the
		// other provider, and the key would then be registered against a provider
		// it was never meant for, so --api-key opts out of the draw.
		const first = getBundledModel("openai", "gpt-4o-mini");
		const second = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!first || !second) {
			throw new Error("Expected bundled test models to exist");
		}
		const authStorage = await AuthStorage.create(path.join(tempDir, "api-key-auth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey(first.provider, "first-test-key");
		authStorage.setRuntimeApiKey(second.provider, "second-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "api-key-models.yml"));
		const settings = Settings.isolated({ "retry.poolSelection": "weighted" });
		settings.setModelRole("task", `${first.provider}/${first.id},${second.provider}/${second.id}`);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const options = await buildCliSessionOptions(
				parseArgs(["--model", "task", "--api-key", "sk-test-key"]),
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(options.model?.id).toBe(first.id);
			expect(options.modelPattern).toBeUndefined();
		} finally {
			exitSpy.mockRestore();
		}
	});
});
