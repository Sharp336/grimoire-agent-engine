/**
 * Configuration loading tests.
 */

import { describe, expect, it } from "bun:test";
import { getConfigPath, getDataDir, loadConfig } from "../src/config";

describe("config", () => {
	it("returns default config when file does not exist", async () => {
		const config = await loadConfig("/nonexistent/path.json");
		expect(config.channels).toEqual({});
		expect(config.agent?.ompPath).toBe("omp");
		expect(config.session?.idleTimeoutMinutes).toBe(60);
	});

	it("resolves config path in home directory", () => {
		const path = getConfigPath();
		expect(path).toContain(".pi/gateway.json");
	});

	it("resolves data dir", () => {
		const dir = getDataDir();
		expect(dir).toContain(".pi/gateway-data");
	});
});
