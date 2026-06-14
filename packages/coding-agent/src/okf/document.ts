/**
 * Open Knowledge Format (OKF) v0.1 document model.
 *
 * Pure parse/serialize/conformance for a single OKF concept document — a
 * markdown file with YAML frontmatter. No I/O. Everything here is a pure
 * function over strings so it is trivial to unit-test.
 *
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 *
 * A concept document has two parts:
 *   1. A YAML frontmatter block delimited by `---` at the top of the file.
 *   2. A markdown body after the frontmatter.
 *
 * Frontmatter requirements (§4.1, §9):
 *   - `type` is REQUIRED (a short string identifying the kind of concept).
 *   - Recommended (priority order): `title`, `description`, `resource`,
 *     `tags`, `timestamp`.
 *   - Any additional keys are allowed; consumers preserve unknown keys.
 *
 * We use `bun`'s `YAML` directly (not `@oh-my-pi/pi-utils` `parseFrontmatter`)
 * to preserve exact frontmatter key casing — OKF producers may use arbitrary
 * extension keys (e.g. `okf_version`) that must survive a round-trip.
 */

import { YAML } from "bun";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed frontmatter for an OKF concept. `type` is required per spec §9;
 * the rest are recommended (§4.1). Unknown extension keys are preserved via
 * the index signature.
 */
export interface OkfFrontmatter {
	/** Short string identifying the kind of concept (REQUIRED). */
	type: string;
	/** Human-readable display name. */
	title?: string;
	/** Single-sentence tag-based summary used for listings/search/previews. */
	description?: string;
	/** URI uniquely identifying the underlying asset, if any. */
	resource?: string;
	/** Cross-cutting categorization tags. */
	tags?: string[];
	/** ISO 8601 datetime of last meaningful change. */
	timestamp?: string;
	// Producer-defined extension keys.
	[key: string]: unknown;
}

/** A parsed OKF concept document (frontmatter + markdown body). */
export interface OkfDocument {
	frontmatter: OkfFrontmatter;
	body: string;
}

/** An OKF concept with its identity (the bundle-relative path without `.md`). */
export interface OkfConcept extends OkfDocument {
	/** Concept ID = file path within the bundle with the `.md` suffix removed. */
	id: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Frontmatter delimiter line (spec §4.1). */
const FRONTMATTER_DELIM = "---";

/**
 * Reserved filenames that MUST NOT be used for concept documents (spec §3.1).
 * These have defined meaning at any level of the bundle hierarchy.
 */
export const RESERVED_FILENAMES: ReadonlySet<string> = new Set(["index.md", "log.md"]);

/**
 * Required frontmatter key (spec §4.1, §9).
 */
export const REQUIRED_FRONTMATTER_KEY = "type" as const;

/**
 * Recommended frontmatter keys in priority order (spec §4.1). Serialisation
 * emits keys in this order, then extras alphabetically, so re-serialising the
 * same document is deterministic.
 */
export const RECOMMENDED_FRONTMATTER_KEYS = ["type", "title", "description", "resource", "tags", "timestamp"] as const;

/**
 * Default `type` assigned when a concept is missing one during conformance
 * normalisation. The spec (§4.1) says consumers MUST tolerate unknown types;
 * `"Reference"` is a descriptive, self-explanatory fallback.
 */
export const DEFAULT_CONCEPT_TYPE = "Reference";

/** Maximum characters for a derived `description` (keeps listings/previews compact). */
const MAX_DESCRIPTION_CHARS = 512;

/** Maximum tags in a derived `description`. */
const MAX_DESCRIPTION_TAGS = 32;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/** Raised when frontmatter cannot be parsed or the document is malformed. */
export class OkfDocumentError extends Error {
	constructor(
		message: string,
		readonly source?: string,
	) {
		super(source ? `OKF (${source}): ${message}` : `OKF: ${message}`);
		this.name = "OkfDocumentError";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an OKF concept document from raw markdown text.
 *
 * If the text has no frontmatter block, an empty `OkfFrontmatter` is returned
 * and the entire input becomes the body (callers can then `conform()` to add
 * the required `type`).
 *
 * Key casing is preserved — the raw YAML keys are kept exactly as written.
 *
 * @throws {@link OkfDocumentError} if the frontmatter YAML is invalid.
 */
export function parse(text: string, source?: string): OkfDocument {
	const normalized = text.replace(/\r\n?/g, "\n");

	// A frontmatter block starts with `---` on its own line and ends with a
	// closing `---` on its own line (spec §4.1).
	if (!normalized.startsWith(`${FRONTMATTER_DELIM}\n`)) {
		return { frontmatter: {} as OkfFrontmatter, body: normalized.trim() };
	}

	const endIdx = normalized.indexOf(`\n${FRONTMATTER_DELIM}`, FRONTMATTER_DELIM.length);
	if (endIdx === -1) {
		throw new OkfDocumentError("Unterminated YAML frontmatter block", source);
	}

	const fmText = normalized.slice(FRONTMATTER_DELIM.length + 1, endIdx);
	const body = normalized
		.slice(endIdx + FRONTMATTER_DELIM.length + 1)
		.replace(/^\n/, "")
		.trim();

	let loaded: Record<string, unknown>;
	try {
		// Replace tabs with spaces before YAML parsing (tabs are invalid in YAML).
		loaded = (YAML.parse(fmText.replaceAll("\t", "  ")) as Record<string, unknown> | null) ?? {};
	} catch (error) {
		throw new OkfDocumentError(
			`Invalid YAML in frontmatter: ${error instanceof Error ? error.message : String(error)}`,
			source,
		);
	}

	if (typeof loaded !== "object" || Array.isArray(loaded)) {
		throw new OkfDocumentError("Frontmatter must be a YAML mapping", source);
	}

	return { frontmatter: loaded as OkfFrontmatter, body };
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialize
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialise an OKF document to deterministic markdown.
 *
 * Frontmatter keys are ordered: required + recommended keys first (in spec
 * priority order), then extension keys alphabetically. The body follows after
 * a blank line. Output always ends with a trailing newline.
 */
export function serialize(doc: OkfDocument): string {
	const ordered = orderFrontmatter(doc.frontmatter);
	const fmYaml = YAML.stringify(ordered).trim();
	const body = doc.body.trim();
	return body.length > 0
		? `${FRONTMATTER_DELIM}\n${fmYaml}\n${FRONTMATTER_DELIM}\n\n${body}\n`
		: `${FRONTMATTER_DELIM}\n${fmYaml}\n${FRONTMATTER_DELIM}\n`;
}

/** Reorder frontmatter keys: recommended first (spec order), then extras alphabetical. */
function orderFrontmatter(fm: OkfFrontmatter): Record<string, unknown> {
	const ordered: Record<string, unknown> = {};
	for (const key of RECOMMENDED_FRONTMATTER_KEYS) {
		if (fm[key] !== undefined) ordered[key] = fm[key];
	}
	const extras = Object.keys(fm)
		.filter(k => !RECOMMENDED_FRONTMATTER_KEYS.includes(k as (typeof RECOMMENDED_FRONTMATTER_KEYS)[number]))
		.sort();
	for (const key of extras) {
		if (fm[key] !== undefined) ordered[key] = fm[key];
	}
	return ordered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conformance (spec §9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate that a document conforms to OKF v0.1 §9:
 * the frontmatter block contains a non-empty `type` field.
 *
 * All other constraints (missing optional fields, unknown type values, etc.)
 * are soft guidance per spec §9 and do NOT cause validation failure.
 *
 * @throws {@link OkfDocumentError} if `type` is missing or empty.
 */
export function validate(doc: OkfDocument, source?: string): void {
	const type = doc.frontmatter[REQUIRED_FRONTMATTER_KEY];
	if (typeof type !== "string" || type.trim().length === 0) {
		throw new OkfDocumentError(`Missing or empty required frontmatter key: "${REQUIRED_FRONTMATTER_KEY}"`, source);
	}
}

/** True when the document passes {@link validate} without throwing. */
export function isValid(doc: OkfDocument): boolean {
	try {
		validate(doc);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure a raw concept string conforms to OKF v0.1.
 *
 * Parses the text, ensures a non-empty `type` (defaults to
 * {@link DEFAULT_CONCEPT_TYPE}), derives a tag-based `description` if missing,
 * and re-serialises deterministically.
 *
 * @returns The (possibly re-serialised) content, whether it changed, the
 *   resolved `type`, and the resolved `description`.
 */
export function ensureConformance(
	relativePath: string,
	text: string,
): { content: string; changed: boolean; type: string; description: string } {
	const parsed = parse(text, relativePath);
	const fm = { ...parsed.frontmatter };
	let changed = false;

	// Ensure `type` (spec §9: non-empty required).
	if (typeof fm.type !== "string" || fm.type.trim().length === 0) {
		fm.type = DEFAULT_CONCEPT_TYPE;
		changed = true;
	}

	// Ensure `description` (tag-based retrieval field for listings/search).
	let description = frontmatterString(fm.description);
	if (!description || !isTagBasedDescription(description)) {
		const derived = deriveDescription(relativePath, parsed.body || frontmatterString(fm.title) || "");
		if (derived) {
			fm.description = derived;
			description = derived;
			changed = true;
		}
	}

	const doc: OkfDocument = { frontmatter: fm, body: parsed.body };
	return { content: serialize(doc), changed, type: fm.type, description: description ?? "" };
}

/** Coerce an unknown frontmatter value to a trimmed string, or `undefined`. */
function frontmatterString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Description derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Heuristically derive a tag-based `description` from a concept's path and body.
 *
 * Extracts short retrieval tags from: the category (first path segment), the
 * topic (filename), markdown headings, and key phrases from the first lines.
 * Tags are comma-separated and capped at {@link MAX_DESCRIPTION_TAGS}.
 *
 * This mirrors the OKF blog's guidance that `description` should be a dense
 * retrieval field, not a sentence — subsystem names, file names, workflow
 * names, config keys, etc.
 */
export function deriveDescription(relativePath: string, body: string): string {
	const tags: string[] = [];
	const seen = new Set<string>();

	const addTag = (candidate: string | undefined): void => {
		if (tags.length >= MAX_DESCRIPTION_TAGS || !candidate) return;
		const tag = normaliseTag(candidate);
		if (!tag) return;
		const key = tag.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		tags.push(tag);
	};

	// Category (first path segment) and topic (filename without `.md`).
	const segments = relativePath.replace(/\.md$/i, "").split("/");
	if (segments.length > 0 && segments[0]) addTag(humanise(segments[0]));
	if (segments.length > 1 && segments[segments.length - 1]) {
		addTag(humanise(segments[segments.length - 1]));
	}

	// Scan headings and first content lines for tag-like phrases.
	let inFence = false;
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("```") || line.startsWith("~~~")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		if (/^#{1,6}\s+/.test(line)) {
			addTag(stripMarkdown(line));
			continue;
		}

		for (const phrase of splitTagLine(line)) {
			addTag(phrase);
		}
		if (tags.length >= MAX_DESCRIPTION_TAGS) break;
	}

	const description = tags.length > 0 ? tags.join(", ") : humanise(segments[segments.length - 1] ?? "note");
	return trimDescription(description);
}

/**
 * Heuristic: is an existing `description` already tag-based (not a sentence)?
 * If so, leave it alone during conformance normalisation.
 */
function isTagBasedDescription(description: string): boolean {
	const trimmed = description.trim();
	if (!trimmed) return false;
	if (trimmed.includes(",")) return true;
	// Short, no punctuation, no verbs → likely a tag.
	return (
		trimmed.length <= 48 &&
		!/[.!?]$/.test(trimmed) &&
		!/\b(?:is|are|was|were|must|should|needs?|contains?|stores?|uses?|requires?|supports?)\b/i.test(trimmed)
	);
}

/** Strip markdown formatting from a line to get a clean text phrase. */
function stripMarkdown(line: string): string {
	return line
		.trim()
		.replace(/^#{1,6}\s+/, "")
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/^>\s?/, "")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[*_~`]/g, "")
		.trim();
}

/** Split a content line into candidate tag phrases. */
function splitTagLine(line: string): string[] {
	return stripMarkdown(line)
		.split(
			/\b(?:after|before|during|for|when|with|without|because|while|via|using|from|into|under|inside|outside|rather than|instead of)\b/iu,
		)
		.map(part => part.trim())
		.filter(Boolean);
}

/** Normalise a raw tag candidate: strip filler words, tidy punctuation. */
function normaliseTag(text: string): string | undefined {
	const tag = text
		.replace(/^(?:remember that|note that|run|use|keep|prefer|ensure|store|stores|record|records)\s+/i, "")
		.replace(/^[\s,.:;!?()[\]{}"'“”‘’]+|[\s,.:;!?()[\]{}"'“”‘’]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (tag.length < 2) return undefined;
	return trimDescription(tag);
}

/** Humanise a path segment / filename for use as a tag. */
function humanise(segment: string): string {
	const humanised = segment.replace(/[-_]+/g, " ").trim();
	return (humanised || segment).toLowerCase();
}

/** Trim a description to the max length, breaking on a word boundary. */
function trimDescription(text: string): string {
	const normalised = text.replace(/\s+/g, " ").trim();
	if (normalised.length <= MAX_DESCRIPTION_CHARS) return normalised;
	const breakIdx = normalised.lastIndexOf(" ", MAX_DESCRIPTION_CHARS - 1);
	const end = breakIdx >= 64 ? breakIdx : MAX_DESCRIPTION_CHARS - 1;
	return `${normalised.slice(0, end).trimEnd()}…`;
}
