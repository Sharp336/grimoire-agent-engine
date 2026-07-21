import { type Component, Container, Markdown, Spacer, Text, type TUI, truncateToWidth } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "../../tools/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

type BtwPanelState = "running" | "complete" | "aborted" | "error";

export type ConsultationPanelStatus =
	| "saving-boundary"
	| "consulting-model"
	| "streaming-turn"
	| "saving"
	| "saved"
	| "cancelled"
	| "failed";

export interface ConsultationPanelView {
	threadId: string;
	title: string;
	turnIndex: number;
	turnCount: number;
	status: ConsultationPanelStatus;
	question: string;
	answer: string;
	isLatest: boolean;
	contextNotice?: string;
}

interface BtwPanelComponentOptions {
	question: string;
	tui: TUI;
	commandLabel?: "/btw" | "/consult";
	allowBranch?: boolean;
	completionHint?: string;
	consultation?: ConsultationPanelView;
}

export class BtwPanelComponent extends Container {
	#question: string;
	#tui: TUI;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#visibleAnswer = "";
	#closed = false;
	#commandLabel: "/btw" | "/consult";
	#allowBranch: boolean;
	#completionHint: string;
	#consultation: ConsultationPanelView | undefined;
	#consultationWaitingText: Text | undefined;
	#consultationAnswerComponent: Markdown | undefined;
	#consultationHeaderComponent: Text | undefined;
	#consultationQuestionComponent: Text | undefined;
	#consultationNoticeComponent: Text | undefined;
	#consultationFooterComponent: Text | undefined;
	#consultationBorder = new DynamicBorder(str => theme.fg("dim", str));
	#consultationScrollOffset = 0;
	#consultationLastSeenAnswerLength = 0;
	#consultationAnswerRowCount = 0;
	#consultationViewportVersion = 0;
	#consultationViewportCache: readonly string[] | undefined;
	#consultationViewportCacheWidth = -1;
	#consultationViewportCacheVersion = -1;
	#consultationRenderScheduled = false;
	#consultationRenderGeneration = 0;

	constructor(options: BtwPanelComponentOptions) {
		super();
		this.#question = options.question;
		this.#tui = options.tui;
		this.#commandLabel = options.commandLabel ?? "/btw";
		this.#allowBranch = options.allowBranch ?? true;
		this.#completionHint = options.completionHint ?? "c copy · b branch to chat · Esc dismiss";
		this.#consultation = options.consultation;
		if (this.#consultation) {
			this.#question = this.#consultation.question;
			this.#answer = this.#consultation.answer;
			this.#visibleAnswer = replaceTabs(this.#answer).trim();
			this.#consultationScrollOffset = Number.MAX_SAFE_INTEGER;
			this.#consultationLastSeenAnswerLength = this.#answer.length;
		}
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

	/**
	 * Replace the consultation snapshot. Answer-only changes keep the existing
	 * panel tree and mutate its reply child in place; selection and terminal
	 * transitions retain the simpler structural rebuild.
	 */
	setConsultationView(view: ConsultationPanelView): void {
		if (this.#closed) return;
		const previous = this.#consultation;
		const answerChanged = previous?.answer !== view.answer;
		const turnChanged = previous?.threadId !== view.threadId || previous?.turnIndex !== view.turnIndex;
		this.#consultation = { ...view };
		this.#question = view.question;
		this.#answer = view.answer;
		this.#visibleAnswer = replaceTabs(view.answer).trim();
		if (turnChanged) {
			this.#consultationScrollOffset = Number.MAX_SAFE_INTEGER;
			this.#consultationLastSeenAnswerLength = this.#answer.length;
		} else if (answerChanged && this.#isAtConsultationBottom()) {
			// Keep the viewport pinned to the tail across a live append. The
			// actual max is recalculated from rendered rows below.
			this.#consultationScrollOffset = Number.MAX_SAFE_INTEGER;
			this.#consultationLastSeenAnswerLength = this.#answer.length;
		}
		if (!previous || this.#consultationStructureChanged(previous, view)) {
			this.#rebuildConsultation();
			return;
		}
		this.#updateConsultationAnswer(view);
	}

	/**
	 * Append a live consultation delta without replacing the panel tree. The
	 * controller calls this only while the latest visible turn is already in
	 * its streaming state.
	 */
	appendConsultationText(delta: string): void {
		if (!delta || this.#closed || !this.#consultation) return;
		const wasAtBottom = this.#isAtConsultationBottom();
		this.#answer += delta;
		this.#visibleAnswer = replaceTabs(this.#answer).trim();
		this.#consultation = { ...this.#consultation, answer: this.#answer };
		if (wasAtBottom) {
			this.#consultationScrollOffset = Number.MAX_SAFE_INTEGER;
			this.#consultationLastSeenAnswerLength = this.#answer.length;
		}
		this.#updateConsultationAnswer(this.#consultation);
	}

	markComplete(): void {
		if (this.#closed) return;
		this.#state = "complete";
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
		return this.#allowBranch && this.isCopyable();
	}

	isCopyable(): boolean {
		if (this.#consultation) return this.#visibleAnswer.length > 0;
		return this.#state === "complete" && this.#visibleAnswer.length > 0;
	}

	getCopyText(): string | undefined {
		if (!this.isCopyable()) return undefined;
		return this.#visibleAnswer;
	}

	/**
	 * Scroll the bounded consultation answer viewport without moving the
	 * editor's cursor. Follow state is the physical bottom position, rather
	 * than a separate sticky mode, so every route to the bottom resumes it.
	 */
	scrollConsultationAnswer(delta: number): boolean {
		if (!this.#consultation || this.#closed || !Number.isFinite(delta)) return false;
		const maxOffset = this.#consultationMaxOffset();
		const nextOffset = Math.max(0, Math.min(maxOffset, this.#consultationScrollOffset + Math.trunc(delta)));
		const changed = nextOffset !== this.#consultationScrollOffset;
		this.#consultationScrollOffset = nextOffset;
		this.#markConsultationAnswerSeenAtBottom();
		this.#updateConsultationFooter();
		this.#invalidateConsultationViewport();
		this.#scheduleConsultationRender();
		return changed;
	}

	scrollConsultationAnswerPage(direction: -1 | 1): boolean {
		const page = Math.max(1, this.#consultationAnswerViewportRows() - 1);
		return this.scrollConsultationAnswer(direction * page);
	}

	/** Return to the latest reply row and resume streaming tail-follow. */
	followConsultationAnswer(): boolean {
		if (!this.#consultation || this.#closed) return false;
		this.#consultationScrollOffset = this.#consultationMaxOffset();
		this.#markConsultationAnswerSeenAtBottom();
		this.#updateConsultationFooter();
		this.#invalidateConsultationViewport();
		this.#scheduleConsultationRender();
		return true;
	}

	close(): void {
		this.#closed = true;
		// A queued microtask cannot be unscheduled, so invalidate it before it
		// reaches the TUI. This prevents a dismissed consultation from repainting
		// its formerly anchored live region after another panel takes ownership.
		this.#consultationRenderScheduled = false;
		this.#consultationRenderGeneration++;
		this.#consultationViewportCache = undefined;
	}

	render(width: number): readonly string[] {
		if (!this.#consultation) return super.render(width);
		const safeWidth = Math.max(1, width);
		if (
			this.#consultationViewportCache &&
			this.#consultationViewportCacheWidth === safeWidth &&
			this.#consultationViewportCacheVersion === this.#consultationViewportVersion
		) {
			return this.#consultationViewportCache;
		}
		const rows = this.#renderConsultationViewport(safeWidth);
		this.#consultationViewportCache = rows;
		this.#consultationViewportCacheWidth = safeWidth;
		this.#consultationViewportCacheVersion = this.#consultationViewportVersion;
		return rows;
	}

	invalidate(): void {
		super.invalidate();
		this.#consultationBorder.invalidate();
		this.#invalidateConsultationViewport();
	}

	#rebuild(): void {
		if (this.#consultation) {
			this.#rebuildConsultation();
			return;
		}
		this.clear();
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", replaceTabs(this.#question)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#contentComponent());
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.#footerLine(), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		// Component-scoped: a rebuild replaces only this panel's own children
		// (streaming deltas arrive per token, and a full compose would re-walk
		// the whole transcript each time). Before the panel is mounted the TUI
		// cannot resolve it and falls back to a full compose on its own.
		this.#tui.requestComponentRender(this);
	}

	#rebuildConsultation(): void {
		const view = this.#consultation;
		if (!view) return;
		this.clear();
		this.#consultationHeaderComponent = new Text(this.#consultationHeader(view), 1, 0);
		this.#consultationQuestionComponent = new Text(theme.fg("accent", `Q: ${replaceTabs(view.question)}`), 1, 0);
		this.#consultationNoticeComponent = view.contextNotice
			? new Text(theme.fg("warning", view.contextNotice), 1, 0)
			: undefined;
		this.#consultationWaitingText = new Text(this.#visibleAnswer ? "" : this.#consultationEmptyText(view), 1, 0);
		this.#consultationAnswerComponent = new Markdown(this.#visibleAnswer, 1, 0, getMarkdownTheme());
		this.#consultationFooterComponent = new Text(this.#consultationFooter(view), 1, 0);
		this.#invalidateConsultationViewport();
		this.#scheduleConsultationRender();
	}

	#consultationStructureChanged(previous: ConsultationPanelView, next: ConsultationPanelView): boolean {
		return (
			previous.threadId !== next.threadId ||
			previous.title !== next.title ||
			previous.turnIndex !== next.turnIndex ||
			previous.turnCount !== next.turnCount ||
			previous.status !== next.status ||
			previous.question !== next.question ||
			previous.isLatest !== next.isLatest ||
			previous.contextNotice !== next.contextNotice
		);
	}

	#updateConsultationAnswer(view: ConsultationPanelView): void {
		if (!this.#consultationAnswerComponent || !this.#consultationWaitingText || !this.#consultationFooterComponent) {
			this.#rebuildConsultation();
			return;
		}
		this.#consultationWaitingText.setText(this.#visibleAnswer ? "" : this.#consultationEmptyText(view));
		this.#consultationAnswerComponent.setText(this.#visibleAnswer);
		this.#updateConsultationFooter();
		this.#invalidateConsultationViewport();
		this.#scheduleConsultationRender();
	}

	#updateConsultationFooter(): void {
		if (this.#consultation && this.#consultationFooterComponent) {
			this.#consultationFooterComponent.setText(this.#consultationFooter(this.#consultation));
		}
	}

	#consultationMaxOffset(): number {
		return Math.max(0, this.#consultationAnswerRowCount - this.#consultationAnswerViewportRows());
	}

	#isAtConsultationBottom(): boolean {
		return this.#consultationScrollOffset >= this.#consultationMaxOffset();
	}

	#hasUnseenConsultationOutput(): boolean {
		return !this.#isAtConsultationBottom() && this.#answer.length > this.#consultationLastSeenAnswerLength;
	}

	#markConsultationAnswerSeenAtBottom(): void {
		if (this.#isAtConsultationBottom()) this.#consultationLastSeenAnswerLength = this.#answer.length;
	}

	#invalidateConsultationViewport(): void {
		this.#consultationViewportVersion++;
		this.#consultationViewportCache = undefined;
	}

	#consultationRowBudget(): number {
		const terminalRows =
			Number.isFinite(this.#tui.terminal?.rows) && (this.#tui.terminal?.rows ?? 0) > 0
				? (this.#tui.terminal?.rows ?? 40)
				: (process.stdout.rows ?? 40);
		return Math.max(1, Math.min(terminalRows, Math.min(20, Math.max(8, Math.round(terminalRows * 0.4)))));
	}

	#consultationAnswerViewportRows(includeQuestion = true): number {
		const budget = this.#consultationRowBudget();
		if (budget < 3) return 1;

		const chromeRows = 2 + (budget >= 6 ? 2 : 0) + (this.#consultationNoticeComponent ? 1 : 0);
		const questionRows =
			includeQuestion && this.#consultation && !this.#isTerminalConsultationStatus(this.#consultation.status)
				? Math.min(1, Math.max(0, budget - chromeRows - 1))
				: 0;
		return Math.max(1, budget - chromeRows - questionRows);
	}

	#clipConsultationRows(rows: readonly string[], maxRows: number, width: number): string[] {
		if (maxRows <= 0) return [];
		const clipped = rows.slice(0, maxRows).map(row => truncateToWidth(row, width));
		if (rows.length > maxRows) {
			const last = clipped.length - 1;
			clipped[last] = width <= 1 ? "…" : `${truncateToWidth(clipped[last] ?? "", Math.max(1, width - 1))}…`;
		}
		return clipped;
	}

	#renderConsultationViewport(width: number): readonly string[] {
		const view = this.#consultation;
		const header = this.#consultationHeaderComponent;
		const question = this.#consultationQuestionComponent;
		const footer = this.#consultationFooterComponent;
		const answer = this.#consultationAnswerComponent;
		const waiting = this.#consultationWaitingText;
		if (!view || !header || !question || !footer || !answer || !waiting) return [];

		const budget = this.#consultationRowBudget();
		const answerRows = this.#visibleAnswer ? answer.render(width) : waiting.render(width);
		if (budget < 3) {
			this.#consultationAnswerRowCount = answerRows.length;
			this.#consultationScrollOffset = Math.min(this.#consultationScrollOffset, this.#consultationMaxOffset());
			this.#markConsultationAnswerSeenAtBottom();
			const headerRows = this.#clipConsultationRows(
				[`${this.#consultationHeader(view)} · ${this.#consultationFooter(view)}`],
				1,
				width,
			);
			if (budget === 1) return headerRows;
			const lastAnswerRows = answerRows.length > 0 ? answerRows.slice(-1) : [""];
			return [...headerRows, ...this.#clipConsultationRows(lastAnswerRows, 1, width)];
		}

		const bordered = budget >= 6;
		const running = !this.#isTerminalConsultationStatus(view.status);
		const answerViewportRows = this.#consultationAnswerViewportRows();
		const questionLimit = running ? this.#consultationAnswerViewportRows(false) - answerViewportRows : 0;
		const questionRows = this.#clipConsultationRows(question.render(width), questionLimit, width);
		this.#consultationAnswerRowCount = answerRows.length;
		this.#consultationScrollOffset = Math.min(this.#consultationScrollOffset, this.#consultationMaxOffset());
		this.#markConsultationAnswerSeenAtBottom();
		this.#updateConsultationFooter();
		const visibleAnswerRows = answerRows.slice(
			this.#consultationScrollOffset,
			this.#consultationScrollOffset + answerViewportRows,
		);
		while (visibleAnswerRows.length < answerViewportRows) {
			visibleAnswerRows.push("");
		}

		const rows: string[] = [];
		if (bordered) rows.push(...this.#consultationBorder.render(width));
		rows.push(...this.#clipConsultationRows(header.render(width), 1, width));
		rows.push(...questionRows);
		if (this.#consultationNoticeComponent) {
			rows.push(...this.#clipConsultationRows(this.#consultationNoticeComponent.render(width), 1, width));
		}
		rows.push(...visibleAnswerRows.map(row => truncateToWidth(row, width)));
		rows.push(...this.#clipConsultationRows(footer.render(width), 1, width));
		if (bordered) rows.push(...this.#consultationBorder.render(width));
		return rows.slice(0, budget);
	}

	#scheduleConsultationRender(): void {
		if (this.#closed || this.#consultationRenderScheduled) return;
		this.#consultationRenderScheduled = true;
		const generation = this.#consultationRenderGeneration;
		queueMicrotask(() => {
			if (this.#closed || generation !== this.#consultationRenderGeneration || !this.#consultationRenderScheduled) {
				return;
			}
			this.#consultationRenderScheduled = false;
			this.#tui.requestComponentRender(this);
		});
	}

	#footerLine(): string {
		switch (this.#state) {
			case "running":
				return theme.fg("muted", `Esc cancel ${this.#commandLabel}`);
			case "complete":
				return theme.fg("muted", this.isCopyable() ? this.#completionHint : "Esc dismiss");
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
		return new Markdown(text, 1, 0, getMarkdownTheme());
	}
	#consultationHeader(view: ConsultationPanelView): string {
		const subject = view.title.trim() || view.question.trim() || "Consultation";
		const turn = `${Math.max(1, view.turnIndex)}/${Math.max(1, view.turnCount)}`;
		return `${theme.fg("accent", `Consult · ${subject} · ${turn}`)} · ${theme.fg(
			"muted",
			this.#consultationStatusLabel(view.status),
		)}`;
	}

	#consultationStatusLabel(status: ConsultationPanelStatus): string {
		switch (status) {
			case "saving-boundary":
				return "Saving boundary";
			case "consulting-model":
				return "Consulting";
			case "streaming-turn":
				return "Streaming";
			case "saving":
				return "Saving";
			case "saved":
				return "Saved";
			case "cancelled":
				return "Cancelled";
			case "failed":
				return "Failed";
		}
	}

	#consultationEmptyText(view: ConsultationPanelView): string {
		if (view.status === "failed") return theme.fg("error", "Consultation failed before returning text.");
		if (view.status === "cancelled") return theme.fg("warning", "Consultation cancelled.");
		if (view.status === "saved") return theme.fg("dim", "No text returned.");
		return theme.fg("dim", "Waiting for response…");
	}

	#isTerminalConsultationStatus(status: ConsultationPanelStatus): boolean {
		return status === "saved" || status === "cancelled" || status === "failed";
	}

	#consultationFooter(view: ConsultationPanelView): string {
		if (this.#hasUnseenConsultationOutput()) {
			return theme.fg("accent", "↓ new output · Alt+PgUp/PgDn · Alt+Home/End");
		}
		if (!this.#isTerminalConsultationStatus(view.status)) {
			return theme.fg("muted", "Streaming · Alt+PgUp/PgDn scroll · ? cancel · Esc parent");
		}
		return theme.fg("muted", "Enter follow-up · Alt+Enter use in parent · ? actions · Esc parent");
	}
}
