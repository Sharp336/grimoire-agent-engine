import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetStartupWatchdogForTests, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { discoverSessionAuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { getAgentDbPath, TempDir, VERSION } from "@oh-my-pi/pi-utils";

const AUTH_BROKER_ENV_KEYS = [
	"OMP_AUTH_BROKER_URL",
	"OMP_AUTH_BROKER_TOKEN",
	"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
] as const;

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}

async function captureEarlyExit(args: string[], configure?: (parsed: Args) => void) {
	const parsed = parseArgs(args);
	configure?.(parsed);
	const stdout: string[] = [];
	const stderr: string[] = [];
	let discoveryCalls = 0;
	const discoverAuthStorage = vi.fn(async () => {
		discoveryCalls++;
		throw new Error("auth discovery should not run");
	});
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ProcessExitSignal(code ?? 0);
	}) as typeof process.exit);

	let thrown: unknown;
	let watchdogWasArmed = false;
	try {
		await runRootCommand(parsed, args, { discoverAuthStorage });
	} catch (error) {
		thrown = error;
	} finally {
		watchdogWasArmed = resetStartupWatchdogForTests();
	}
	if (!(thrown instanceof ProcessExitSignal)) throw thrown;

	return { code: thrown.code, stdout: stdout.join(""), stderr: stderr.join(""), discoveryCalls, watchdogWasArmed };
}

describe("session auth storage sharing", () => {
	let tempDir: TempDir;
	let savedEnv: Partial<Record<(typeof AUTH_BROKER_ENV_KEYS)[number], string>>;

	beforeEach(() => {
		resetSettingsForTest();
		AgentStorage.resetInstance();
		tempDir = TempDir.createSync("@omp-session-auth-sharing-");
		savedEnv = {};
		for (const key of AUTH_BROKER_ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(async () => {
		resetStartupWatchdogForTests();
		resetSettingsForTest();
		AgentStorage.resetInstance();
		vi.restoreAllMocks();
		for (const key of AUTH_BROKER_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await tempDir.remove();
	});

	it("uses the owner connection without opening or closing a standalone store", async () => {
		const agentDir = tempDir.path();
		const standaloneOpen = vi.spyOn(SqliteAuthCredentialStore, "open");

		const authStorage = await discoverSessionAuthStorage(agentDir);
		expect(standaloneOpen).toHaveBeenCalledTimes(0);

		await Settings.init({ cwd: tempDir.path(), agentDir });
		const owner = await AgentStorage.open(getAgentDbPath(agentDir));
		owner.replaceAuthCredentialsForProvider("test-provider", [
			{ type: "api_key", key: "shared-key", source: "login" },
		]);
		await authStorage.reload();
		expect(authStorage.listStoredCredentials("test-provider").map(row => row.credential)).toEqual([
			{ type: "api_key", key: "shared-key", source: "login" },
		]);

		authStorage.close();
		authStorage.close();
		expect(owner.listAuthCredentials("test-provider").map(row => row.credential)).toEqual([
			{ type: "api_key", key: "shared-key", source: "login" },
		]);
	});

	describe("root command auth storage discovery", () => {
		it("prints --version without discovering session auth storage", async () => {
			const result = await captureEarlyExit(["--version"]);

			expect(result.code).toBe(0);
			expect(result.stdout).toBe(`${VERSION}\n`);
			expect(result.stderr).toBe("");
			expect(result.discoveryCalls).toBe(0);
			expect(result.watchdogWasArmed).toBe(true);
		});

		it("exports a session without discovering session auth storage", async () => {
			const inputPath = path.join(tempDir.path(), "session.jsonl");
			const outputPath = path.join(tempDir.path(), "session.html");
			await Bun.write(
				inputPath,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "export-session",
					timestamp: "2026-07-28T00:00:00.000Z",
					cwd: tempDir.path(),
				})}\n`,
			);

			const result = await captureEarlyExit(["--export", inputPath, outputPath]);

			expect(result.code).toBe(0);
			expect(result.stdout).toBe(`Exported to: ${outputPath}\n`);
			expect(result.stderr).toBe("");
			expect(result.discoveryCalls).toBe(0);
			expect(result.watchdogWasArmed).toBe(true);
			expect(await Bun.file(outputPath).exists()).toBe(true);
		});

		it("rejects RPC file arguments without discovering session auth storage", async () => {
			const result = await captureEarlyExit(["@prompt.md"], parsed => {
				parsed.mode = "rpc";
			});

			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Error: @file arguments are not supported in RPC mode");
			expect(result.discoveryCalls).toBe(0);
			expect(result.watchdogWasArmed).toBe(true);
		});

		it("still discovers session auth storage for normal session startup", async () => {
			const parsed = parseArgs(["--print", "hello"]);
			const discoverAuthStorage = vi.fn(async () => {
				throw new Error("stop after auth discovery");
			});

			let watchdogWasArmed = false;
			try {
				await expect(runRootCommand(parsed, ["--print", "hello"], { discoverAuthStorage })).rejects.toThrow(
					"stop after auth discovery",
				);
			} finally {
				watchdogWasArmed = resetStartupWatchdogForTests();
			}
			expect(discoverAuthStorage).toHaveBeenCalledTimes(1);
			expect(watchdogWasArmed).toBe(true);
		});
	});
});
