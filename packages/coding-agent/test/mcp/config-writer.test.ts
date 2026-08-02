import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	setMcpServerEnabled,
	setServerDisabled,
} from "../../src/mcp/config-writer";

describe("config-writer concurrent mutations", () => {
	let dir: string;
	let filePath: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-config-"));
		filePath = path.join(dir, "mcp.json");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("preserves both servers when two adds race the same file", async () => {
		await Promise.all([
			addMCPServer(filePath, "alpha", { type: "stdio", command: "a" }),
			addMCPServer(filePath, "bravo", { type: "stdio", command: "b" }),
		]);

		const config = await readMCPConfigFile(filePath);
		expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["alpha", "bravo"]);
	});

	it("preserves both denylist edits when disable calls race", async () => {
		await Promise.all([setServerDisabled(filePath, "alpha", true), setServerDisabled(filePath, "bravo", true)]);

		expect((await readDisabledServers(filePath)).sort()).toEqual(["alpha", "bravo"]);
	});

	it("writes into a directory that does not exist yet", async () => {
		const nestedPath = path.join(dir, "nested", "deep", "mcp.json");
		await addMCPServer(nestedPath, "alpha", { type: "stdio", command: "a" });

		const config = await readMCPConfigFile(nestedPath);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});

	it("does not clear user overlays when toggling a project definition", async () => {
		const userPath = path.join(dir, "user", "mcp.json");
		const projectPath = path.join(dir, "project", "mcp.json");
		await Bun.write(userPath, JSON.stringify({ disabledServers: ["shared"] }));
		await Bun.write(
			projectPath,
			JSON.stringify({ mcpServers: { shared: { type: "stdio", command: "project", enabled: false } } }),
		);

		await setMcpServerEnabled({ userPath, projectPath, name: "shared", enabled: true });

		expect((await readMCPConfigFile(projectPath)).mcpServers?.shared?.enabled).toBe(true);
		expect((await readMCPConfigFile(userPath)).disabledServers).toEqual(["shared"]);
	});

	it("clears a force-enable overlay when disabling a standalone definition", async () => {
		const userPath = path.join(dir, "user", "mcp.json");
		const projectPath = path.join(dir, "project", "mcp.json");
		const standalonePath = path.join(dir, "standalone", "mcp.json");
		await Bun.write(userPath, JSON.stringify({ enabledServers: ["shared"] }));
		await Bun.write(
			standalonePath,
			JSON.stringify({ mcpServers: { shared: { type: "stdio", command: "standalone", enabled: true } } }),
		);

		await setMcpServerEnabled({
			userPath,
			projectPath,
			sourcePath: standalonePath,
			name: "shared",
			enabled: false,
		});

		expect((await readMCPConfigFile(standalonePath)).mcpServers?.shared?.enabled).toBe(false);
		expect((await readMCPConfigFile(userPath)).enabledServers).toBeUndefined();
	});
});
