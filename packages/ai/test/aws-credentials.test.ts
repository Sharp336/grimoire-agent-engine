import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearAwsCredentialCache, resolveAwsCredentials } from "../src/providers/aws-credentials";
import { withEnv } from "./helpers";

// These tests cover the `credential_process` branch of the AWS credential
// resolver. We point AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE at a
// throwaway tmpdir and provide a tiny Bun script that prints the documented
// JSON envelope on stdout. The chain falls through env (cleared) and into the
// profile reader, which spawns the script.

const ENV_KEYS = [
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_CONFIG_FILE",
	"AWS_EC2_METADATA_DISABLED",
] as const;

type SavedEnv = Partial<Record<(typeof ENV_KEYS)[number], string>>;

let savedEnv: SavedEnv = {};
let tmpDir: string;

function snapshotEnv() {
	savedEnv = {};
	for (const k of ENV_KEYS) {
		const v = process.env[k];
		if (v !== undefined) savedEnv[k] = v;
		delete process.env[k];
	}
}

function restoreEnv() {
	for (const k of ENV_KEYS) {
		const v = savedEnv[k];
		if (v !== undefined) process.env[k] = v;
		else delete process.env[k];
	}
}

function writeProcessScript(payload: object): string {
	const scriptPath = path.join(tmpDir, "creds-process.mjs");
	fs.writeFileSync(scriptPath, `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`, "utf8");
	return scriptPath;
}

function writeFailingScript(exitCode: number, stderr = ""): string {
	const scriptPath = path.join(tmpDir, "creds-process-fail.mjs");
	fs.writeFileSync(
		scriptPath,
		`process.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(${exitCode});\n`,
		"utf8",
	);
	return scriptPath;
}

function writeConfig(profile: string, command: string) {
	fs.writeFileSync(
		path.join(tmpDir, "config"),
		`[profile ${profile}]\ncredential_process = ${command}\nregion = us-east-1\n`,
		"utf8",
	);
	fs.writeFileSync(path.join(tmpDir, "credentials"), "", "utf8");
	process.env.AWS_CONFIG_FILE = path.join(tmpDir, "config");
	process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(tmpDir, "credentials");
	// Disable IMDS fallback so a missing process branch surfaces as an error
	// instead of timing out against the metadata service.
	process.env.AWS_EC2_METADATA_DISABLED = "true";
}

beforeEach(() => {
	snapshotEnv();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aws-credentials-test-"));
	clearAwsCredentialCache();
});

afterEach(() => {
	restoreEnv();
	clearAwsCredentialCache();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("aws-credentials credential_process", () => {
	test("spawns the configured process and parses Version 1 JSON", async () => {
		const script = writeProcessScript({
			Version: 1,
			AccessKeyId: "AKIAPROCESS",
			SecretAccessKey: "secret-from-process",
			SessionToken: "session-from-process",
			Expiration: "2099-01-01T00:00:00Z",
		});
		writeConfig("custom-aws-auth-tool", `${process.execPath} ${script}`);

		const creds = await resolveAwsCredentials({ profile: "custom-aws-auth-tool" });

		expect(creds.accessKeyId).toBe("AKIAPROCESS");
		expect(creds.secretAccessKey).toBe("secret-from-process");
		expect(creds.sessionToken).toBe("session-from-process");
		expect(creds.expiresAt).toBe(Date.parse("2099-01-01T00:00:00Z"));
	});

	test("omits sessionToken/expiresAt when the process does not provide them", async () => {
		const script = writeProcessScript({
			Version: 1,
			AccessKeyId: "AKIASTATIC",
			SecretAccessKey: "static-secret",
		});
		writeConfig("static-process", `${process.execPath} ${script}`);

		const creds = await resolveAwsCredentials({ profile: "static-process" });

		expect(creds.accessKeyId).toBe("AKIASTATIC");
		expect(creds.secretAccessKey).toBe("static-secret");
		expect(creds.sessionToken).toBeUndefined();
		expect(creds.expiresAt).toBeUndefined();
	});

	test("rejects unsupported Version values", async () => {
		const script = writeProcessScript({
			Version: 2,
			AccessKeyId: "AKIA",
			SecretAccessKey: "secret",
		});
		writeConfig("bad-version", `${process.execPath} ${script}`);

		await expect(resolveAwsCredentials({ profile: "bad-version" })).rejects.toThrow(/unsupported Version/i);
	});

	test("rejects malformed Expiration values (would otherwise cache as non-expiring)", async () => {
		// Without this guard, an unparseable Expiration would silently become
		// `undefined` and the cache would treat the credentials as eternal —
		// requests would later fail with expired-token errors and the helper
		// would never be re-invoked.
		const script = writeProcessScript({
			Version: 1,
			AccessKeyId: "AKIA",
			SecretAccessKey: "secret",
			Expiration: "not-a-real-timestamp",
		});
		writeConfig("bad-expiration", `${process.execPath} ${script}`);

		await expect(resolveAwsCredentials({ profile: "bad-expiration" })).rejects.toThrow(/invalid Expiration/i);
	});

	test("rejects empty Expiration string (still a malformed envelope)", async () => {
		const script = writeProcessScript({
			Version: 1,
			AccessKeyId: "AKIA",
			SecretAccessKey: "secret",
			Expiration: "",
		});
		writeConfig("empty-expiration", `${process.execPath} ${script}`);

		await expect(resolveAwsCredentials({ profile: "empty-expiration" })).rejects.toThrow(/invalid Expiration/i);
	});

	test("rejects responses missing AccessKeyId or SecretAccessKey", async () => {
		const script = writeProcessScript({ Version: 1, AccessKeyId: "AKIA" });
		writeConfig("missing-secret", `${process.execPath} ${script}`);

		await expect(resolveAwsCredentials({ profile: "missing-secret" })).rejects.toThrow(
			/no AccessKeyId\/SecretAccessKey/,
		);
	});

	test("surfaces non-zero exit status from the process", async () => {
		const script = writeFailingScript(7, "boom\n");
		writeConfig("failing-process", `${process.execPath} ${script}`);

		await expect(resolveAwsCredentials({ profile: "failing-process" })).rejects.toThrow(
			/credential_process for profile 'failing-process' failed/,
		);
	});

	test("honors quoted arguments in the command line", async () => {
		const dirWithSpace = path.join(tmpDir, "dir with space");
		fs.mkdirSync(dirWithSpace);
		const scriptPath = path.join(dirWithSpace, "creds.mjs");
		fs.writeFileSync(
			scriptPath,
			`process.stdout.write(JSON.stringify({Version:1,AccessKeyId:"AK",SecretAccessKey:"SK"}));\n`,
			"utf8",
		);
		writeConfig("quoted-args", `"${process.execPath}" "${scriptPath}"`);

		const creds = await resolveAwsCredentials({ profile: "quoted-args" });
		expect(creds.accessKeyId).toBe("AK");
		expect(creds.secretAccessKey).toBe("SK");
	});

	test("env credentials still win over credential_process (chain order)", async () => {
		const script = writeProcessScript({
			Version: 1,
			AccessKeyId: "AKIAPROCESS",
			SecretAccessKey: "process-secret",
		});
		writeConfig("env-wins", `${process.execPath} ${script}`);

		process.env.AWS_ACCESS_KEY_ID = "AKIAFROMENV";
		process.env.AWS_SECRET_ACCESS_KEY = "env-secret";

		const creds = await resolveAwsCredentials({ profile: "env-wins" });
		expect(creds.accessKeyId).toBe("AKIAFROMENV");
		expect(creds.secretAccessKey).toBe("env-secret");
	});

	test("preserves backslashes inside double-quoted args (Windows-path tokenization)", async () => {
		// Reproduces the shape AWS docs document for Windows:
		//   credential_process = "C:\Tools\creds.cmd" --path "C:\x\y"
		// The earlier tokenizer ate every backslash inside `"..."`, which would
		// have turned `C:\x\y` into `C:xy`. The script echoes its argv[1] back
		// inside the AccessKeyId so we can assert byte-exact preservation.
		const scriptPath = path.join(tmpDir, "echo-arg.mjs");
		fs.writeFileSync(
			scriptPath,
			`const arg = process.argv[2];\nprocess.stdout.write(JSON.stringify({Version:1,AccessKeyId:arg,SecretAccessKey:"SK"}));\n`,
			"utf8",
		);
		const argWithBackslashes = "C:\\Path\\To\\creds.cmd";
		writeConfig("windows-args", `"${process.execPath}" "${scriptPath}" "${argWithBackslashes}"`);

		const creds = await resolveAwsCredentials({ profile: "windows-args" });
		expect(creds.accessKeyId).toBe(argWithBackslashes);
		expect(creds.secretAccessKey).toBe("SK");
	});

	test("treats `\\ ` outside quotes as an escaped literal space (POSIX shell)", async () => {
		// Without backslash-escape support outside quotes, `arg\ with\ spaces`
		// would split into three argv entries. POSIX shells (and shlex.split,
		// which botocore uses) treat `\<char>` outside quotes as a literal
		// `<char>`, so the helper should receive a single token.
		const scriptPath = path.join(tmpDir, "echo-arg.mjs");
		fs.writeFileSync(
			scriptPath,
			`const arg = process.argv[2];\nprocess.stdout.write(JSON.stringify({Version:1,AccessKeyId:arg,SecretAccessKey:"SK"}));\n`,
			"utf8",
		);
		writeConfig("escaped-spaces", `${process.execPath} ${scriptPath} arg\\ with\\ spaces`);

		const creds = await resolveAwsCredentials({ profile: "escaped-spaces" });
		expect(creds.accessKeyId).toBe("arg with spaces");
		expect(creds.secretAccessKey).toBe("SK");
	});

	test("rejects a credential_process command line ending in a stray backslash", async () => {
		writeConfig("trailing-backslash", `${process.execPath} foo\\`);

		await expect(resolveAwsCredentials({ profile: "trailing-backslash" })).rejects.toThrow(
			/ends with a stray backslash/,
		);
	});

	test.skipIf(process.platform !== "win32")(
		"runs Windows .cmd helpers through cmd.exe (execFile would refuse them)",
		async () => {
			// Node's execFile cannot launch .cmd / .bat directly on Windows, but the
			// AWS docs include .cmd examples, so the resolver must route those
			// through the shell. We write a tiny .cmd that prints the JSON envelope
			// and assert it's invoked successfully.
			const cmdPath = path.join(tmpDir, "creds.cmd");
			const payload = '{"Version":1,"AccessKeyId":"AKIACMD","SecretAccessKey":"cmd-secret"}';
			fs.writeFileSync(cmdPath, `@echo off\r\necho ${payload}\r\n`, "utf8");
			writeConfig("windows-cmd", `"${cmdPath}"`);

			const creds = await resolveAwsCredentials({ profile: "windows-cmd" });
			expect(creds.accessKeyId).toBe("AKIACMD");
			expect(creds.secretAccessKey).toBe("cmd-secret");
		},
	);

	test.skipIf(process.platform !== "win32")(
		"resolves bare-name Windows helpers via PATHEXT (.cmd shim)",
		async () => {
			// Real-world Windows entries often look like
			//   credential_process = aws-vault exec foo --json
			// where `aws-vault` has no extension and resolves to `aws-vault.cmd`
			// (or .exe) through PATH + PATHEXT. That's a shell behavior — Win32
			// CreateProcess wouldn't find it — so the resolver must use the shell
			// even when the first token has no extension.
			const helperName = "omp-test-creds";
			const helperPath = path.join(tmpDir, `${helperName}.cmd`);
			const payload = '{"Version":1,"AccessKeyId":"AKIABARE","SecretAccessKey":"bare-secret"}';
			fs.writeFileSync(helperPath, `@echo off\r\necho ${payload}\r\n`, "utf8");

			await withEnv({ PATH: `${tmpDir};${process.env.PATH ?? ""}` }, async () => {
				writeConfig("windows-bare", helperName);
				const creds = await resolveAwsCredentials({ profile: "windows-bare" });
				expect(creds.accessKeyId).toBe("AKIABARE");
				expect(creds.secretAccessKey).toBe("bare-secret");
			});
		},
	);

	test("AbortSignal cancels a hanging credential_process", async () => {
		// Sleep forever — long enough that the only way the promise resolves is
		// via the AbortSignal we hand to resolveAwsCredentials.
		const scriptPath = path.join(tmpDir, "hang.mjs");
		fs.writeFileSync(scriptPath, "setTimeout(() => {}, 60_000);\n", "utf8");
		writeConfig("hanging-process", `${process.execPath} ${scriptPath}`);

		const ac = new AbortController();
		const pending = resolveAwsCredentials({ profile: "hanging-process", signal: ac.signal });
		// Give the child a tick to actually spawn before aborting.
		await new Promise((resolve) => setTimeout(resolve, 50));
		ac.abort();

		await expect(pending).rejects.toThrow(/credential_process for profile 'hanging-process' failed/);
	});
});
