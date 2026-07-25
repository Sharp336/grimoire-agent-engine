import { renderSvgToPng } from "@oh-my-pi/pi-natives";
import { logger, renderNomnomlAsciiSafe, renderNomnomlSvg } from "@oh-my-pi/pi-utils";

export type MarkdownNomnomlRendering = "off" | "svg" | "ascii";

let markdownNomnomlRendering: MarkdownNomnomlRendering = "svg";
const asciiCache = new Map<string, string | null>();
const pngCache = new Map<string, Promise<string | null> | string | null>();

// Both caches live for the whole session and only clear on an explicit theme
// change, so they need their own ceiling: one diagram re-rendered at N terminal
// widths stores N ASCII entries, and each PNG entry holds a full base64 payload.
// Eviction is insertion-order (Map iterates oldest key first), not LRU — a cap
// is what bounds memory; recency ranking would not earn its complexity here.
const ASCII_CACHE_MAX_ENTRIES = 256;
const PNG_CACHE_MAX_ENTRIES = 64;

function cacheAscii(key: string, ascii: string | null): void {
	asciiCache.set(key, ascii);
	if (asciiCache.size <= ASCII_CACHE_MAX_ENTRIES) return;
	const oldest = asciiCache.keys().next();
	if (!oldest.done) asciiCache.delete(oldest.value);
}

/** Drop the oldest settled entry. Returns false when every slot is in flight. */
function evictSettledPng(): boolean {
	for (const [candidate, cached] of pngCache) {
		// Never drop an in-flight render: concurrent callers dedupe on that exact
		// promise, and deleting it would make the next caller re-rasterize.
		if (cached instanceof Promise) continue;
		pngCache.delete(candidate);
		return true;
	}
	return false;
}

function cachePng(key: string, png: Promise<string | null> | string | null): void {
	// Hard cap: with every slot in flight there is no evictable victim, so the new
	// render goes uncached rather than growing the map past the ceiling.
	if (!pngCache.has(key) && pngCache.size >= PNG_CACHE_MAX_ENTRIES && !evictSettledPng()) return;
	pngCache.set(key, png);
}

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
	cacheAscii(key, ascii);
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
	cachePng(normalized, pending);
	const result = await pending;
	// Claim the slot only if it is still ours: a clearNomnomlCache() (or a slot we
	// never got) during flight must not resurrect an entry behind the caller's back.
	if (pngCache.get(normalized) === pending) cachePng(normalized, result);
	return result;
}
