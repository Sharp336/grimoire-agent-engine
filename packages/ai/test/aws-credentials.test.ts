import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearAwsCredentialCache, resolveAwsCredentials } from "../src/providers/aws-credentials";

// These tests cover the `credential_process` branch of the AWS credential
// resolver. We point AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE at a
// throwaway tmpdir and provide a tiny Bun script that prints the documented
// JSON envelope on stdout. The chain falls through env (cleared) and into the
// profile reader, which spawns the script.

interface SavedEnv {
	AWS_PROFILE?: string;
	AWS_REGION?: string;
	AWS_DEFAULT_REGION?: string;
	AWS_ACCESS_KEY_ID?: string;
	AWS_SECRET_ACCESS_KEY?: string;
	AWS_SESSION_TOKEN?: string;
	AWS_SHARED_CREDENTIALS_FILE?: string;
	AWS_CONFIG_FILE?: string;
	AWS_EC2_METADATA_DISABLED?: string;
}

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
		writeConfig("quarry-omp", `${process.execPath} ${script}`);

		const creds = await resolveAwsCredentials({ profile: "quarry-omp" });

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
