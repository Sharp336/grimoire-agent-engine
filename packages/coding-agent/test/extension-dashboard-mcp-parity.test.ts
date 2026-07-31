import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, reset as resetDiscoveryCache } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadAllExtensions } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

describe("Extension Control Center MCP activation", () => {
	let projectDir = "";
	let userAgentDir = "";

	beforeEach(async () => {
		resetSettingsForTest();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-dashboard-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-dashboard-user-"));
		setAgentDir(userAgentDir);
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await Bun.write(
			path.join(projectDir, ".omp", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"settings-disabled": { command: "echo", args: ["disabled"] },
					"source-disabled": { command: "echo", args: ["source"], enabled: false },
				},
			}),
		);
		initializeWithSettings(await Settings.init({ inMemory: true, cwd: projectDir }));
	});

	afterEach(async () => {
		resetSettingsForTest();
		resetDiscoveryCache();
		__resetDirsFromEnvForTests();
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
	});

	test("renders shared activation disablement and locks source-hard-disabled MCP servers", async () => {
		const extensions = await loadAllExtensions(projectDir, ["mcp:settings-disabled"]);
		const settingsDisabled = extensions.find(extension => extension.id === "mcp:settings-disabled");
		const sourceDisabled = extensions.find(extension => extension.id === "mcp:source-disabled");

		expect(settingsDisabled?.state).toBe("disabled");
		expect(settingsDisabled?.disabledReason).toBe("item-disabled");
		expect(sourceDisabled?.state).toBe("disabled");
		expect(sourceDisabled?.activationLocked).toBe(true);
	});

	test("honors the user MCP denylist and force-enable allowlist", async () => {
		await Bun.write(
			path.join(userAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {},
				disabledServers: ["settings-disabled"],
				enabledServers: ["source-disabled"],
			}),
		);
		resetDiscoveryCache();

		const extensions = await loadAllExtensions(projectDir, []);
		const denylisted = extensions.find(extension => extension.id === "mcp:settings-disabled");
		const forceEnabled = extensions.find(extension => extension.id === "mcp:source-disabled");

		expect(denylisted).toMatchObject({ state: "disabled", disabledReason: "item-disabled" });
		expect(forceEnabled).toMatchObject({ state: "active", activationLocked: false });
	});

	test("uses request-scoped provider activation instead of the runtime registry", async () => {
		const projectEnabled = await loadAllExtensions(projectDir, [], []);
		const projectDisabled = await loadAllExtensions(projectDir, [], ["native"]);

		expect(projectEnabled.find(extension => extension.id === "mcp:settings-disabled")).toMatchObject({
			state: "active",
			disabledReason: undefined,
		});
		expect(projectDisabled.find(extension => extension.id === "mcp:settings-disabled")).toBeUndefined();
	});
});
