import { countTokens } from "@oh-my-pi/pi-agent-core";
import type { Context, Message } from "@oh-my-pi/pi-ai";

type JsonPrimitive = string | number | boolean | null;
type FlatRow = Record<string, JsonPrimitive>;
type ColumnType = "string" | "number" | "boolean" | "null";

interface Column {
	name: string;
	type: ColumnType;
	optional: boolean;
}

interface CsvCell {
	value: string;
	quoted: boolean;
}

const MIN_ROWS = 2;
const SAFE_COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NUMBER_LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
/** Mirrors snapcompact's token floor so both transforms classify the same input scale. */
export const MIN_LOSSLESS_REENCODE_TOKENS = 3000;
/** Stage 1 intentionally stops at the existing inline-result cap. */
export const MAX_LOSSLESS_REENCODE_BYTES = 50 * 1024;
/** Adjacent snapcompact precedent: the complete replacement must save at least 10% of estimated tokens. */
export const LOSSLESS_REENCODE_SAVINGS_MARGIN = 0.9;

/**
 * Re-encode an eligible JSON array, otherwise return the original bytes.
 *
 * Format v1 is deliberately conservative:
 * - at least two flat objects with at least one shared, always-present key;
 * - sorted ASCII-safe column names and one non-null primitive type per column;
 * - an unquoted empty cell is absent, unquoted `null` is null, and `""` is an
 *   empty string (the literal string `null` is quoted);
 * - JSON number literals must already equal canonical `JSON.stringify` output,
 *   be finite safe integers when integral, and must not be negative zero.
 */
export function reencodeLosslessJsonArray(input: string): string {
	return encodeLosslessJsonTable(input) ?? input;
}

/** Encode an eligible JSON array as the deterministic v1 schema+CSV format. */
export function encodeLosslessJsonTable(input: string): string | undefined {
	try {
		const rows = new FlatJsonArrayParser(input).parse();
		const columns = inferColumns(rows);
		if (!columns) return undefined;
		const encoded = encodeRows(rows, columns);
		const decoded = decodeLosslessJsonTable(encoded);
		return decoded && equalRows(rows, decoded) ? encoded : undefined;
	} catch {
		return undefined;
	}
}

/** Decode the deterministic v1 schema+CSV format, rejecting malformed input. */
export function decodeLosslessJsonTable(encoded: string): FlatRow[] | undefined {
	try {
		const newline = encoded.indexOf("\n");
		if (newline < 0) return undefined;
		const columns = parseHeader(encoded.slice(0, newline));
		if (!columns) return undefined;
		const cells = parseCsv(encoded.slice(newline + 1));
		if (!cells || cells.length !== columns.rowCount) return undefined;

		const rows: FlatRow[] = [];
		for (const csvRow of cells) {
			if (csvRow.length !== columns.items.length) return undefined;
			const row: FlatRow = {};
			for (let i = 0; i < columns.items.length; i++) {
				const column = columns.items[i];
				const cell = csvRow[i];
				const decoded = decodeCell(cell, column);
				if (!decoded.ok) return undefined;
				if (!decoded.absent) {
					Object.defineProperty(row, column.name, {
						value: decoded.value,
						enumerable: true,
						configurable: true,
						writable: true,
					});
				}
			}
			rows.push(row);
		}
		return rows;
	} catch {
		return undefined;
	}
}

export interface LosslessReencodeOptions {
	toolAllowlist: readonly string[];
}

export interface LosslessReencodeSwap {
	messageIndex: number;
	blockIndex: number;
	replacement: string;
}

/**
 * Plan deterministic historical tool-result replacements without mutating the
 * provider context. Candidates are visited oldest-first and the newest tool
 * result is a stable frontier that always remains verbatim.
 */
export function planLosslessReencodes(
	messages: readonly Message[],
	options: LosslessReencodeOptions,
): LosslessReencodeSwap[] {
	if (!Array.isArray(options.toolAllowlist) || options.toolAllowlist.length === 0) return [];
	let newestToolResultIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "toolResult") {
			newestToolResultIndex = i;
			break;
		}
	}
	if (newestToolResultIndex < 0) return [];

	const swaps: LosslessReencodeSwap[] = [];
	for (let messageIndex = 0; messageIndex < newestToolResultIndex; messageIndex++) {
		const message = messages[messageIndex];
		if (message.role !== "toolResult") continue;
		if (!options.toolAllowlist.includes(message.toolName)) continue;
		for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
			const block = message.content[blockIndex];
			if (block.type !== "text") continue;
			const originalBytes = Buffer.byteLength(block.text, "utf8");
			if (originalBytes > MAX_LOSSLESS_REENCODE_BYTES) continue;
			const originalTokens = countTokens(block.text);
			if (originalTokens < MIN_LOSSLESS_REENCODE_TOKENS) continue;
			const encoded = encodeLosslessJsonTable(block.text);
			if (!encoded) continue;
			const marker = `[lossless-reencode v1 schema+csv; values exact, formatting/key-order normalized; original=${originalBytes}B]`;
			const replacement = `${marker}\n${encoded}`;
			const replacementBytes = Buffer.byteLength(replacement, "utf8");
			// Token savings are the goal and match snapcompact's precedent. The
			// byte guard is independent defense against pathological wire growth.
			if (replacementBytes > originalBytes) continue;
			if (countTokens(replacement) > originalTokens * LOSSLESS_REENCODE_SAVINGS_MARGIN) continue;
			swaps.push({ messageIndex, blockIndex, replacement });
		}
	}
	return swaps;
}

/** Apply the pure plan to fresh message/content arrays for provider dispatch. */
export function transformLosslessToolResults(context: Context, options: LosslessReencodeOptions): Context {
	const swaps = planLosslessReencodes(context.messages, options);
	if (swaps.length === 0) return context;

	const messages = [...context.messages];
	for (const swap of swaps) {
		const message = messages[swap.messageIndex];
		if (message.role !== "toolResult") continue;
		const content = [...message.content];
		const block = content[swap.blockIndex];
		if (block?.type !== "text") continue;
		content[swap.blockIndex] = { ...block, text: swap.replacement };
		messages[swap.messageIndex] = { ...message, content };
	}
	return { ...context, messages };
}

class FlatJsonArrayParser {
	#index = 0;

	constructor(readonly input: string) {}

	parse(): FlatRow[] {
		this.#skipWhitespace();
		this.#expect("[");
		this.#skipWhitespace();
		const rows: FlatRow[] = [];
		if (this.#peek() === "]") {
			this.#index++;
		} else {
			while (true) {
				rows.push(this.#parseObject());
				this.#skipWhitespace();
				const next = this.#peek();
				if (next === "]") {
					this.#index++;
					break;
				}
				this.#expect(",");
				this.#skipWhitespace();
			}
		}
		this.#skipWhitespace();
		if (this.#index !== this.input.length || rows.length < MIN_ROWS) throw new Error("Unsupported JSON array");
		return rows;
	}

	#parseObject(): FlatRow {
		this.#expect("{");
		this.#skipWhitespace();
		const row: FlatRow = {};
		const keys = new Set<string>();
		if (this.#peek() === "}") {
			this.#index++;
			return row;
		}

		while (true) {
			if (this.#peek() !== '"') throw new Error("Object key must be a string");
			const key = this.#parseString();
			if (!SAFE_COLUMN_NAME.test(key) || keys.has(key)) throw new Error("Unsupported or duplicate key");
			keys.add(key);
			this.#skipWhitespace();
			this.#expect(":");
			this.#skipWhitespace();
			const value = this.#parsePrimitive();
			Object.defineProperty(row, key, {
				value,
				enumerable: true,
				configurable: true,
				writable: true,
			});
			this.#skipWhitespace();
			const next = this.#peek();
			if (next === "}") {
				this.#index++;
				return row;
			}
			this.#expect(",");
			this.#skipWhitespace();
		}
	}

	#parsePrimitive(): JsonPrimitive {
		const next = this.#peek();
		if (next === '"') return this.#parseString();
		if (next === "t") return this.#literal("true", true);
		if (next === "f") return this.#literal("false", false);
		if (next === "n") return this.#literal("null", null);
		if (next === "{" || next === "[") throw new Error("Nested values are unsupported");

		NUMBER_LITERAL.lastIndex = this.#index;
		const match = NUMBER_LITERAL.exec(this.input);
		if (!match) throw new Error("Expected primitive value");
		const raw = match[0];
		this.#index += raw.length;
		const value = Number(raw);
		if (!isCanonicalNumber(raw, value)) throw new Error("Non-canonical number");
		return value;
	}

	#parseString(): string {
		const start = this.#index;
		this.#expect('"');
		while (this.#index < this.input.length) {
			const code = this.input.charCodeAt(this.#index);
			if (code === 0x22) {
				this.#index++;
				const value = JSON.parse(this.input.slice(start, this.#index)) as string;
				if (!value.isWellFormed()) throw new Error("Ill-formed JSON string");
				return value;
			}
			if (code < 0x20) throw new Error("Control character in JSON string");
			if (code !== 0x5c) {
				this.#index++;
				continue;
			}
			this.#index++;
			const escapeCode = this.input[this.#index];
			if (!escapeCode || !'"\\/bfnrtu'.includes(escapeCode)) throw new Error("Invalid JSON escape");
			this.#index++;
			if (escapeCode === "u") {
				const hex = this.input.slice(this.#index, this.#index + 4);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("Invalid Unicode escape");
				this.#index += 4;
			}
		}
		throw new Error("Unterminated JSON string");
	}

	#literal<T extends JsonPrimitive>(text: string, value: T): T {
		if (!this.input.startsWith(text, this.#index)) throw new Error("Invalid literal");
		this.#index += text.length;
		return value;
	}

	#skipWhitespace(): void {
		while (this.#index < this.input.length && /[\t\n\r ]/.test(this.input[this.#index])) this.#index++;
	}

	#expect(expected: string): void {
		if (this.input[this.#index] !== expected) throw new Error(`Expected ${expected}`);
		this.#index++;
	}

	#peek(): string | undefined {
		return this.input[this.#index];
	}
}

function inferColumns(rows: FlatRow[]): Column[] | undefined {
	const names = [...new Set(rows.flatMap(row => Object.keys(row)))].sort();
	if (names.length === 0 || !names.some(name => rows.every(row => Object.hasOwn(row, name)))) return undefined;

	const columns: Column[] = [];
	for (const name of names) {
		let type: Exclude<ColumnType, "null"> | undefined;
		let optional = false;
		for (const row of rows) {
			if (!Object.hasOwn(row, name)) {
				optional = true;
				continue;
			}
			const value = row[name];
			if (value === null) continue;
			const valueType = typeof value;
			if (valueType !== "string" && valueType !== "number" && valueType !== "boolean") return undefined;
			if (type && type !== valueType) return undefined;
			type = valueType;
		}
		columns.push({ name, type: type ?? "null", optional });
	}
	return columns;
}

function encodeRows(rows: FlatRow[], columns: Column[]): string {
	const header = `[${rows.length}]{${columns
		.map(column => `${column.name}:${column.type}${column.optional ? "?" : ""}`)
		.join(",")}}`;
	const body = rows.map(row => columns.map(column => encodeCell(row, column)).join(",")).join("\n");
	return `${header}\n${body}`;
}

function encodeCell(row: FlatRow, column: Column): string {
	if (!Object.hasOwn(row, column.name)) return "";
	const value = row[column.name];
	if (value === null) return "null";
	if (typeof value === "string") return encodeCsvString(value);
	return JSON.stringify(value);
}

function encodeCsvString(value: string): string {
	if (value === "" || value === "null" || /[",\r\n]/.test(value) || /^\s|\s$/u.test(value)) {
		return `"${value.replaceAll('"', '""')}"`;
	}
	return value;
}

function parseHeader(header: string): { rowCount: number; items: Column[] } | undefined {
	const match = /^\[(\d+)]\{(.*)}$/.exec(header);
	if (!match) return undefined;
	const rowCount = Number(match[1]);
	if (!Number.isSafeInteger(rowCount) || rowCount < MIN_ROWS || match[2].length === 0) return undefined;

	const items: Column[] = [];
	const seen = new Set<string>();
	for (const descriptor of match[2].split(",")) {
		const column = /^([A-Za-z_][A-Za-z0-9_.-]*):(string|number|boolean|null)(\?)?$/.exec(descriptor);
		if (!column || seen.has(column[1])) return undefined;
		if (items.length > 0 && items[items.length - 1].name >= column[1]) return undefined;
		seen.add(column[1]);
		items.push({ name: column[1], type: column[2] as ColumnType, optional: column[3] === "?" });
	}
	return { rowCount, items };
}

function parseCsv(body: string): CsvCell[][] | undefined {
	if (body.length === 0 || body.endsWith("\n")) return undefined;
	const rows: CsvCell[][] = [];
	let row: CsvCell[] = [];
	let index = 0;

	while (index < body.length) {
		let value = "";
		let quoted = false;
		if (body[index] === '"') {
			quoted = true;
			index++;
			let closed = false;
			while (index < body.length) {
				const char = body[index++];
				if (char !== '"') {
					value += char;
					continue;
				}
				if (body[index] === '"') {
					value += '"';
					index++;
					continue;
				}
				closed = true;
				break;
			}
			if (!closed) return undefined;
		} else {
			const start = index;
			while (index < body.length && body[index] !== "," && body[index] !== "\n") {
				if (body[index] === '"' || body[index] === "\r") return undefined;
				index++;
			}
			value = body.slice(start, index);
		}

		row.push({ value, quoted });
		if (index === body.length) {
			rows.push(row);
			break;
		}
		if (body[index] === ",") {
			index++;
			if (index === body.length) {
				row.push({ value: "", quoted: false });
				rows.push(row);
			}
			continue;
		}
		if (body[index] === "\n") {
			rows.push(row);
			row = [];
			index++;
			continue;
		}
		return undefined;
	}
	return rows;
}

function decodeCell(
	cell: CsvCell,
	column: Column,
): { ok: true; absent: boolean; value?: JsonPrimitive } | { ok: false } {
	if (!cell.quoted && cell.value === "") return column.optional ? { ok: true, absent: true } : { ok: false };
	if (!cell.quoted && cell.value === "null") return { ok: true, absent: false, value: null };
	if (column.type === "null") return { ok: false };
	if (column.type === "string") return { ok: true, absent: false, value: cell.value };
	if (cell.quoted) return { ok: false };
	if (column.type === "boolean") {
		if (cell.value === "true") return { ok: true, absent: false, value: true };
		if (cell.value === "false") return { ok: true, absent: false, value: false };
		return { ok: false };
	}
	const value = Number(cell.value);
	return isCanonicalNumber(cell.value, value) ? { ok: true, absent: false, value } : { ok: false };
}

function isCanonicalNumber(raw: string, value: number): boolean {
	if (!Number.isFinite(value) || Object.is(value, -0)) return false;
	if (Number.isInteger(value) && !Number.isSafeInteger(value)) return false;
	return JSON.stringify(value) === raw;
}

function equalRows(left: FlatRow[], right: FlatRow[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		const leftKeys = Object.keys(left[i]).sort();
		const rightKeys = Object.keys(right[i]).sort();
		if (leftKeys.length !== rightKeys.length) return false;
		for (let k = 0; k < leftKeys.length; k++) {
			const key = leftKeys[k];
			if (key !== rightKeys[k] || !Object.is(left[i][key], right[i][key])) return false;
		}
	}
	return true;
}
