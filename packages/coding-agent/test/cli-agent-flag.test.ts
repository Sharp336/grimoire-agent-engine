import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getModelMatchPreferences, resolveModelScope } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const MYAGENT_MD = [
	"---",
	"name: myagent",
	"description: Test main-session persona agent.",
	"model: anthropic/claude-sonnet-4-5",
	"tools: read, bash",
	"spawns: scout",
	"thinkingLevel: high",
	"---",
	"You are the myagent persona for the main session.",
].join("\n");

const SUBAGENT_ONLY_MD = [
	"---",
	"name: subagentOnlyAgent",
	"description: Subagent-only test agent.",
	"mode: subagent",
	"---",
	"You are a subagent-only agent.",
].join("\n");

describe("--agent CLI flag", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-cli-agent-${Snowflake.next()}`);
		fs.mkdirSync(path.join(tempDir, ".omp", "agents"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".omp", "agents", "myagent.md"), MYAGENT_MD);
		fs.writeFileSync(path.join(tempDir, ".omp", "agents", "subagentOnlyAgent.md"), SUBAGENT_ONLY_MD);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const authStorage of authStoragesToClose) authStorage.close();
		authStoragesToClose.length = 0;
		clearOmpExtensionCliRoots();
		clearFsCache();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	async function newRegistry(name: string): Promise<{ authStorage: AuthStorage; modelRegistry: ModelRegistry }> {
		const authStorage = await AuthStorage.create(path.join(tempDir, `${name}.db`));
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, `${name}.yml`));
		return { authStorage, modelRegistry };
	}

	function spyExit() {
		return vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit called");
		});
	}

	test("parseArgs records --agent", () => {
		const parsed = parseArgs(["--agent", "myagent"]);

		expect(parsed.agent).toBe("myagent");
	});

	test("--model CLI flag wins over agent.model", async () => {
		const { modelRegistry } = await newRegistry("cli-model");
		const settings = Settings.isolated();
		const parsed = parseArgs(["--cwd", tempDir, "--agent", "myagent", "--model", "anthropic/claude-sonnet-4-5"]);

		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.model?.provider).toBe("anthropic");
		expect(options.model?.id).toBe("claude-sonnet-4-5");
		expect(options.modelPattern).toBeUndefined();
	});

	test("--tools CLI flag wins over agent.tools", async () => {
		const { modelRegistry } = await newRegistry("cli-tools");
		const settings = Settings.isolated();
		const parsed = parseArgs(["--cwd", tempDir, "--agent", "myagent", "--tools", "read"]);

		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.toolNames).toEqual(["read"]);
		expect(options.restrictToolNames).toBeUndefined();
	});

	test("--agent unknown exits 1", async () => {
		const { modelRegistry } = await newRegistry("unknown");
		const settings = Settings.isolated();
		const parsed = parseArgs(["--cwd", tempDir, "--agent", "unknown"]);
		const exitSpy = spyExit();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await expect(
				buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings),
			).rejects.toThrow("process.exit called");
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			exitSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	test("--agent subagent-only agent exits 1", async () => {
		const { modelRegistry } = await newRegistry("subagent");
		const settings = Settings.isolated();
		const parsed = parseArgs(["--cwd", tempDir, "--agent", "subagentOnlyAgent"]);
		const exitSpy = spyExit();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await expect(
				buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings),
			).rejects.toThrow("process.exit called");
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			exitSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	test("--agent disabled in settings exits 1", async () => {
		const { modelRegistry } = await newRegistry("disabled");
		const settings = Settings.isolated({ "task.disabledAgents": ["myagent"] });
		const parsed = parseArgs(["--cwd", tempDir, "--agent", "myagent"]);
		const exitSpy = spyExit();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await expect(
				buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings),
			).rejects.toThrow("process.exit called");
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			exitSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	test("--agent applies agent frontmatter when CLI flags are absent", async () => {
		const { modelRegistry } = await newRegistry("persona");
		const settings = Settings.isolated();
		const parsed = parseArgs(["--cwd", tempDir, "--agent", "myagent"]);

		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.modelPattern).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(options.thinkingLevel).toBe(Effort.High);
		expect(options.toolNames).toEqual(["read", "bash", "task"]);
		// The persona's tool list is applied as the EXACT active set (subagent
		// restrictToolNames semantics) — no MCP/LSP/extension/memory widening.
		expect(options.restrictToolNames).toBe(true);
		expect(options.spawns).toBe("scout");
		// The persona prompt lives in the MUTABLE persona channel (not the
		// immutable launch append) so a later /agent switch replaces it.
		expect(options.personaAppendPrompt).toContain("You are the myagent persona for the main session.");
		expect(options.appendSystemPrompt).toBeUndefined();
		expect(options.personaName).toBe("myagent");
	});

	test("settings-seeded scoped thinking does not suppress the persona's thinkingLevel", async () => {
		// Regression: `options.thinkingLevel` can be seeded from settings
		// (enabledModels scoped thinking) independently of the CLI --model
		// suffix. A settings default must NOT count as an explicit CLI override
		// against the agent persona's thinkingLevel.
		const { authStorage, modelRegistry } = await newRegistry("scoped-thinking");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({ enabledModels: ["anthropic/*:low"] });
		const scopedModels = await resolveModelScope(
			["anthropic/*:low"],
			modelRegistry,
			getModelMatchPreferences(settings),
			settings,
		);
		expect(scopedModels.length).toBeGreaterThan(0);
		expect(scopedModels[0].explicitThinkingLevel).toBe(true);
		// --model without a thinking suffix: the CLI model wins, but the
		// settings-seeded scoped thinking must not suppress the persona's
		// `thinkingLevel: high` frontmatter.
		const parsed = parseArgs(["--cwd", tempDir, "--agent", "myagent", "--model", "anthropic/claude-sonnet-4-5"]);

		const options = await buildSessionOptions(
			parsed,
			scopedModels,
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.model?.provider).toBe("anthropic");
		expect(options.model?.id).toBe("claude-sonnet-4-5");
		expect(options.thinkingLevel).toBe(Effort.High);
	});

	test("--model thinking suffix wins over the persona's thinkingLevel", async () => {
		// Positive control: a `--model` pattern carrying a thinking suffix is
		// an explicit CLI override and must beat the persona's frontmatter.
		const { modelRegistry } = await newRegistry("suffix-thinking");
		const settings = Settings.isolated();
		const parsed = parseArgs(["--cwd", tempDir, "--agent", "myagent", "--model", "anthropic/claude-sonnet-4-5:low"]);

		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.model?.provider).toBe("anthropic");
		expect(options.model?.id).toBe("claude-sonnet-4-5");
		expect(options.thinkingLevel).toBe(Effort.Low);
	});

	test("persona model frontmatter replaces the scoped default when --model is absent", async () => {
		// Regression (codex #3754547620): with `--agent` and NO explicit
		// `--model`, buildSessionOptions seeds `options.model` from the scoped
		// default (enabledModels). The persona's `model:` frontmatter must
		// replace that default — the populated default must not short-circuit
		// the deferred persona pattern in createAgentSession.
		const { authStorage, modelRegistry } = await newRegistry("persona-default-model");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({ enabledModels: ["anthropic/*"] });
		const scopedModels = await resolveModelScope(
			["anthropic/*"],
			modelRegistry,
			getModelMatchPreferences(settings),
			settings,
		);
		expect(scopedModels.length).toBeGreaterThan(0);
		// The scoped default differs from the persona's model (sonnet).
		expect(scopedModels[0].model.id).not.toBe("claude-sonnet-4-5");
		const parsed = parseArgs(["--cwd", tempDir, "--agent", "myagent"]);

		const options = await buildSessionOptions(
			parsed,
			scopedModels,
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		// The default is deferred, not dropped: an unresolvable persona model
		// falls back to it instead of failing startup.
		expect(options.model).toBeUndefined();
		expect(options.modelPattern).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(options.modelPatternFallbackModel?.id).toBe(scopedModels[0].model.id);
		// The persona's thinkingLevel still applies (no suffix on its model).
		expect(options.thinkingLevel).toBe(Effort.High);
	});

	test("explicit --model still wins over the persona's model frontmatter", async () => {
		// Negative control: an explicit `--model` is the ONLY documented
		// override — the persona's `model:` frontmatter must be ignored even
		// when a scoped default would otherwise apply.
		const { authStorage, modelRegistry } = await newRegistry("persona-explicit-model");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({ enabledModels: ["anthropic/*"] });
		const scopedModels = await resolveModelScope(
			["anthropic/*"],
			modelRegistry,
			getModelMatchPreferences(settings),
			settings,
		);
		expect(scopedModels.length).toBeGreaterThan(0);
		const parsed = parseArgs(["--cwd", tempDir, "--agent", "myagent", "--model", "anthropic/claude-sonnet-4-5"]);

		const options = await buildSessionOptions(
			parsed,
			scopedModels,
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.model?.provider).toBe("anthropic");
		expect(options.model?.id).toBe("claude-sonnet-4-5");
		expect(options.modelPattern).toBeUndefined();
		expect(options.modelPatternFallbackModel).toBeUndefined();
	});
});
