import { describe, expect, it } from "bun:test";
import { ExtensionToolWrapper } from "../src/extensibility/extensions/wrapper";
import { resolveCodeMode } from "../src/session/code-mode";
import { SessionTools, type SessionToolsHost } from "../src/session/session-tools";

const enabledToolNames = ["eval", "todo", "read", "bash"];

function resolve(provider: string, overrides: Partial<Parameters<typeof resolveCodeMode>[0]> = {}) {
	return resolveCodeMode({
		provider,
		setting: "off",
		enabledToolNames,
		evalTransportAvailable: true,
		...overrides,
	});
}

describe("provider-agnostic extension Code Mode", () => {
	for (const provider of ["anthropic", "google-antigravity", "openai", "openai-codex", "xai-oauth"]) {
		it(`activates for ${provider}`, () => {
			const result = resolve(provider, { extensionActivation: "all-models" });
			expect(result.active).toBe(true);
			expect([...result.directToolNames]).toEqual(["eval", "todo"]);
		});
	}

	it("fails closed when the eval replacement cannot reach the native tool bridge", () => {
		const result = resolve("anthropic", {
			extensionActivation: "all-models",
			evalTransportAvailable: false,
		});
		expect(result.active).toBe(false);
		expect([...result.directToolNames]).toEqual(enabledToolNames);
	});

	it("gates extension bridge claims on the native same-name transport capability", () => {
		const replacement = {
			name: "eval",
			supportsCodeModeTransport: () => true,
		};
		let nativeAvailable = false;
		const wrapped = new ExtensionToolWrapper(
			replacement as never,
			{
				nativeToolSupportsCodeModeTransport: () => nativeAvailable,
			} as never,
		);

		expect(wrapped.supportsCodeModeTransport()).toBe(false);
		nativeAvailable = true;
		expect(wrapped.supportsCodeModeTransport()).toBe(true);
		nativeAvailable = false;
		expect(wrapped.supportsCodeModeTransport()).toBe(false);
	});

	it("does not change non-Codex behavior without an extension opt-in", () => {
		expect(resolve("anthropic", { setting: "on" }).active).toBe(false);
	});

	it("forwards the live bridge through the extension tool wrapper", () => {
		let receivedBridge: { getDeclarations(): string | undefined } | undefined;
		const replacement = {
			name: "eval",
			codeModeActivation: "all-models",
			supportsCodeModeTransport: () => receivedBridge !== undefined,
			setCodeModeBridge: (bridge: typeof receivedBridge) => {
				receivedBridge = bridge;
			},
		};
		const wrapped = new ExtensionToolWrapper(
			replacement as never,
			{
				nativeToolSupportsCodeModeTransport: () => true,
			} as never,
		);
		const host = {
			agent: { state: { tools: [wrapped] } },
			settings: {
				get: (key: string) => (key === "providers.openai-codex.codeModeDirectTools" ? [] : "off"),
			},
			model: () => ({ provider: "anthropic" }),
		} as unknown as SessionToolsHost;
		const sessionTools = new SessionTools(host, {
			toolRegistry: new Map([["eval", wrapped]]),
			baseSystemPrompt: [],
		} as never);

		expect(sessionTools.codeModeChangesBetween(undefined, { provider: "anthropic" } as never)).toBe(true);
		expect(receivedBridge).toBeDefined();
	});

	it("reconciles initial all-model activation before the first provider request", () => {
		const evalTool = {
			name: "eval",
			codeModeActivation: "all-models",
			supportsCodeModeTransport: () => true,
		};
		const readTool = { name: "read" };
		const host = {
			agent: { state: { tools: [evalTool, readTool] } },
			settings: {
				get: (key: string) => (key === "providers.openai-codex.codeModeDirectTools" ? [] : "off"),
			},
			model: () => undefined,
		} as unknown as SessionToolsHost;
		const sessionTools = new SessionTools(host, {
			toolRegistry: new Map([
				["eval", evalTool],
				["read", readTool],
			]),
			baseSystemPrompt: [],
		} as never);

		expect(sessionTools.codeModeChangesBetween(undefined, { provider: "anthropic" } as never)).toBe(true);
		expect(
			sessionTools.codeModeChangesBetween({ provider: "anthropic" } as never, { provider: "xai-oauth" } as never),
		).toBe(false);
	});

	it("supplies live declarations for hidden tool schemas", () => {
		let bridge: { getDeclarations(): string | undefined } | undefined;
		const evalTool = {
			name: "eval",
			codeModeActivation: "all-models",
			supportsCodeModeTransport: () => bridge !== undefined,
			setCodeModeBridge: (next: typeof bridge) => {
				bridge = next;
			},
		};
		const readTool = {
			name: "read",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		};
		const batchTool = {
			name: "batch",
			parameters: {
				type: "object",
				properties: { paths: { type: "array", items: { type: "string" } } },
				required: ["paths"],
			},
		};
		const host = {
			agent: { state: { tools: [evalTool, readTool, batchTool] } },
			settings: {
				get: (key: string) => (key === "providers.openai-codex.codeModeDirectTools" ? [] : "off"),
			},
			model: () => ({ provider: "anthropic" }),
		} as unknown as SessionToolsHost;
		const sessionTools = new SessionTools(host, {
			toolRegistry: new Map<string, unknown>([
				["eval", evalTool],
				["read", readTool],
				["batch", batchTool],
			]),
			baseSystemPrompt: [],
		} as never);

		expect(sessionTools.codeModeChangesBetween(undefined, { provider: "anthropic" } as never)).toBe(true);
		const declarations = bridge?.getDeclarations();
		expect(declarations).toContain("read(args: { path: string }): Promise<unknown>;");
		expect(declarations).toContain("batch(args: { paths: string[] }): Promise<unknown>;");
		expect(declarations).not.toContain("eval(args:");
	});

	it("keeps native Codex activation unchanged", () => {
		expect(resolve("openai-codex", { setting: "on" }).active).toBe(true);
		expect(resolve("openai-codex", { setting: "auto", toolMode: "code_mode_only" }).active).toBe(true);
	});
});
