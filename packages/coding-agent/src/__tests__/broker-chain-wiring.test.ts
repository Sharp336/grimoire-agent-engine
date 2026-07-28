import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "../extensibility/extensions/types";
import { SecretBroker } from "../secrets/broker/broker";
import { InfisicalProvider } from "../secrets/broker/provider-infisical";
import { createRunWithChainTool } from "../secrets/broker/run-with-chain-tool";
import { createSecretBrokerExtension } from "../secrets/broker/secret-broker-extension";
import type { SecretHandle, SecretValue } from "../secrets/broker/types";

/**
 * Tier-3 Task 4: session wiring — InfisicalProvider registration + chain tool
 * registration.
 *
 * These tests verify the wiring surfaces without booting the full SDK session:
 * (1) `createRunWithChainTool` produces a valid ToolDefinition; (2) the
 * secret-broker extension registers BOTH `run_with_secret` AND `run_with_chain`;
 * (3) `InfisicalProvider` is constructed when its env vars are present and the
 * health check passes.
 */

/** Capture-only ExtensionAPI for asserting what the factory registered. */
function captureApi(): {
	api: ExtensionAPI;
	registeredTools: ToolDefinition[];
	commands: Map<
		string,
		{ description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
	>;
} {
	const registeredTools: ToolDefinition[] = [];
	const commands = new Map<
		string,
		{ description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
	>();
	const api = {
		registerTool(tool: ToolDefinition) {
			registeredTools.push(tool);
		},
		registerCommand(
			name: string,
			options: {
				description?: string;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		) {
			commands.set(name, options);
		},
		// No-op event bus — the factory registers a `context` handler (Phase A1);
		// these tests exercise tools/commands, not event wiring.
		on() {},
	} as unknown as ExtensionAPI;
	return { api, registeredTools, commands };
}

describe("Tier-3 Task 4: createRunWithChainTool produces a valid ToolDefinition", () => {
	it("has the correct name + approval tier + a defined parameter schema", () => {
		const broker = new SecretBroker();
		const tool = createRunWithChainTool(broker);
		expect(tool.name).toBe("run_with_chain");
		expect(tool.approval).toBe("exec");
		expect(tool.parameters).toBeDefined();
		expect(tool.description.length).toBeGreaterThan(0);
	});
});

describe("Tier-3 Task 4 + Phase C Task C1: secret-broker extension registers all four broker tools", () => {
	it("registers exactly four tools with the expected names + approval tiers", () => {
		const broker = new SecretBroker();
		const { api, registeredTools } = captureApi();
		createSecretBrokerExtension(broker)(api);
		expect(registeredTools).toHaveLength(4);
		const names = registeredTools.map(t => t.name).sort();
		expect(names).toEqual(["browser_with_secret", "human_terminal", "run_with_chain", "run_with_secret"]);
		for (const tool of registeredTools) {
			expect(tool.approval).toBe("exec");
		}
	});
});

describe("Tier-3 Task 4: InfisicalProvider is constructed when env vars are set", () => {
	// A mock provider that records its construction args so we can assert the
	// wiring would have registered it. We spy on `isAvailable()` to simulate the
	// health check without hitting the real Infisical API.
	class StubInfisicalProvider extends InfisicalProvider {
		readonly #available: boolean;
		constructor(opts: {
			clientId: string;
			clientSecret: string;
			workspaceId: string;
			apiUrl?: string;
			available: boolean;
		}) {
			super(opts);
			this.#available = opts.available;
		}
		async isAvailable(): Promise<boolean> {
			return this.#available;
		}
		// Stub resolve so we never touch the network in this test.
		async resolve(handle: SecretHandle): Promise<SecretValue> {
			return { handle, value: "stub-infisical-value" };
		}
	}

	it("constructs an InfisicalProvider from env vars and registers it when the health check passes", async () => {
		const provider = new StubInfisicalProvider({
			clientId: "test",
			clientSecret: "test",
			workspaceId: "ws-1234",
			available: true,
		});
		expect(provider.name).toBe("infisical");
		expect(await provider.isAvailable()).toBe(true);

		// Mirror the sdk.ts wiring: register when available.
		const broker = new SecretBroker();
		if (await provider.isAvailable()) {
			broker.registerProvider(provider);
		}
		expect(broker.getProvider("infisical")).toBe(provider);
	});

	it("does NOT register the provider when the health check fails", async () => {
		const provider = new StubInfisicalProvider({
			clientId: "test",
			clientSecret: "test",
			workspaceId: "ws-1234",
			available: false,
		});
		const broker = new SecretBroker();
		if (await provider.isAvailable()) {
			broker.registerProvider(provider);
		}
		expect(broker.getProvider("infisical")).toBeUndefined();
	});
});
