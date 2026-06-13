import { maskNonProse } from "./markdown-prose";
import { theme } from "./theme/theme";

/** A gradient keyword highlighter. `resetTo` is the SGR foreground sequence
 *  re-emitted after each painted keyword so surrounding text keeps its color;
 *  it defaults to a plain foreground reset (editor / default-colored text). */
export type KeywordHighlighter = (text: string, resetTo?: string) => string;

const FG_RESET = "\x1b[39m";

/** Color-stop parameters for a gradient sweep. */
export interface GradientSpec {
	/** Number of color stops swept across the gradient. */
	stops: number;
	/** Maps a normalized position `t` in [0, 1) to an HSL hue in degrees. */
	hue: (t: number) => number;
	/** HSL saturation percentage. Default 90. */
	saturation?: number;
	/** HSL lightness percentage. Default 62. */
	lightness?: number;
}

/** Declarative spec for {@link createGradientHighlighter}. */
export interface GradientHighlightSpec extends GradientSpec {
	/** Cheap, stateless presence probe used to skip the boundary regex on most lines. Must be non-global. */
	probe: RegExp;
	/** Global, word-bounded match regex walked by `.replace`. */
	highlight: RegExp;
}

/**
 * Gradient palettes compiled per spec, then per active color mode. Keyed on the
 * spec object so module-level specs (keyword highlighters, status badges) reuse
 * one compiled palette per mode instead of recomputing the HSL stops every call.
 */
const paletteCache = new WeakMap<GradientSpec, Map<string, readonly string[]>>();

function gradientPalette(spec: GradientSpec): readonly string[] {
	const mode = theme.getColorMode();
	let byMode = paletteCache.get(spec);
	if (!byMode) {
		byMode = new Map();
		paletteCache.set(spec, byMode);
	}
	const cached = byMode.get(mode);
	if (cached) return cached;
	const { stops, hue, saturation = 90, lightness = 62 } = spec;
	const format = mode === "truecolor" ? "ansi-16m" : "ansi-256";
	const next: string[] = [];
	for (let i = 0; i < stops; i++) {
		next.push(Bun.color(`hsl(${Math.round(hue(i / stops))}, ${saturation}%, ${lightness}%)`, format) ?? "");
	}
	byMode.set(mode, next);
	return next;
}

/**
 * Paint every character of `text` with `spec`'s HSL gradient, re-emitting
 * `resetTo` once at the end so following text keeps its color. Adds only
 * zero-width SGR escapes — the visible width is unchanged.
 */
export function paintGradient(text: string, spec: GradientSpec, resetTo: string = FG_RESET): string {
	if (text.length === 0) return "";
	const stopsArr = gradientPalette(spec);
	const n = text.length;
	let out = "";
	let prev = "";
	for (let i = 0; i < n; i++) {
		const color = stopsArr[Math.floor((i / n) * stopsArr.length)] ?? stopsArr[0] ?? "";
		// Coalesce consecutive characters that resolve to the same stop.
		if (color !== prev) {
			out += color;
			prev = color;
		}
		out += text[i];
	}
	return `${out}${resetTo}`;
}

/**
 * Build a stateless highlighter that paints each standalone match of `highlight`
 * with a smooth HSL gradient for editor display. The returned function adds only
 * zero-width SGR escapes — the visible width is unchanged — and returns the input
 * untouched when `probe` does not match. The palette is compiled lazily and
 * memoized per active color mode.
 */
export function createGradientHighlighter(spec: GradientHighlightSpec): KeywordHighlighter {
	const { probe, highlight } = spec;
	return (text: string, resetTo: string = FG_RESET): string => {
		if (!probe.test(text)) return text;
		// Match against a code/markup-masked copy so keywords inside code spans,
		// fenced blocks, or XML sections never paint; indices still address `text`.
		const masked = maskNonProse(text);
		let out = "";
		let last = 0;
		for (const m of masked.matchAll(highlight)) {
			const start = m.index ?? 0;
			const end = start + m[0].length;
			out += text.slice(last, start) + paintGradient(text.slice(start, end), spec, resetTo);
			last = end;
		}
		return out + text.slice(last);
	};
}
