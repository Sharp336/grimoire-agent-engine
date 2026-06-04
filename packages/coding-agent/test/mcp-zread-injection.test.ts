import { describe, expect, it } from "bun:test";
import type { SourceMeta } from "../src/capability/types";
import { injectZreadMCPServer } from "../src/mcp/config";
import type { MCPHttpServerConfig, MCPServerConfig } from "../src/mcp/types";

const ZREAD_URL = "https://api.z.ai/api/mcp/zread/mcp";

function makeMaps(): [Record<string, MCPServerConfig>, Record<string, SourceMeta>] {
	return [{}, {}];
}

function assertHttpConfig(config: MCPServerConfig | undefined): MCPHttpServerConfig {
	if (config?.type !== "http") {
		throw new Error(`Expected http config, got ${config?.type ?? "undefined"}`);
	}
	return config;
}

describe("injectZreadMCPServer", () => {
	it("does nothing when apiKey is not provided", () => {
		const [configs, sources] = makeMaps();
		const result = injectZreadMCPServer(configs, sources);
		expect(result.configs).toEqual({});
		expect(result.sources).toEqual({});
	});

	it("returns new maps without mutating originals", () => {
		const [configs, sources] = makeMaps();
		const result = injectZreadMCPServer(configs, sources, new Set(), "sk-test-key");
		expect(configs).toEqual({});
		expect(sources).toEqual({});
		expect(result.configs.zread).toBeDefined();
	});

	it("injects zread server when apiKey is provided", () => {
		const [configs, sources] = makeMaps();
		const result = injectZreadMCPServer(configs, sources, new Set(), "sk-test-key");

		const zreadConfig = assertHttpConfig(result.configs.zread);
		expect(zreadConfig.url).toBe(ZREAD_URL);
		expect(zreadConfig.headers?.Authorization).toBe("Bearer sk-test-key");
		expect(result.sources.zread?.provider).toBe("zread");
		expect(result.sources.zread?.level).toBe("native");
	});

	it("strips Bearer prefix from apiKey", () => {
		const [configs, sources] = makeMaps();
		const result = injectZreadMCPServer(configs, sources, new Set(), "Bearer sk-test-key");

		const zreadConfig = assertHttpConfig(result.configs.zread);
		expect(zreadConfig.headers?.Authorization).toBe("Bearer sk-test-key");
	});

	it("does not override user-configured zread server", () => {
		const [configs, sources] = makeMaps();
		configs.zread = { type: "http", url: "https://custom.example.com/zread" };
		sources.zread = { provider: "manual", providerName: "Manual", path: "~/.mcp.json", level: "user" };

		const result = injectZreadMCPServer(configs, sources, new Set(), "sk-test-key");

		const zreadConfig = assertHttpConfig(result.configs.zread);
		expect(zreadConfig.url).toBe("https://custom.example.com/zread");
		expect(result.sources.zread?.provider).toBe("manual");
	});

	it("respects case-insensitive server name collision", () => {
		const [configs, sources] = makeMaps();
		configs.Zread = { type: "http", url: "https://custom.example.com/zread" };
		sources.Zread = { provider: "manual", providerName: "Manual", path: "~/.mcp.json", level: "user" };

		const result = injectZreadMCPServer(configs, sources, new Set(), "sk-test-key");

		expect(result.configs.zread).toBeUndefined();
		expect(assertHttpConfig(result.configs.Zread).url).toBe("https://custom.example.com/zread");
	});

	it("does not inject when zread is in disabledServers denylist", () => {
		const [configs, sources] = makeMaps();
		const disabled = new Set(["zread"]);

		const result = injectZreadMCPServer(configs, sources, disabled, "sk-test-key");

		expect(result.configs).toEqual({});
		expect(result.sources).toEqual({});
	});

	it("respects case-insensitive disabledServers match", () => {
		const [configs, sources] = makeMaps();
		const disabled = new Set(["Zread"]);

		const result = injectZreadMCPServer(configs, sources, disabled, "sk-test-key");

		expect(result.configs).toEqual({});
	});

	it("does not inject when zread exists in discoveredNames (even if disabled/filtered)", () => {
		const [configs, sources] = makeMaps();
		const discovered = new Set(["zread", "some-other-server"]);

		const result = injectZreadMCPServer(configs, sources, new Set(), "sk-test-key", discovered);

		expect(result.configs).toEqual({});
		expect(result.sources).toEqual({});
	});
});
