import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearAwsCredentialCache,
	resolveAwsCredentials,
	tokenizeCredentialProcessCommand,
} from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { removeWithRetries } from "../../utils/src/temp";

// `credential_process` integration coverage. Drives a real `Bun.spawn`
// against a fixture script so the JSON envelope contract, exit-code
// handling, abort propagation, cache behavior, and the POSIX-style
// tokenizer are all exercised end-to-end.

const ENV_KEYS = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_EC2_METADATA_DISABLED",
] as const;

function quoteForConfig(p: string): string {
	if (!/[\s"]/.test(p)) return p;
	// Wrap in double quotes; our tokenizer preserves backslashes so Windows
	// paths survive without further escaping.
	return `"${p.replace(/(["])/g, "\\$1")}"`;
}

describe("tokenizeCredentialProcessCommand", () => {
	test("splits on whitespace", () => {
		expect(tokenizeCredentialProcessCommand("/bin/auth --json")).toEqual(["/bin/auth", "--json"]);
	});

	test("collapses runs of whitespace", () => {
		expect(tokenizeCredentialProcessCommand("  a\tb \n c")).toEqual(["a", "b", "c"]);
	});

	test("double quotes preserve Windows backslashes", () => {
		expect(tokenizeCredentialProcessCommand(`"C:\\Program Files\\auth\\tool.exe" --json`)).toEqual([
			"C:\\Program Files\\auth\\tool.exe",
			"--json",
		]);
	});

	test('double quotes still escape $ ` " and \\', () => {
		expect(tokenizeCredentialProcessCommand(`"a\\"b" "\\$x" "\\\\n"`)).toEqual([`a"b`, "$x", "\\n"]);
	});

	test("single quotes are fully literal", () => {
		expect(tokenizeCredentialProcessCommand(`'C:\\path with spaces\\bin' --x`)).toEqual([
			"C:\\path with spaces\\bin",
			"--x",
		]);
	});

	test("backslash outside quotes escapes the next character", () => {
		expect(tokenizeCredentialProcessCommand(`a\\ b c`)).toEqual(["a b", "c"]);
	});

	test("rejects unterminated quotes", () => {
		expect(() => tokenizeCredentialProcessCommand(`"unterminated`)).toThrow(/unterminated/);
		expect(() => tokenizeCredentialProcessCommand(`'half`)).toThrow(/unterminated/);
	});

	test("empty input yields no tokens", () => {
		expect(tokenizeCredentialProcessCommand("")).toEqual([]);
		expect(tokenizeCredentialProcessCommand("   \t  ")).toEqual([]);
	});
});

describe("resolveAwsCredentials credential_process", () => {
	let tmp: string;
	const saved = new Map<string, string | undefined>();

	beforeEach(async () => {
		for (const k of ENV_KEYS) {
			saved.set(k, Bun.env[k]);
			delete Bun.env[k];
		}
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-credproc-"));
		clearAwsCredentialCache();
	});

	afterEach(async () => {
		for (const [k, v] of saved) {
			if (v === undefined) delete Bun.env[k];
			else Bun.env[k] = v;
		}
		saved.clear();
		await removeWithRetries(tmp);
		clearAwsCredentialCache();
	});

	async function writeFixture(name: string, body: string): Promise<string> {
		const p = path.join(tmp, name);
		await Bun.write(p, body);
		return p;
	}

	async function writeConfig(profile: string, line: string): Promise<void> {
		const cfg = path.join(tmp, "config");
		await Bun.write(cfg, `[profile ${profile}]\n${line}\n`);
		Bun.env.AWS_CONFIG_FILE = cfg;
		// Point shared credentials at a known-empty file so static-creds resolution
		// definitely misses.
		const sharedPath = path.join(tmp, "credentials");
		await Bun.write(sharedPath, "");
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = sharedPath;
	}

	test("parses a Version 1 envelope and honors Expiration", async () => {
		const script = await writeFixture(
			"good.js",
			`console.log(JSON.stringify({Version:1,AccessKeyId:"AKIATEST",SecretAccessKey:"sek",SessionToken:"tok",Expiration:"2099-01-01T00:00:00Z"}));`,
		);
		await writeConfig("good", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);

		const creds = await resolveAwsCredentials({ profile: "good", region: "us-east-1" });
		expect(creds.accessKeyId).toBe("AKIATEST");
		expect(creds.secretAccessKey).toBe("sek");
		expect(creds.sessionToken).toBe("tok");
		expect(creds.expiresAt).toBe(Date.parse("2099-01-01T00:00:00Z"));
	});

	test("caches by profile so the helper is only invoked once", async () => {
		const counterPath = path.join(tmp, "calls.txt");
		const script = await writeFixture(
			"counted.js",
			`const fs=require("node:fs");
			 const prev=fs.existsSync(${JSON.stringify(counterPath)})?Number(fs.readFileSync(${JSON.stringify(counterPath)},"utf8")):0;
			 fs.writeFileSync(${JSON.stringify(counterPath)},String(prev+1));
			 console.log(JSON.stringify({Version:1,AccessKeyId:"AKIA",SecretAccessKey:"s",Expiration:"2099-01-01T00:00:00Z"}));`,
		);
		await writeConfig(
			"counted",
			`credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`,
		);

		await resolveAwsCredentials({ profile: "counted" });
		await resolveAwsCredentials({ profile: "counted" });
		const calls = Number(await Bun.file(counterPath).text());
		expect(calls).toBe(1);
	});

	test("rejects unsupported envelope versions", async () => {
		const script = await writeFixture(
			"badversion.js",
			`console.log(JSON.stringify({Version:2,AccessKeyId:"a",SecretAccessKey:"b"}));`,
		);
		await writeConfig("badv", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);
		await expect(resolveAwsCredentials({ profile: "badv" })).rejects.toThrow(/unsupported Version 2/);
	});

	test("surfaces stderr on non-zero exit", async () => {
		const script = await writeFixture("fail.js", `process.stderr.write("auth helper broke");process.exit(7);`);
		await writeConfig(
			"failing",
			`credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`,
		);
		await expect(resolveAwsCredentials({ profile: "failing" })).rejects.toThrow(/exited 7.*auth helper broke/);
	});

	test("aborts a long-running helper when the caller's signal fires", async () => {
		const script = await writeFixture("hang.js", `setTimeout(()=>{},60_000);`);
		await writeConfig("hangs", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);
		const ctrl = new AbortController();
		const promise = resolveAwsCredentials({ profile: "hangs", signal: ctrl.signal });
		setTimeout(() => ctrl.abort(new Error("test abort")), 50);
		await expect(promise).rejects.toBeDefined();
	});
});

// `awsAuthRefresh` coverage. The SSO cache lives under `os.homedir()` (which
// can't be redirected mid-process), so these drive the reactive path through
// the file seam instead: an SSO profile with no cached token first throws
// `sso-token-missing`, and the refresh command writes static keys into the
// shared credentials file that the retry's profile resolution then returns
// (static keys are checked ahead of the SSO branch). No homedir or fetch mocks.
describe("resolveAwsCredentials awsAuthRefresh", () => {
	let tmp: string;
	const saved = new Map<string, string | undefined>();

	const START_URL = "https://example.awsapps.com/start";
	const SSO_REGION = "us-east-1";
	let credentialsPath: string;

	beforeEach(async () => {
		for (const k of ENV_KEYS) {
			saved.set(k, Bun.env[k]);
			delete Bun.env[k];
		}
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-authrefresh-"));
		credentialsPath = path.join(tmp, "credentials");
		clearAwsCredentialCache();
	});

	afterEach(async () => {
		for (const [k, v] of saved) {
			if (v === undefined) delete Bun.env[k];
			else Bun.env[k] = v;
		}
		saved.clear();
		await removeWithRetries(tmp);
		clearAwsCredentialCache();
	});

	async function writeFixtureFile(name: string, body: string): Promise<string> {
		const p = path.join(tmp, name);
		await Bun.write(p, body);
		return p;
	}

	/** SSO profile with no cached token, so the first resolution throws sso-token-missing. */
	async function writeSsoConfig(profile: string): Promise<void> {
		const cfg = path.join(tmp, "config");
		await Bun.write(
			cfg,
			`[profile ${profile}]\n` +
				`sso_start_url = ${START_URL}\n` +
				`sso_region = ${SSO_REGION}\n` +
				`sso_account_id = 111122223333\n` +
				`sso_role_name = TestRole\n`,
		);
		Bun.env.AWS_CONFIG_FILE = cfg;
		await Bun.write(credentialsPath, "");
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
	}

	test("missing SSO token surfaces an actionable error without a refresh command", async () => {
		await writeSsoConfig("bare");
		await expect(resolveAwsCredentials({ profile: "bare", region: SSO_REGION })).rejects.toThrow(/aws sso login/i);
	});

	test("runs awsAuthRefresh on a stale token, then re-resolves the repaired creds", async () => {
		await writeSsoConfig("refreshable");

		// The refresh command stands in for `aws sso login`: it repairs on-disk
		// state so the retry resolves. Writing static keys for the profile is the
		// simplest repair to observe (the retry returns them ahead of the SSO
		// branch); a marker file proves the command actually ran.
		const marker = path.join(tmp, "ran.txt");
		const written = `[refreshable]\naws_access_key_id = AKIAFRESH\naws_secret_access_key = fresh-secret\n`;
		const refreshScript = await writeFixtureFile(
			"refresh.js",
			`const fs=require("node:fs");
			 fs.writeFileSync(${JSON.stringify(credentialsPath)}, ${JSON.stringify(written)});
			 fs.writeFileSync(${JSON.stringify(marker)}, "1");`,
		);
		const authRefresh = `${quoteForConfig(process.execPath)} ${quoteForConfig(refreshScript)}`;

		const creds = await resolveAwsCredentials({ profile: "refreshable", region: SSO_REGION, authRefresh });
		expect(creds.accessKeyId).toBe("AKIAFRESH");
		expect(creds.secretAccessKey).toBe("fresh-secret");
		expect(await Bun.file(marker).exists()).toBe(true);
	});

	test("surfaces the refresh command's non-zero exit", async () => {
		await writeSsoConfig("broken-refresh");
		const failScript = await writeFixtureFile(
			"fail-refresh.js",
			`process.stderr.write("login failed");process.exit(3);`,
		);
		const authRefresh = `${quoteForConfig(process.execPath)} ${quoteForConfig(failScript)}`;
		await expect(
			resolveAwsCredentials({ profile: "broken-refresh", region: SSO_REGION, authRefresh }),
		).rejects.toThrow(/awsAuthRefresh command exited 3.*login failed/);
	});
});
