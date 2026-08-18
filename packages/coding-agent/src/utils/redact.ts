/**
 * Shared secret redaction for text that leaves the live session and gets
 * persisted or re-fed to a model: consolidated memories, `learned.md` lines,
 * generated managed-skill bodies, and bounded failure evidence.
 *
 * Deliberately pattern-based and conservative — it cannot recognise arbitrary
 * high-entropy strings, so it targets the shapes that actually leak (prefixed
 * provider tokens, JWTs, AWS access-key ids, `key=`-style assignments).
 */

const SECRET_PATTERNS: readonly RegExp[] = [
	/(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}/g,
	// JWT-shaped triple. The boundary guards are load-bearing for PERFORMANCE, not
	// just precision: without them a long unbroken run of word characters (e.g. a
	// 64 KB generated body) makes the engine retry the `{16,}` segments from every
	// offset, which is quadratic — 8 KB already costs ~85ms, 64 KB several seconds.
	// Anchoring to token boundaries lets a failed attempt skip the whole run.
	/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
	/(?:AKIA|ASIA)[A-Z0-9]{16}/g,
	// Common provider token prefixes (GitHub, npm, Slack, Google).
	/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	/github_pat_[A-Za-z0-9_]{20,}/g,
	/npm_[A-Za-z0-9]{30,}/g,
	/xox[baprs]-[A-Za-z0-9-]{10,}/g,
	/AIza[A-Za-z0-9_-]{30,}/g,
];

/** Replace credential-shaped substrings with `[REDACTED]`. */
export function redactSecrets(input: string): string {
	let out = input;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}
