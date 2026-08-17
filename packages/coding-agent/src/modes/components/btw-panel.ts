import { type Component, Container, Markdown, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "../../tools/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

type BtwPanelState = "running" | "complete" | "branching" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	tui: TUI;
	canBranch?: () => boolean;
}

/** Never shrink the live side answer below this, even on a short terminal. */
const BTW_ANSWER_MIN_ROWS = 6;
/** Ceiling for the live side answer as a share of the viewport. */
const BTW_ANSWER_VIEWPORT_FRACTION = 0.4;

/**
 * Bounds the rendered answer so the anchored panel keeps fitting the window.
 * Delegates to the real renderer at the real width, so the visible rows cannot
 * drift from the answer the user copies or branches.
 */
class BoundedAnswer implements Component {
	constructor(
		private readonly answer: Component,
		private readonly maxRows: () => number,
	) {}

	render(width: number): readonly string[] {
		const rows = this.answer.render(width);
		const limit = Math.max(1, this.maxRows());
		if (rows.length <= limit) return rows;
		const hidden = rows.length - (limit - 1);
		// Keep the tail: a streaming answer is read at its newest end.
		return [
			theme.fg("dim", `… ${hidden} earlier ${hidden === 1 ? "row" : "rows"} — c copy for the full answer`),
			...rows.slice(rows.length - (limit - 1)),
		];
	}
}

class BtwFooter implements Component {
	#getLine: () => string;
	#line: string | undefined;
	#text: Text | undefined;

	constructor(getLine: () => string) {
		this.#getLine = getLine;
	}

	render(width: number): readonly string[] {
		const line = this.#getLine();
		if (line !== this.#line || !this.#text) {
			this.#line = line;
			this.#text = new Text(line, 1, 0);
		}
		return this.#text.render(width);
	}
}

export class BtwPanelComponent extends Container {
	#question: string;
	#tui: TUI;
	#canBranch: (() => boolean) | undefined;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#visibleAnswer = "";
	#closed = false;

	constructor(options: BtwPanelComponentOptions) {
		super();
		this.#question = options.question;
		this.#tui = options.tui;
		this.#canBranch = options.canBranch;
		this.#rebuild();
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer += delta;
		this.#visibleAnswer = replaceTabs(this.#answer).trim();
		this.#rebuild();
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = text;
		this.#visibleAnswer = replaceTabs(text).trim();
		this.#rebuild();
	}

	markComplete(): void {
		if (this.#closed) return;
		this.#state = "complete";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	/** Shows that the completed answer is being promoted into the chat session. */
	markBranching(): void {
		if (this.#closed) return;
		this.#state = "branching";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#errorMessage = message;
		this.#rebuild();
	}

	isBranchable(): boolean {
		return this.isCopyable();
	}

	isCopyable(): boolean {
		return this.#state === "complete" && this.#visibleAnswer.length > 0;
	}

	getCopyText(): string | undefined {
		if (!this.isCopyable()) return undefined;
		return this.#visibleAnswer;
	}

	close(): void {
		this.#closed = true;
	}

	#rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", replaceTabs(this.#question)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#contentComponent());
		this.addChild(new Spacer(1));
		this.addChild(new BtwFooter(() => this.#footerLine()));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		// Component-scoped: a rebuild replaces only this panel's own children
		// (streaming deltas arrive per token, and a full compose would re-walk
		// the whole transcript each time). Before the panel is mounted the TUI
		// cannot resolve it and falls back to a full compose on its own.
		this.#tui.requestComponentRender(this);
	}

	#footerLine(): string {
		switch (this.#state) {
			case "running":
				return theme.fg("muted", "Esc cancel /btw");
			case "complete": {
				if (!this.isCopyable()) return theme.fg("muted", "Esc dismiss");
				const actions = ["c copy"];
				if (this.#canBranch?.() ?? this.isBranchable()) actions.push("b branch to chat");
				actions.push("Esc dismiss");
				return theme.fg("muted", actions.join(" · "));
			}
			case "branching":
				return theme.fg("muted", `${theme.status.pending} Branching to chat…`);
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} Cancelled · Esc dismiss`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · Esc dismiss`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(theme.fg("error", replaceTabs(this.#errorMessage ?? "Unknown error")), 1, 0);
		}
		const text = this.#visibleAnswer;
		if (!text) {
			const waiting =
				this.#state === "running" ? `${theme.status.pending} Waiting for response…` : "No text returned.";
			return new Text(theme.fg("dim", waiting), 1, 0);
		}
		return new BoundedAnswer(new Markdown(text, 1, 0, getMarkdownTheme()), () => this.#maxAnswerRows());
	}

	/**
	 * The panel lives in the anchored live region above the editor, which the
	 * engine can only keep out of native scrollback while it fits the window.
	 * A long side answer that outgrows it scrolls off, commits as history, and
	 * then re-commits from its new position on the next rebuild — the answer
	 * piles up in chunks while it is still streaming. Bound the live view the
	 * same way queued command output is bounded; the full text stays one `c`
	 * away and `b` still promotes all of it into the chat.
	 */
	#maxAnswerRows(): number {
		// Hosts that render the panel outside a real terminal (tests, headless
		// probes) expose no viewport; fall back to the floor rather than assuming.
		const viewport = this.#tui.terminal?.rows;
		if (typeof viewport !== "number" || !Number.isFinite(viewport) || viewport <= 0) return BTW_ANSWER_MIN_ROWS;
		return Math.max(BTW_ANSWER_MIN_ROWS, Math.trunc(viewport * BTW_ANSWER_VIEWPORT_FRACTION));
	}
}
