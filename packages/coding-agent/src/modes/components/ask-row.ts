import {
	CURSOR_MARKER,
	Ellipsis,
	type MarkdownTheme,
	padding,
	renderInlineMarkdown,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import type { ExtensionAskDialogQuestion } from "../../extensibility/extensions";
import { type Theme, theme } from "../theme/theme";

/** Width of the leading prefix column shared by every ask row (the focus
 *  cursor cell, the jump-digit cell, and the option-marker cell). Wrapped
 *  label continuations, descriptions, and the custom-input echo all indent by
 *  this same amount, so every row keeps its content left-aligned across the
 *  dialog, transcript, and legacy surfaces. */
export const ASK_ROW_PREFIX_COLUMNS = 6;

/** A single renderable ask row: an option entry or the "other" custom input.
 *  Mirrors the dialog's internal row shape so the transcript and legacy paths
 *  can feed the same engine without their own copies of the contract. */
export interface AskQuestionRow {
	kind: "option" | "other";
	key: string;
	label: string;
	optionIndex: number | undefined;
}

export interface AskRowRenderContext {
	question: ExtensionAskDialogQuestion;
	focused: boolean;
	checked: boolean;
	/** "1".."9" when a jump digit is rendered for this row, else undefined. */
	jumpDigit: string | undefined;
	/** When true, an option description renders every wrapped line; otherwise it
	 *  collapses to the first two and the surplus is a counted cue. */
	expanded: boolean;
	note: string | undefined;
	/** Echoed under an `other` row when the user is typing a custom answer. */
	customInput: string | undefined;
	/** Inner content width (the prefix is not part of this budget). */
	width: number;
	mdTheme: MarkdownTheme;
	/** Emit the terminal-cursor sentinel on the focused row. Only the focused,
	 *  declared row ever carries it — TUI extracts the bottom-most marker. */
	declareCursor: boolean;
}

export interface AskRowLines {
	lines: string[];
	/** Number of description lines hidden behind the collapse cue (0 when none
	 *  hidden or the description is expanded). */
	hiddenDescriptionLines: number;
}

/** Shared option marker glyph: a checkbox for multi questions, a radio control
 *  otherwise. Colour is applied by the caller via {@link theme.fg} and follows
 *  `checked` only — focus never changes the marker's hue. Glyphs come from
 *  `uiTheme` so transcript renders match the theme instance they were handed. */
export function askOptionMarker(uiTheme: Theme, multi: boolean | undefined, checked: boolean): string {
	if (multi) return checked ? uiTheme.checkbox.checked : uiTheme.checkbox.unchecked;
	return checked ? uiTheme.radio.selected : uiTheme.radio.unselected;
}

/** Render one ask row. Pure: given the same row and context it returns the same
 *  lines, with no caching or preview state of its own. */
export function renderAskRow(row: AskQuestionRow, ctx: AskRowRenderContext): AskRowLines {
	const isOption = row.kind === "option";
	const isOther = row.kind === "other";
	const option = isOption ? ctx.question.options[row.optionIndex ?? -1] : undefined;

	// Cells 1-4 of the prefix: focus cursor (plus the terminal-cursor sentinel
	// only for the focused, declared row), a spacer, the jump digit, a spacer.
	// Including the cursor glyph, this half of the prefix is exactly
	// ASK_ROW_PREFIX_COLUMNS - 2 columns wide.
	const cursorCell = ctx.focused ? theme.nav.cursor : " ";
	const cursorMarker = ctx.focused && ctx.declareCursor ? CURSOR_MARKER : "";
	const jumpCell = ctx.jumpDigit !== undefined ? theme.fg("dim", ctx.jumpDigit) : " ";
	const prefix = `${cursorCell}${cursorMarker} ${jumpCell} `;

	// Cells 5-6 of the prefix: the option marker followed by a spacer. The
	// marker's colour tracks `checked`, never `focused`.
	const marker = theme.fg(ctx.checked ? "success" : "dim", askOptionMarker(theme, ctx.question.multi, ctx.checked));

	const color = ctx.focused ? "accent" : ctx.checked ? "toolOutput" : "text";
	const label = renderInlineMarkdown(row.label, ctx.mdTheme, t => theme.fg(color, t));
	const contentWidth = Math.max(1, ctx.width - ASK_ROW_PREFIX_COLUMNS);
	const noteMarker = ctx.note !== undefined ? theme.fg("success", "  ✎ note") : "";
	const noteWidth = noteMarker ? visibleWidth(noteMarker) : 0;
	// Reserve the trailing note marker on the first label line so fit() cannot
	// clip it when the label fills contentWidth.
	const wrapBudget = Math.max(1, contentWidth - noteWidth);
	const wrappedLabel = wrapTextWithAnsi(label, wrapBudget);

	const lines = [`${prefix}${marker} ${wrappedLabel[0] ?? ""}${noteMarker}`];
	const indent = padding(ASK_ROW_PREFIX_COLUMNS);
	for (let i = 1; i < wrappedLabel.length; i++) {
		lines.push(`${indent}${wrappedLabel[i] ?? ""}`);
	}

	let hiddenDescriptionLines = 0;
	if (ctx.focused && isOption && option?.description?.trim()) {
		// The description belongs to the focused row only. Unfocused rows carry
		// the prefix, label, and note marker and nothing else, so the collapse
		// cue can never light up (hiddenDescriptionLines stays 0 below) for a
		// row the user is not looking at. Collapsed: the first two wrapped
		// lines, then a counted cue when more remain. Expanded: every line, no
		// cap. A focused description is never truncated without a visible
		// escape.
		const description = renderInlineMarkdown(option.description.trim(), ctx.mdTheme, t => theme.fg("muted", t));
		const wrapped = wrapTextWithAnsi(description, contentWidth);
		hiddenDescriptionLines = ctx.expanded ? 0 : Math.max(0, wrapped.length - 2);
		for (const line of ctx.expanded ? wrapped : wrapped.slice(0, 2)) {
			lines.push(`${indent}${truncateToWidth(line, contentWidth, Ellipsis.Unicode)}`);
		}
		if (!ctx.expanded && hiddenDescriptionLines > 0) {
			const glyph = theme.nav.expand || "▾";
			lines.push(`${indent}${theme.fg("dim", `${glyph} ${hiddenDescriptionLines} more lines`)}`);
		}
	}

	if (isOther && ctx.customInput !== undefined) {
		const preview = replaceTabs(ctx.customInput).replace(/\s+/g, " ").trim();
		lines.push(theme.fg("muted", `${indent}${truncateToWidth(preview, contentWidth, Ellipsis.Unicode)}`));
	}

	return { lines, hiddenDescriptionLines };
}
