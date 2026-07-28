import { readFileSync } from "node:fs";

/**
 * Phase C Task C2 — site catalog for the rotation flow.
 *
 * Maps a site to its rotation recipe: login/change-password URLs, form
 * selectors, 2FA method, and post-change verification. The catalog file
 * lives at `OMP_SECRET_HOME/site-catalog.json` (an empty catalog is
 * valid — recipes are operator-authored per site). Fail-closed (R2):
 * invalid entries abort the load with per-entry errors; a missing or
 * malformed file throws.
 */

export interface SiteRecipe {
	domain: string;
	tier: 1 | 2 | 3 | 4;
	loginUrl: string;
	changePasswordUrl: string;
	usernameField: string;
	passwordField: string;
	/** Change-form "current password" selector. Defaults to passwordField when absent. */
	currentPasswordField?: string;
	newPasswordField: string;
	confirmPasswordField?: string;
	submitButton: string;
	twoFaMethod?: "totp" | "webauthn" | "sms" | "email";
	twoFaField?: string;
	postChangeVerification?: string;
	quirks?: string[];
	selectorOverrides?: Record<string, string>;
}

const REQUIRED_STRING_FIELDS = [
	"domain",
	"loginUrl",
	"changePasswordUrl",
	"usernameField",
	"passwordField",
	"newPasswordField",
	"submitButton",
] as const;

const TWO_FA_METHODS = new Set(["totp", "webauthn", "sms", "email"]);

/** Structural validation (no schema dependency). Returns a list of human-readable errors; empty = valid. */
export function validateSiteRecipe(recipe: unknown): string[] {
	const errors: string[] = [];
	if (recipe === null || typeof recipe !== "object" || Array.isArray(recipe)) {
		return ["entry is not an object"];
	}
	const record = recipe as Record<string, unknown>;
	for (const field of REQUIRED_STRING_FIELDS) {
		const value = record[field];
		if (typeof value !== "string" || value.trim().length === 0) {
			errors.push(`${field} is required (non-empty string)`);
		}
	}
	if (![1, 2, 3, 4].includes(record.tier as number)) {
		errors.push("tier must be 1|2|3|4");
	}
	for (const field of ["loginUrl", "changePasswordUrl"] as const) {
		const value = record[field];
		if (typeof value === "string" && value.length > 0 && !value.startsWith("https://")) {
			errors.push(`${field} must be an https:// URL`);
		}
	}
	if (record.twoFaMethod !== undefined && !TWO_FA_METHODS.has(record.twoFaMethod as string)) {
		errors.push("twoFaMethod must be totp|webauthn|sms|email");
	}
	if (record.quirks !== undefined && !Array.isArray(record.quirks)) {
		errors.push("quirks must be an array of strings");
	}
	return errors;
}

/**
 * Load and validate the site catalog. Fail-closed: any invalid entry
 * aborts the load with per-entry errors.
 */
export function loadSiteCatalog(path: string): SiteRecipe[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		throw new Error(`site catalog unreadable at ${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`site catalog is not valid JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(`site catalog at ${path} must be a JSON array of recipes`);
	}
	const allErrors: string[] = [];
	for (const [index, entry] of parsed.entries()) {
		const errors = validateSiteRecipe(entry);
		if (errors.length > 0) {
			const domain =
				entry !== null && typeof entry === "object" && "domain" in entry
					? String((entry as { domain?: unknown }).domain)
					: `index ${index}`;
			allErrors.push(`entry index ${index} (${domain}): ${errors.join("; ")}`);
		}
	}
	if (allErrors.length > 0) {
				throw new Error(`site catalog invalid:\n${allErrors.join("\n")}`);
	}
	return parsed as SiteRecipe[];
}
