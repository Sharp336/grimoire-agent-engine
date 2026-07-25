import { renderSvgToPng } from "@oh-my-pi/pi-natives";
import { logger, renderNomnomlAsciiSafe, renderNomnomlSvg } from "@oh-my-pi/pi-utils";

export type MarkdownNomnomlRendering = "off" | "svg" | "ascii";

let markdownNomnomlRendering: MarkdownNomnomlRendering = "svg";
const asciiCache = new Map<string, string | null>();
const pngCache = new Map<string, Promise<string | null> | string | null>();

// Native MAX_PIXELS (64_000_000) only rejects after SVG generation. Bound the
// source cheaply first so pathological fences never reach sync parse/layout.
// No existing char-budget neighbor fits; style matches MAX_PIXELS / MAX_CANVAS_CELLS.
const MAX_SOURCE_CHARS = 64_000;

export function setMarkdownNomnomlRendering(mode: MarkdownNomnomlRendering): void {
	if (markdownNomnomlRendering === mode) return;
	markdownNomnomlRendering = mode;
}

export function getMarkdownNomnomlRendering(): MarkdownNomnomlRendering {
	return markdownNomnomlRendering;
}

export function clearNomnomlCache(): void {
	asciiCache.clear();
	pngCache.clear();
}

function normalizedSource(source: string): string | null {
	const normalized = source.replace(/\r\n?/g, "\n").trim();
	return normalized.length === 0 ? null : normalized;
}

function rejectOversizedSource(normalized: string): boolean {
	if (normalized.length <= MAX_SOURCE_CHARS) return false;
	logger.debug("Nomnoml source exceeds size budget", {
		length: normalized.length,
		maxSourceChars: MAX_SOURCE_CHARS,
	});
	return true;
}

export function resolveNomnomlAscii(source: string, maxWidth?: number): string | null {
	const normalized = normalizedSource(source);
	if (normalized === null) return null;
	// renderNomnomlAsciiSafe only rejects oversized canvases after parse/layout,
	// so the same pre-generation source bound applies here.
	if (rejectOversizedSource(normalized)) return null;
	const key = `${maxWidth ?? ""}\x00${normalized}`;
	const cached = asciiCache.get(key);
	if (cached !== undefined) return cached;
	const ascii = renderNomnomlAsciiSafe(normalized, maxWidth ?? 120);
	asciiCache.set(key, ascii);
	return ascii;
}

export async function resolveNomnomlPng(source: string): Promise<string | null> {
	const normalized = normalizedSource(source);
	if (normalized === null) return null;
	if (rejectOversizedSource(normalized)) return null;
	const cached = pngCache.get(normalized);
	if (typeof cached === "string" || cached === null) return cached;
	if (cached !== undefined) return cached;

	const pending = (async () => {
		try {
			const svg = renderNomnomlSvg(normalized);
			if (svg === null) return null;
			const bytes = await renderSvgToPng(svg, 2);
			return Buffer.from(bytes).toString("base64");
		} catch (err) {
			logger.debug("Nomnoml SVG rasterization failed", { error: String(err) });
			return null;
		}
	})();
	pngCache.set(normalized, pending);
	const result = await pending;
	pngCache.set(normalized, result);
	return result;
}
