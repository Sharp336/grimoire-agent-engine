import nomnoml from "nomnoml";
import { sanitizeText } from "./sanitize-text";

type Point = { x: number; y: number };
type Label = { text?: string; x?: number; y?: number; width?: number; height?: number };
type LayoutPart = {
	lines?: string[];
	nodes?: LayoutNode[];
	assocs?: Association[];
	width?: number;
	height?: number;
	x?: number;
	y?: number;
	/** Compartment-local origin nomnoml applies before drawing nested content. */
	offset?: Point;
};
type LayoutNode = LayoutPart & {
	id?: string;
	type?: string;
	parts?: LayoutPart[];
	dividers?: number[];
};
type Association = {
	type?: string;
	path?: Point[];
	points?: Point[];
	startLabel?: Label;
	endLabel?: Label;
};
type NomnomlConfig = {
	direction?: string;
	padding?: number;
	spacing?: number;
	gutter?: number;
	edgeMargin?: number;
	arrowSize?: number;
	bendSize?: number;
	styles?: Record<string, { visual?: string }>;
};
type ParsedNomnoml = { root: LayoutPart; config: NomnomlConfig };
type Measurer = {
	setFont: (font: string, size: number, weight: string, style: string) => void;
	textWidth: (text: string) => number;
	textHeight: () => number;
};
type NomnomlRuntime = typeof nomnoml & {
	parse: (source: string) => ParsedNomnoml;
	layout: (measurer: Measurer, config: NomnomlConfig, root: LayoutPart) => void;
};

// nomnoml 1.7.0 ships incomplete .d.ts declarations: parse/layout are exported
// at runtime but absent from the type file. Keep the escape hatch local.
const nomnomlRuntime = nomnoml as NomnomlRuntime;

const MAX_CANVAS_CELLS = 40_000;
const MAX_DIMENSION = 400;
const WIDE_CONTINUATION_CELL = "\0";
const COMPARTMENT_DIVIDER = Symbol("compartment-divider");
type NodeRow = string | typeof COMPARTMENT_DIVIDER;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

class CharGrid {
	#cells: string[][];

	constructor(
		readonly width: number,
		readonly height: number,
	) {
		this.#cells = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
	}

	set(x: number, y: number, char: string): void {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
		const row = this.#cells[y];
		if (!row) return;
		const previous = row[x];
		const current = previous === WIDE_CONTINUATION_CELL ? " " : (previous ?? " ");
		const next = mergeChars(current, char);
		row[x] = next;
		const width = Bun.stringWidth(next);
		// If a narrower glyph replaced a wider one at this leading cell, clear the
		// now-orphaned continuation sentinels it used to own.
		const previousWidth = previous && previous !== WIDE_CONTINUATION_CELL ? Bun.stringWidth(previous) : 1;
		for (let dx = Math.max(1, width); dx < previousWidth && x + dx < this.width; dx++) {
			if (row[x + dx] === WIDE_CONTINUATION_CELL) row[x + dx] = " ";
		}
		if (width <= 1) return;
		for (let dx = 1; dx < width && x + dx < this.width; dx++) {
			row[x + dx] = WIDE_CONTINUATION_CELL;
		}
	}

	text(x: number, y: number, text: string): void {
		let cursor = x;
		for (const { segment } of graphemeSegmenter.segment(text)) {
			this.set(cursor, y, segment);
			cursor += Bun.stringWidth(segment) || 1;
		}
	}

	lines(): string[] {
		let top = 0;
		let bottom = this.#cells.length - 1;
		while (top <= bottom && rowEmpty(this.#cells[top])) top++;
		while (bottom >= top && rowEmpty(this.#cells[bottom])) bottom--;
		if (top > bottom) return [];

		let left = this.width;
		let right = 0;
		for (let y = top; y <= bottom; y++) {
			const row = this.#cells[y];
			if (!row) continue;
			for (let x = 0; x < row.length; x++) {
				const cell = row[x] ?? " ";
				if (cell !== " " && cell !== WIDE_CONTINUATION_CELL) {
					left = Math.min(left, x);
					right = Math.max(right, x);
				}
			}
		}
		if (left > right) return [];

		const result: string[] = [];
		for (let y = top; y <= bottom; y++) {
			const row = this.#cells[y];
			if (!row) continue;
			result.push(
				row
					.slice(left, right + 1)
					.filter(cell => cell !== WIDE_CONTINUATION_CELL)
					.join("")
					.trimEnd(),
			);
		}
		return result;
	}
}

function rowEmpty(row: string[] | undefined): boolean {
	return row === undefined || row.every(char => char === " " || char === WIDE_CONTINUATION_CELL);
}

function isHorizontal(char: string): boolean {
	return char === "─" || char === "-" || char === "┼" || char === "+";
}

function isVertical(char: string): boolean {
	return char === "│" || char === "|" || char === "┼" || char === "+";
}

function mergeChars(current: string, next: string): string {
	if (current === " " || current === next) return next;
	if (next === " ") return current;
	if ((isHorizontal(current) && isVertical(next)) || (isVertical(current) && isHorizontal(next))) return "┼";
	if (current === "┼" && (isHorizontal(next) || isVertical(next))) return current;
	if (next === "┼" && (isHorizontal(current) || isVertical(current))) return next;
	if ("<>^v".includes(next)) return next;
	if ("┌┐└┘│─".includes(current) && "│─".includes(next)) return current;
	return next;
}

function compactConfig(config: NomnomlConfig, direction?: "TB" | "LR"): NomnomlConfig {
	return {
		...config,
		direction: direction ?? config.direction,
		padding: 1,
		spacing: 4,
		gutter: 2,
		edgeMargin: 0,
		arrowSize: 1,
		bendSize: 0.3,
	};
}

/** Strip controls via {@link sanitizeText}, then collapse tabs to spaces for the fixed-width grid. */
function sanitizeDiagramText(text: string): string {
	return sanitizeText(text).replaceAll("\t", " ");
}

function sanitizeAssociationLabels(assoc: Association): void {
	if (assoc.startLabel?.text !== undefined) {
		assoc.startLabel.text = sanitizeDiagramText(assoc.startLabel.text);
	}
	if (assoc.endLabel?.text !== undefined) {
		assoc.endLabel.text = sanitizeDiagramText(assoc.endLabel.text);
	}
}

/** Sanitize every user-facing string on the parse tree before measure/draw so both see the same text. */
function sanitizeLayoutPart(part: LayoutPart): void {
	if (part.lines) part.lines = part.lines.map(sanitizeDiagramText);
	for (const node of part.nodes ?? []) sanitizeLayoutNode(node);
	for (const assoc of part.assocs ?? []) sanitizeAssociationLabels(assoc);
}

function sanitizeLayoutNode(node: LayoutNode): void {
	if (typeof node.id === "string") node.id = sanitizeDiagramText(node.id);
	sanitizeLayoutPart(node);
	for (const part of node.parts ?? []) sanitizeLayoutPart(part);
}

function layout(source: string, direction?: "TB" | "LR"): ParsedNomnoml | null {
	const parsed = nomnomlRuntime.parse(source);
	parsed.config = compactConfig(parsed.config, direction);
	// Narrowest entry: scrub labels/lines once before nomnoml measures and we draw.
	sanitizeLayoutPart(parsed.root);
	const measurer: Measurer = {
		setFont: () => {},
		textWidth: (text: string) => Math.max(1, Bun.stringWidth(text)),
		textHeight: () => 1,
	};
	nomnomlRuntime.layout(measurer, parsed.config, parsed.root);
	return parsed;
}

function isHidden(node: LayoutNode, config: NomnomlConfig): boolean {
	return config.styles?.[node.type ?? "class"]?.visual === "hidden";
}

/** Text rows a classifier draws inside its own border: its compartment lines, divider-separated. */
function collectNodeRows(node: LayoutNode): NodeRow[] {
	const rows: NodeRow[] = [];
	const parts = node.parts ?? [];
	for (const part of parts) {
		// Child classifiers are drawn as their own boxes by drawNode, not inlined here.
		for (const line of part.lines ?? []) {
			const trimmed = line.trim();
			if (trimmed) rows.push(trimmed);
		}
		if (rows.length > 0 && part !== parts[parts.length - 1]) rows.push(COMPARTMENT_DIVIDER);
	}
	if (rows.length === 0 && node.id) rows.push(node.id);
	return rows;
}

function nodeWidth(rows: NodeRow[]): number {
	let width = 1;
	for (const row of rows) {
		if (row !== COMPARTMENT_DIVIDER) width = Math.max(width, Bun.stringWidth(row));
	}
	return width;
}

/** Cell geometry of a classifier's border box, in the coordinate frame of its compartment. */
type NodeBox = { rows: NodeRow[]; width: number; height: number; left: number; top: number };

function nodeBox(node: LayoutNode, offsetX: number, offsetY: number): NodeBox {
	const rows = collectNodeRows(node);
	const width = Math.max(3, Math.ceil(node.width ?? nodeWidth(rows) + 2));
	const height = Math.max(3, Math.ceil(node.height ?? rows.length + 2));
	return {
		rows,
		width,
		height,
		left: offsetX + (node.x ?? 0) - width / 2,
		top: offsetY + (node.y ?? 0) - height / 2,
	};
}

/**
 * Origin nomnoml uses for a compartment's own nodes and associations: the
 * owning node's top-left, then `part.x/y`, then `part.offset`, then the gutter.
 */
function compartmentOrigin(box: NodeBox, part: LayoutPart, config: NomnomlConfig): Point {
	const gutter = config.gutter ?? 0;
	return {
		x: box.left + (part.x ?? 0) + (part.offset?.x ?? 0) + gutter,
		y: box.top + (part.y ?? 0) + (part.offset?.y ?? 0) + gutter,
	};
}

function drawNode(grid: CharGrid, node: LayoutNode, config: NomnomlConfig, offsetX = 0, offsetY = 0): void {
	const box = nodeBox(node, offsetX, offsetY);
	const { rows, width, height } = box;
	const left = Math.round(box.left);
	const top = Math.round(box.top);
	const right = left + width - 1;
	const bottom = top + height - 1;

	grid.set(left, top, "┌");
	grid.set(right, top, "┐");
	grid.set(left, bottom, "└");
	grid.set(right, bottom, "┘");
	for (let x = left + 1; x < right; x++) {
		grid.set(x, top, "─");
		grid.set(x, bottom, "─");
	}
	for (let y = top + 1; y < bottom; y++) {
		grid.set(left, y, "│");
		grid.set(right, y, "│");
	}

	const availableRows = Math.max(1, height - 2);
	for (let i = 0; i < Math.min(rows.length, availableRows); i++) {
		const row = rows[i] ?? "";
		if (row === COMPARTMENT_DIVIDER) {
			for (let x = left + 1; x < right; x++) grid.set(x, top + 1 + i, "─");
			continue;
		}
		const rowWidth = Bun.stringWidth(row);
		const x = left + 1 + Math.max(0, Math.floor((width - 2 - rowWidth) / 2));
		grid.text(x, top + 1 + i, row);
	}

	// Nested classifiers are laid out as real boxes inside their compartment, so
	// draw them there instead of flattening them into the parent's text rows.
	for (const part of node.parts ?? []) {
		const origin = compartmentOrigin(box, part, config);
		for (const child of part.nodes ?? []) {
			if (!isHidden(child, config)) drawNode(grid, child, config, origin.x, origin.y);
		}
	}
}

/**
 * Shift an association's geometry into root coordinates.
 *
 * nomnoml lays out nested content relative to the enclosing compartment, so an
 * association inside `node.parts[*]` carries part-local points. Root-level
 * associations already sit in absolute coordinates and are returned untouched.
 */
function translateAssoc(assoc: Association, dx: number, dy: number): Association {
	if (dx === 0 && dy === 0) return assoc;
	const shiftPoints = (points: Point[] | undefined): Point[] | undefined =>
		points?.map(point => ({ x: point.x + dx, y: point.y + dy }));
	const shiftLabel = (label: Label | undefined): Label | undefined =>
		label === undefined
			? undefined
			: {
					...label,
					x: label.x === undefined ? undefined : label.x + dx,
					y: label.y === undefined ? undefined : label.y + dy,
				};
	return {
		...assoc,
		path: shiftPoints(assoc.path),
		points: shiftPoints(assoc.points),
		startLabel: shiftLabel(assoc.startLabel),
		endLabel: shiftLabel(assoc.endLabel),
	};
}

/**
 * Gather every association in the tree, root-first, in root coordinates.
 *
 * Mirrors {@link drawNode}'s recursion — same `node.parts[*]` descent, same
 * {@link compartmentOrigin}, same hidden-node skip — so edges and boxes always
 * agree on what exists and where it sits. The root compartment's own
 * offset/gutter is skipped because top-level nodes are drawn without it too,
 * and a uniform shift is trimmed away by {@link CharGrid.lines}.
 */
function collectAllAssocs(
	part: LayoutPart,
	config: NomnomlConfig,
	offsetX = 0,
	offsetY = 0,
	out: Association[] = [],
	seen: Set<Association> = new Set(),
): Association[] {
	for (const assoc of part.assocs ?? []) {
		if (seen.has(assoc)) continue;
		seen.add(assoc);
		out.push(translateAssoc(assoc, offsetX, offsetY));
	}
	for (const node of part.nodes ?? []) {
		if (isHidden(node, config)) continue;
		const box = nodeBox(node, offsetX, offsetY);
		for (const child of node.parts ?? []) {
			const origin = compartmentOrigin(box, child, config);
			collectAllAssocs(child, config, origin.x, origin.y, out, seen);
		}
	}
	return out;
}

function drawAssociationLines(grid: CharGrid, assoc: Association): void {
	if (assoc.type === "-/-") return;
	const points = assoc.path ?? assoc.points ?? [];
	if (points.length < 2) return;
	for (let i = 1; i < points.length; i++) {
		const previous = points[i - 1];
		const current = points[i];
		if (!previous || !current) continue;
		drawSegment(grid, roundPoint(previous), roundPoint(current));
	}
}

function drawAssociationDecorations(grid: CharGrid, assoc: Association): void {
	if (assoc.type === "-/-") return;
	const points = assoc.path ?? assoc.points ?? [];
	if (points.length < 2) return;
	const tokens = (assoc.type ?? "").split(/[-_]/);
	drawTerminator(grid, points, true, tokens[0] ?? "");
	drawTerminator(grid, points, false, tokens[tokens.length - 1] ?? "");
	drawLabel(grid, assoc.startLabel);
	drawLabel(grid, assoc.endLabel);
}

function drawTerminator(grid: CharGrid, points: Point[], atStart: boolean, terminator: string): void {
	if (!terminator) return;
	// path = [sourceNode, ...edge.points, targetNode]; marker at path[1]/path[length-2]
	const markerPoint = atStart ? points[1] : points[points.length - 2];
	const nodePoint = atStart ? points[0] : points[points.length - 1];
	if (!markerPoint || !nodePoint) return;
	const dx = nodePoint.x - markerPoint.x;
	const dy = nodePoint.y - markerPoint.y;
	const direction = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : dy >= 0 ? "down" : "up";
	const directional = (right: string, left: string, down: string, up: string): string =>
		direction === "right" ? right : direction === "left" ? left : direction === "down" ? down : up;
	let glyph: string;
	if (terminator === ">" || terminator === "<") glyph = directional(">", "<", "v", "^");
	else if (terminator === ":>" || terminator === "<:") glyph = directional("▷", "◁", "▽", "△");
	else if (terminator === "+") glyph = "♦";
	else if (terminator === "o") glyph = "◇";
	else if (terminator === "(" || terminator === ")") glyph = directional(")", "(", "⌣", "⌢");
	else if (terminator === "(o" || terminator === "o)") glyph = "⊙";
	else if (terminator === ">o" || terminator === "o<") glyph = "⊚";
	else return;
	const point = roundPoint(markerPoint);
	grid.set(point.x, point.y, glyph);
}

function roundPoint(point: Point): Point {
	return { x: Math.round(point.x), y: Math.round(point.y) };
}

function drawSegment(grid: CharGrid, start: Point, end: Point): void {
	if (start.x !== end.x && start.y !== end.y) {
		drawSegment(grid, start, { x: end.x, y: start.y });
		drawSegment(grid, { x: end.x, y: start.y }, end);
		return;
	}
	if (start.x === end.x) {
		const min = Math.min(start.y, end.y);
		const max = Math.max(start.y, end.y);
		for (let y = min; y <= max; y++) grid.set(start.x, y, "│");
		return;
	}
	const min = Math.min(start.x, end.x);
	const max = Math.max(start.x, end.x);
	for (let x = min; x <= max; x++) grid.set(x, start.y, "─");
}

function drawLabel(grid: CharGrid, label: Label | undefined): void {
	const text = label?.text?.trim();
	if (!text || label?.x === undefined || label.y === undefined) return;
	const x = Math.round(label.x - Bun.stringWidth(text) / 2);
	const y = Math.round(label.y);
	grid.text(x, y, text);
}

function asciiDisplayWidth(ascii: string): number {
	let max = 0;
	for (const line of ascii.split("\n")) max = Math.max(max, Bun.stringWidth(line));
	return max;
}

function renderLayout(root: LayoutPart, config: NomnomlConfig): string | null {
	const width = Math.max(1, Math.ceil(root.width ?? 0) + 2);
	const height = Math.max(1, Math.ceil(root.height ?? 0) + 2);
	if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_CANVAS_CELLS) return null;
	const grid = new CharGrid(width, height);
	const assocs = collectAllAssocs(root, config);
	for (const assoc of assocs) drawAssociationLines(grid, assoc);
	for (const node of root.nodes ?? []) {
		if (!isHidden(node, config)) drawNode(grid, node, config);
	}
	for (const assoc of assocs) drawAssociationDecorations(grid, assoc);
	const lines = grid.lines();
	// Empty string = valid layout with nothing visible (e.g. all-hidden nodes).
	// null is reserved for parse/layout/oversized failure so Markdown can fall back.
	return lines.join("\n");
}

function renderVariant(source: string, direction?: "TB" | "LR"): string | null {
	const parsed = layout(source, direction);
	return parsed ? renderLayout(parsed.root, parsed.config) : null;
}

export function renderNomnomlAsciiSafe(source: string, maxWidth = 120): string | null {
	try {
		const normalizedSource = source.replace(/\r\n?/g, "\n").trim();
		if (!normalizedSource) return null;
		const base = renderVariant(normalizedSource);
		let best: string | null = base !== null && asciiDisplayWidth(base) <= maxWidth ? base : null;
		let bestWidth = best === null ? Number.POSITIVE_INFINITY : asciiDisplayWidth(best);
		for (const direction of ["TB", "LR"] as const) {
			const variant = renderVariant(normalizedSource, direction);
			if (variant === null) continue;
			const width = asciiDisplayWidth(variant);
			if (width <= maxWidth && width < bestWidth) {
				best = variant;
				bestWidth = width;
			}
		}
		return best;
	} catch {
		return null;
	}
}
