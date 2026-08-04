import { chatGptWebSetupExists, nativeLocalRuntimeBootstrap, setupChatGptWeb } from "@oh-my-pi/pi-chatgpt-web";
import { runChatGptWebCli } from "@oh-my-pi/pi-chatgpt-web/cli";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { Settings } from "../config/settings";
import { CHATGPT_WEB_EXTENSION_SOURCE_ID } from "../extensibility/extensions/keyless-provider";

export type ChatGptWebHostAction = "enable" | "disable" | "status" | "login" | "doctor";

export interface ChatGptWebHostCommandIo {
	writeOut(text: string): void;
	writeErr(text: string): void;
}

export interface ChatGptWebHostCommandDependencies {
	readonly settings: Pick<Settings, "get" | "set" | "flush">;
	readonly setupExists: () => Promise<boolean>;
	readonly setupBrowserOnly: () => Promise<void>;
	readonly runPackageCli: (argv: readonly string[], io: ChatGptWebHostCommandIo) => Promise<number>;
}

export function resolveChatGptWebExtensionEntrypoint(): string {
	return CHATGPT_WEB_EXTENSION_SOURCE_ID;
}

async function defaultDependencies(): Promise<ChatGptWebHostCommandDependencies> {
	const secureHost = nativeLocalRuntimeBootstrap.secureHost;
	return {
		settings: await Settings.init({ cwd: getProjectDir() }),
		setupExists: () => chatGptWebSetupExists({ secureHost }),
		setupBrowserOnly: async () => {
			await setupChatGptWeb({ mode: "browser-only", secureHost });
		},
		runPackageCli: (argv, io) => runChatGptWebCli(argv, { io }),
	};
}

export async function runChatGptWebHostCommand(
	action: ChatGptWebHostAction,
	args: readonly string[],
	io: ChatGptWebHostCommandIo,
	dependencies?: ChatGptWebHostCommandDependencies,
): Promise<number> {
	dependencies ??= await defaultDependencies();
	const extensionPath = resolveChatGptWebExtensionEntrypoint();
	const configuredExtensions = dependencies.settings.get("extensions");
	const extensions = Array.isArray(configuredExtensions) ? [...configuredExtensions] : [];

	if (action === "enable") {
		if (!(await dependencies.setupExists())) await dependencies.setupBrowserOnly();
		if (!extensions.includes(extensionPath)) extensions.push(extensionPath);
		dependencies.settings.set("extensions", extensions);
		await dependencies.settings.flush();
		io.writeOut(`${JSON.stringify({ enabled: true })}\n`);
		return 0;
	}
	if (action === "disable") {
		dependencies.settings.set(
			"extensions",
			extensions.filter(configuredPath => configuredPath !== extensionPath),
		);
		await dependencies.settings.flush();
		io.writeOut(`${JSON.stringify({ enabled: false })}\n`);
		return 0;
	}
	if (action === "status") {
		const packageOutput: string[] = [];
		const exitCode = await dependencies.runPackageCli([action, ...args], {
			writeOut: text => packageOutput.push(text),
			writeErr: text => io.writeErr(text),
		});
		if (exitCode !== 0) return exitCode;
		const packageStatus: unknown = JSON.parse(packageOutput.join(""));
		if (packageStatus === null || typeof packageStatus !== "object" || Array.isArray(packageStatus)) {
			throw new Error("ChatGPT Web package returned an invalid status record");
		}
		io.writeOut(`${JSON.stringify({ ...packageStatus, enabled: extensions.includes(extensionPath) })}\n`);
		return 0;
	}

	const exitCode = await dependencies.runPackageCli([action, ...args], io);
	return exitCode;
}

const ACTIONS: ChatGptWebHostAction[] = ["enable", "disable", "status", "login", "doctor"];

export default class ChatGptWeb extends Command {
	static description = "Manage the local ChatGPT Web provider";
	static strict = false;

	static args = {
		action: Args.string({ description: "ChatGPT Web action", required: true, options: ACTIONS }),
		arguments: Args.string({ description: "Action arguments", required: false, multiple: true }),
	};

	async run(): Promise<void> {
		const [rawAction, ...actionArgs] = this.argv;
		if (!ACTIONS.includes(rawAction as ChatGptWebHostAction)) throw new Error("Invalid ChatGPT Web action");
		const action = rawAction as ChatGptWebHostAction;
		const exitCode = await runChatGptWebHostCommand(action, actionArgs, {
			writeOut: text => process.stdout.write(text),
			writeErr: text => process.stderr.write(text),
		});
		if (exitCode !== 0) throw new Error("ChatGPT Web command failed");
	}
}
