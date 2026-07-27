import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { discoverSessionAuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { getAgentDbPath, TempDir } from "@oh-my-pi/pi-utils";

const AUTH_BROKER_ENV_KEYS = [
	"OMP_AUTH_BROKER_URL",
	"OMP_AUTH_BROKER_TOKEN",
	"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
] as const;

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
});
