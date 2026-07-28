import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "../extensibility/extensions/types";
import { SecretBroker } from "../secrets/broker/broker";
import { createRunWithSecretTool } from "../secrets/broker/run-with-secret-tool";
import { createSecretBrokerExtension } from "../secrets/broker/secret-broker-extension";
import type { ExecResult, SecretHandle, SecretValue } from "../secrets/broker/types";
import { SecretObfuscator } from "../secrets/obfuscator";

/**
 * Tier-2 Task 7: session wiring + `/redact` command.
 *
 * The `createSecretBrokerExtension(broker)` factory registers the
 * `run_with_secret` tool and a `/redact` slash command. `/redact` resolves a
 * vault handle via the broker, registers the resolved VALUE into the
 * obfuscator (so it is redacted from all future outbound messages), and
 * returns ONLY the handle placeholder to the agent — never the value.
 */

/** Mock provider whose resolution is fully controlled by the test. */
class MockProvider {
	readonly name: string;
	readonly #value: string;
	readonly #available: boolean;
	constructor(name: string, value: string, available = true) {
		this.name = name;
		this.#value = value;
		this.#available = available;
	}
	async resolve(handle: SecretHandle): Promise<SecretValue> {
		if (!this.#available) throw new Error("provider unavailable");
		return { handle, value: this.#value };
	}
	async isAvailable(): Promise<boolean> {
		return this.#available;
	}
}

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

/** Build an ExtensionCommandContext carrying only the surfaces /redact touches. */
function commandCtx(obfuscator: SecretObfuscator, notifySink: string[]): ExtensionCommandContext {
	const ui = {
		notify(message: string, _type?: "info" | "warning" | "error") {
			notifySink.push(message);
		},
	} as unknown as ExtensionCommandContext["ui"];
	return { ui, obfuscator } as unknown as ExtensionCommandContext;
}

/** Resolved secret value used across the /redact + integration tests. */
const SECRET_VALUE = "topsecret-value-9999";

describe("Tier-2 Task 7: createRunWithSecretTool produces a valid ToolDefinition", () => {
	it("is registered by the extension factory with the correct name + approval", () => {
		const broker = new SecretBroker();
		const { api, registeredTools } = captureApi();
		createSecretBrokerExtension(broker)(api);
		// Tier-2 added run_with_secret; Tier-3 added run_with_chain; Phase C
		// Task C1 added browser_with_secret.
		expect(registeredTools).toHaveLength(4);
		const tool = registeredTools.find(t => t.name === "run_with_secret");
		expect(tool?.approval).toBe("exec");
		expect(tool?.parameters).toBeDefined();
	});
});

describe("Tier-2 Task 7: /redact command", () => {
	it("resolves the handle via the broker and registers the value into the obfuscator", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(
			new MockProvider("bitwarden", SECRET_VALUE) as unknown as Parameters<typeof broker.registerProvider>[0],
		);
		const { api, commands } = captureApi();
		createSecretBrokerExtension(broker)(api);

		const redact = commands.get("redact");
		expect(redact).toBeDefined();

		const obfuscator = new SecretObfuscator([]);
		// Sanity: value is NOT redacted before /redact.
		expect(obfuscator.obfuscate(`leaked ${SECRET_VALUE} here`)).toContain(SECRET_VALUE);

		const notifySink: string[] = [];
		await redact?.handler("bitwarden item-123 password", commandCtx(obfuscator, notifySink));

		// After /redact: the value IS redacted to a #HASH# placeholder.
		const redacted = obfuscator.obfuscate(`leaked ${SECRET_VALUE} here`);
		expect(redacted).not.toContain(SECRET_VALUE);
		expect(redacted).toMatch(/\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/);
	});

	it("returns ONLY the handle placeholder to the agent — never the value", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(
			new MockProvider("bitwarden", SECRET_VALUE) as unknown as Parameters<typeof broker.registerProvider>[0],
		);
		const { api, commands } = captureApi();
		createSecretBrokerExtension(broker)(api);
		const redact = commands.get("redact");

		const obfuscator = new SecretObfuscator([]);
		const notifySink: string[] = [];
		await redact?.handler("bitwarden item-456", commandCtx(obfuscator, notifySink));

		// The notification the operator/agent sees must carry the handle and NOT the value.
		const output = notifySink.join("\n");
		expect(output).toContain("{{vault:bitwarden/item-456}}");
		expect(output).not.toContain(SECRET_VALUE);
	});

	it("includes the field segment in the handle when a field is given", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(
			new MockProvider("bitwarden", SECRET_VALUE) as unknown as Parameters<typeof broker.registerProvider>[0],
		);
		const { api, commands } = captureApi();
		createSecretBrokerExtension(broker)(api);
		const redact = commands.get("redact");

		const obfuscator = new SecretObfuscator([]);
		const notifySink: string[] = [];
		await redact?.handler("bitwarden item-789 totp", commandCtx(obfuscator, notifySink));

		const output = notifySink.join("\n");
		expect(output).toContain("{{vault:bitwarden/item-789/totp}}");
		expect(output).not.toContain(SECRET_VALUE);
	});

	it("errors (fail-closed) when the broker cannot resolve the handle — value never registered", async () => {
		const broker = new SecretBroker();
		// No provider registered → resolution fails.
		const { api, commands } = captureApi();
		createSecretBrokerExtension(broker)(api);
		const redact = commands.get("redact");

		const obfuscator = new SecretObfuscator([]);
		const notifySink: string[] = [];
		await redact?.handler("ghost item-000 password", commandCtx(obfuscator, notifySink));

		// Failure path: an error notification, and the value is NOT registered
		// (there is no value to register). The handle placeholder is also absent.
		const output = notifySink.join("\n");
		expect(output).toMatch(/fail|error|unknown provider/i);
		expect(output).not.toContain("{{vault:");
	});

	it("errors when called with too few arguments", async () => {
		const broker = new SecretBroker();
		const { api, commands } = captureApi();
		createSecretBrokerExtension(broker)(api);
		const redact = commands.get("redact");

		const obfuscator = new SecretObfuscator([]);
		const notifySink: string[] = [];
		await redact?.handler("bitwarden", commandCtx(obfuscator, notifySink));

		const output = notifySink.join("\n");
		expect(output).toMatch(/requires|usage|provider/i);
		expect(output).not.toContain("{{vault:");
	});
});

describe("Tier-2 Task 7: integration — broker + provider + obfuscator together", () => {
	it("resolve → addSecret → obfuscate shows a placeholder, and run_with_secret scrubs the same value", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(
			new MockProvider("bitwarden", SECRET_VALUE) as unknown as Parameters<typeof broker.registerProvider>[0],
		);

		// 1. /redact-equivalent flow: resolve + register into obfuscator.
		const obfuscator = new SecretObfuscator([]);
		const resolved = await broker.resolveHandle({ provider: "bitwarden", itemId: "z-1", field: "password" });
		expect(resolved.value).toBe(SECRET_VALUE);
		obfuscator.addSecret({ type: "plain", content: resolved.value });

		// 2. Obfuscation now hides the value.
		const masked = obfuscator.obfuscate(`token=${SECRET_VALUE}`);
		expect(masked).not.toContain(SECRET_VALUE);
		expect(masked).toMatch(/\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/);

		// 3. run_with_secret scrubs the same value from subprocess stdout.
		const tool = createRunWithSecretTool(broker);
		const result = await tool.execute(
			"int-1",
			{
				handle: { provider: "bitwarden", itemId: "z-1", field: "password" },
				command: "env",
				args: [],
				envKey: "TOKEN",
			},
			undefined,
			undefined,
			{} as ExtensionCommandContext,
		);
		const parsed = JSON.parse((result.content[0] as { type: string; text?: string }).text ?? "") as ExecResult;
		expect(parsed.exitCode).toBe(0);
		expect(JSON.stringify(parsed)).not.toContain(SECRET_VALUE);
	});
});
