import { sanitizeExternalToolText } from "../../tools/xdev";

/** Sanitize untrusted text and bound its UTF-8 representation without splitting surrogate pairs. */
export function sanitizeRpcText(value: string, maxBytes: number): string {
	const sanitized = sanitizeExternalToolText(value).trim();
	if (Buffer.byteLength(sanitized, "utf8") <= maxBytes) return sanitized;
	let low = 0;
	let high = sanitized.length;
	while (low < high) {
		const midpoint = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(sanitized.slice(0, midpoint), "utf8") <= maxBytes) low = midpoint;
		else high = midpoint - 1;
	}
	if (low > 0 && low < sanitized.length) {
		const previous = sanitized.charCodeAt(low - 1);
		if (previous >= 0xd800 && previous <= 0xdbff) low--;
	}
	return sanitized.slice(0, low);
}
