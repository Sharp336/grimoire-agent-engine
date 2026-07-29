import { Ellipsis, replaceTabs, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { ExtensionAskDialogValidation } from "../extensibility/extensions";

/** Custom answers beyond this size fail validation without reaching RegExp. */
export const MAX_ASK_CUSTOM_INPUT_LENGTH = 1024;
const MAX_ASK_PATTERN_LENGTH = 256;
const MAX_ASK_BOUNDED_QUANTIFIER = 64;

/**
 * Accept a deliberately small, linear-time subset of JavaScript regular
 * expressions before handing it to the native backtracking engine. Groups,
 * backreferences, and more than one quantified atom can create exponential or
 * high-polynomial work; rejecting them keeps model-controlled validation safe
 * on the synchronous TUI path.
 */
export function isSafeAskCustomInputPattern(pattern: string): boolean {
	if (pattern.length > MAX_ASK_PATTERN_LENGTH) return false;

	let quantifiers = 0;
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index] ?? "";
		if (char === "\\") {
			const escaped = pattern[++index];
			if (escaped === undefined || /[1-9k]/u.test(escaped)) return false;
			continue;
		}
		if (char === "[") {
			let closed = false;
			for (index++; index < pattern.length; index++) {
				if (pattern[index] === "\\") {
					index++;
					continue;
				}
				if (pattern[index] === "]") {
					closed = true;
					break;
				}
			}
			if (!closed) return false;
			continue;
		}
		if (char === "(" || char === ")") return false;
		if (char === "*" || char === "+" || char === "?") {
			if (++quantifiers > 1) return false;
			continue;
		}
		if (char !== "{") continue;

		const end = pattern.indexOf("}", index + 1);
		if (end === -1) return false;
		const bounds = pattern.slice(index + 1, end).split(",");
		if (
			bounds.length > 2 ||
			bounds.some(bound => bound !== "" && !/^\d+$/u.test(bound)) ||
			bounds[0] === "" ||
			bounds.some(bound => bound !== "" && Number(bound) > MAX_ASK_BOUNDED_QUANTIFIER)
		) {
			return false;
		}
		if (++quantifiers > 1) return false;
		index = end;
	}
	return true;
}

/**
 * Format a validation retry title at the render boundary. All callers share
 * control-character stripping, whitespace normalization, and a row budget so
 * extension-provided messages cannot displace the editor.
 */
export function formatAskValidationTitle(
	validationError: string | undefined,
	title: string,
	options: { width?: number; maxRows?: number } = {},
): string {
	if (validationError === undefined) return title;

	const width = Math.max(1, options.width ?? (process.stdout.columns ?? 80) - 4);
	const maxRows = Math.max(1, options.maxRows ?? 3);
	const content = replaceTabs(sanitizeText(`${validationError}\n\n${title}`))
		.replace(/\s+/g, " ")
		.trim();
	const rows = wrapTextWithAnsi(content, width);
	if (rows.length <= maxRows) return rows.join("\n");
	const kept = rows.slice(0, maxRows - 1);
	return [...kept, truncateToWidth(rows[maxRows - 1] ?? "", width, Ellipsis.Unicode)].join("\n");
}

export function getAskCustomInputValidationError(
	input: string,
	validation: ExtensionAskDialogValidation | undefined,
): string | undefined {
	if (!validation) return undefined;
	if (input.length > MAX_ASK_CUSTOM_INPUT_LENGTH) {
		return validation.message ?? "Custom answer does not meet the required format.";
	}
	let failed = false;
	if (validation.minLength !== undefined && input.length < validation.minLength) failed = true;
	if (validation.maxLength !== undefined && input.length > validation.maxLength) failed = true;
	if (validation.pattern !== undefined) {
		try {
			if (!isSafeAskCustomInputPattern(validation.pattern) || !new RegExp(validation.pattern).test(input))
				failed = true;
		} catch {
			failed = true;
		}
	}
	return failed ? (validation.message ?? "Custom answer does not meet the required format.") : undefined;
}
