import { describe, expect, test } from "bun:test";
import {
	buildRestartCommand,
	RESTART_API_KEY_ENV,
	type RestartCommandEnvironment,
	type RestartSpawn,
	type RestartSpawnInput,
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
