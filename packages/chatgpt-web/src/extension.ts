import type {
	ChatGptWebLoginStatus,
	ChatGptWebProviderModel,
	ChatGptWebResolvedRuntime,
	ChatGptWebRuntimeConfig,
	ChatGptWebStream,
	ChatGptWebStreamOptions,
} from "@oh-my-pi/pi-chatgpt-web";
import {
	CHATGPT_WEB_API,
	createChatGptWebProviderModels,
	createChatGptWebStream,
	nativeLocalRuntimeBootstrap,
	readChatGptWebConfig,
	readChatGptWebLoginStatus,
} from "@oh-my-pi/pi-chatgpt-web";
import type { ChatGptWebRuntimeEpoch } from "./mcp/tunnel";
import type { BrowserHost } from "./runtime/host";

const CHATGPT_WEB_BASE_URL = "chatgpt-web://local" as const;

interface StructuralKeylessRegistration {
	readonly keylessCapability: object;
}

interface StructuralExtensionApi {
	issueKeylessProviderRegistration(request: {
		api: typeof CHATGPT_WEB_API;
		baseUrl: typeof CHATGPT_WEB_BASE_URL;
	}): StructuralKeylessRegistration | undefined;
	registerProvider(
		name: string,
		config: {
			baseUrl: typeof CHATGPT_WEB_BASE_URL;
			api: typeof CHATGPT_WEB_API;
			auth: "none";
			keylessCapability: object;
			streamSimple: ChatGptWebStream;
			models: readonly ChatGptWebProviderModel[];
		},
	): void;
}

export interface ChatGptWebExtensionDependencies {
	readonly readConfig: () => Promise<ChatGptWebRuntimeConfig | null>;
	readonly readLoginStatus: () => Promise<ChatGptWebLoginStatus | null>;
	readonly createModels: (proAvailable: boolean, fullMode: boolean) => readonly ChatGptWebProviderModel[];
	readonly createStream: (options?: ChatGptWebStreamOptions) => ChatGptWebStream;
}

export type ChatGptWebRuntimeResolver = () => Promise<ChatGptWebResolvedRuntime>;
export interface ChatGptWebRuntimeEpochBinding {
	readonly config: ChatGptWebRuntimeConfig;
	readonly host: BrowserHost;
	readonly epoch: ChatGptWebRuntimeEpoch;
}

/**
 * Binds the provider stream to the exact epoch owned by the launcher/runtime supervisor.
 * Full mode requires the real broker orchestration adapter; browser-only rejects one.
 */
export function bindChatGptWebRuntimeEpoch(binding: ChatGptWebRuntimeEpochBinding): ChatGptWebResolvedRuntime {
	const { config, host, epoch } = binding;
	if (config.mode === "full") {
		if (!epoch.broker || !epoch.runtimeKey || !epoch.orchestration) {
			throw new Error("ChatGPT Web full runtime epoch is missing broker orchestration authority");
		}
		return Object.freeze({ config, host, gate: epoch.gate, orchestration: epoch.orchestration });
	}
	if (epoch.broker || epoch.runtimeKey || epoch.orchestration) {
		throw new Error("ChatGPT Web browser-only runtime rejects full-mode authority");
	}
	return Object.freeze({ config, host, gate: epoch.gate });
}

let runtimeResolver: ChatGptWebRuntimeResolver | undefined;

/** Install the process-owned browser/runtime resolver before the registered provider handles a turn. */
export function installChatGptWebRuntimeResolver(resolver: ChatGptWebRuntimeResolver): () => void {
	if (runtimeResolver && runtimeResolver !== resolver) {
		throw new Error("ChatGPT Web runtime resolver is already installed");
	}
	runtimeResolver = resolver;
	return () => {
		if (runtimeResolver === resolver) runtimeResolver = undefined;
	};
}

async function resolveInstalledRuntime(): Promise<ChatGptWebResolvedRuntime> {
	return runtimeResolver ? runtimeResolver() : nativeLocalRuntimeBootstrap.resolveRuntime();
}

const defaultDependencies: ChatGptWebExtensionDependencies = {
	readConfig: () => readChatGptWebConfig({ host: nativeLocalRuntimeBootstrap.secureHost }),
	readLoginStatus: () => readChatGptWebLoginStatus({ secureHost: nativeLocalRuntimeBootstrap.secureHost }),
	createModels: createChatGptWebProviderModels,
	createStream: options => createChatGptWebStream({ ...options, resolveRuntime: resolveInstalledRuntime }),
};

/** Build the package-owned extension without importing coding-agent internals. */
export function createChatGptWebExtension(
	dependencies: ChatGptWebExtensionDependencies = defaultDependencies,
): (pi: StructuralExtensionApi) => Promise<void> {
	return async pi => {
		let config: ChatGptWebRuntimeConfig | null;
		let login: ChatGptWebLoginStatus | null;
		try {
			[config, login] = await Promise.all([dependencies.readConfig(), dependencies.readLoginStatus()]);
		} catch {
			return;
		}
		if (!config || !login?.authenticated) return;

		const registration = pi.issueKeylessProviderRegistration({
			api: CHATGPT_WEB_API,
			baseUrl: CHATGPT_WEB_BASE_URL,
		});
		if (!registration) return;

		let stream: ChatGptWebStream | undefined;
		const streamSimple: ChatGptWebStream = (...args) => {
			stream ??= dependencies.createStream({ config });
			return stream(...args);
		};
		const models = dependencies.createModels(login.proAvailable, config.mode === "full");

		pi.registerProvider(CHATGPT_WEB_API, {
			baseUrl: CHATGPT_WEB_BASE_URL,
			api: CHATGPT_WEB_API,
			auth: "none",
			keylessCapability: registration.keylessCapability,
			streamSimple,
			models,
		});
	};
}

export default createChatGptWebExtension();
