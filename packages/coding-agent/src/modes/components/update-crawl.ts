import {
	type Component,
	matchesKey,
	type OverlayFocusOwner,
	type OverlayHandle,
	type OverlayOptions,
	replaceTabs,
	TERMINAL,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import { stripInlineMarkdown } from "./plan-toc";

const UPDATE_CRAWL_TICK_MS = 48;

const ROWS_PER_SECOND = 2.5;
const MAX_CONTENT_WIDTH = 58;
const CONTENT_WIDTH_RATIO = 0.52;
const TOP_EDGE_ROW = 1;
const TOP_FADE_ROWS = 5;
const NEAR_YELLOW = [255, 216, 64] as const;
const FAR_AMBER = [132, 78, 12] as const;
type Rgb = readonly [red: number, green: number, blue: number];
const STAR_BRIGHT: Rgb = [208, 220, 235];
const STAR_MEDIUM: Rgb = [132, 148, 168];
const STAR_DIM: Rgb = [72, 84, 102];
const HINT_COLOR: Rgb = [104, 108, 116];
const BLACK_BACKGROUND = "\x1b[40m";
const DEFAULT_BACKGROUND = "\x1b[49m";

interface CrawlRow {
	readonly text: string;
	readonly kind: "title" | "heading" | "body";
}
const BLANK_ROW = { text: "", kind: "body" } as const;
const THREE_BLANK_ROWS = [BLANK_ROW, BLANK_ROW, BLANK_ROW];

const TITLE_ART = [
	" ###  #   #    #   # #   #    ####  #####",
	"#   # #   #    ## ##  # #     #   #   #  ",
	"#   # #####    # # #   #      ####    #  ",
	"#   # #   #    #   #   #      #       #  ",
	" ###  #   #    #   #   #      #     #####",
] as const;

/** Slice of the interactive mode used by the fullscreen update overlay. */
export interface UpdateCrawlHost {
	ui: {
		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
		setFocus(component: Component): void;
		requestRender(): void;
		readonly terminal: {
			readonly rows: number;
		};
	};
}

/** Optional animation clock overrides for deterministic hosts and tests. */
export interface RunUpdateCrawlOptions {
	readonly tickMs?: number;
	readonly now?: () => number;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
	const t = clamp01((value - edge0) / Math.max(Number.EPSILON, edge1 - edge0));
	return t * t * (3 - 2 * t);
}

function crawlContentWidth(width: number): number {
	return Math.max(1, Math.min(MAX_CONTENT_WIDTH, Math.floor(Math.max(1, width) * CONTENT_WIDTH_RATIO)));
}

function cleanTerminalText(value: string): string {
	return replaceTabs(Bun.stripANSI(value)).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function cleanInlineMarkdown(value: string): string {
	return stripInlineMarkdown(cleanTerminalText(value)).replace(/\\([\\`*_[\]{}()#+\-.!])/g, "$1");
}

function wrapRow(text: string, width: number, kind: CrawlRow["kind"], preserveWhitespace = false): CrawlRow[] {
	if (!text) return [{ text: "", kind }];
	return Bun.wrapAnsi(text, width, { hard: true, trim: false, wordWrap: true })
		.split("\n")
		.map(line => ({ text: preserveWhitespace ? line : line.trim(), kind }));
}

const ROMAN_PLACES = [
	["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"],
	["", "X", "XX", "XXX", "XL", "L", "LX", "LXX", "LXXX", "XC"],
	["", "C", "CC", "CCC", "CD", "D", "DC", "DCC", "DCCC", "CM"],
] as const;

function romanizeInteger(value: number): string {
	if (!Number.isSafeInteger(value) || value < 0) return String(value);
	if (value === 0) return "N";
	return (
		"M".repeat(Math.floor(value / 1_000)) +
		ROMAN_PLACES[2][Math.floor(value / 100) % 10] +
		ROMAN_PLACES[1][Math.floor(value / 10) % 10] +
		ROMAN_PLACES[0][value % 10]
	);
}

/** Format every numeric segment of a version as a Roman numeral. */
export function formatRomanVersion(version: string): string {
	return version.replace(/\d+/g, digits => romanizeInteger(Number.parseInt(digits, 10)));
}

function buildReleaseRows(markdown: string, version: string, contentWidth: number, bullet: string): CrawlRow[] {
	const rows: CrawlRow[] = [];
	let activeFence: string | undefined;

	for (const rawLine of markdown.split("\n")) {
		const trimmed = rawLine.trim();
		const fence = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
		if (!activeFence && fence) {
			activeFence = fence[1];
			continue;
		}
		if (
			activeFence &&
			fence &&
			fence[2] === "" &&
			fence[1][0] === activeFence[0] &&
			fence[1].length >= activeFence.length
		) {
			activeFence = undefined;
			continue;
		}

		if (activeFence) {
			const text = cleanTerminalText(rawLine);
			rows.push(...wrapRow(text, contentWidth, "body", true));
			continue;
		}

		if (!trimmed) {
			if (rows.at(-1)?.text) rows.push(BLANK_ROW);
			continue;
		}

		const release = trimmed.match(/^##\s+\[?(\d+\.\d+\.\d+)\]?/);
		if (release) {
			if (release[1] !== version) {
				rows.push(...wrapRow(`EPISODE ${formatRomanVersion(release[1])}`, contentWidth, "heading"));
			}
			continue;
		}

		const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
		if (heading) {
			rows.push(...wrapRow(cleanInlineMarkdown(heading[1]).toUpperCase(), contentWidth, "heading"));
			continue;
		}

		const listItem = trimmed.match(/^[-*+]\s+(.+)$/);
		if (listItem) {
			rows.push(...wrapRow(`${bullet} ${cleanInlineMarkdown(listItem[1])}`, contentWidth, "body"), BLANK_ROW);
			continue;
		}

		if (/^\d+[.)]\s+/.test(trimmed)) {
			rows.push(...wrapRow(cleanInlineMarkdown(trimmed), contentWidth, "body"), BLANK_ROW);
			continue;
		}

		const text = cleanInlineMarkdown(trimmed);
		if (text) rows.push(...wrapRow(text, contentWidth, "body"));
	}

	while (rows.length > 0 && !rows.at(-1)?.text) rows.pop();
	return rows;
}
function buildCrawlRows(markdown: string, version: string, width: number): CrawlRow[] {
	const contentWidth = crawlContentWidth(width);
	const titleRows: CrawlRow[] = TITLE_ART.every(line => visibleWidth(line) <= contentWidth)
		? TITLE_ART.map(text => ({ text, kind: "title" as const }))
		: wrapRow("O H   M Y   P I", contentWidth, "title");
	return [
		...titleRows,
		BLANK_ROW,
		...wrapRow(`EPISODE ${formatRomanVersion(version)}`, contentWidth, "heading"),
		BLANK_ROW,
		...wrapRow("W H A T ' S   N E W", contentWidth, "title"),
		BLANK_ROW,
		...buildReleaseRows(markdown, version, contentWidth, "•"),
		...THREE_BLANK_ROWS,
	];
}

function starGlyph(x: number, y: number, frame: number): string {
	let hash = Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663);
	hash = Math.imul(hash ^ (hash >>> 13), 1274126177) >>> 0;
	if (hash % 59 > 2) return " ";
	const phase = (frame + ((hash >>> 8) % 16)) % 16;
	if (phase === 0) return styleSceneText("✦", STAR_BRIGHT);
	if (phase <= 2) return styleSceneText("*", STAR_MEDIUM);
	return styleSceneText("·", STAR_DIM);
}

function starfieldRow(width: number, y: number, frame: number): string[] {
	return Array.from({ length: width }, (_, x) => starGlyph(x, y, frame));
}

function interpolateChannel(far: number, near: number, depth: number): number {
	return Math.round(far + (near - far) * smoothstep(0, 1, depth));
}
function styleSceneText(text: string, [red, green, blue]: Rgb): string {
	const format = TERMINAL.trueColor ? "ansi-16m" : "ansi-256";
	const color = Bun.color(`rgb(${red}, ${green}, ${blue})`, format) ?? "";
	return `${color}${text}\x1b[39m`;
}

function styleCrawlText(row: CrawlRow, text: string, depth: number, opacity: number): string {
	const background = 0;
	const red = interpolateChannel(FAR_AMBER[0], NEAR_YELLOW[0], depth);
	const green = interpolateChannel(FAR_AMBER[1], NEAR_YELLOW[1], depth);
	const blue = interpolateChannel(FAR_AMBER[2], NEAR_YELLOW[2], depth);
	const fadedRed = Math.round(background + (red - background) * opacity);
	const fadedGreen = Math.round(background + (green - background) * opacity);
	const fadedBlue = Math.round(background + (blue - background) * opacity);
	const styled = styleSceneText(text, [fadedRed, fadedGreen, fadedBlue]);
	return row.kind === "body" || opacity < 0.6 ? styled : theme.bold(styled);
}

function renderPreparedCrawl(width: number, height: number, elapsedMs: number, rows: readonly CrawlRow[]): string[] {
	const w = Math.max(1, width);
	const h = Math.max(1, height);
	const frame = Math.floor(Math.max(0, elapsedMs) / UPDATE_CRAWL_TICK_MS);
	const output = Array.from({ length: h }, (_, y) => starfieldRow(w, y, frame));
	const usableHeight = Math.max(1, h - TOP_EDGE_ROW - 2);
	const scrollRows = (Math.max(0, elapsedMs) / 1000) * ROWS_PER_SECOND;
	const firstY = TOP_EDGE_ROW + usableHeight - 1 - scrollRows;

	for (let index = 0; index < rows.length; index++) {
		const targetY = Math.round(firstY + index);
		if (targetY <= TOP_EDGE_ROW || targetY >= h - 1) continue;
		const row = rows[index];
		if (!row.text || visibleWidth(row.text) > w) continue;
		const distanceFromTop = targetY - TOP_EDGE_ROW;
		const opacity = smoothstep(0, TOP_FADE_ROWS, distanceFromTop);
		const depth = distanceFromTop / usableHeight;
		const lineWidth = visibleWidth(row.text);
		const start = Math.max(0, Math.floor((w - lineWidth) / 2));
		const background = output[targetY];
		output[targetY] = [
			...background.slice(0, start),
			styleCrawlText(row, row.text, depth, opacity),
			...background.slice(Math.min(w, start + lineWidth)),
		];
	}

	const complete = firstY + rows.length <= TOP_EDGE_ROW + 1;
	const hint = complete ? "enter to continue" : "enter to skip";
	const hintWidth = visibleWidth(hint);
	if (hintWidth <= w) {
		const styledHint = styleSceneText(hint, HINT_COLOR);
		const hintStart = Math.floor((w - hintWidth) / 2);
		const bottom = output[h - 1];
		output[h - 1] = [...bottom.slice(0, hintStart), styledHint, ...bottom.slice(hintStart + hintWidth)];
	}

	return output.map(line => `${BLACK_BACKGROUND}${line.join("")}${DEFAULT_BACKGROUND}`);
}

/** Paint one deterministic crawl frame. Exported for rendering tests and gallery use. */
export function renderUpdateCrawl(
	width: number,
	height: number,
	elapsedMs: number,
	markdown: string,
	version: string,
): string[] {
	return renderPreparedCrawl(width, height, elapsedMs, buildCrawlRows(markdown, version, width));
}

/** Hold a fullscreen cinematic changelog until the user continues or skips it with Enter. */
export async function runUpdateCrawl(
	host: UpdateCrawlHost,
	markdown: string,
	version: string,
	options: RunUpdateCrawlOptions = {},
): Promise<void> {
	const done = Promise.withResolvers<void>();
	const now = options.now ?? (() => performance.now());
	let startedAt = 0;
	let renderWidth = 0;
	let rows: CrawlRow[] = [];

	const component: Component & OverlayFocusOwner = {
		ownsOverlayFocusTarget: target => target === component,
		handleInput(data) {
			if (
				matchesKey(data, "enter") ||
				matchesKey(data, "return") ||
				matchesKey(data, "escape") ||
				matchesKey(data, "esc") ||
				matchesKey(data, "ctrl+c")
			) {
				done.resolve();
			}
		},
		render(width) {
			const safeWidth = Math.max(1, width);
			const height = Math.max(1, host.ui.terminal.rows);
			const elapsedMs = Math.max(0, now() - startedAt);
			if (safeWidth !== renderWidth) {
				renderWidth = safeWidth;
				rows = buildCrawlRows(markdown, version, safeWidth);
			}
			return renderPreparedCrawl(safeWidth, height, elapsedMs, rows);
		},
	};
	const overlay = host.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	let timer: NodeJS.Timeout | undefined;
	try {
		host.ui.setFocus(component);
		startedAt = now();
		timer = setInterval(() => host.ui.requestRender(), options.tickMs ?? UPDATE_CRAWL_TICK_MS);
		host.ui.requestRender();
		await done.promise;
	} finally {
		clearInterval(timer);
		host.ui.setFocus(component);
		overlay.hide();
	}
}
