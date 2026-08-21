import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../config/settings";
import { computeMemoryBankScope, type MemoryBankScoping } from "../memory-backend/bank-scope";

export type MnemosyneOssOwnership = "shared" | "omp";

export interface MnemosyneOssBackendConfig {
	executable?: string;
	dataDir: string;
	baseBank: string;
	bank: string;
	globalBank: string;
	retainBank: string;
	recallBanks: readonly string[];
	sharedBanks: readonly string[];
	scoping: MemoryBankScoping;
	ownership: MnemosyneOssOwnership;
	autoRecall: boolean;
	autoRetain: boolean;
	localEmbeddings: boolean;
	embeddingModel?: string;
	localConsolidation: boolean;
	localLlmRepo?: string;
	localLlmFile?: string;
	consolidationMode: "local" | "heuristic";
	autoMigrate: boolean;
	retainEveryNTurns: number;
	recallLimit: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	injectionTokenLimit: number;
	requestTimeoutMs: number;
	sleepTimeoutMs: number;
	shutdownTimeoutMs: number;
	debug: boolean;
	diagnostic?: string;
}

const BANK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Resolve the Mnemosyne OSS settings without touching the shared store.
 *
 * Invalid paths and explicit bank names are retained as a diagnostic config so
 * the adapter can remain inert without silently selecting another backend.
 */
export function loadMnemosyneOssConfig(settings: Settings, _agentDir: string): MnemosyneOssBackendConfig {
	const scoping = settings.get("mnemosyne-oss.scoping");
	const configuredBank = settings.get("mnemosyne-oss.bank")?.trim() || undefined;
	const dataDir = resolveDataDir(settings.get("mnemosyne-oss.dataDir"), settings.getCwd());
	const localConsolidation = settings.get("mnemosyne-oss.localConsolidation");
	const scope = computeMemoryBankScope(configuredBank, settings.getCwd(), scoping);
	const diagnostic =
		configuredBank && !BANK_NAME_RE.test(configuredBank)
			? `Mnemosyne OSS bank "${configuredBank}" is invalid. Bank names must start with an alphanumeric character and contain only letters, numbers, underscores, or hyphens.`
			: dataDir.includes("\0")
				? "Mnemosyne OSS data directory contains a null byte."
				: undefined;
	const localLlmRepo = localConsolidation
		? settings.get("mnemosyne-oss.localLlmRepo")?.trim() || undefined
		: undefined;
	const localLlmFile = localConsolidation
		? settings.get("mnemosyne-oss.localLlmFile")?.trim() || undefined
		: undefined;
	return {
		executable: settings.get("mnemosyne-oss.executable")?.trim() || undefined,
		dataDir,
		baseBank: scope.baseBank,
		bank: scope.bank,
		globalBank: scope.globalBank,
		retainBank: scope.retainBank,
		recallBanks: scope.recallBanks,
		sharedBanks: scope.recallBanks.filter(bank => bank !== scope.retainBank),
		scoping,
		ownership: settings.get("mnemosyne-oss.ownership"),
		autoRecall: settings.get("mnemosyne-oss.autoRecall"),
		autoRetain: settings.get("mnemosyne-oss.autoRetain"),
		localEmbeddings: settings.get("mnemosyne-oss.localEmbeddings"),
		embeddingModel: settings.get("mnemosyne-oss.embeddingModel")?.trim() || undefined,
		localConsolidation,
		localLlmRepo,
		localLlmFile,
		consolidationMode: localConsolidation && (localLlmRepo || localLlmFile) ? "local" : "heuristic",
		autoMigrate: settings.get("mnemosyne-oss.autoMigrate"),
		retainEveryNTurns: normalizePositiveInteger(settings.get("mnemosyne-oss.retainEveryNTurns")),
		recallLimit: normalizePositiveInteger(settings.get("mnemosyne-oss.recallLimit")),
		recallContextTurns: normalizePositiveInteger(settings.get("mnemosyne-oss.recallContextTurns")),
		recallMaxQueryChars: normalizePositiveInteger(settings.get("mnemosyne-oss.recallMaxQueryChars"), 256),
		injectionTokenLimit: normalizePositiveInteger(settings.get("mnemosyne-oss.injectionTokenLimit"), 256),
		requestTimeoutMs: normalizePositiveInteger(settings.get("mnemosyne-oss.requestTimeoutMs")),
		sleepTimeoutMs: normalizePositiveInteger(settings.get("mnemosyne-oss.sleepTimeoutMs")),
		shutdownTimeoutMs: normalizePositiveInteger(settings.get("mnemosyne-oss.shutdownTimeoutMs")),
		debug: settings.get("mnemosyne-oss.debug"),
		diagnostic,
	};
}

function resolveDataDir(configured: string | undefined, cwd: string): string {
	const value =
		configured?.trim() ||
		Bun.env.MNEMOSYNE_DATA_DIR?.trim() ||
		path.join(os.homedir(), ".hermes", "mnemosyne", "data");
	const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
	return path.resolve(cwd, expanded);
}

function normalizePositiveInteger(value: number, minimum = 1): number {
	if (!Number.isFinite(value)) return minimum;
	return Math.max(minimum, Math.floor(value));
}
