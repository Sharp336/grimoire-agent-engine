/**
 * Shell-quoting helpers for safe interpolation of dynamic values into POSIX
 * shell commands. Kept here (rather than duplicated beside every call site) so
 * exactly one implementation exists across the monorepo.
 */

/**
 * Quote a string for safe interpolation into a POSIX shell single-quoted
 * context. Every `'` inside the value becomes `'\''`, closing and reopening
 * the surrounding single quotes so the result is always balanced.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Quote a string for a PowerShell single-quoted literal. This is separate
 * from shellQuote because PowerShell escapes embedded quotes by doubling them.
 */
export function powershellQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}
