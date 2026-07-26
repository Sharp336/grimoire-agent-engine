import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * validateModelPools runs from the TurnRecovery constructor, so a real
 * AgentSession is the public entry point that exercises it. Warnings land in
 * session.configWarnings next to the retry.fallbackChains warnings.
 */
describe("model pool configuration warnings", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let primaryModel: Model;
	let secondaryModel: Model;
	let unauthenticatedModel: Model;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-model-pool-validation-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const openai = getBundledModel("openai", "gpt-4o-mini");
		const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
		// No credentials are set for this provider, so it is in the registry but
		// not in getAvailable().
		const google = getBundledModel("google", "gemini-2.5-flash");
		if (!openai || !anthropic || !google) {
			throw new Error("Expected bundled test models to exist");
		}
		primaryModel = openai;
		secondaryModel = anthropic;
		unauthenticatedModel = google;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	function warningsFor(settings: Settings): string[] {
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Not exercised");
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		return session.configWarnings;
	}

	it("stays silent for the default configuration", () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		expect(warningsFor(settings).filter(warning => warning.includes("pool"))).toEqual([]);
	});

	it("stays silent for ordered selection with empty pool weights", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolSelection": "ordered",
			"retry.poolWeights": {},
		});
		settings.setModelRole(
			"task",
			`${primaryModel.provider}/${primaryModel.id},nonexistent-provider/nonexistent-model`,
		);
		expect(warningsFor(settings).filter(warning => warning.includes("pool"))).toEqual([]);
	});

	it("accepts valid selector keys and provider wildcards", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolWeights": {
				[`${primaryModel.provider}/${primaryModel.id}`]: 2,
				[`${secondaryModel.provider}/*`]: 0,
			},
		});
		expect(warningsFor(settings).filter(warning => warning.includes("poolWeights"))).toEqual([]);
	});

	it("warns on a pool weight key that names an unknown model", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolWeights": { "openai/nonexistent-model": 2 },
		});
		expect(warningsFor(settings)).toContain(
			"retry.poolWeights key references unknown model: openai/nonexistent-model",
		);
	});

	it("warns on a pool weight key carrying a thinking-level suffix", () => {
		// getPoolWeight probes the bare selector only, so `anthropic/claude-sonnet-4-5:max`
		// parses and resolves but would silently weigh 1.
		const selector = `${secondaryModel.provider}/${secondaryModel.id}`;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolWeights": { [`${selector}:max`]: 0 },
		});
		expect(warningsFor(settings)).toContain(
			`retry.poolWeights key must be a bare model selector like ${selector}: ${selector}:max`,
		);
	});

	it("warns on an id-prefix wildcard key, which the weight lookup never matches", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolWeights": { "openrouter/google/*": 5 },
		});
		expect(warningsFor(settings)).toContain(
			"retry.poolWeights wildcard key must be provider/*, id-prefix wildcards are not matched: openrouter/google/*",
		);
	});

	it("warns on a pool weight wildcard for an unknown provider", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolWeights": { "nonexistent-provider/*": 1 },
		});
		expect(warningsFor(settings)).toContain(
			"retry.poolWeights wildcard key references unknown provider: nonexistent-provider/*",
		);
	});

	it("warns on negative and non-numeric pool weights", async () => {
		const selector = `${primaryModel.provider}/${primaryModel.id}`;
		const expected = `retry.poolWeights value for '${selector}' must be a non-negative finite number.`;
		const negative = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolWeights": { [selector]: -1 },
		});
		expect(warningsFor(negative)).toContain(expected);

		await session?.dispose();
		session = undefined;
		const nonNumeric = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolWeights": { [selector]: "fast" as never },
		});
		expect(warningsFor(nonNumeric)).toContain(expected);
	});

	it("warns when the pool weights sum past the floating point range", () => {
		// Each value passes the per-key check but the total is Infinity, which
		// leaves the draw unable to pick anything.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolWeights": {
				[`${primaryModel.provider}/${primaryModel.id}`]: 1e308,
				[`${secondaryModel.provider}/${secondaryModel.id}`]: 1e308,
			},
		});
		expect(warningsFor(settings)).toContain(
			"retry.poolWeights values are too large to sum; keep them well below 1e308.",
		);
	});

	it("warns when pool weights is not a mapping", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolWeights": ["openai/gpt-4o-mini"] as never,
		});
		expect(warningsFor(settings)).toContain(
			"retry.poolWeights must be a mapping of model selectors or provider wildcards to non-negative numbers.",
		);
	});

	it("warns when a weighted role lists a model the registry cannot resolve", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolSelection": "weighted",
		});
		settings.setModelRole("task", `${primaryModel.provider}/${primaryModel.id},github-copilot/claude-opus-99`);
		const warnings = warningsFor(settings);
		expect(warnings).toContain(
			"modelRoles.task lists a model the registry cannot resolve: github-copilot/claude-opus-99 (skipped by pool draws and fallback)",
		);
		expect(warnings.filter(warning => warning.includes(`${primaryModel.provider}/${primaryModel.id}`))).toEqual([]);
	});

	it("stays silent for a fuzzy role member the draw resolves at runtime", async () => {
		// Validation must use the resolution the draw uses. `openai/4o-min` is not a
		// registry id, but parseModelPattern resolves it to openai/gpt-4o-mini, which
		// is the model the session would actually start on. An exact-id check here
		// warned on every session start and every subagent spawn for a config that
		// works.
		const fuzzy = Settings.isolated({ "compaction.enabled": false, "retry.poolSelection": "weighted" });
		fuzzy.setModelRole("task", `openai/4o-min,${secondaryModel.provider}/${secondaryModel.id}`);
		expect(warningsFor(fuzzy).filter(warning => warning.includes("modelRoles."))).toEqual([]);

		await session?.dispose();
		session = undefined;
		// `github-copilot/claude-opus-5` from the issue thread does fuzzy-resolve
		// (to claude-opus-4.5), so it must not warn either.
		const copilot = Settings.isolated({ "compaction.enabled": false, "retry.poolSelection": "weighted" });
		copilot.setModelRole("task", `github-copilot/claude-opus-5,${secondaryModel.provider}/${secondaryModel.id}`);
		expect(warningsFor(copilot).filter(warning => warning.includes("modelRoles."))).toEqual([]);
	});

	it("stays silent about a known model whose provider has no credentials", () => {
		// The draw drops an unauthenticated candidate through hasConfiguredAuth.
		// Warning about it would fire on every session start of a user who has
		// only logged into one of their two plans.
		expect(modelRegistry.getAvailable().some(model => model.provider === unauthenticatedModel.provider)).toBe(false);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolSelection": "weighted",
		});
		settings.setModelRole(
			"task",
			`${primaryModel.provider}/${primaryModel.id},${unauthenticatedModel.provider}/${unauthenticatedModel.id}`,
		);
		expect(warningsFor(settings).filter(warning => warning.includes("modelRoles."))).toEqual([]);
	});

	it("stays silent about a model from a discovery-backed provider that is offline", async () => {
		// ollama, lm-studio and llama.cpp contribute zero models while the local
		// server is down and the 24h discovery cache has expired. The model resolves
		// again as soon as the server is back, so warning would fire on every
		// session start and every subagent spawn for a config that is not broken.
		const discoverySpy = vi
			.spyOn(modelRegistry, "getProviderDiscoveryState")
			.mockImplementation(provider =>
				provider === "ollama"
					? { provider: "ollama", status: "idle", optional: true, stale: false, models: [] }
					: undefined,
			);
		try {
			const offline = Settings.isolated({ "compaction.enabled": false, "retry.poolSelection": "weighted" });
			offline.setModelRole("task", `${primaryModel.provider}/${primaryModel.id},ollama/qwen3`);
			expect(warningsFor(offline).filter(warning => warning.includes("modelRoles."))).toEqual([]);

			await session?.dispose();
			session = undefined;
			// A provider without a discovery state still warns, so the skip is scoped.
			const unknown = Settings.isolated({ "compaction.enabled": false, "retry.poolSelection": "weighted" });
			unknown.setModelRole("task", `${primaryModel.provider}/${primaryModel.id},github-copilot/claude-opus-99`);
			expect(warningsFor(unknown)).toContain(
				"modelRoles.task lists a model the registry cannot resolve: github-copilot/claude-opus-99 (skipped by pool draws and fallback)",
			);
		} finally {
			discoverySpy.mockRestore();
		}
	});

	it("does not warn about single-candidate roles under weighted selection", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.poolSelection": "weighted",
		});
		settings.setModelRole("slow", "github-copilot/claude-opus-5");
		expect(warningsFor(settings).filter(warning => warning.includes("modelRoles."))).toEqual([]);
	});
});
