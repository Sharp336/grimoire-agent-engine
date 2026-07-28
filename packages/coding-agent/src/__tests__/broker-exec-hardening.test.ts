import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOSED_PATH, ENV_OVERRIDE_BLACKLIST, hardenedSpawn } from "../secrets/broker/exec-hardening";

describe("Tier-2 Task 3: hardenedSpawn", () => {
	const saved: Record<string, string | undefined> = {};

	afterEach(() => {
		// Restore process.env mutations.
		for (const key of Object.keys(saved)) {
			if (saved[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = saved[key];
			}
			delete saved[key];
		}
	});

	it("ENV_OVERRIDE_BLACKLIST contains the 20 vars", () => {
		expect(ENV_OVERRIDE_BLACKLIST).toHaveLength(20);
		expect(ENV_OVERRIDE_BLACKLIST).toContain("LD_PRELOAD");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("LD_LIBRARY_PATH");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("LD_AUDIT");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("LD_DEBUG");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("DYLD_INSERT_LIBRARIES");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("DYLD_LIBRARY_PATH");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("DYLD_FALLBACK_LIBRARY_PATH");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("BASH_ENV");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("ENV");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("SSH_ASKPASS");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("GIT_SSH_COMMAND");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("GIT_TERMINAL_PROMPT");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("PYTHONPATH");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("NODE_OPTIONS");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("NODE_PATH");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("PERL5OPT");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("RUBYOPT");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("PERLLIB");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("CLASSPATH");
		expect(ENV_OVERRIDE_BLACKLIST).toContain("JAVA_TOOL_OPTIONS");
	});

	it("CLOSED_PATH is the closed allowlist", () => {
		expect(CLOSED_PATH).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
	});

	it("blacklisted vars are stripped from the subprocess env", async () => {
		saved.LD_PRELOAD = process.env.LD_PRELOAD;
		saved.NODE_OPTIONS = process.env.NODE_OPTIONS;
		saved.BASH_ENV = process.env.BASH_ENV;
		process.env.LD_PRELOAD = "/tmp/evil.so";
		process.env.NODE_OPTIONS = "--require /tmp/evil.js";
		process.env.BASH_ENV = "/tmp/evil.sh";

		const result = await hardenedSpawn({
			command: "printenv",
			args: ["LD_PRELOAD", "NODE_OPTIONS", "BASH_ENV"],
		});
		// printenv prints nothing for unset vars (exit 1 is fine), output must be empty.
		expect(result.stdout.trim()).toBe("");
	});

	it("PATH is set to the closed allowlist", async () => {
		saved.PATH = process.env.PATH;
		process.env.PATH = "/tmp/evil/bin:/usr/local/bin";

		const result = await hardenedSpawn({ command: "printenv", args: ["PATH"] });
		expect(result.stdout.trim()).toBe(CLOSED_PATH);
	});

	it("SSH_AUTH_SOCK/SSH_AGENT_PID are stripped by default (S4 fail-closed)", async () => {
		saved.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
		saved.SSH_AGENT_PID = process.env.SSH_AGENT_PID;
		saved.S4_MARKER = process.env.S4_MARKER;
		process.env.SSH_AUTH_SOCK = "/tmp/user-full-agent.sock";
		process.env.SSH_AGENT_PID = "12345";
		process.env.S4_MARKER = "present";

		const result = await hardenedSpawn({
			command: "printenv",
			args: ["SSH_AUTH_SOCK", "SSH_AGENT_PID"],
		});
		// printenv prints nothing for unset vars (exit 1 is fine), output must be empty.
		expect(result.stdout.trim()).toBe("");

		// Sanity: unrelated vars DO pass through — the strip is SSH-specific.
		const marker = await hardenedSpawn({ command: "printenv", args: ["S4_MARKER"] });
		expect(marker.stdout.trim()).toBe("present");
	});

	it("sshAuthSock option injects the restricted agent socket (S4)", async () => {
		saved.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
		process.env.SSH_AUTH_SOCK = "/tmp/user-full-agent.sock";

		const result = await hardenedSpawn({
			command: "printenv",
			args: ["SSH_AUTH_SOCK"],
			sshAuthSock: "/tmp/restricted-broker-agent.sock",
		});
		expect(result.stdout.trim()).toBe("/tmp/restricted-broker-agent.sock");
	});

	it("envSecrets are injected into the subprocess env but NOT into process.env", async () => {
		const before = process.env.MY_TEST_SECRET_BROKER;
		saved.MY_TEST_SECRET_BROKER = before;
		expect(process.env.MY_TEST_SECRET_BROKER).toBeUndefined();

		const result = await hardenedSpawn({
			command: "printenv",
			args: ["MY_TEST_SECRET_BROKER"],
			envSecrets: { MY_TEST_SECRET_BROKER: "super-secret-value-1234" },
		});
		expect(result.stdout.trim()).toBe("super-secret-value-1234");
		// Agent's own process.env must remain untouched.
		expect(process.env.MY_TEST_SECRET_BROKER).toBeUndefined();
	});

	it('array-form argv works (spawn echo with ["hello"])', async () => {
		const result = await hardenedSpawn({ command: "echo", args: ["hello"] });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello");
	});

	it("subprocess can read the injected secret via printenv", async () => {
		const result = await hardenedSpawn({
			command: "printenv",
			args: ["INJECTED_API_KEY"],
			envSecrets: { INJECTED_API_KEY: "sk-test-9876abcd" },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("sk-test-9876abcd");
	});

	it("command with spaces (bash -c ...) fails because it is not a valid binary name", async () => {
		const result = await hardenedSpawn({ command: "bash -c 'echo hello'", args: [] });
		expect(result.exitCode).not.toBe(0);
	});

	interface DiskExfiltrationCase {
		readonly label: string;
		readonly command: string;
		readonly buildArgs: (outputPath: string) => string[];
	}

	const diskExfiltrationCases: readonly DiskExfiltrationCase[] = [
		{
			label: "tee output file",
			command: "tee",
			buildArgs: outputPath => [outputPath],
		},
		{
			label: "cp from /proc/self/environ",
			command: "cp",
			buildArgs: outputPath => ["/proc/self/environ", outputPath],
		},
		{
			label: "dd from /proc/self/environ",
			command: "dd",
			buildArgs: outputPath => ["if=/proc/self/environ", `of=${outputPath}`, "status=none"],
		},
		{
			label: "base64 output file from /proc/self/environ",
			command: "base64",
			buildArgs: outputPath => ["/proc/self/environ", "-o", outputPath],
		},
		{
			label: "shell redirection from /proc/self/environ",
			command: "sh",
			buildArgs: outputPath => ["-c", `cat /proc/self/environ > ${JSON.stringify(outputPath)}`],
		},
	];

	for (const testCase of diskExfiltrationCases) {
		it(`fail-closed: rejects ${testCase.label} before spawning`, async () => {
			const tempDirectory = mkdtempSync(join(tmpdir(), "omp-broker-s3-"));
			const outputPath = join(tempDirectory, "leaked-environ");

			try {
				const result = await hardenedSpawn({
					command: testCase.command,
					args: testCase.buildArgs(outputPath),
					envSecrets: { S3_TEST_SECRET: "synthetic-s3-secret" },
				});

				expect(result.exitCode).toBe(-1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("[BROKER]");
				expect(result.stderr).toContain("filesystem write");
				expect(existsSync(outputPath)).toBe(false);
			} finally {
				rmSync(tempDirectory, { recursive: true, force: true });
			}
		});
	}
});
