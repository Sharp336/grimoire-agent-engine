import {
	type Component,
	Ellipsis,
	Input,
	matchesKey,
	replaceTabs,
	ScrollView,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type {
	ReviewDiffFile,
	ReviewDiffRow,
	ReviewSourceRow,
} from "../../extensibility/custom-commands/bundled/review/shared";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { sanitizeStatusText } from "../shared";
import { theme } from "../theme/theme";
import {
	matchesAppExternalEditor,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { renderDiff } from "./diff";
import {
	bottomBorder,
	divider,
	dividerSplit,
	fit,
	row,
	splitBodyWidth,
	splitRow,
	topBorder,
	topBorderSplit,
} from "./overlay-box";

export const CONTINUE_CODE_REVIEW_ACTION = "Continue with LLM review";
export const PASTE_CODE_REVIEW_ACTION = "Paste annotations into prompt";

export interface CodeReviewAnnotation {
	path: string;
	oldPath?: string;
	newPath?: string;
	occurrence: number;
	hunkHeader: string;
	oldLine?: number;
	newLine?: number;
	rawLine: string;
	note: string;
}

export interface CodeReviewOverlayResult {
	action: "review" | "paste";
	annotations: CodeReviewAnnotation[];
}

export interface CodeReviewOverlayCallbacks {
	onComplete(result: CodeReviewOverlayResult | undefined): void;
	onWarning?(message: string): void;
}

interface CommittedAnnotation {
	fileIndex: number;
	sourceIndex: number;
	annotation: CodeReviewAnnotation;
}

interface RenderedDiffBody {
	lines: string[];
	renderedRowBySource: number[];
}

type FocusRegion = "files" | "diff" | "actions";

const OVERLAY_TITLE = "Code Review";
const MIN_BODY_ROWS = 3;
const SIDEBAR_MIN_TOTAL_WIDTH = 64;
const SIDEBAR_MIN_BODY_WIDTH = 40;
const ACTIONS = [CONTINUE_CODE_REVIEW_ACTION, PASTE_CODE_REVIEW_ACTION] as const;

function isSourceRow(row: ReviewDiffRow): row is ReviewSourceRow {
	return row.kind === "context" || row.kind === "added" || row.kind === "removed";
}

function sourceRows(file: ReviewDiffFile): ReviewSourceRow[] {
	return file.rows.filter(isSourceRow);
}

function canonicalDiffRow(row: ReviewSourceRow): string {
	const marker = row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " ";
	const line = row.kind === "removed" ? row.oldLine : (row.newLine ?? row.oldLine);
	return `${marker}${line ?? ""}|${row.content}`;
}

function displayFileLabel(file: ReviewDiffFile): string {
	return file.occurrence > 1 ? `${file.path} (${file.occurrence})` : file.path;
}

export class CodeReviewOverlay implements Component {
	#scrollView = new ScrollView([], {
		height: MIN_BODY_ROWS,
		scrollbar: "auto",
		ellipsis: Ellipsis.Omit,
		theme: { track: text => theme.fg("dim", text), thumb: text => theme.fg("accent", text) },
	});
	#input = new Input();
	#focus: FocusRegion = "actions";
	#fileIndex = 0;
	#sourceIndex = 0;
	#actionIndex = 0;
	#bodyHeight = MIN_BODY_ROWS;
	#sidebarShown = false;
	#annotating = false;
	#finished = false;
	#annotations: CommittedAnnotation[] = [];

	constructor(
		private readonly tui: TUI,
		private readonly files: readonly ReviewDiffFile[],
		private readonly mode: string,
		private readonly callbacks: CodeReviewOverlayCallbacks,
		private readonly externalEditorLabel?: string,
	) {
		this.#input.setUseTerminalCursor(false);
		this.#input.onSubmit = value => this.#commitAnnotation(value);
		this.#input.onEscape = () => this.#cancelAnnotation();
		this.#resetSourceCursor();
	}

	invalidate(): void {}

	dispose(): void {
		this.#finished = true;
	}

	getAnnotations(): CodeReviewAnnotation[] {
		return this.#annotations.map(entry => ({ ...entry.annotation }));
	}

	handleInput(data: string): void {
		if (this.#finished) return;
		if (this.#annotating) {
			if (matchesAppExternalEditor(data)) {
				void this.#openAnnotationEditor();
				return;
			}
			this.#input.handleInput(data);
			return;
		}
		if (matchesSelectCancel(data)) {
			this.#finish(undefined);
			return;
		}
		if (data === "[") {
			this.#selectRelativeFile(-1);
			return;
		}
		if (data === "]") {
			this.#selectRelativeFile(1);
			return;
		}
		if (data === "u") {
			this.#undoAnnotation();
			return;
		}
		if (matchesKey(data, "tab") || data === "\t") {
			this.#cycleFocus(1);
			return;
		}
		if (matchesKey(data, "shift+tab") || data === "\x1b[Z") {
			this.#cycleFocus(-1);
			return;
		}
		switch (this.#focus) {
			case "files":
				this.#handleFiles(data);
				break;
			case "diff":
				this.#handleDiff(data);
				break;
			case "actions":
				this.#handleActions(data);
				break;
		}
	}

	#finish(result: CodeReviewOverlayResult | undefined): void {
		if (this.#finished) return;
		this.#finished = true;
		this.callbacks.onComplete(result);
	}

	#cycleFocus(direction: number): void {
		const regions: FocusRegion[] = this.#sidebarShown ? ["files", "diff", "actions"] : ["diff", "actions"];
		const current = regions.indexOf(this.#focus);
		const base = current < 0 ? regions.length - 1 : current;
		this.#focus = regions[(base + direction + regions.length) % regions.length]!;
	}

	#handleFiles(data: string): void {
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			this.#selectFile(Math.max(0, this.#fileIndex - 1));
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			this.#selectFile(Math.min(this.files.length - 1, this.#fileIndex + 1));
			return;
		}
		if (
			matchesKey(data, "right") ||
			matchesKey(data, "l") ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			data === "\n"
		) {
			this.#focus = "diff";
		}
	}

	#handleDiff(data: string): void {
		if (data === "a") {
			this.#startAnnotation();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			if (this.#sidebarShown) this.#focus = "files";
			return;
		}
		if (
			matchesKey(data, "right") ||
			matchesKey(data, "l") ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			data === "\n"
		) {
			this.#focus = "actions";
			return;
		}
		if (matchesKey(data, "shift+up")) {
			this.#moveSourceCursor(-5);
			return;
		}
		if (matchesKey(data, "shift+down")) {
			this.#moveSourceCursor(5);
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			this.#moveSourceCursor(-1);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			this.#moveSourceCursor(1);
			return;
		}
		if (matchesSelectPageUp(data)) {
			this.#moveSourceCursor(-Math.max(1, this.#bodyHeight - 1));
			return;
		}
		if (matchesSelectPageDown(data)) {
			this.#moveSourceCursor(Math.max(1, this.#bodyHeight - 1));
			return;
		}
		if (data === "g" || matchesKey(data, "home")) {
			this.#sourceIndex = 0;
			return;
		}
		if (data === "G" || matchesKey(data, "end")) {
			this.#sourceIndex = Math.max(0, this.#currentSourceRows().length - 1);
		}
	}

	#handleActions(data: string): void {
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			this.#actionIndex = 0;
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			if (this.#annotations.length > 0) this.#actionIndex = 1;
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			if (this.#actionIndex === 1 && this.#annotations.length === 0) return;
			this.#finish({
				action: this.#actionIndex === 0 ? "review" : "paste",
				annotations: this.getAnnotations(),
			});
		}
	}

	#selectFile(index: number): void {
		if (this.files.length === 0) return;
		this.#fileIndex = Math.max(0, Math.min(this.files.length - 1, index));
		this.#resetSourceCursor();
		this.#scrollView.scrollToTop();
	}

	#selectRelativeFile(delta: number): void {
		if (this.files.length === 0) return;
		this.#selectFile((this.#fileIndex + delta + this.files.length) % this.files.length);
	}

	#resetSourceCursor(): void {
		this.#sourceIndex = 0;
	}

	#currentFile(): ReviewDiffFile | undefined {
		return this.files[this.#fileIndex];
	}

	#currentSourceRows(): ReviewSourceRow[] {
		const file = this.#currentFile();
		return file ? sourceRows(file) : [];
	}

	#moveSourceCursor(delta: number): void {
		const rows = this.#currentSourceRows();
		if (rows.length === 0) return;
		this.#sourceIndex = Math.max(0, Math.min(rows.length - 1, this.#sourceIndex + delta));
	}

	#startAnnotation(): void {
		if (this.#currentSourceRows()[this.#sourceIndex] === undefined) {
			this.callbacks.onWarning?.("This file has no annotatable diff rows");
			return;
		}
		this.#annotating = true;
		this.#input.setValue("");
	}

	#cancelAnnotation(): void {
		this.#annotating = false;
		this.#input.setValue("");
	}

	#commitAnnotation(value: string): void {
		const note = value.trim();
		const file = this.#currentFile();
		const source = this.#currentSourceRows()[this.#sourceIndex];
		this.#annotating = false;
		this.#input.setValue("");
		if (!note || !file || !source) return;
		this.#annotations.push({
			fileIndex: this.#fileIndex,
			sourceIndex: this.#sourceIndex,
			annotation: {
				path: file.path,
				oldPath: file.oldPath,
				newPath: file.newPath,
				occurrence: file.occurrence,
				hunkHeader: source.hunkHeader,
				oldLine: source.oldLine,
				newLine: source.newLine,
				rawLine: source.raw,
				note,
			},
		});
	}

	#undoAnnotation(): void {
		this.#annotations.pop();
		if (this.#annotations.length === 0 && this.#actionIndex === 1) this.#actionIndex = 0;
	}

	async #openAnnotationEditor(): Promise<void> {
		const editorCommand = getEditorCommand();
		if (!editorCommand) {
			this.callbacks.onWarning?.("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}
		const draft = this.#input.getValue();
		try {
			this.tui.stop();
			const result = await openInEditor(editorCommand, draft, { extension: ".md" });
			if (result !== null) this.#commitAnnotation(result);
		} finally {
			this.tui.start();
			this.tui.requestRender(true);
		}
	}

	#annotationCount(fileIndex: number): number {
		let count = 0;
		for (const entry of this.#annotations) if (entry.fileIndex === fileIndex) count++;
		return count;
	}

	#renderBody(contentWidth: number): RenderedDiffBody {
		const file = this.#currentFile();
		if (!file) return { lines: [theme.fg("dim", "No reviewable files")], renderedRowBySource: [] };
		if (file.isBinary) {
			return { lines: [theme.fg("dim", "Binary diff; no annotatable source rows")], renderedRowBySource: [] };
		}
		if (file.rows.length === 0) {
			return {
				lines: [theme.fg("dim", "No diff hunks; this may be a rename-only change")],
				renderedRowBySource: [],
			};
		}

		const lines: string[] = [];
		const renderedRowBySource: number[] = [];
		let sourceIndex = 0;
		let run: ReviewSourceRow[] = [];
		const flushRun = (): void => {
			if (run.length === 0) return;
			const rendered = renderDiff(run.map(canonicalDiffRow).join("\n"), { filePath: file.path }).split("\n");
			for (let index = 0; index < run.length; index++) {
				const currentSourceIndex = sourceIndex++;
				renderedRowBySource[currentSourceIndex] = lines.length;
				let renderedLine = rendered[index] ?? "";
				if (this.#focus === "diff" && currentSourceIndex === this.#sourceIndex) {
					renderedLine = theme.bg("selectedBg", fit(`${theme.nav.cursor} ${renderedLine}`, contentWidth));
				}
				lines.push(truncateToWidth(renderedLine, contentWidth));
				for (const entry of this.#annotations) {
					if (entry.fileIndex === this.#fileIndex && entry.sourceIndex === currentSourceIndex) {
						this.#appendAnnotationCallout(lines, entry.annotation.note, contentWidth);
					}
				}
			}
			run = [];
		};
		for (const diffRow of file.rows) {
			if (isSourceRow(diffRow)) {
				run.push(diffRow);
				continue;
			}
			flushRun();
			lines.push(theme.fg(diffRow.kind === "hunk" ? "accent" : "dim", replaceTabs(sanitizeText(diffRow.raw))));
		}
		flushRun();
		return { lines, renderedRowBySource };
	}

	#appendAnnotationCallout(lines: string[], note: string, width: number): void {
		for (const [index, noteLine] of note.split(/\r?\n/).entries()) {
			const prefix =
				index === 0
					? `${theme.fg("warning", "▎ ")}${theme.fg("dim", "note: ")}`
					: `${theme.fg("warning", "▎ ")}      `;
			const available = Math.max(0, width - visibleWidth(prefix));
			const content = truncateToWidth(replaceTabs(sanitizeText(noteLine)), available, Ellipsis.Unicode);
			lines.push(truncateToWidth(`${prefix}${theme.fg("accent", content)}`, width));
		}
	}

	#ensureCursorVisible(renderedRowBySource: readonly number[]): void {
		const row = renderedRowBySource[this.#sourceIndex];
		if (row === undefined) return;
		const offset = this.#scrollView.getScrollOffset();
		if (row < offset) this.#scrollView.setScrollOffset(row);
		else if (row >= offset + this.#bodyHeight) this.#scrollView.setScrollOffset(row - this.#bodyHeight + 1);
	}

	#sidebarWidth(width: number): number {
		return Math.max(18, Math.min(32, Math.round(width * 0.28)));
	}

	#canShowSidebar(width: number): boolean {
		const sidebarWidth = this.#sidebarWidth(width);
		return width >= SIDEBAR_MIN_TOTAL_WIDTH && splitBodyWidth(width, sidebarWidth) >= SIDEBAR_MIN_BODY_WIDTH;
	}

	#renderSidebar(rows: number, width: number): string[] {
		const start = Math.max(
			0,
			Math.min(this.#fileIndex - Math.floor(rows / 2), Math.max(0, this.files.length - rows)),
		);
		return Array.from({ length: rows }, (_, rowIndex) => {
			const index = start + rowIndex;
			const file = this.files[index];
			if (!file) return "";
			const selected = index === this.#fileIndex;
			const count = this.#annotationCount(index);
			const badge = `${theme.fg("dim", ` +${file.linesAdded}/-${file.linesRemoved}`)}${count ? theme.fg("warning", ` ✎${count}`) : ""}`;
			const available = Math.max(0, width - visibleWidth(badge) - 2);
			const label = truncateToWidth(sanitizeStatusText(displayFileLabel(file)), available, Ellipsis.Unicode);
			const cursor = selected ? (this.#focus === "files" ? "› " : "▎ ") : "  ";
			const line = fit(`${cursor}${label}${badge}`, width);
			return selected && this.#focus === "files"
				? theme.bg("selectedBg", theme.bold(line))
				: theme.fg(selected ? "accent" : "muted", line);
		});
	}

	#renderCurrentFileHeader(width: number): string {
		const file = this.#currentFile();
		if (!file) return theme.fg("dim", "No reviewable files");
		const count = this.#annotationCount(this.#fileIndex);
		const suffix = `  +${file.linesAdded}/-${file.linesRemoved}${count ? `  ✎${count}` : ""}`;
		return truncateToWidth(
			`${theme.bold(sanitizeStatusText(displayFileLabel(file)))}${theme.fg("dim", suffix)}`,
			width,
			Ellipsis.Unicode,
		);
	}

	#renderActions(): string[] {
		return ACTIONS.map((label, index) => {
			const disabled = index === 1 && this.#annotations.length === 0;
			const selected = index === this.#actionIndex;
			const cursor = selected ? `${theme.nav.cursor} ` : "  ";
			const text = disabled
				? theme.fg("dim", label)
				: selected && this.#focus === "actions"
					? theme.bold(theme.fg("accent", label))
					: theme.fg("text", label);
			return cursor + text;
		});
	}

	#renderFooter(width: number): string[] {
		if (this.#annotating) {
			const source = this.#currentSourceRows()[this.#sourceIndex];
			const location = source
				? `${displayFileLabel(this.#currentFile()!)} · ${source.oldLine ?? "-"}/${source.newLine ?? "-"}`
				: "diff row";
			const caption = truncateToWidth(
				`${theme.fg("dim", "Annotate")} ${theme.fg("accent", sanitizeStatusText(location))}`,
				width,
				Ellipsis.Unicode,
			);
			const hints = ["enter save", "esc cancel"];
			if (this.externalEditorLabel) hints.push(`${this.externalEditorLabel} editor`);
			return [caption, this.#input.render(width)[0] ?? "", theme.fg("dim", hints.join(" · "))];
		}
		const focusHelp =
			this.#focus === "files"
				? "↑↓ file · ⏎ diff"
				: this.#focus === "diff"
					? "↑↓ line · ⇧ faster · pgup/pgdn · g/G ends · a annotate"
					: "↑↓ select · ⏎ confirm";
		return [theme.fg("dim", `${focusHelp} · [/] file · u undo · tab regions · esc cancel`)];
	}

	render(width: number): readonly string[] {
		const termHeight = process.stdout.rows || 40;
		this.#sidebarShown = this.#canShowSidebar(width);
		if (!this.#sidebarShown && this.#focus === "files") this.#focus = "diff";
		const sidebarWidth = this.#sidebarShown ? this.#sidebarWidth(width) : 0;
		const innerWidth = Math.max(1, width - 4);
		const bodyWidth = this.#sidebarShown ? splitBodyWidth(width, sidebarWidth) : innerWidth;
		const footer = this.#renderFooter(innerWidth);
		const narrowHeaderRows = this.#sidebarShown ? 0 : 1;
		const chromeRows = 4 + 1 + ACTIONS.length + footer.length + narrowHeaderRows;
		this.#bodyHeight = Math.max(MIN_BODY_ROWS, termHeight - chromeRows);
		const renderedBody = this.#renderBody(bodyWidth);
		this.#scrollView.setLines(renderedBody.lines);
		this.#scrollView.setHeight(this.#bodyHeight);
		this.#ensureCursorVisible(renderedBody.renderedRowBySource);
		const body = this.#scrollView.render(bodyWidth);
		const out: string[] = [];
		if (this.#sidebarShown) {
			const sidebar = this.#renderSidebar(this.#bodyHeight, sidebarWidth);
			out.push(topBorderSplit(width, OVERLAY_TITLE, sidebarWidth));
			for (let index = 0; index < this.#bodyHeight; index++) {
				out.push(splitRow(sidebar[index] ?? "", body[index] ?? "", width, sidebarWidth));
			}
			out.push(dividerSplit(width, sidebarWidth));
		} else {
			out.push(topBorder(width, OVERLAY_TITLE));
			out.push(row(this.#renderCurrentFileHeader(innerWidth), width));
			for (const bodyLine of body) out.push(row(bodyLine, width));
			out.push(divider(width));
		}
		out.push(row(theme.bold(theme.fg("accent", sanitizeStatusText(this.mode))), width));
		for (const action of this.#renderActions()) out.push(row(action, width));
		out.push(divider(width));
		for (const footerLine of footer) out.push(row(footerLine, width));
		out.push(bottomBorder(width));
		return out;
	}
}
