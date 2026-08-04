import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const CHATGPT_WEB_VERIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const CHATGPT_WEB_TUNNEL_ID_PATTERN = /^tunnel_[a-f0-9]{32}$/u;

export type ChatGptWebMode = "browser-only" | "full";

export interface ChatGptWebRuntimeConfig {
	readonly mode: ChatGptWebMode;
	readonly tunnelId: string | null;
	readonly runtimeKeyConfigured: boolean;
}

export interface ChatGptWebPaths {
	readonly agentDir: string;
	readonly root: string;
	readonly config: string;
	readonly controlToken: string;
	readonly runtimeKey: string;
	readonly browserProfile: string;
	readonly ownership: string;
	readonly verification: string;
	readonly logs: string;
	readonly evidence: string;
}

export interface ChatGptWebProcessIdentity {
	readonly pid: number;
	readonly processStartIdentity: string;
}

export interface ChatGptWebOwnershipRecord {
	readonly version: 1;
	readonly ownerNonce: string;
	readonly process: ChatGptWebProcessIdentity;
	readonly profileGeneration: string;
}

export interface ChatGptWebExecutableIdentity {
	readonly identity: string;
	readonly sha256: string;
	readonly version: string;
}

export interface ChatGptWebVerificationMarker {
	readonly version: 1;
	readonly authenticated: true;
	readonly verifiedAt: string;
	readonly proAvailable: boolean;
	readonly profileGeneration: string;
	readonly profileIdentity: string;
	readonly executable: ChatGptWebExecutableIdentity;
	readonly ownerFence: string;
}

export type SecureEntryKind = "directory" | "file" | "executable";

/** Opaque, already-open native capability. Implementations must reject structural clones and stale handles. */
export interface SecureEntryReference {
	readonly identity: string;
	readonly kind: SecureEntryKind;
	readonly __secureEntry: unique symbol;
}

export interface SecureReadResult {
	readonly entry: SecureEntryReference;
	readonly bytes: Uint8Array;
}

export interface SecureExternalFile extends SecureReadResult {
	consume(): void;
	close(): void;
}

export interface SecureStateSession {
	readonly mode: "read" | "mutate";
	readonly ownership: ChatGptWebOwnershipRecord;
	/** Held ownership file capability; revalidated before browser authority is used. */
	readonly ownershipEntry: SecureEntryReference;
	readonly ownerFence: string;
	readonly profile: SecureEntryReference;
	read(name: ChatGptWebStateName): Promise<SecureReadResult | null>;
	assertCurrent(entry: SecureEntryReference): Promise<void>;
	verifyExecutable(identity: ChatGptWebExecutableIdentity): Promise<boolean>;
	openExternalOwnerFile(path: string): Promise<SecureExternalFile>;
	replaceAtomic(
		name: ChatGptWebStateName,
		bytes: Uint8Array,
		expectedDestinationIdentity: string | null,
	): Promise<SecureEntryReference>;
	importAtomic(
		name: "runtime-key",
		source: SecureExternalFile,
		expectedDestinationIdentity: string | null,
	): Promise<SecureEntryReference>;
	removeAtomic(name: ChatGptWebStateName, expectedIdentity: string): Promise<void>;
	removeAllOwnedState(): Promise<void>;
	close(): Promise<void>;
}

export type ChatGptWebStateName = "config.json" | "control-token" | "runtime-key" | "verification.json";

/**
 * Security boundary for profile/config persistence. A production implementation must use held
 * no-follow native handles, owner-only ACL checks, an OS lock, and compare-and-replace operations.
 */
export interface SecureConfigHost {
	readonly available: boolean;
	currentProcessIdentity(): Promise<ChatGptWebProcessIdentity>;
	openState(
		paths: ChatGptWebPaths,
		options: {
			readonly mode: "read" | "mutate";
			readonly proposedOwnership?: ChatGptWebOwnershipRecord;
		},
	): Promise<SecureStateSession>;
}

export class NativeSecurityUnavailableError extends Error {
	constructor() {
		super("The required native owner-safe file security surface is unavailable");
		this.name = "NativeSecurityUnavailableError";
	}
}

const unavailableSecureConfigHost: SecureConfigHost = {
	available: false,
	async currentProcessIdentity(): Promise<ChatGptWebProcessIdentity> {
		throw new NativeSecurityUnavailableError();
	},
	async openState(): Promise<SecureStateSession> {
		throw new NativeSecurityUnavailableError();
	},
};

let configuredSecureConfigHost: SecureConfigHost | undefined;

/** Installs the native-backed host owned by the embedding package. Tests should inject dependencies directly. */
export function setChatGptWebSecureConfigHost(host: SecureConfigHost | undefined): void {
	configuredSecureConfigHost = host;
}

export function getChatGptWebSecureConfigHost(): SecureConfigHost {
	return configuredSecureConfigHost ?? unavailableSecureConfigHost;
}

function containsTraversal(value: string): boolean {
	return value.split(/[\\/]+/u).some(segment => segment === "..");
}

function isWindowsAbsolute(value: string): boolean {
	return path.win32.isAbsolute(value) && (/^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\"));
}

function normalizeAgentDir(value: string): string {
	if (value.length === 0 || value.includes("\0") || containsTraversal(value)) {
		throw new Error("Invalid ChatGPT Web agent directory");
	}
	if (isWindowsAbsolute(value)) {
		const normalized = path.win32
			.normalize(value)
			.replace(/[\\/]+$/u, "")
			.toLowerCase();
		if (normalized === "" || normalized === ".") throw new Error("Invalid ChatGPT Web agent directory");
		return normalized;
	}
	if (!path.posix.isAbsolute(value)) throw new Error("ChatGPT Web agent directory must be absolute");
	const normalized = path.posix.normalize(value).replace(/\/+$/u, "") || "/";
	const provided = value.replace(/\/+$/u, "") || "/";
	if (normalized !== provided) {
		throw new Error("ChatGPT Web agent directory must already be normalized");
	}
	return normalized;
}

export function resolveChatGptWebPaths(agentDir?: string): ChatGptWebPaths {
	const configuredAgentDir = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".omp", "agent");
	const normalizedAgentDir = normalizeAgentDir(configuredAgentDir);
	const join = isWindowsAbsolute(normalizedAgentDir) ? path.win32.join : path.posix.join;
	const root = join(normalizedAgentDir, "chatgpt-web");
	return {
		agentDir: normalizedAgentDir,
		root,
		config: join(root, "config.json"),
		controlToken: join(root, "control-token"),
		runtimeKey: join(root, "runtime-key"),
		browserProfile: join(root, "browser-profile"),
		ownership: join(root, "ownership"),
		verification: join(root, "verification.json"),
		logs: join(root, "logs"),
		evidence: join(root, "local-evidence"),
	};
}

export function createChatGptWebOwnership(
	processIdentity: ChatGptWebProcessIdentity,
	randomId: () => string = () => randomBytes(32).toString("hex"),
): ChatGptWebOwnershipRecord {
	if (
		!Number.isSafeInteger(processIdentity.pid) ||
		processIdentity.pid <= 0 ||
		processIdentity.processStartIdentity === ""
	) {
		throw new Error("Invalid current process identity");
	}
	return {
		version: 1,
		ownerNonce: randomId(),
		process: processIdentity,
		profileGeneration: randomId(),
	};
}

export function encodeJson(value: unknown): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

export function decodeJson(bytes: Uint8Array): unknown {
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

const RuntimeConfigSchema = z.discriminatedUnion("mode", [
	z.strictObject({
		mode: z.literal("browser-only"),
		tunnelId: z.null(),
		runtimeKeyConfigured: z.literal(false),
	}),
	z.strictObject({
		mode: z.literal("full"),
		tunnelId: z.string().regex(CHATGPT_WEB_TUNNEL_ID_PATTERN),
		runtimeKeyConfigured: z.literal(true),
	}),
]);

const ProcessIdentitySchema = z.strictObject({
	pid: z.number().int().positive().safe(),
	processStartIdentity: z.string().min(1),
});

const OwnershipSchema = z.strictObject({
	version: z.literal(1),
	ownerNonce: z.string().min(32),
	process: ProcessIdentitySchema,
	profileGeneration: z.string().min(32),
});

const ExecutableIdentitySchema = z.strictObject({
	identity: z.string().min(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/u),
	version: z.string().min(1),
});

const VerificationMarkerSchema = z.strictObject({
	version: z.literal(1),
	authenticated: z.literal(true),
	verifiedAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
	proAvailable: z.boolean(),
	profileGeneration: z.string().min(32),
	profileIdentity: z.string().min(1),
	executable: ExecutableIdentitySchema,
	ownerFence: z.string().min(32),
});

export function parseChatGptWebRuntimeConfig(value: unknown): ChatGptWebRuntimeConfig {
	return RuntimeConfigSchema.parse(value);
}

export function parseChatGptWebOwnership(value: unknown): ChatGptWebOwnershipRecord {
	return OwnershipSchema.parse(value);
}

export function parseChatGptWebVerificationMarker(value: unknown): ChatGptWebVerificationMarker {
	return VerificationMarkerSchema.parse(value);
}

async function proposedOwnership(host: SecureConfigHost): Promise<ChatGptWebOwnershipRecord> {
	return createChatGptWebOwnership(await host.currentProcessIdentity());
}

export async function openChatGptWebState(options: {
	readonly agentDir?: string;
	readonly mode: "read" | "mutate";
	readonly host?: SecureConfigHost;
}): Promise<{ paths: ChatGptWebPaths; session: SecureStateSession }> {
	const host = options.host ?? getChatGptWebSecureConfigHost();
	if (!host.available) throw new NativeSecurityUnavailableError();
	const paths = resolveChatGptWebPaths(options.agentDir);
	const session = await host.openState(paths, {
		mode: options.mode,
		...(options.mode === "mutate" ? { proposedOwnership: await proposedOwnership(host) } : {}),
	});
	try {
		parseChatGptWebOwnership(session.ownership);
		if (session.mode !== options.mode || session.ownerFence !== session.ownership.ownerNonce) {
			throw new Error("Secure state ownership changed");
		}
		await session.assertCurrent(session.profile);
		return { paths, session };
	} catch (error) {
		await session.close();
		throw error;
	}
}

export async function readChatGptWebConfig(
	options: { readonly agentDir?: string; readonly host?: SecureConfigHost } = {},
): Promise<ChatGptWebRuntimeConfig | null> {
	let session: SecureStateSession;
	try {
		({ session } = await openChatGptWebState({ ...options, mode: "read" }));
	} catch (error) {
		if (
			error instanceof Error &&
			(/^native-open-error-[23]:/u.test(error.message) ||
				error.message === "ChatGPT Web secure-state ownership is absent" ||
				error.message === "ChatGPT Web browser profile is absent")
		) {
			return null;
		}
		throw error;
	}
	try {
		const stored = await session.read("config.json");
		if (!stored) return null;
		await session.assertCurrent(stored.entry);
		return parseChatGptWebRuntimeConfig(decodeJson(stored.bytes));
	} finally {
		await session.close();
	}
}
