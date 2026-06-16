import { logger } from "@oh-my-pi/pi-utils";

/**
 * Global key the `mupdf` WASM loader reads for its Emscripten module options
 * (mupdf/dist/mupdf.js: `await libmupdf_wasm(globalThis["$libmupdf_wasm_Module"])`).
 * Emscripten honours `print`/`printErr` from this object; both default to
 * `console.log`/`console.error`, which corrupt the TUI when MuPDF emits
 * recoverable-format warnings during PDF text extraction.
 */
export const MUPDF_MODULE_GLOBAL = "$libmupdf_wasm_Module";

const INSTALLED = "__ompMupdfQuiet";

/**
 * Route MuPDF's WASM stdout/stderr to the file logger instead of the console so
 * warnings like "format error: No common ancestor in structure tree" never reach
 * the terminal. Idempotent. Must run before `mupdf` is first imported — Emscripten
 * reads the options object once at instantiation.
 */
export function installMupdfQuietHook(): void {
	const g = globalThis as Record<string, unknown>;
	const current = g[MUPDF_MODULE_GLOBAL];
	const prev = current && typeof current === "object" ? (current as Record<string, unknown>) : null;
	if (prev?.[INSTALLED]) return;
	const sink = (text: string): void => {
		logger.debug(`[mupdf] ${text}`);
	};
	g[MUPDF_MODULE_GLOBAL] = {
		...(prev ?? {}),
		print: sink,
		printErr: sink,
		[INSTALLED]: true,
	};
}
