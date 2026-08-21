export interface ProgressLine {
	text: string;
	truncated: boolean;
}

/** Incrementally reports complete, non-empty output lines with bounded partial state. */
export class ProgressLines {
	static readonly MAX_LINE_CHARS = 500;
	static readonly #HEAD_CHARS = Math.floor(ProgressLines.MAX_LINE_CHARS / 2);
	static readonly #TAIL_CHARS = ProgressLines.MAX_LINE_CHARS - ProgressLines.#HEAD_CHARS;
	readonly #report: (line: ProgressLine) => void;
	#partial = "";
	#head = "";
	#tail = "";
	#truncated = false;

	constructor(report: (line: ProgressLine) => void) {
		this.#report = report;
	}

	append(chunk: string): void {
		let start = 0;
		let newline = chunk.indexOf("\n");
		while (newline !== -1) {
			this.#appendPartial(chunk.slice(start, newline));
			this.#reportLine(this.#partial);
			this.#partial = "";
			this.#head = "";
			this.#tail = "";
			this.#truncated = false;
			start = newline + 1;
			newline = chunk.indexOf("\n", start);
		}
		if (start < chunk.length) this.#appendPartial(chunk.slice(start));
	}

	finish(): void {
		if (this.#partial === "" && !this.#truncated) return;
		const line = this.#partial;
		this.#partial = "";
		this.#reportLine(line);
		this.#head = "";
		this.#tail = "";
		this.#truncated = false;
	}

	reset(): void {
		this.#partial = "";
		this.#head = "";
		this.#tail = "";
		this.#truncated = false;
	}

	#appendPartial(segment: string): void {
		if (this.#truncated) {
			this.#tail =
				segment.length >= ProgressLines.#TAIL_CHARS
					? segment.slice(-ProgressLines.#TAIL_CHARS)
					: `${this.#tail.slice(-(ProgressLines.#TAIL_CHARS - segment.length))}${segment}`;
			return;
		}
		if (this.#partial.length + segment.length <= ProgressLines.MAX_LINE_CHARS) {
			this.#partial += segment;
			return;
		}
		this.#head = `${this.#partial}${segment.slice(0, ProgressLines.#HEAD_CHARS)}`.slice(0, ProgressLines.#HEAD_CHARS);
		this.#tail =
			segment.length >= ProgressLines.#TAIL_CHARS
				? segment.slice(-ProgressLines.#TAIL_CHARS)
				: `${this.#partial.slice(-(ProgressLines.#TAIL_CHARS - segment.length))}${segment}`;
		this.#partial = "";
		this.#truncated = true;
	}

	#reportLine(rawLine: string): void {
		const preview = this.#truncated ? `${this.#head}${this.#tail}` : rawLine;
		const line = preview.replace(/\r$/, "");
		if (line.trim().length === 0) return;
		this.#report({ text: line, truncated: this.#truncated });
	}
}
