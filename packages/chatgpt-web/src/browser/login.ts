import {
	CHATGPT_WEB_VERIFICATION_MAX_AGE_MS,
	type ChatGptWebRuntimeConfig,
	type ChatGptWebVerificationMarker,
	decodeJson,
	encodeJson,
	openChatGptWebState,
	parseChatGptWebRuntimeConfig,
	parseChatGptWebVerificationMarker,
	type SecureConfigHost,
	type SecureStateSession,
} from "../config";
import type { BrowserLoginResult, LoginHost } from "./login-host";

export interface LoginChatGptWebOptions {
	readonly agentDir?: string;
	readonly secureHost?: SecureConfigHost;
	readonly loginHost: LoginHost;
	readonly executableOverride?: string;
	readonly signal?: AbortSignal;
}

export interface ChatGptWebLoginStatus {
	readonly authenticated: true;
	readonly proAvailable: boolean;
	readonly verifiedAt: string;
}

function validateLoginResult(result: BrowserLoginResult, session: SecureStateSession): void {
	if (
		result.authenticated !== true ||
		typeof result.proAvailable !== "boolean" ||
		!Number.isFinite(Date.parse(result.verifiedAt)) ||
		result.profileIdentity !== session.profile.identity ||
		result.executable.identity === "" ||
		!/^[a-f0-9]{64}$/u.test(result.executable.sha256) ||
		result.executable.version === ""
	) {
		throw new Error("Browser login returned invalid verification metadata");
	}
}

async function readConfig(session: SecureStateSession): Promise<ChatGptWebRuntimeConfig> {
	const stored = await session.read("config.json");
	if (!stored) throw new Error("ChatGPT Web setup is required before login");
	await session.assertCurrent(stored.entry);
	return parseChatGptWebRuntimeConfig(decodeJson(stored.bytes));
}

async function removeExistingMarker(session: SecureStateSession): Promise<void> {
	const stored = await session.read("verification.json");
	if (!stored) return;
	await session.assertCurrent(stored.entry);
	await session.removeAtomic("verification.json", stored.entry.identity);
}

export async function loginChatGptWeb(options: LoginChatGptWebOptions): Promise<ChatGptWebLoginStatus> {
	const { session } = await openChatGptWebState({
		agentDir: options.agentDir,
		host: options.secureHost,
		mode: "mutate",
	});
	let loginHostClosed = false;
	try {
		const config = await readConfig(session);
		await removeExistingMarker(session);
		const result = await options.loginHost.login({
			profile: session.profile,
			config,
			profileGeneration: session.ownership.profileGeneration,
			ownerFence: session.ownerFence,
			headed: true,
			signal: options.signal,
			executableOverride: options.executableOverride,
		});
		validateLoginResult(result, session);
		await session.assertCurrent(session.profile);
		if (!(await session.verifyExecutable(result.executable))) {
			throw new Error("Browser executable identity changed during login");
		}
		await options.loginHost.close();
		loginHostClosed = true;
		const marker: ChatGptWebVerificationMarker = {
			version: 1,
			authenticated: true,
			verifiedAt: result.verifiedAt,
			proAvailable: result.proAvailable,
			profileGeneration: session.ownership.profileGeneration,
			profileIdentity: session.profile.identity,
			executable: result.executable,
			ownerFence: session.ownerFence,
		};
		await session.assertCurrent(session.profile);
		await session.replaceAtomic("verification.json", encodeJson(marker), null);
		return { authenticated: true, proAvailable: marker.proAvailable, verifiedAt: marker.verifiedAt };
	} finally {
		try {
			if (!loginHostClosed) await options.loginHost.close();
		} finally {
			await session.close();
		}
	}
}

async function readValidMarker(
	session: SecureStateSession,
	now: number,
	maxAgeMs: number,
): Promise<ChatGptWebVerificationMarker | null> {
	const stored = await session.read("verification.json");
	if (!stored) return null;
	const marker = parseChatGptWebVerificationMarker(decodeJson(stored.bytes));
	const verifiedAt = Date.parse(marker.verifiedAt);
	if (verifiedAt > now || now - verifiedAt > maxAgeMs) return null;
	if (
		marker.profileGeneration !== session.ownership.profileGeneration ||
		marker.ownerFence !== session.ownerFence ||
		marker.profileIdentity !== session.profile.identity
	) {
		return null;
	}
	if (!(await session.verifyExecutable(marker.executable))) return null;
	await session.assertCurrent(stored.entry);
	await session.assertCurrent(session.profile);
	return marker;
}

export async function readChatGptWebLoginStatus(
	options: {
		readonly agentDir?: string;
		readonly secureHost?: SecureConfigHost;
		readonly now?: number;
		readonly maxAgeMs?: number;
	} = {},
): Promise<ChatGptWebLoginStatus | null> {
	let session: SecureStateSession | undefined;
	let status: ChatGptWebLoginStatus | null = null;
	try {
		({ session } = await openChatGptWebState({
			agentDir: options.agentDir,
			host: options.secureHost,
			mode: "read",
		}));
		const marker = await readValidMarker(
			session,
			options.now ?? Date.now(),
			options.maxAgeMs ?? CHATGPT_WEB_VERIFICATION_MAX_AGE_MS,
		);
		if (marker) {
			status = { authenticated: true, proAvailable: marker.proAvailable, verifiedAt: marker.verifiedAt };
		}
	} catch {
		status = null;
	}
	if (!session) return null;
	try {
		await session.close();
	} catch {
		return null;
	}
	return status;
}

export async function hasChatGptWebLogin(
	options: {
		readonly agentDir?: string;
		readonly secureHost?: SecureConfigHost;
		readonly now?: number;
		readonly maxAgeMs?: number;
	} = {},
): Promise<boolean> {
	return (await readChatGptWebLoginStatus(options)) !== null;
}
