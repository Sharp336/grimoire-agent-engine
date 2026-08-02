import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";

/**
 * Legacy effort selectors accepted by the deprecated `--thinking <effort>`
 * compatibility path. Canonical thinking-mode selectors live in
 * `CLI_THINKING_MODES`; new callers should use `CLI_EFFORT_LEVELS`.
 */
export const CLI_THINKING_LEVELS: readonly string[] = ["off", ...THINKING_EFFORTS, "auto"];
