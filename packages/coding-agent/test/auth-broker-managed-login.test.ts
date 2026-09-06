import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

const SOURCE = "managed-login-test";
const originalAgentDir = getAgentDir();
let tempRoot: string | undefined;

afterEach(async () => {
	unregisterOAuthProviders(SOURCE);
	setAgentDir(originalAgentDir);
	if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
	tempRoot = undefined;
});

describe("auth-broker managed OAuth login", () => {
	test("reports a managed provider failure without exposing its raw credential-bearing error", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-login-"));
		setAgentDir(path.join(tempRoot, "agent"));
		const statusFile = path.join(tempRoot, "private", "oauth-status.json");
		registerOAuthProvider({
			id: "fixture-failed-oauth",
			name: "Fixture failed OAuth",
			sourceId: SOURCE,
			login: async () => {
				throw new Error("Authorization rejected: fixture-secret-token");
			},
		});
		await expect(
			runAuthBrokerCommand({ action: "login", flags: { json: true, provider: "fixture-failed-oauth", statusFile } }),
		).rejects.toThrow("oauth_login_failed");
		const wire = await fs.readFile(statusFile, "utf8");
		expect(JSON.parse(wire)).toMatchObject({ status: "failed", errorCode: "oauth_login_failed" });
		expect(wire).not.toContain("fixture-secret-token");
	});

	test("publishes only safe authorization and exact stored-row identity", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-login-"));
		setAgentDir(path.join(tempRoot, "agent"));
		const statusFile = path.join(tempRoot, "private", "oauth-status.json");
		registerOAuthProvider({
			id: "fixture-managed-oauth",
			name: "Fixture managed OAuth",
			sourceId: SOURCE,
			login: async callbacks => {
				callbacks.onAuth({
					url: "https://auth.openai.com/codex/device",
					instructions: "Enter code: ABCD-EFGH",
				});
				return {
					access: "fixture-access-token",
					refresh: "fixture-refresh-token",
					expires: Date.now() + 60_000,
					accountId: "fixture-account",
					email: "owner@example.test",
				};
			},
		});

		await runAuthBrokerCommand({
			action: "login",
			flags: {
				json: true,
				provider: "fixture-managed-oauth",
				statusFile,
			},
		});

		const wire = await fs.readFile(statusFile, "utf8");
		const status = JSON.parse(wire);
		expect(status).toMatchObject({
			schema: "omp.oauth_login_status.v1",
			status: "connected",
			loginProviderId: "fixture-managed-oauth",
			credentialProviderId: "fixture-managed-oauth",
			account: { accountId: "fixture-account", email: "owner@example.test" },
		});
		expect(status.account.credentialId).toBeInteger();
		expect(wire).not.toContain("fixture-access-token");
		expect(wire).not.toContain("fixture-refresh-token");
	});
});
