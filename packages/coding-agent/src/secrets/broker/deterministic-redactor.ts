import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { SecretObfuscator } from "../obfuscator";

/**
 * Phase C Task C2 — deterministic redactors (learn-once-then-preempt).
 *
 * For sites that DISPLAY the new password post-rotation (HTML span, SMS
 * body, email body): the extraction pattern is encoded ONCE, validated
 * against a sample document + observed value, and persisted. From then on
 * every value matching that pattern is registered into the obfuscator
 * BEFORE the model sees the document.
 *
 * Fail-closed (R2): a pattern that extracts nothing, or a value different
 * from the observed one, is rejected — nothing is registered or persisted.
 *
 * v1 css-text scope: exactly `tag.class`, `.class`, `tag`, and `#id`
 * patterns (no combinators, no pseudo-selectors). Regex kind: exactly one
 * capture group.
 */

export interface DeterministicRedactor {
	domain: string;
	kind: "css-text" | "regex";
	pattern: string;
}

export interface LearnRedactorOptions extends DeterministicRedactor {
	sampleDocument: string;
	observedValue: string;
	obfuscator: SecretObfuscator;
	storePath: string;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Minimal css-text extraction for the v1 pattern forms. Returns the element's inner text, or undefined. */
function extractCssText(pattern: string, document: string): string | undefined {
	let tag: string | undefined;
	let klass: string | undefined;
	let id: string | undefined;
	const tagClass = /^([a-zA-Z][a-zA-Z0-9]*)\.([a-zA-Z0-9_-]+)$/.exec(pattern);
	const classOnly = /^\.([a-zA-Z0-9_-]+)$/.exec(pattern);
	const idOnly = /^#([a-zA-Z0-9_-]+)$/.exec(pattern);
	const tagOnly = /^([a-zA-Z][a-zA-Z0-9]*)$/.exec(pattern);
	if (tagClass) {
		[, tag, klass] = tagClass;
	} else if (classOnly) {
		[, klass] = classOnly;
	} else if (idOnly) {
		[, id] = idOnly;
	} else if (tagOnly) {
		[, tag] = tagOnly;
	} else {
		return undefined;
	}
	const tagPattern = tag ?? "[a-zA-Z][a-zA-Z0-9]*";
	let attrPattern = "";
	if (klass) attrPattern = `[^>]*class="[^"]*\\b${escapeRegExp(klass)}\\b[^"]*"`;
	if (id) attrPattern = `[^>]*id="${escapeRegExp(id)}"`;
	const re = new RegExp(`<${tagPattern}${attrPattern}[^>]*>([^<]*)</${tagPattern}>`, "i");
	const match = re.exec(document);
	return match?.[1]?.trim();
}

function countCaptureGroups(pattern: string): number {
	let count = 0;
	for (let i = 0; i < pattern.length; i++) {
		if (pattern[i] === "\\") {
			i++;
			continue;
		}
		if (pattern[i] === "(" && pattern[i + 1] !== "?") count++;
	}
	return count;
}

/** Extract the redactor's value from a document. Undefined when no match. */
export function extractValue(redactor: DeterministicRedactor, document: string): string | undefined {
	if (redactor.kind === "css-text") {
		return extractCssText(redactor.pattern, document);
	}
	const re = new RegExp(redactor.pattern);
	const match = re.exec(document);
	return match?.[1];
}

/**
 * Validate the pattern against a sample document + observed value, register
 * the value into the obfuscator, and persist the redactor. Idempotent per
 * (domain, kind, pattern).
 */
export function learnRedactor(opts: LearnRedactorOptions): { ok: boolean; reason?: string } {
	if (opts.kind === "regex" && countCaptureGroups(opts.pattern) !== 1) {
		return { ok: false, reason: "regex kind requires exactly one capture group" };
	}
	if (opts.kind === "regex") {
		try {
			new RegExp(opts.pattern);
		} catch {
			return { ok: false, reason: "invalid regex pattern" };
		}
	}
	const extracted = extractValue(opts, opts.sampleDocument);
	if (extracted === undefined) {
		return { ok: false, reason: "pattern extracts nothing from the sample document" };
	}
	if (extracted !== opts.observedValue) {
		return { ok: false, reason: `pattern extracts "${extracted}", not the observed value` };
	}
	opts.obfuscator.addSecret({
		type: "plain",
		content: opts.observedValue,
		friendlyName: opts.domain,
		source: "deterministic-redactor",
	});
	const redactors = loadRedactors(opts.storePath);
	if (!redactors.some(r => r.domain === opts.domain && r.kind === opts.kind && r.pattern === opts.pattern)) {
		redactors.push({ domain: opts.domain, kind: opts.kind, pattern: opts.pattern });
		writeFileSync(opts.storePath, JSON.stringify(redactors, null, 2), { mode: 0o600 });
	}
	return { ok: true };
}

/** Load persisted redactors. Missing file → empty list. */
export function loadRedactors(storePath: string): DeterministicRedactor[] {
	if (!existsSync(storePath)) return [];
	try {
		const parsed = JSON.parse(readFileSync(storePath, "utf8")) as unknown;
		return Array.isArray(parsed) ? (parsed as DeterministicRedactor[]) : [];
	} catch {
		return [];
	}
}

/**
 * Apply all redactors for a domain: extract each value, register it into
 * the obfuscator, and return the document with known values obfuscated.
 * Documents for domains without redactors pass through unchanged.
 */
export function applyRedactors(
	domain: string,
	documentText: string,
	obfuscator: SecretObfuscator,
	redactors: DeterministicRedactor[],
): string {
	const matching = redactors.filter(r => r.domain === domain);
	if (matching.length === 0) return documentText;
	for (const redactor of matching) {
		const value = extractValue(redactor, documentText);
		if (value !== undefined && value.length > 0) {
			obfuscator.addSecret({ type: "plain", content: value, source: "deterministic-redactor" });
		}
	}
	return obfuscator.obfuscate(documentText);
}
