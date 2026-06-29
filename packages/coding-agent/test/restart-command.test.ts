import { describe, expect, spyOn, test } from "bun:test";
import {
	buildRestartCommand,
	consumeRestartExtensionFlagValues,
	RESTART_API_KEY_ENV,
	RESTART_EXTENSION_FLAG_VALUES_ENV,
	type RestartCommandEnvironment,
	type RestartExtensionFlagValue,
	type RestartSpawn,
	type RestartSpawnInput,
	restoreRestartExtensionFlagValues,
	spawnRestartProcess,
} from "@oh-my-pi/pi-coding-agent/cli/restart";

const packageRoot = "/repo/packages/coding-agent";

function baseOptions() {
	return {
		sessionId: "sess-1",
		cwd: "/repo/project",
		sessionDir: "/repo/project/.sessions",
		activeProfile: "work",
		approvalMode: "write" as const,
	};
}

function valuesForFlag(cmd: string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < cmd.length - 1; index++) {
		if (cmd[index] === flag) values.push(cmd[index + 1] as string);
	}
	return values;
}

describe("restart command construction", () => {
	test("builds a compiled binary restart command", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => "/ignored/cli.ts",
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		expect(buildRestartCommand(baseOptions(), env)).toEqual({
			cmd: [
				"/opt/omp/omp",
				"--profile",
				"work",
				"--cwd",
				"/repo/project",
				"--approval-mode",
				"write",
				"--session-dir",
				"/repo/project/.sessions",
				"--resume",
				"sess-1",
			],
			cwd: "/repo/project",
		});
	});

	test("builds a host-entry restart command from the host directory", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => false,
			workerHostEntry: () => "/repo/packages/coding-agent/src/cli.ts",
			execPath: "/usr/bin/bun",
			packageRoot,
		};

		const command = buildRestartCommand(baseOptions(), env);

		expect(command.cmd.slice(0, 2)).toEqual(["/usr/bin/bun", "cli.ts"]);
		expect(command.cwd).toBe("/repo/packages/coding-agent/src");
	});

	test("builds a source fallback restart command from the package root", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => false,
			workerHostEntry: () => null,
			execPath: "/usr/bin/bun",
			packageRoot,
		};

		const command = buildRestartCommand(baseOptions(), env);

		expect(command.cmd.slice(0, 2)).toEqual(["/usr/bin/bun", "src/cli.ts"]);
		expect(command.cwd).toBe(packageRoot);
	});

	test("omits profile arguments when no active profile exists", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		const command = buildRestartCommand(
			{
				sessionId: "sess-1",
				cwd: "/repo/project",
				approvalMode: "write",
				sessionDir: "/repo/project/.sessions",
			},
			env,
		);

		expect(command.cmd).toEqual([
			"/opt/omp/omp",
			"--cwd",
			"/repo/project",
			"--approval-mode",
			"write",
			"--session-dir",
			"/repo/project/.sessions",
			"--resume",
			"sess-1",
		]);
		expect(command.cmd).not.toContain("--profile");
		expect(command.cmd).not.toContain("work");
		expect(command.cwd).toBe("/repo/project");
	});

	test("preserves custom session dirs across restart", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		const command = buildRestartCommand({ ...baseOptions(), sessionDir: "/tmp/omp-sessions" }, env);

		expect(valuesForFlag(command.cmd, "--session-dir")).toEqual(["/tmp/omp-sessions"]);
		expect(command.cmd.indexOf("--session-dir")).toBeLessThan(command.cmd.indexOf("--resume"));
		expect(command.cwd).toBe("/repo/project");
	});

	test("preserves disabled extension discovery across restart", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		const command = buildRestartCommand({ ...baseOptions(), disableExtensions: true }, env);

		expect(command.cmd).toContain("--no-extensions");
		expect(command.cmd.indexOf("--no-extensions")).toBeLessThan(command.cmd.indexOf("--session-dir"));
		expect(command.cmd.indexOf("--no-extensions")).toBeLessThan(command.cmd.indexOf("--resume"));
	});

	test("preserves custom config files across restart", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		const command = buildRestartCommand({ ...baseOptions(), configFiles: ["./dev.yml", "/tmp/override.yml"] }, env);

		expect(valuesForFlag(command.cmd, "--config")).toEqual(["./dev.yml", "/tmp/override.yml"]);
		expect(command.cmd.indexOf("--config")).toBeLessThan(command.cmd.indexOf("--session-dir"));
		expect(command.cmd.indexOf("--config")).toBeLessThan(command.cmd.indexOf("--resume"));
	});

	test("preserves explicit extension and plugin roots across restart", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		const command = buildRestartCommand(
			{
				...baseOptions(),
				extensionPaths: ["./ext-one", "pkg-two"],
				hookPaths: ["./hook-one"],
				pluginDirs: ["./plugin-one", "./plugin-two"],
			},
			env,
		);

		expect(valuesForFlag(command.cmd, "--extension")).toEqual(["./ext-one", "pkg-two"]);
		expect(valuesForFlag(command.cmd, "--hook")).toEqual(["./hook-one"]);
		expect(valuesForFlag(command.cmd, "--plugin-dir")).toEqual(["./plugin-one", "./plugin-two"]);
		expect(command.cmd.indexOf("--extension")).toBeLessThan(command.cmd.indexOf("--session-dir"));
		expect(command.cmd.indexOf("--hook")).toBeLessThan(command.cmd.indexOf("--resume"));
		expect(command.cmd.indexOf("--plugin-dir")).toBeLessThan(command.cmd.indexOf("--resume"));
	});

	test("hands off CLI API keys via child env instead of argv", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		const command = buildRestartCommand({ ...baseOptions(), apiKey: "sk-runtime" }, env);

		expect(command.cmd).not.toContain("--api-key");
		expect(command.cmd).not.toContain("sk-runtime");
		expect(command.env).toEqual({ [RESTART_API_KEY_ENV]: "sk-runtime" });
	});

	test("hands off extension CLI flag values via child env instead of argv", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};
		const extensionFlagValues: RestartExtensionFlagValue[] = [
			["spawn-peer", "reviewer"],
			["headless", true],
		];

		const command = buildRestartCommand({ ...baseOptions(), extensionFlagValues }, env);

		expect(command.cmd).not.toContain("--spawn-peer");
		expect(command.cmd).not.toContain("--headless");
		expect(command.env).toEqual({
			[RESTART_EXTENSION_FLAG_VALUES_ENV]: JSON.stringify(extensionFlagValues),
		});
	});

	test("ignores malformed restart extension flag env payloads", () => {
		const env = { [RESTART_EXTENSION_FLAG_VALUES_ENV]: "not-json" };

		expect(consumeRestartExtensionFlagValues(env)).toBeUndefined();
		expect(env[RESTART_EXTENSION_FLAG_VALUES_ENV]).toBeUndefined();
	});

	test("restores only registered extension flag values", () => {
		const recorded = new Map<string, boolean | string>();
		const registeredFlags: Record<string, true> = { "spawn-peer": true, headless: true };
		const sink = {
			getFlags: () => ({ has: (name: string) => registeredFlags[name] === true }),
			setFlagValue: (name: string, value: boolean | string) => {
				recorded.set(name, value);
			},
		};

		restoreRestartExtensionFlagValues(sink, [
			["spawn-peer", "reviewer"],
			["missing", "dropped"],
			["headless", true],
		]);

		expect([...recorded.entries()]).toEqual([
			["spawn-peer", "reviewer"],
			["headless", true],
		]);
	});

	test("preserves disabled context flags across restart", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		const command = buildRestartCommand(
			{ ...baseOptions(), disableLsp: true, disableRules: true, disableSkills: true },
			env,
		);

		expect(command.cmd).toContain("--no-lsp");
		expect(command.cmd).toContain("--no-skills");
		expect(command.cmd).toContain("--no-rules");
		expect(command.cmd.indexOf("--no-lsp")).toBeLessThan(command.cmd.indexOf("--session-dir"));
		expect(command.cmd.indexOf("--no-skills")).toBeLessThan(command.cmd.indexOf("--resume"));
		expect(command.cmd.indexOf("--no-rules")).toBeLessThan(command.cmd.indexOf("--resume"));
	});

	test("preserves CLI system prompts across restart", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		const command = buildRestartCommand(
			{
				...baseOptions(),
				systemPrompt: "Use this exact prompt",
				appendSystemPrompt: "Append this guidance",
			},
			env,
		);

		expect(valuesForFlag(command.cmd, "--system-prompt")).toEqual(["Use this exact prompt"]);
		expect(valuesForFlag(command.cmd, "--append-system-prompt")).toEqual(["Append this guidance"]);
		expect(command.cmd.indexOf("--system-prompt")).toBeLessThan(command.cmd.indexOf("--session-dir"));
		expect(command.cmd.indexOf("--append-system-prompt")).toBeLessThan(command.cmd.indexOf("--resume"));
	});

	test("preserves skill filters across restart", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		const command = buildRestartCommand({ ...baseOptions(), skillPatterns: ["git-*", "review"] }, env);
		const disabledCommand = buildRestartCommand(
			{ ...baseOptions(), disableSkills: true, skillPatterns: ["git-*"] },
			env,
		);

		expect(valuesForFlag(command.cmd, "--skills")).toEqual(["git-*,review"]);
		expect(command.cmd.indexOf("--skills")).toBeLessThan(command.cmd.indexOf("--session-dir"));
		expect(command.cmd.indexOf("--skills")).toBeLessThan(command.cmd.indexOf("--resume"));
		expect(disabledCommand.cmd).toContain("--no-skills");
		expect(valuesForFlag(disabledCommand.cmd, "--skills")).toEqual(["git-*"]);
	});

	test("preserves CLI-only model and UI overrides across restart", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		const command = buildRestartCommand(
			{
				...baseOptions(),
				modelPatterns: ["sonnet", "gpt-5"],
				smolModel: "haiku",
				slowModel: "opus",
				planModel: "planner",
				thinking: "auto",
				hideThinking: true,
				advisor: true,
			},
			env,
		);

		expect(valuesForFlag(command.cmd, "--models")).toEqual(["sonnet,gpt-5"]);
		expect(valuesForFlag(command.cmd, "--smol")).toEqual(["haiku"]);
		expect(valuesForFlag(command.cmd, "--slow")).toEqual(["opus"]);
		expect(valuesForFlag(command.cmd, "--plan")).toEqual(["planner"]);
		expect(valuesForFlag(command.cmd, "--thinking")).toEqual(["auto"]);
		expect(command.cmd).toContain("--hide-thinking");
		expect(command.cmd).toContain("--advisor");
		expect(command.cmd.indexOf("--models")).toBeLessThan(command.cmd.indexOf("--session-dir"));
		expect(command.cmd.indexOf("--hide-thinking")).toBeLessThan(command.cmd.indexOf("--resume"));
		expect(command.cmd.indexOf("--advisor")).toBeLessThan(command.cmd.indexOf("--resume"));
	});

	test("preserves a positive remaining max-time budget across restart", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};
		const now = 1_700_000_000_000;
		const nowSpy = spyOn(Date, "now").mockReturnValue(now);
		try {
			const command = buildRestartCommand({ ...baseOptions(), maxTimeDeadline: now + 125_001 }, env);

			expect(valuesForFlag(command.cmd, "--max-time")).toEqual(["126"]);
			expect(command.cmd.indexOf("--max-time")).toBeLessThan(command.cmd.indexOf("--session-dir"));
		} finally {
			nowSpy.mockRestore();
		}
	});

	test("clamps elapsed max-time deadlines to one second across restart", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};
		const now = 1_700_000_000_000;
		const nowSpy = spyOn(Date, "now").mockReturnValue(now);
		try {
			const command = buildRestartCommand({ ...baseOptions(), maxTimeDeadline: now }, env);

			expect(valuesForFlag(command.cmd, "--max-time")).toEqual(["1"]);
		} finally {
			nowSpy.mockRestore();
		}
	});

	test("preserves disabled tools across restart", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		const command = buildRestartCommand({ ...baseOptions(), toolRestriction: { kind: "none" } }, env);

		expect(command.cmd).toContain("--no-tools");
		expect(command.cmd.indexOf("--no-tools")).toBeLessThan(command.cmd.indexOf("--session-dir"));
		expect(command.cmd).not.toContain("--tools");
	});

	test("preserves a tool allowlist across restart", () => {
		const env: RestartCommandEnvironment = {
			isCompiledBinary: () => true,
			workerHostEntry: () => null,
			execPath: "/opt/omp/omp",
			packageRoot,
		};

		const command = buildRestartCommand(
			{ ...baseOptions(), toolRestriction: { kind: "allowlist", toolNames: ["read", "grep"] } },
			env,
		);

		expect(command.cmd).toContain("--tools");
		expect(command.cmd[command.cmd.indexOf("--tools") + 1]).toBe("read,grep");
		expect(command.cmd.indexOf("--tools")).toBeLessThan(command.cmd.indexOf("--session-dir"));
		expect(command.cmd).not.toContain("--no-tools");
	});
});

describe("restart process spawning", () => {
	test("spawns with inherited stdio and returns the child exit code", async () => {
		let recorded: RestartSpawnInput | undefined;
		const spawn: RestartSpawn = options => {
			recorded = options;
			return { exited: Promise.resolve(7) };
		};

		const exitCode = await spawnRestartProcess(
			{ cmd: ["/opt/omp/omp", "--resume", "sess-1"], cwd: "/repo/project" },
			{ spawn },
		);

		expect(exitCode).toBe(7);
		expect(recorded).toEqual({
			cmd: ["/opt/omp/omp", "--resume", "sess-1"],
			cwd: "/repo/project",
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
	});

	test("passes restart env overrides to the child process", async () => {
		let recorded: RestartSpawnInput | undefined;
		const spawn: RestartSpawn = options => {
			recorded = options;
			return { exited: Promise.resolve(0) };
		};

		await spawnRestartProcess(
			{ cmd: ["/opt/omp/omp", "--resume", "sess-1"], cwd: "/repo/project", env: { [RESTART_API_KEY_ENV]: "sk" } },
			{ spawn },
		);

		expect(recorded?.cmd).toEqual(["/opt/omp/omp", "--resume", "sess-1"]);
		expect(recorded?.env?.[RESTART_API_KEY_ENV]).toBe("sk");
	});
});
