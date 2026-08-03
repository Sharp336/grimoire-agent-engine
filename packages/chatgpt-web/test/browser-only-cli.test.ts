import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LoginHost } from "../src/browser/login-host";
import { type ChatGptWebCliDependencies, type ChatGptWebCliIo, runChatGptWebCli } from "../src/cli";
import type { SecureConfigHost } from "../src/config";

const secureHost = { available: true } as SecureConfigHost;
const loginHost: LoginHost = {
	async login(): Promise<never> {
		throw new Error("unexpected login");
	},
	async close(): Promise<void> {},
};

function io(): { value: ChatGptWebCliIo; stdout: string; stderr: string } {
	let stdout = "";
	let stderr = "";
	return {
		get value() {
			return {
				writeOut(text: string): void {
					stdout += text;
				},
				writeErr(text: string): void {
					stderr += text;
				},
			};
		},
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
	};
}

function dependencies(overrides: Partial<ChatGptWebCliDependencies> = {}): ChatGptWebCliDependencies {
	return {
		secureHost,
		createLoginHost: () => loginHost,
		setup: async () => ({ config: { mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false } }),
		login: async () => ({ authenticated: true, proAvailable: false, verifiedAt: "2026-08-02T12:00:00.000Z" }),
		readConfig: async () => ({ mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false }),
		readLoginStatus: async () => ({
			authenticated: true,
			proAvailable: false,
			verifiedAt: "2026-08-02T12:00:00.000Z",
		}),
		uninstall: async () => {},
		...overrides,
	};
}

async function runCliInChild(argv: readonly string[]): Promise<{
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly lifecycle: readonly string[];
}> {
	const scriptPath = path.join(process.cwd(), `.chatgpt-web-cli-fixture-${randomUUID()}.ts`);
	const cliUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/cli.ts")).href;
	await Bun.write(
		scriptPath,
		`
import { runChatGptWebCli } from ${JSON.stringify(cliUrl)};
const lifecycle = [];
let stdout = "";
let stderr = "";
const io = {
	writeOut(text) { stdout += text; },
	writeErr(text) { stderr += text; },
};
const dependencies = {
	secureHost: { available: true },
	createLoginHost: () => ({ async login() { throw new Error("unexpected login"); }, async close() {} }),
	setup: async () => ({ config: { mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false } }),
	login: async () => ({ authenticated: true, proAvailable: false, verifiedAt: "2026-08-02T12:00:00.000Z" }),
	readConfig: async () => ({ mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false }),
	readLoginStatus: async () => ({ authenticated: true, proAvailable: false, verifiedAt: "2026-08-02T12:00:00.000Z" }),
	uninstall: async () => {},
	createServeRuntime: async () => {
		lifecycle.push("runtime:create");
		return {
			async start() { lifecycle.push("browser:start"); },
			async stop() { lifecycle.push("browser:stop"); },
		};
	},
};
const code = await runChatGptWebCli(JSON.parse(Bun.env.CHATGPT_WEB_ARGV), {
	dependencies,
	io,
	mcpHandoff: async () => { lifecycle.push("mcp:start"); },
});
process.stdout.write(JSON.stringify({ code, stdout, stderr, lifecycle }));
`,
	);
	try {
		const child = Bun.spawn([process.execPath, scriptPath], {
			cwd: path.resolve(import.meta.dir, ".."),
			env: { ...process.env, CHATGPT_WEB_ARGV: JSON.stringify(argv) },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if ((await child.exited) !== 0) throw new Error(`CLI fixture process failed: ${stderr}`);
		return JSON.parse(stdout) as { code: number; stdout: string; stderr: string; lifecycle: string[] };
	} finally {
		await rm(scriptPath, { force: true });
	}
}

describe("browser-only CLI topology", () => {
	test("serve reaches one local browser runtime and never starts MCP or a tunnel", async () => {
		const calls: string[] = [];
		const output = io();
		const deps = dependencies({
			async createServeRuntime({ config }) {
				expect(config.mode).toBe("browser-only");
				calls.push("runtime:create");
				return {
					async start() {
						calls.push("browser:start");
					},
					async stop() {
						calls.push("browser:stop");
					},
				};
			},
		});
		expect(
			await runChatGptWebCli(["serve", "--mode", "browser-only"], { dependencies: deps, io: output.value }),
		).toBe(0);
		expect(calls).toEqual(["runtime:create", "browser:start", "browser:stop"]);
		expect(output.stdout).toBe('{"served":true,"mode":"browser-only"}\n');
		expect(output.stderr).toBe("");
	});

	test("keeps the host open until the injected shutdown promise resolves", async () => {
		const shutdown = Promise.withResolvers<void>();
		const calls: string[] = [];
		const output = io();
		const command = runChatGptWebCli(["serve", "--mode", "browser-only"], {
			dependencies: dependencies({
				async createServeRuntime() {
					return {
						async start() {
							calls.push("start");
						},
						async waitForShutdown() {
							calls.push("wait");
							await shutdown.promise;
						},
						async stop() {
							calls.push("stop");
						},
					};
				},
			}),
			io: output.value,
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(calls).toEqual(["start", "wait"]);
		expect(output.stdout).toBe('{"served":true,"mode":"browser-only"}\n');
		shutdown.resolve();
		expect(await command).toBe(0);
		expect(calls).toEqual(["start", "wait", "stop"]);
	});

	test("executes the package CLI entrypoint in a child process with injected topology seams", async () => {
		const browser = await runCliInChild(["serve", "--mode", "browser-only"]);
		expect(browser.code).toBe(0);
		expect(JSON.parse(browser.stdout)).toEqual({ served: true, mode: "browser-only" });
		expect(browser.stderr).toBe("");
		expect(browser.lifecycle).toEqual(["runtime:create", "browser:start", "browser:stop"]);

		const full = await runCliInChild(["serve", "--mode", "full"]);
		expect(full.code).toBe(1);
		expect(full.stdout).toBe("");
		expect(full.stderr).toBe("ChatGPT Web command failed\n");
		expect(full.lifecycle).toEqual([]);

		const unknownMcp = await runCliInChild(["mcp", "--unexpected"]);
		expect(unknownMcp.code).toBe(1);
		expect(unknownMcp.lifecycle).toEqual([]);
	});

	test("invokes the real package bin and fails closed without preconfigured native state", async () => {
		const child = Bun.spawn(
			[process.execPath, path.resolve(import.meta.dir, "../src/cli.ts"), "serve", "--mode", "browser-only"],
			{ cwd: path.resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(await child.exited).toBe(1);
		expect(stdout).toBe("");
		expect([
			"ChatGPT Web command failed\n",
			"ChatGPT Web command failed (native-secure-state-capability-unavailable)\n",
		]).toContain(stderr);
	});

	test("rejects full mode and tunnel/MCP flags before creating a runtime", async () => {
		let created = 0;
		const deps = dependencies({
			async createServeRuntime() {
				created++;
				throw new Error("must not start");
			},
		});
		for (const argv of [
			["serve", "--mode", "full"],
			["serve", "--mode", "browser-only", "--tunnel-id", `tunnel_${"a".repeat(32)}`],
			["serve", "--mode", "browser-only", "--runtime-key-file", "/private/key"],
			["serve", "--mode", "browser-only", "--broker-handoff"],
		] as const) {
			const output = io();
			expect(await runChatGptWebCli(argv, { dependencies: deps, io: output.value })).toBe(1);
			expect(output.stderr).toBe("ChatGPT Web command failed\n");
		}
		expect(created).toBe(0);
	});

	test("fails closed for missing login marker and unknown MCP commands", async () => {
		let created = 0;
		const deps = dependencies({
			async createServeRuntime() {
				created++;
				throw new Error("must not start");
			},
			async readLoginStatus() {
				return null;
			},
		});
		const missingLogin = io();
		expect(
			await runChatGptWebCli(["serve", "--mode", "browser-only"], { dependencies: deps, io: missingLogin.value }),
		).toBe(1);
		expect(created).toBe(0);

		let mcpStarted = false;
		const unknownMcp = io();
		expect(
			await runChatGptWebCli(["mcp", "--unexpected"], {
				dependencies: deps,
				io: unknownMcp.value,
				mcpHandoff: async () => {
					mcpStarted = true;
				},
			}),
		).toBe(1);
		expect(mcpStarted).toBe(false);
	});

	test("does not fall back when stored config switches away from browser-only", async () => {
		let created = 0;
		const output = io();
		const deps = dependencies({
			async readConfig() {
				return { mode: "full", tunnelId: `tunnel_${"b".repeat(32)}`, runtimeKeyConfigured: true };
			},
			async createServeRuntime() {
				created++;
				throw new Error("must not start");
			},
		});
		expect(
			await runChatGptWebCli(["serve", "--mode", "browser-only"], { dependencies: deps, io: output.value }),
		).toBe(1);
		expect(created).toBe(0);
	});
});
