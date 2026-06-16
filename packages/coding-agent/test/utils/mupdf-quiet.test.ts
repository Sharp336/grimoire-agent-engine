/**
 * Regression: MuPDF WASM warnings (e.g. "format error: No common ancestor in
 * structure tree") must not leak to the console/TUI during PDF conversion. The
 * fix routes Emscripten print/printErr to the file logger via a global module
 * hook installed before `mupdf` is first imported.
 */
import { describe, expect, it, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
// Side-effect import: loading markit.ts (the sole markit-ai importer) must
// install the hook at module load, before mupdf is ever imported. A static
// side-effect import is the rule-compliant way to assert that wiring.
import "@oh-my-pi/pi-coding-agent/utils/markit";
import { installMupdfQuietHook, MUPDF_MODULE_GLOBAL } from "@oh-my-pi/pi-coding-agent/utils/mupdf-quiet";

type ModuleConfig = { print?: (t: string) => void; printErr?: (t: string) => void; [k: string]: unknown };
const cfg = (): ModuleConfig | undefined =>
	(globalThis as Record<string, unknown>)[MUPDF_MODULE_GLOBAL] as ModuleConfig | undefined;

describe("mupdf quiet hook", () => {
	it("is installed at module load when markit.ts is imported", () => {
		expect(cfg()?.__ompMupdfQuiet).toBe(true);
		expect(typeof cfg()?.printErr).toBe("function");
	});

	it("routes print and printErr to logger.debug, never the console/TUI", () => {
		const g = globalThis as Record<string, unknown>;
		const saved = g[MUPDF_MODULE_GLOBAL];
		delete g[MUPDF_MODULE_GLOBAL];
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const cerr = vi.spyOn(console, "error").mockImplementation(() => {});
		const clog = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			installMupdfQuietHook();
			cfg()?.printErr?.("format error: No common ancestor in structure tree");
			cfg()?.print?.("warning: structure tree broken, assume tree is missing");
			expect(debug).toHaveBeenCalledTimes(2);
			expect(debug.mock.calls[0]?.[0]).toContain("No common ancestor");
			expect(cerr).not.toHaveBeenCalled();
			expect(clog).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			g[MUPDF_MODULE_GLOBAL] = saved;
		}
	});

	it("is idempotent and preserves pre-existing module config keys", () => {
		const g = globalThis as Record<string, unknown>;
		const saved = g[MUPDF_MODULE_GLOBAL];
		g[MUPDF_MODULE_GLOBAL] = { locateFile: (f: string) => f, custom: 42 };
		try {
			installMupdfQuietHook();
			const first = cfg();
			expect(first?.custom).toBe(42);
			expect(typeof first?.locateFile).toBe("function");
			expect(typeof first?.printErr).toBe("function");
			installMupdfQuietHook();
			expect(cfg()).toBe(first); // sentinel short-circuits, no re-clobber
		} finally {
			g[MUPDF_MODULE_GLOBAL] = saved;
		}
	});
});
