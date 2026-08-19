/**
 * Dead-route detection for worker routing: a model that 404s or is reported
 * as not found / invalid / deprecated is suppressed for the remainder of the
 * orchestration run so siblings don't immediately retry the same dead route.
 * Bounded (max 20 selectors) and session-scoped (per TaskTool instance).
 */

export const DEAD_MODEL_PATTERN =
	/not[_\s-]found|invalid[_\s-]model|model[_\s-]is[_\s-]not[_\s-]valid|no longer supported|deprecated|decommissioned|\b404\b/i;

/** Stricter check for full child transcript scans: requires model context to avoid matching system-prompt boilerplate. */
export const DEAD_MODEL_FILE_PATTERN =
	/models\/[a-z0-9._-]+\s+is not found|\b404\b.*model|model.*\b404\b|is not supported for generateContent/i;

export function isDeadModelMessage(text: string): boolean {
	return DEAD_MODEL_PATTERN.test(text);
}

export function isDeadModelFileMessage(text: string): boolean {
	return DEAD_MODEL_FILE_PATTERN.test(text);
}

/** Extract a provider-qualified selector like `google/gemini-1.5-flash` from an error string, if present. */
export function extractSelectorFromDeadMessage(text: string): string | undefined {
	// e.g. "models/gemini-1.5-flash is not found" or "google/gemini-1.5-flash"
	const m1 = text.match(/models\/([a-z0-9._-]+)/i);
	if (m1?.[1]) {
		const bare = m1[1];
		if (bare.endsWith(".ts") || bare.endsWith(".js") || bare === "stats") return undefined;
		const m2 = text.match(/([a-z0-9-]+)\/([a-z0-9._-]+)\s+is not found/i);
		if (m2?.[1] && m2[2] && !m2[2].endsWith(".ts") && m2[1].toLowerCase() !== "models")
			return `${m2[1].toLowerCase()}/${m2[2]}`;
		if (!bare.includes("-") && !bare.includes(".")) return undefined;
		return bare;
	}
	const m3 = text.match(/([a-z0-9-]+)\/([a-z0-9._-]+)(?:\s|:).*not found/i);
	if (m3?.[1] && m3[2] && !m3[2].endsWith(".ts") && m3[1].toLowerCase() !== "models")
		return `${m3[1].toLowerCase()}/${m3[2]}`;
	return undefined;
}
