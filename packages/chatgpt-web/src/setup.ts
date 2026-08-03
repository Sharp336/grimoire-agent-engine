import path from "node:path";
import {
	CHATGPT_WEB_TUNNEL_ID_PATTERN,
	type ChatGptWebRuntimeConfig,
	decodeJson,
	encodeJson,
	openChatGptWebState,
	parseChatGptWebRuntimeConfig,
	readChatGptWebConfig,
	type SecureConfigHost,
	type SecureReadResult,
	type SecureStateSession,
} from "./config";

export interface SetupChatGptWebOptions {
	readonly mode: "browser-only" | "full";
	readonly tunnelId?: string;
	readonly runtimeKeyFile?: string;
	readonly agentDir?: string;
	readonly secureHost?: SecureConfigHost;
}

export interface ChatGptWebSetupResult {
	readonly config: ChatGptWebRuntimeConfig;
}

export function validateChatGptWebTunnelId(value: string): string {
	if (!CHATGPT_WEB_TUNNEL_ID_PATTERN.test(value)) {
		throw new Error("Tunnel identifier must use the allowlisted opaque tunnel format");
	}
	return value;
}

function validateExternalKeyPath(value: string): string {
	if (value.includes("\0") || value.split(/[\\/]+/u).includes("..")) {
		throw new Error("Invalid runtime key file");
	}
	const absolute = path.isAbsolute(value) || path.win32.isAbsolute(value);
	if (!absolute) throw new Error("Runtime key file must be absolute");
	return value;
}

async function readExisting(
	session: SecureStateSession,
	name: "config.json" | "runtime-key",
): Promise<SecureReadResult | null> {
	const existing = await session.read(name);
	if (existing) await session.assertCurrent(existing.entry);
	return existing;
}

async function writeConfig(
	session: SecureStateSession,
	config: ChatGptWebRuntimeConfig,
	existing: SecureReadResult | null,
): Promise<void> {
	if (existing) parseChatGptWebRuntimeConfig(decodeJson(existing.bytes));
	await session.replaceAtomic("config.json", encodeJson(config), existing?.entry.identity ?? null);
}

export async function setupChatGptWeb(options: SetupChatGptWebOptions): Promise<ChatGptWebSetupResult> {
	const { session } = await openChatGptWebState({
		agentDir: options.agentDir,
		host: options.secureHost,
		mode: "mutate",
	});
	try {
		const existingConfig = await readExisting(session, "config.json");
		if (options.mode === "browser-only") {
			if (options.tunnelId !== undefined || options.runtimeKeyFile !== undefined) {
				throw new Error("Browser-only setup does not accept tunnel credentials");
			}
			const config: ChatGptWebRuntimeConfig = {
				mode: "browser-only",
				tunnelId: null,
				runtimeKeyConfigured: false,
			};
			await writeConfig(session, config, existingConfig);
			const existingKey = await readExisting(session, "runtime-key");
			if (existingKey) await session.removeAtomic("runtime-key", existingKey.entry.identity);
			return { config };
		}

		if (options.tunnelId === undefined || options.runtimeKeyFile === undefined) {
			throw new Error("Full mode requires a tunnel identifier and runtime key file");
		}
		const tunnelId = validateChatGptWebTunnelId(options.tunnelId);
		const keyPath = validateExternalKeyPath(options.runtimeKeyFile);
		const source = await session.openExternalOwnerFile(keyPath);
		try {
			if (source.bytes.byteLength === 0) throw new Error("Runtime key file is empty");
			await session.assertCurrent(source.entry);
			const existingKey = await readExisting(session, "runtime-key");
			const imported = await session.importAtomic("runtime-key", source, existingKey?.entry.identity ?? null);
			source.consume();
			await session.assertCurrent(imported);
		} finally {
			source.close();
		}
		const config: ChatGptWebRuntimeConfig = {
			mode: "full",
			tunnelId,
			runtimeKeyConfigured: true,
		};
		await writeConfig(session, config, existingConfig);
		return { config };
	} finally {
		await session.close();
	}
}

export async function uninstallChatGptWeb(
	options: { readonly agentDir?: string; readonly secureHost?: SecureConfigHost } = {},
): Promise<void> {
	const { session } = await openChatGptWebState({
		agentDir: options.agentDir,
		host: options.secureHost,
		mode: "mutate",
	});
	try {
		await session.assertCurrent(session.profile);
		await session.removeAllOwnedState();
	} finally {
		await session.close();
	}
}

export async function chatGptWebSetupExists(
	options: { readonly agentDir?: string; readonly secureHost?: SecureConfigHost } = {},
): Promise<boolean> {
	try {
		return (await readChatGptWebConfig({ agentDir: options.agentDir, host: options.secureHost })) !== null;
	} catch {
		return false;
	}
}
