import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import {
	type ChatGptWebHostCommandDependencies,
	resolveChatGptWebExtensionEntrypoint,
	runChatGptWebHostCommand,
} from "../src/commands/chatgpt-web";
import { Settings } from "../src/config/settings";
import { CHATGPT_WEB_EXTENSION_SOURCE_ID } from "../src/extensibility/extensions/keyless-provider";
import { discoverExtensionPaths } from "../src/extensibility/extensions/loader";
import { AgentStorage } from "../src/session/agent-storage";

const temporaryDirectories: string[] = [];
afterEach(async () => {
	AgentStorage.resetInstance();
	for (const directory of temporaryDirectories.splice(0)) {
		if (fs.existsSync(directory)) await removeWithRetries(directory);
	}
});

async function persistedSettings(initialExtensions: string[] = []) {
	const root = path.join(os.tmpdir(), `pi-chatgpt-web-command-${Snowflake.next()}`);
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	temporaryDirectories.push(root);
	const instance = await Settings.loadIsolated({ agentDir, cwd: root });
	instance.set("extensions", initialExtensions);
	await instance.flush();
	return { root, agentDir, instance };
}

function commandIo() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		io: {
			writeOut: (text: string) => out.push(text),
			writeErr: (text: string) => err.push(text),
		},
	};
}

describe("chatgpt-web host command", () => {
	test("uses a stable package-owned source ID that the extension loader recognizes", async () => {
		const { root, instance } = await persistedSettings();
		const extensionPath = resolveChatGptWebExtensionEntrypoint();
		expect(extensionPath).toBe(CHATGPT_WEB_EXTENSION_SOURCE_ID);
		expect(path.isAbsolute(extensionPath)).toBe(false);

		const discovered = await discoverExtensionPaths([extensionPath], root, undefined, { ambient: false });
		expect(discovered).toEqual([CHATGPT_WEB_EXTENSION_SOURCE_ID]);
		instance.cancelPendingSaves();
	});

	test("enable establishes browser-only setup once, stays idempotent, and disable removes only its extension", async () => {
		const unrelated = path.resolve("unrelated-extension.ts");
		const extensionPath = resolveChatGptWebExtensionEntrypoint();
		const { root, agentDir, instance } = await persistedSettings([unrelated]);
		let configured = false;
		let setupCalls = 0;
		const deps: ChatGptWebHostCommandDependencies = {
			settings: instance,
			setupExists: async () => configured,
			setupBrowserOnly: async () => {
				configured = true;
				setupCalls++;
			},
			runPackageCli: async () => 0,
		};
		const { io } = commandIo();

		await runChatGptWebHostCommand("enable", [], io, deps);
		await runChatGptWebHostCommand("enable", [], io, deps);
		expect(setupCalls).toBe(1);
		instance.cancelPendingSaves();
		const enabled = await Settings.loadIsolated({ agentDir, cwd: root });
		expect(enabled.get("extensions")).toEqual([unrelated, extensionPath]);

		await runChatGptWebHostCommand("disable", [], io, { ...deps, settings: enabled });
		enabled.cancelPendingSaves();
		const disabled = await Settings.loadIsolated({ agentDir, cwd: root });
		expect(disabled.get("extensions")).toEqual([unrelated]);
		disabled.cancelPendingSaves();
	});

	test("status reports activation and forwards only package-redacted health", async () => {
		const extensionPath = resolveChatGptWebExtensionEntrypoint();
		const { instance } = await persistedSettings([extensionPath]);
		const output = commandIo();
		const packageCalls: string[][] = [];
		const deps: ChatGptWebHostCommandDependencies = {
			settings: instance,
			setupExists: async () => true,
			setupBrowserOnly: async () => {},
			runPackageCli: async (argv, io) => {
				packageCalls.push([...argv]);
				io.writeOut(
					`${JSON.stringify({
						configured: true,
						mode: "browser-only",
						tunnelConfigured: false,
						runtimeKeyConfigured: false,
						authenticated: true,
						proAvailable: true,
					})}\n`,
				);
				return 0;
			},
		};
		await expect(runChatGptWebHostCommand("status", [], output.io, deps)).resolves.toBe(0);
		expect(packageCalls).toEqual([["status"]]);
		const rendered = output.out.join("");
		expect(rendered.endsWith("\n")).toBe(true);
		const lines = rendered.split("\n");
		expect(lines.pop()).toBe("");
		expect(lines).toHaveLength(1);
		expect(lines.map(line => JSON.parse(line))).toEqual([
			{
				enabled: true,
				configured: true,
				mode: "browser-only",
				tunnelConfigured: false,
				runtimeKeyConfigured: false,
				authenticated: true,
				proAvailable: true,
			},
		]);
		expect(rendered).not.toContain(extensionPath);
		expect(output.err).toEqual([]);
		instance.cancelPendingSaves();
	});

	test("login and doctor delegate to package-local credential-free flows", async () => {
		const { instance } = await persistedSettings();
		const calls: string[][] = [];
		const output = commandIo();
		const deps: ChatGptWebHostCommandDependencies = {
			settings: instance,
			setupExists: async () => true,
			setupBrowserOnly: async () => {},
			runPackageCli: async argv => {
				calls.push([...argv]);
				return 0;
			},
		};
		await runChatGptWebHostCommand("login", ["--chrome", "chrome"], output.io, deps);
		await runChatGptWebHostCommand("doctor", [], output.io, deps);
		expect(calls).toEqual([["login", "--chrome", "chrome"], ["doctor"]]);

		instance.cancelPendingSaves();
	});
});
