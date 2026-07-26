import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";

export const COMMENT_CHECKER_WIDGET_KEY = "omp-comment-checker";

export type CommentCheckerUiStatus = "idle" | "loading" | "missing" | "clean" | "warning" | "error";

export type CommentCheckerWarning = {
	filePath: string;
	message: string;
};

export type CommentCheckerUiState = {
	status: CommentCheckerUiStatus;
	checkedFiles: string[];
	warnings: CommentCheckerWarning[];
	errorMessage?: string;
};

export type WidgetSetter = (
	key: string,
	lines: string[] | undefined,
	options?: { placement?: "aboveEditor" | "belowEditor" },
) => void;

function formatPreview(message: string): string {
	return truncateToWidth(replaceTabs(message.trim()), TRUNCATE_LENGTHS.CONTENT);
}

export function getCommentCheckerWidgetLines(state: CommentCheckerUiState): string[] | undefined {
	if (state.status !== "warning") return undefined;
	if (state.warnings.length === 0) return undefined;
	const header = "⚠ omp-comment-checker";
	const summary = `  ${state.warnings.length} warning(s) in:`;
	const maxLines = 10;
	const lines: string[] = [header, summary];
	for (const warning of state.warnings.slice(0, maxLines)) {
		const preview = formatPreview(warning.message);
		const displayPath = replaceTabs(shortenPath(warning.filePath));
		lines.push(`  • ${displayPath} — ${preview}`);
	}
	if (state.warnings.length > maxLines) {
		lines.push(`  … (${state.warnings.length - maxLines} more)`);
	}
	return lines;
}

export function formatFooterStatus(state: CommentCheckerUiState): string | undefined {
	if (state.status === "clean") return "comment-checker: clean";
	if (state.status !== "warning") return undefined;
	if (state.warnings.length === 0) return undefined;
	const maxFiles = 3;
	const fileList = state.warnings.slice(0, maxFiles).map(warning => replaceTabs(shortenPath(warning.filePath)));
	const suffix = state.warnings.length > maxFiles ? " …" : "";
	return `⚠ comment-checker: ${state.warnings.length} warning(s) in ${fileList.join(", ")}${suffix}`;
}

export function syncCommentCheckerWidget(setWidget: WidgetSetter, state: CommentCheckerUiState): void {
	setWidget(COMMENT_CHECKER_WIDGET_KEY, getCommentCheckerWidgetLines(state), { placement: "aboveEditor" });
}
