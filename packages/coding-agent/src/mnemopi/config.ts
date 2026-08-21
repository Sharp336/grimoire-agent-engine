import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MnemopiOptions } from "@oh-my-pi/pi-mnemopi";
import { getMemoriesDir, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { computeMemoryBankScope, type MemoryBankScoping } from "../memory-backend/bank-scope";

export type MnemopiLlmMode = "none" | "smol" | "remote";

export type MnemopiScoping = MemoryBankScoping;

export type MnemopiProviderOptions = Pick<
	MnemopiOptions,
	"noEmbeddings" | "embeddingModel" | "embeddingApiUrl" | "embeddingApiKey" | "llm" | "debug"
>;

export interface MnemopiBackendConfig {
	dbPath: string;
	baseBank?: string;
	bank: string;
	globalBank?: string;
	retainBank?: string;
	recallBanks?: readonly string[];
	scoping?: MnemopiScoping;
	autoRecall: boolean;
	autoRetain: boolean;
	polyphonicRecall: boolean;
	enhancedRecall: boolean;
	proactiveLinking: boolean;
	retainEveryNTurns: number;
	recallLimit: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	injectionTokenLimit: number;
	debug: boolean;
	providerOptions: MnemopiProviderOptions;
	llmMode: MnemopiLlmMode;
	llmBaseUrl?: string;
	llmApiKey?: string;
	llmModel?: string;
}

export function loadMnemopiConfig(settings: Settings, agentDir: string): MnemopiBackendConfig {
	const configuredDbPath = settings.get("mnemopi.dbPath");
	const cwd = settings.getCwd();
	const scoping = settings.get("mnemopi.scoping");
	const dbPath = configuredDbPath ?? path.join(getMemoriesDir(agentDir), "mnemopi", "mnemopi.db");
	const scope = computeMemoryBankScope(settings.get("mnemopi.bank"), cwd, scoping);
	const recallBanks =
		scoping === "global" ? scope.recallBanks : extendRecallWithLegacyBanks(scope.recallBanks, dbPath, cwd);
	const llmMode = settings.get("mnemopi.llmMode");
	const embeddingOverride = settings.get("mnemopi.embeddingModel");
	const embeddingVariant = settings.get("mnemopi.embeddingVariant");
	// Map the variant explicitly rather than indexing an object with the raw config
	// value (which could resolve an inherited property like `__proto__`); any value
	// other than the multilingual variant falls back to the English default.
	const variantModel =
		embeddingVariant === "multilingual" ? "intfloat/multilingual-e5-large" : "BAAI/bge-base-en-v1.5";
	// Precedence: explicit `mnemopi.embeddingModel` setting > `MNEMOPI_EMBEDDING_MODEL`
	// env (documented model-level override) > variant-derived default. Without the env
	// term a variant default would silently shadow a user's configured env model.
	const embeddingModel = embeddingOverride?.trim() || Bun.env.MNEMOPI_EMBEDDING_MODEL?.trim() || variantModel;
	return {
		dbPath,
		baseBank: scope.baseBank,
		bank: scope.bank,
		globalBank: scope.globalBank,
		retainBank: scope.retainBank,
		recallBanks,
		scoping,
		autoRecall: settings.get("mnemopi.autoRecall"),
		autoRetain: settings.get("mnemopi.autoRetain"),
		polyphonicRecall: settings.get("mnemopi.polyphonicRecall"),
		enhancedRecall: settings.get("mnemopi.enhancedRecall"),
		proactiveLinking: settings.get("mnemopi.proactiveLinking"),
		retainEveryNTurns: Math.max(1, Math.floor(settings.get("mnemopi.retainEveryNTurns"))),
		recallLimit: Math.max(1, Math.floor(settings.get("mnemopi.recallLimit"))),
		recallContextTurns: Math.max(1, Math.floor(settings.get("mnemopi.recallContextTurns"))),
		recallMaxQueryChars: Math.max(256, Math.floor(settings.get("mnemopi.recallMaxQueryChars"))),
		injectionTokenLimit: Math.max(256, Math.floor(settings.get("mnemopi.injectionTokenLimit"))),
		debug: settings.get("mnemopi.debug"),
		providerOptions: {
			noEmbeddings: settings.get("mnemopi.noEmbeddings"),
			debug: settings.get("mnemopi.debug"),
			embeddingModel,
			embeddingApiUrl: settings.get("mnemopi.embeddingApiUrl"),
			embeddingApiKey: settings.get("mnemopi.embeddingApiKey"),
			llm:
				llmMode === "remote"
					? {
							baseUrl: settings.get("mnemopi.llmBaseUrl"),
							apiKey: settings.get("mnemopi.llmApiKey"),
							model: settings.get("mnemopi.llmModel"),
						}
					: false,
		},
		llmMode,
		llmBaseUrl: settings.get("mnemopi.llmBaseUrl"),
		llmApiKey: settings.get("mnemopi.llmApiKey"),
		llmModel: settings.get("mnemopi.llmModel"),
	};
}

// Cap legacy-bank scanning at session start so a pathological banks/
// directory cannot dominate startup latency.
const LEGACY_BANK_SCAN_LIMIT = 64;

/**
 * Discover sibling banks under `<dbDir>/banks/` whose `working_memory` rows
 * all carry the active `cwd` in `metadata_json.$.cwd`, and add those safe
 * single-cwd banks to the recall set. This rescues memories stranded by a
 * previous, less-stable bank derivation (#2412) without recalling mixed-cwd
 * legacy banks wholesale under per-project isolation.
 *
 * Robust by design: a missing banks directory, unreadable bank dir, or
 * corrupt SQLite file is silently skipped. Scanning is capped at
 * {@link LEGACY_BANK_SCAN_LIMIT} to bound startup cost.
 */
export function extendRecallWithLegacyBanks(
	resolved: readonly string[],
	dbPath: string,
	cwd: string,
): readonly string[] {
	const banksDir = path.join(path.dirname(dbPath), "banks");
	const cwdAbs = path.resolve(cwd || ".");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(banksDir, { withFileTypes: true });
	} catch {
		return resolved;
	}
	const have = new Set(resolved);
	const extras: string[] = [];
	let scanned = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || have.has(entry.name)) continue;
		if (scanned >= LEGACY_BANK_SCAN_LIMIT) break;
		scanned++;
		const candidate = path.join(banksDir, entry.name, "mnemopi.db");
		if (bankOnlyHasCwd(candidate, cwdAbs)) extras.push(entry.name);
	}
	return extras.length === 0 ? resolved : [...resolved, ...extras];
}

function bankOnlyHasCwd(dbPath: string, cwd: string): boolean {
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		const row = db
			.prepare<{ matching: number; unsafe: number }, [string, string]>(`
				SELECT
					SUM(CASE WHEN json_extract(metadata_json, '$.cwd') = ? THEN 1 ELSE 0 END) AS matching,
					SUM(CASE WHEN json_extract(metadata_json, '$.cwd') IS NULL OR json_extract(metadata_json, '$.cwd') <> ? THEN 1 ELSE 0 END) AS unsafe
				FROM working_memory
			`)
			.get(cwd, cwd);
		return (row?.matching ?? 0) > 0 && (row?.unsafe ?? 0) === 0;
	} catch (error) {
		logger.debug("Mnemopi: legacy bank probe failed", { dbPath, error: String(error) });
		return false;
	} finally {
		try {
			db?.close();
		} catch {
			// nothing to do — read-only handle.
		}
	}
}

export function truncateApproxTokens(text: string, tokenLimit: number): string {
	const maxChars = Math.max(0, tokenLimit * 4);
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
