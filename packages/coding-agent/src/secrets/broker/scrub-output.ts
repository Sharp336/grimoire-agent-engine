/**
 * Tier-2 Secret Broker — output scrubbing.
 *
 * Replace known secret values in subprocess stdout/stderr with `[REDACTED]` before
 * returning anything to the agent. The broker knows which values it resolved; it
 * scrubs those exact values (plus their base64 and URL-encoded variants, which
 * commonly appear in token dumps and redirect URLs).
 *
 * Secrets shorter than 4 characters are skipped — they produce too many false
 * positives (e.g., "ab" matching inside unrelated words).
 */

/**
 * Scrub known secret values from subprocess output.
 *
 * Replaces exact matches with `[REDACTED]`, and also scrubs base64 and URL-encoded
 * variants of each secret. Secrets shorter than 4 characters are left alone.
 */
export function scrubOutput(output: string, knownSecrets: string[]): string {
	let result = output;
	for (const secret of knownSecrets) {
		if (secret.length < 4) continue; // too short to safely scrub
		// Exact match.
		result = result.split(secret).join("[REDACTED]");
		// Base64 variant — secrets often appear base64-encoded in token dumps.
		const b64 = Buffer.from(secret).toString("base64");
		if (b64 !== secret && b64.length > 4) {
			result = result.split(b64).join("[REDACTED]");
		}
		// URL-encoded variant — secrets appear encoded in redirect URLs / query strings.
		const urlEnc = encodeURIComponent(secret);
		if (urlEnc !== secret && urlEnc.length > 4) {
			result = result.split(urlEnc).join("[REDACTED]");
		}
	}
	return result;
}
