/**
 * Procedure-catalog metadata for Auto-Learn managed skills.
 *
 * A managed `SKILL.md` is the single source of truth for a procedure BODY. This
 * module owns the small, bounded descriptor that makes a procedure *findable*:
 * the `ompManaged` frontmatter block persisted next to `name`/`description`, and
 * the row/query/outcome shapes the SQLite descriptor cache and the ranker share.
 *
 * Everything here is deliberately deterministic and offline — no embeddings, no
 * model calls — so a local model gets the same recall behavior as a hosted one.
 *
 * Trust boundary: every string field can originate from model output that is
 * persisted and later re-rendered into a prompt, so all of it passes through
 * {@link normalizeMetadataTerm} (control/format chars, angle brackets, and
 * fence delimiters stripped; collapsed to one bounded line).
 */
import { sanitizeManagedDescription } from "./managed-skills";

/** Frontmatter key holding the catalog descriptor inside a managed SKILL.md. */
export const MANAGED_PROCEDURE_FRONTMATTER_KEY = "ompManaged";

/** Current `ompManaged` block version. Bump only for incompatible field changes. */
export const MANAGED_PROCEDURE_SCHEMA_VERSION = 1;

/** Max entries retained per match list; keeps descriptors and FTS rows bounded. */
export const MAX_MATCH_TERMS = 16;

/** Max characters per normalized match term. */
export const MAX_MATCH_TERM_LENGTH = 80;

/**
 * How broadly a procedure applies. Both values remain globally searchable —
 * `project-tagged` only adds same-project ranking affinity, never isolation.
 */
export type ManagedProcedureScope = "global" | "project-tagged";

/** Persisted `ompManaged` frontmatter block. */
export interface ManagedProcedureMetadata {
	schemaVersion: typeof MANAGED_PROCEDURE_SCHEMA_VERSION;
	scope: ManagedProcedureScope;
	/** Collision-resistant project key from `resolveProjectIdentity`; only for `project-tagged`. */
	projectKey?: string;
	/** Human-readable project label; display only, never a match key. */
	projectLabel?: string;
	/** Failure families this procedure addresses (`bash`, `mcp:playwright`, …). */
	toolFamilies: string[];
	/** `process.platform` values this procedure was verified on. */
	platforms: string[];
	/** Symptom/intent phrases that should recall this procedure. */
	triggers: string[];
}

/** Caller-supplied metadata for a create/update; every field is optional. */
export interface ManagedProcedureMetadataInput {
	scope?: ManagedProcedureScope;
	projectKey?: string;
	projectLabel?: string;
	toolFamilies?: readonly string[];
	platforms?: readonly string[];
	triggers?: readonly string[];
}

/**
 * Normalize one match term: reuse the description sanitizer (which strips
 * control/format chars, angle brackets, and fence delimiters and collapses to a
 * single line), lowercase for case-insensitive dedup, then bound the length.
 */
export function normalizeMetadataTerm(raw: string): string {
	const sanitized = sanitizeManagedDescription(raw).toLowerCase();
	return sanitized.length > MAX_MATCH_TERM_LENGTH ? sanitized.slice(0, MAX_MATCH_TERM_LENGTH).trim() : sanitized;
}

/** Normalize, drop empties, dedup case-insensitively, and cap a match list. */
export function normalizeMetadataTerms(raw: readonly string[] | undefined): string[] {
	if (!raw) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const term = normalizeMetadataTerm(entry);
		if (!term || seen.has(term)) continue;
		seen.add(term);
		out.push(term);
		if (out.length >= MAX_MATCH_TERMS) break;
	}
	return out;
}

/**
 * Build the persisted metadata block for a write.
 *
 * `previous` is the block already on disk (undefined for a create, or for a
 * legacy managed skill with no block). Fields the caller omits are inherited
 * from `previous` so an update that only rewrites the body cannot silently
 * erase the catalog keys that make the procedure findable.
 */
export function buildManagedProcedureMetadata(
	input: ManagedProcedureMetadataInput | undefined,
	previous?: ManagedProcedureMetadata,
): ManagedProcedureMetadata {
	const scope = input?.scope ?? previous?.scope ?? "global";
	const projectKey = input?.projectKey ?? previous?.projectKey;
	const projectLabel = input?.projectLabel ?? previous?.projectLabel;
	const metadata: ManagedProcedureMetadata = {
		schemaVersion: MANAGED_PROCEDURE_SCHEMA_VERSION,
		scope,
		toolFamilies: normalizeMetadataTerms(input?.toolFamilies ?? previous?.toolFamilies),
		platforms: normalizeMetadataTerms(input?.platforms ?? previous?.platforms),
		triggers: normalizeMetadataTerms(input?.triggers ?? previous?.triggers),
	};
	// A global procedure carries no project affinity: keep the row clean rather
	// than persisting a key the ranker must then remember to ignore.
	if (scope === "project-tagged") {
		const key = projectKey ? normalizeMetadataTerm(projectKey) : "";
		if (key) metadata.projectKey = key;
		const label = projectLabel ? normalizeMetadataTerm(projectLabel) : "";
		if (label) metadata.projectLabel = label;
	}
	return metadata;
}

/**
 * Parse an `ompManaged` block read back from frontmatter.
 *
 * Returns null for anything unrecognized (absent block, wrong shape, unknown
 * `schemaVersion`); callers treat those managed skills as global legacy
 * procedures and derive searchable terms from name + description instead.
 */
export function parseManagedProcedureMetadata(raw: unknown): ManagedProcedureMetadata | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	if (record.schemaVersion !== MANAGED_PROCEDURE_SCHEMA_VERSION) return null;
	const scope: ManagedProcedureScope = record.scope === "project-tagged" ? "project-tagged" : "global";
	const stringList = (value: unknown): string[] | undefined =>
		Array.isArray(value)
			? normalizeMetadataTerms(value.filter((item): item is string => typeof item === "string"))
			: undefined;
	return buildManagedProcedureMetadata({
		scope,
		projectKey: typeof record.projectKey === "string" ? record.projectKey : undefined,
		projectLabel: typeof record.projectLabel === "string" ? record.projectLabel : undefined,
		toolFamilies: stringList(record.toolFamilies),
		platforms: stringList(record.platforms),
		triggers: stringList(record.triggers),
	});
}

/**
 * One catalog descriptor: everything needed to rank a procedure and to render
 * its recall card. Never holds a procedure body, raw tool arguments, raw tool
 * output, or transcript text — the body stays behind `skill://<name>`.
 */
export interface ProcedureDescriptor {
	name: string;
	description: string;
	scope: ManagedProcedureScope;
	projectKey?: string;
	projectLabel?: string;
	toolFamilies: string[];
	platforms: string[];
	triggers: string[];
}

/** A descriptor plus its persisted recall outcome history. */
export interface ProcedureDescriptorRow extends ProcedureDescriptor {
	/** Times a recalled read was followed by same-family recovery. */
	successCount: number;
	/** Times a recalled read was NOT followed by same-family recovery. */
	missCount: number;
	/** Unix seconds of the last recall, or null when never recalled. */
	lastRecalledAt: number | null;
	/** Unix seconds of the last descriptor write. */
	updatedAt: number;
}

/** Deterministic catalog query built from a failure episode or a manual focus. */
export interface ProcedureSearchQuery {
	/** Exact failure family (`bash`, `mcp:<server>`); drives the eligibility gate. */
	toolFamily?: string;
	/** Current `process.platform`. */
	platform?: string;
	/** Current project key; only boosts when the candidate is `project-tagged`. */
	projectKey?: string;
	/** Lowercased symptom/intent tokens from error summaries, tool intents, or user focus. */
	tokens: readonly string[];
}

/** One ranked, eligible candidate. */
export interface ProcedureMatch {
	descriptor: ProcedureDescriptorRow;
	/** Higher is better; comparable only within one search. */
	score: number;
}

/** Outcome recorded for a procedure whose body was actually read. */
export type ProcedureOutcome = "success" | "miss";

/** Hard cap on candidates pulled from the catalog per episode. */
export const MAX_PROCEDURE_CANDIDATES = 8;

/** Cards emitted in `suggest` mode. `require` mode always selects exactly one. */
export const MAX_SUGGESTED_PROCEDURES = 3;

/**
 * Tokens too generic to prove topical overlap on their own.
 *
 * The eligibility gate requires a NON-generic symptom overlap, otherwise any
 * failing `bash` call would match every `bash` procedure ever recorded through
 * shared filler like "error", "failed", or "command".
 */
const GENERIC_TOKENS: Record<string, true> = {
	and: true,
	argument: true,
	arguments: true,
	bad: true,
	call: true,
	cannot: true,
	command: true,
	could: true,
	error: true,
	exit: true,
	fail: true,
	failed: true,
	failure: true,
	file: true,
	for: true,
	found: true,
	from: true,
	invalid: true,
	missing: true,
	not: true,
	path: true,
	result: true,
	run: true,
	the: true,
	tool: true,
	unable: true,
	unexpected: true,
	with: true,
};

/** Whether a token is specific enough to prove symptom overlap. */
export function isSpecificToken(token: string): boolean {
	return token.length > 2 && GENERIC_TOKENS[token] !== true;
}

/**
 * Split text into lowercased alphanumeric tokens, mirroring FTS5's `unicode61`
 * tokenizer so query tokens align with how descriptors were indexed.
 */
export function tokenizeProcedureText(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(token => token.length > 0);
}

/** Minimum name/description/trigger overlaps that make a non-family match eligible. */
const MIN_LEXICAL_OVERLAPS = 3;

/** Weight of an exact failure-family match. */
const FAMILY_BOOST = 3;
/** Weight of an exact platform match. */
const PLATFORM_BOOST = 1;
/** Weight of same-project affinity on a `project-tagged` candidate. */
const PROJECT_BOOST = 1;
/** Weight of the smoothed historical success ratio. */
const OUTCOME_WEIGHT = 2;
/** Weight of each specific symptom-token overlap. */
const TOKEN_WEIGHT = 0.5;
/** Weight of the lexical rank supplied by the storage layer (already normalized to 0..1). */
const LEXICAL_WEIGHT = 1.5;

/** All searchable terms of a descriptor, tokenized. */
function descriptorTokens(descriptor: ProcedureDescriptor): Set<string> {
	const tokens = new Set<string>();
	for (const token of tokenizeProcedureText(descriptor.name)) tokens.add(token);
	for (const token of tokenizeProcedureText(descriptor.description)) tokens.add(token);
	for (const trigger of descriptor.triggers) {
		for (const token of tokenizeProcedureText(trigger)) tokens.add(token);
	}
	return tokens;
}

/**
 * Smoothed success ratio, so a single lucky hit does not outrank a procedure
 * with a long good record and an unproven procedure is not treated as bad.
 */
export function procedureSuccessRatio(row: Pick<ProcedureDescriptorRow, "successCount" | "missCount">): number {
	return (row.successCount + 1) / (row.successCount + row.missCount + 2);
}

/**
 * Rank candidates and drop ineligible ones.
 *
 * Eligibility (either branch), counting only NON-GENERIC overlaps:
 *   - exact `toolFamily` match AND at least one specific symptom-token overlap, or
 *   - at least {@link MIN_LEXICAL_OVERLAPS} specific name/description/trigger overlaps.
 *
 * Both branches ignore generic tokens. Counting raw overlaps in the second branch
 * would let three shared filler words ("error", "failed", "command") — present in
 * almost every procedure description — admit an unrelated procedure, which is
 * exactly the noise the gate exists to stop.
 *
 * Project affinity and historical outcome only REORDER eligible matches; they
 * can never promote an unrelated procedure, which is what keeps a cross-project
 * recall useful without making it noisy.
 *
 * `lexicalRank` is the storage layer's relevance for that row, already
 * normalized to 0..1 (1 = best). Rows without one contribute nothing.
 */
export function rankProcedureCandidates(
	candidates: readonly ProcedureDescriptorRow[],
	query: ProcedureSearchQuery,
	lexicalRank?: ReadonlyMap<string, number>,
): ProcedureMatch[] {
	const queryTokens = new Set(query.tokens);
	const matches: ProcedureMatch[] = [];
	// Persisted terms are case-folded by `normalizeMetadataTerm`, but the tracker
	// keys a family on the RAW MCP server name (`mcp:MyServer`) so its identity
	// stays faithful to the server. Fold only the comparison side; changing either
	// stored casing or the tracker key would break the other consumer.
	const family = query.toolFamily?.toLowerCase();
	const platform = query.platform?.toLowerCase();
	const projectKey = query.projectKey?.toLowerCase();

	for (const descriptor of candidates) {
		const terms = descriptorTokens(descriptor);
		let specificOverlaps = 0;
		for (const token of queryTokens) {
			if (!terms.has(token) || !isSpecificToken(token)) continue;
			specificOverlaps++;
		}
		const familyMatch = family !== undefined && descriptor.toolFamilies.includes(family);
		// Family-only with no specific overlap would recall every procedure ever
		// recorded for that tool; lexical-only needs enough SPECIFIC hits that it is
		// not just shared filler.
		const eligible = (familyMatch && specificOverlaps > 0) || specificOverlaps >= MIN_LEXICAL_OVERLAPS;
		if (!eligible) continue;

		let score = specificOverlaps * TOKEN_WEIGHT + LEXICAL_WEIGHT * (lexicalRank?.get(descriptor.name) ?? 0);
		if (familyMatch) score += FAMILY_BOOST;
		if (platform !== undefined && descriptor.platforms.includes(platform)) score += PLATFORM_BOOST;
		if (
			descriptor.scope === "project-tagged" &&
			projectKey !== undefined &&
			descriptor.projectKey?.toLowerCase() === projectKey
		) {
			score += PROJECT_BOOST;
		}
		score += OUTCOME_WEIGHT * procedureSuccessRatio(descriptor);
		matches.push({ descriptor, score });
	}

	// Name is the deterministic tiebreak: two procedures can legitimately score
	// identically, and an unstable order would make recall non-reproducible.
	matches.sort((a, b) => b.score - a.score || a.descriptor.name.localeCompare(b.descriptor.name));
	return matches;
}
