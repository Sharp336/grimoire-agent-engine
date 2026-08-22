/**
 * Strip `user:pass@` userinfo from an http(s) URL before it is surfaced in
 * logs, tool output, or terminal messages, so Basic Auth credentials don't
 * leak into transcripts and CI output.
 *
 * Returns the input verbatim when it does not parse as a URL, when the scheme
 * is not http(s), or when there are no credentials to remove — callers rely on
 * that identity to detect whether anything was redacted. Only the userinfo is
 * touched; the path, query, and trailing slash are left exactly as given.
 */
export function redactUrlCredentials(url: string): string {
	if (!url.includes("://")) return url;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
	if (!parsed.username && !parsed.password) return url;
	parsed.username = "";
	parsed.password = "";
	return parsed.toString();
}
