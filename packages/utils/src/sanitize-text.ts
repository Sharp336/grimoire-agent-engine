/**
 * Strip ANSI escape sequences, remove control characters / lone surrogates,
 * and normalize line endings.
 *
 * Bun-native implementation of the former native `sanitizeText` (see
 * `crates/pi-natives/src/text.rs::sanitize_text`). JavaScript strings are
 * already UTF-16 code-unit arrays. `toWellFormed()` handles the uncommon
 * malformed path; when it changes the input, replacement characters are
 * dropped and the normalized result goes through the well-formed sanitizer.
 *
 * Fast path: well-formed input with no controls or ANSI returns the original
 * string after the control probe.
 */

const ESC_CHAR = "\x1b";

// Well-formed strings only need control/ANSI detection: C0 (excl. \t \n),
// CR, DEL, and C1. ESC (0x1B) is in \x0B-\x1F.
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

const REPLACEMENT_CHAR = "\ufffd";

export interface EscapedSurrogates {
	text: string;
	escapedCodeUnits: number;
}

/**
 * Preserve well-formed UTF-16 while spelling each unmatched surrogate as an
 * uppercase ASCII `\\uXXXX` escape before a UTF-8 persistence boundary.
 */
export function escapeUnpairedSurrogates(text: string): EscapedSurrogates {
	let firstInvalid = -1;
	for (let index = 0; index < text.length; index++) {
		const codeUnit = text.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				index++;
				continue;
			}
			firstInvalid = index;
			break;
		}
		if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			firstInvalid = index;
			break;
		}
	}
	if (firstInvalid === -1) return { text, escapedCodeUnits: 0 };

	let escaped = text.slice(0, firstInvalid);
	let segmentStart = firstInvalid;
	let escapedCodeUnits = 0;
	for (let index = firstInvalid; index < text.length; index++) {
		const codeUnit = text.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				index++;
				continue;
			}
		} else if (codeUnit < 0xdc00 || codeUnit > 0xdfff) {
			continue;
		}

		escaped += text.slice(segmentStart, index);
		escaped += `\\u${codeUnit.toString(16).toUpperCase().padStart(4, "0")}`;
		escapedCodeUnits++;
		segmentStart = index + 1;
	}
	escaped += text.slice(segmentStart);
	return { text: escaped, escapedCodeUnits };
}

export function sanitizeText(text: string): string {
	const wellFormed = text.toWellFormed();
	if (wellFormed !== text) {
		return sanitizeWellFormedText(wellFormed.replaceAll(REPLACEMENT_CHAR, ""));
	}
	return sanitizeWellFormedText(text);
}

function sanitizeWellFormedText(text: string): string {
	CONTROL_RE.lastIndex = 0;
	if (CONTROL_RE.exec(text) === null) return text;

	const stripped = text.indexOf(ESC_CHAR) === -1 ? text : Bun.stripANSI(text);
	CONTROL_RE.lastIndex = 0;
	return stripped.replace(CONTROL_RE, "");
}

/**
 * Escape the three XML-significant characters (`&`, `<`, `>`) in text destined
 * for an XML/markup element body. Allocation-conscious: returns the input
 * unchanged (same reference) when nothing needs escaping. Quotes are left as-is
 * — use it for element text, not attribute values.
 */
export function escapeXmlText(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else output += char;
	}
	return output;
}

/**
 * Escape XML-significant characters for an attribute VALUE: the three body
 * characters (`&`, `<`, `>`) plus the double quote (`"` → `&quot;`) that would
 * otherwise close the attribute. Allocation-conscious: returns the input
 * unchanged (same reference) when nothing needs escaping. Use it for attribute
 * values; {@link escapeXmlText} is for element bodies and leaves `"` intact.
 */
export function escapeXmlAttribute(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62 || char === 34) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else if (char === '"') output += "&quot;";
		else output += char;
	}
	return output;
}
