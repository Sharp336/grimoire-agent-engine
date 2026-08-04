#!/usr/bin/env bun
import { type ChatGptWebLoginStatus, loginChatGptWeb, readChatGptWebLoginStatus } from "./browser/login";
import type { LoginHost } from "./browser/login-host";
import { type ChatGptWebRuntimeConfig, readChatGptWebConfig, type SecureConfigHost } from "./config";
import { runMcpHandoffChild } from "./mcp/main";
import { NativeLocalRuntimeUnavailableError, nativeLocalRuntimeBootstrap } from "./runtime/native-local-runtime";
import { setupChatGptWeb, uninstallChatGptWeb } from "./setup";

const HELP = `chatgpt-web

Commands:
  setup --mode browser-only
  setup --mode full --tunnel-id ID --runtime-key-file PATH
  login [--chrome PATH]
  status
  doctor
  serve --mode browser-only|full
  uninstall
  mcp --broker-handoff
`;

export interface ChatGptWebCliIo {
	writeOut(text: string): void;
	writeErr(text: string): void;
}

export interface ChatGptWebServeRuntime {
	readonly start: () => Promise<void>;
	readonly waitForShutdown?: () => Promise<void>;
	readonly stop: () => Promise<void>;
}

export interface ChatGptWebCliDependencies {
	readonly secureHost: SecureConfigHost;
	readonly createLoginHost: () => LoginHost;
	readonly createServeRuntime?: (options: {
		readonly config: ChatGptWebRuntimeConfig;
		readonly login: ChatGptWebLoginStatus;
	}) => Promise<ChatGptWebServeRuntime>;
	readonly setup: typeof setupChatGptWeb;
	readonly login: typeof loginChatGptWeb;
	readonly readConfig: typeof readChatGptWebConfig;
	readonly readLoginStatus: typeof readChatGptWebLoginStatus;
	readonly uninstall: typeof uninstallChatGptWeb;
}

const defaultIo: ChatGptWebCliIo = {
	writeOut(text): void {
		process.stdout.write(text);
	},
	writeErr(text): void {
		process.stderr.write(text);
	},
};

function defaultDependencies(): ChatGptWebCliDependencies {
	return {
		secureHost: nativeLocalRuntimeBootstrap.secureHost,
		createLoginHost: () => nativeLocalRuntimeBootstrap.createLoginHost(),
		createServeRuntime: async () => {
			await nativeLocalRuntimeBootstrap.resolveRuntime();
			const shutdown = Promise.withResolvers<void>();
			const onSignal = () => shutdown.resolve();
			let listening = false;
			let stopped = false;
			return {
				async start(): Promise<void> {
					if (stopped) throw new NativeLocalRuntimeUnavailableError("native-browser-capability-unavailable");
					if (!listening) {
						process.once("SIGINT", onSignal);
						process.once("SIGTERM", onSignal);
						listening = true;
					}
				},
				async waitForShutdown(): Promise<void> {
					await shutdown.promise;
				},
				async stop(): Promise<void> {
					if (stopped) return;
					stopped = true;
					if (listening) {
						process.removeListener("SIGINT", onSignal);
						process.removeListener("SIGTERM", onSignal);
					}
					shutdown.resolve();
					await nativeLocalRuntimeBootstrap.closeRuntime();
				},
			};
		},
		setup: setupChatGptWeb,
		login: loginChatGptWeb,
		readConfig: readChatGptWebConfig,
		readLoginStatus: readChatGptWebLoginStatus,
		uninstall: uninstallChatGptWeb,
	};
}

function takeOption(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error("Missing command option value");
	args.splice(index, 2);
	return value;
}

function assertNoArgs(args: readonly string[]): void {
	if (args.length > 0) throw new Error("Unknown command arguments");
}

function safeStatus(config: ChatGptWebRuntimeConfig | null, login: ChatGptWebLoginStatus | null): string {
	return `${JSON.stringify({
		configured: config !== null,
		mode: config?.mode ?? null,
		tunnelConfigured: config?.tunnelId !== null && config?.tunnelId !== undefined,
		runtimeKeyConfigured: config?.runtimeKeyConfigured ?? false,
		authenticated: login !== null,
		proAvailable: login?.proAvailable ?? false,
	})}\n`;
}

async function runSetup(args: string[], dependencies: ChatGptWebCliDependencies, io: ChatGptWebCliIo): Promise<void> {
	const mode = takeOption(args, "--mode");
	const tunnelId = takeOption(args, "--tunnel-id");
	const runtimeKeyFile = takeOption(args, "--runtime-key-file");
	assertNoArgs(args);
	if (mode !== "browser-only" && mode !== "full") throw new Error("Invalid setup mode");
	await dependencies.setup({
		mode,
		tunnelId,
		runtimeKeyFile,
		secureHost: dependencies.secureHost,
	});
	io.writeOut(`${JSON.stringify({ configured: true, mode })}\n`);
}

async function runLogin(args: string[], dependencies: ChatGptWebCliDependencies, io: ChatGptWebCliIo): Promise<void> {
	const executableOverride = takeOption(args, "--chrome");
	assertNoArgs(args);
	const status = await dependencies.login({
		secureHost: dependencies.secureHost,
		loginHost: dependencies.createLoginHost(),
		executableOverride,
	});
	io.writeOut(`${JSON.stringify(status)}\n`);
}

async function readSafeStatus(dependencies: ChatGptWebCliDependencies): Promise<{
	config: ChatGptWebRuntimeConfig | null;
	login: ChatGptWebLoginStatus | null;
}> {
	const config = await dependencies.readConfig({ host: dependencies.secureHost });
	const login = await dependencies.readLoginStatus({ secureHost: dependencies.secureHost });
	return { config, login };
}
async function runServe(args: string[], dependencies: ChatGptWebCliDependencies, io: ChatGptWebCliIo): Promise<void> {
	const mode = takeOption(args, "--mode");
	if (
		args.some(
			argument =>
				argument === "--tunnel-id" ||
				argument === "--runtime-key-file" ||
				argument === "--broker-handoff" ||
				argument === "mcp",
		)
	) {
		throw new Error("serve does not accept tunnel credentials or MCP commands");
	}
	assertNoArgs(args);
	if (mode !== "browser-only" && mode !== "full") throw new Error("serve requires an explicit runtime mode");
	const { config, login } = await readSafeStatus(dependencies);
	if (!config || config.mode !== mode) throw new Error("Requested ChatGPT Web mode is not configured");
	if (!login) throw new Error("ChatGPT Web login verification is required");
	if (!dependencies.createServeRuntime) throw new Error("ChatGPT Web runtime is unavailable");
	const runtime = await dependencies.createServeRuntime({ config, login });
	try {
		await runtime.start();
		io.writeOut(`${JSON.stringify({ served: true, mode })}\n`);
		if (runtime.waitForShutdown) await runtime.waitForShutdown();
	} finally {
		await runtime.stop();
	}
}

async function runStatus(args: string[], dependencies: ChatGptWebCliDependencies, io: ChatGptWebCliIo): Promise<void> {
	assertNoArgs(args);
	const { config, login } = await readSafeStatus(dependencies);
	io.writeOut(safeStatus(config, login));
}

async function runDoctor(args: string[], dependencies: ChatGptWebCliDependencies, io: ChatGptWebCliIo): Promise<void> {
	assertNoArgs(args);
	const { config, login } = await readSafeStatus(dependencies);
	io.writeOut(
		`${JSON.stringify({
			nativeSecurity: dependencies.secureHost.available ? "ok" : "unavailable",
			configuration: config ? "ok" : "missing",
			login: login ? "ok" : "required",
		})}\n`,
	);
}

async function runUninstall(
	args: string[],
	dependencies: ChatGptWebCliDependencies,
	io: ChatGptWebCliIo,
): Promise<void> {
	assertNoArgs(args);
	await dependencies.uninstall({ secureHost: dependencies.secureHost });
	io.writeOut(`${JSON.stringify({ uninstalled: true })}\n`);
}

export async function runChatGptWebCli(
	argv: readonly string[],
	options: {
		readonly dependencies?: ChatGptWebCliDependencies;
		readonly io?: ChatGptWebCliIo;
		readonly mcpHandoff?: typeof runMcpHandoffChild;
	} = {},
): Promise<number> {
	if (argv[0] === "mcp") {
		if (argv.length !== 2 || argv[1] !== "--broker-handoff") {
			(options.io ?? defaultIo).writeErr("ChatGPT Web command failed\n");
			return 1;
		}
		try {
			await (options.mcpHandoff ?? runMcpHandoffChild)();
			return 0;
		} catch {
			(options.io ?? defaultIo).writeErr("ChatGPT Web command failed\n");
			return 1;
		}
	}
	const dependencies = options.dependencies ?? defaultDependencies();
	const io = options.io ?? defaultIo;
	const [command, ...args] = argv;
	try {
		switch (command) {
			case undefined:
			case "help":
			case "--help":
				io.writeOut(HELP);
				return 0;
			case "setup":
				await runSetup(args, dependencies, io);
				return 0;
			case "login":
				await runLogin(args, dependencies, io);
				return 0;
			case "status":
				await runStatus(args, dependencies, io);
				return 0;
			case "doctor":
				await runDoctor(args, dependencies, io);
				return 0;
			case "serve":
				await runServe(args, dependencies, io);
				return 0;
			case "uninstall":
				await runUninstall(args, dependencies, io);
				return 0;
			default:
				throw new Error("Unknown command");
		}
	} catch (error) {
		io.writeErr(
			error instanceof NativeLocalRuntimeUnavailableError
				? `ChatGPT Web command failed (${error.code})\n`
				: "ChatGPT Web command failed\n",
		);
		return 1;
	}
}

if (import.meta.main) {
	process.exitCode = await runChatGptWebCli(process.argv.slice(2));
}
