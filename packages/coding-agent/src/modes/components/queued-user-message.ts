import type { Component, MarkdownTheme } from "@oh-my-pi/pi-tui";
import { Markdown, padding, visibleWidth } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme";

export class QueuedUserMessageComponent implements Component {
	readonly #markdown: Markdown;
	readonly #getSpinnerFrame: () => number;
	readonly #spinnerFrames: string[];
	readonly #spinnerColorFn: (value: string) => string;
	readonly #prefixWidth: number;
	readonly #markdownTheme: MarkdownTheme;

	constructor(options: {
		text: string;
		getSpinnerFrame: () => number;
		spinnerFrames?: string[];
		prefixWidth?: number;
		spinnerColorFn?: (value: string) => string;
	}) {
		this.#getSpinnerFrame = options.getSpinnerFrame;
		this.#spinnerFrames = options.spinnerFrames?.length ? options.spinnerFrames : theme.getSpinnerFrames("activity");
		this.#spinnerColorFn = options.spinnerColorFn ?? (value => theme.fg("dim", value));
		this.#prefixWidth = Math.max(2, Math.floor(options.prefixWidth ?? 3));
		this.#markdownTheme = getMarkdownTheme();

		const bgColor = (value: string) => theme.bg("userMessageBg", value);
		const color = (value: string) => theme.fg("userMessageText", value);
		this.#markdown = new Markdown(options.text, 1, 1, this.#markdownTheme, { bgColor, color });
	}

	invalidate(): void {
		this.#markdown.invalidate();
	}

	render(width: number): string[] {
		if (width <= 0) return [];

		const frameIndex = this.#getSpinnerFrame();
		const frame = this.#spinnerFrames.length > 0 ? this.#spinnerFrames[frameIndex % this.#spinnerFrames.length] : "";
		const spinner = frame ? this.#spinnerColorFn(frame) : "";

		const bubbleWidth = Math.max(1, width - this.#prefixWidth);
		const bubbleLines = this.#markdown.render(bubbleWidth);
		if (bubbleLines.length === 0) return [];

		const centerIndex = Math.floor((bubbleLines.length - 1) / 2);

		const emptyPrefix = padding(this.#prefixWidth);
		const spinnerVisWidth = visibleWidth(spinner);
		const spinnerPrefix = spinner + padding(Math.max(0, this.#prefixWidth - spinnerVisWidth));

		const combined: string[] = [];
		for (let i = 0; i < bubbleLines.length; i++) {
			const prefix = i === centerIndex ? spinnerPrefix : emptyPrefix;
			combined.push(prefix + bubbleLines[i]);
		}

		return ["", ...combined];
	}
}
