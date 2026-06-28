import { describe, expect, test } from "bun:test";
import {
	buildRestartCommand,
	type RestartCommandEnvironment,
	type RestartSpawn,
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

type RecordedSpawnOptions = {
	cmd: string[];
	cwd: string;
	stdin: "inherit";
	stdout: "inherit";
	stderr: "inherit";
};

describe("restart process spawning", () => {
	test("spawns with inherited stdio and returns the child exit code", async () => {
		let recorded: RecordedSpawnOptions | undefined;
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
});
