import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getPluginsLockfile, getPluginsPackageJson, setAgentDir } from "@oh-my-pi/pi-utils";
import { PluginManager } from "../src/extensibility/plugins/manager";

describe("PluginManager list()", () => {
	let tempRoot: string;
	let projectDir: string;
	let pluginDir: string;
	let originalAgentDir: string;
	let originalConfigDir: string | undefined;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		originalConfigDir = process.env.PI_CONFIG_DIR;
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-list-"));
		projectDir = path.join(tempRoot, "project");
		pluginDir = path.join(tempRoot, "linked-plugin");

		process.env.PI_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
		setAgentDir(path.join(tempRoot, "agent"));
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(pluginDir, { recursive: true });
		await Bun.write(
			path.join(pluginDir, "package.json"),
			JSON.stringify(
				{
					name: "ecc-linked-test",
					version: "1.2.3",
					omp: {
						description: "linked plugin test fixture",
						version: "1.2.3",
					},
				},
				null,
				2,
			),
		);
	});

	afterEach(async () => {
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		setAgentDir(originalAgentDir);
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("includes a successfully linked local plugin even before any npm dependency install state exists", async () => {
		const manager = new PluginManager(projectDir);
		await manager.link(pluginDir);

		const pluginPkg = await Bun.file(getPluginsPackageJson()).json();
		expect(pluginPkg).toMatchObject({
			name: "omp-plugins",
			private: true,
			dependencies: {},
		});

		const runtimeConfig = await Bun.file(getPluginsLockfile()).json();
		expect(runtimeConfig.plugins["ecc-linked-test"]).toMatchObject({
			version: "1.2.3",
			enabled: true,
			enabledFeatures: null,
		});

		const plugins = await manager.list();
		const matches = plugins.filter(plugin => plugin.name === "ecc-linked-test");
		expect(matches).toHaveLength(1);
		expect(matches[0]).toMatchObject({
			name: "ecc-linked-test",
			version: "1.2.3",
			enabled: true,
		});
	});
});
