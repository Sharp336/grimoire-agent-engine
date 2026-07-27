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

export function formatPreview(message: string): string {
	const singleLine = message.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
	return truncateToWidth(replaceTabs(singleLine), TRUNCATE_LENGTHS.CONTENT);
}

export function getCommentCheckerWidgetLines(state: CommentCheckerUiState): string[] | undefined {
	if (state.status === "error") {
		const header = "✖ omp-comment-checker error";
		const detail = state.errorMessage ? `  ${formatPreview(state.errorMessage)}` : "  Checker execution failed";
		return [header, detail];
	}
	if (state.status === "missing") {
		return ["✖ omp-comment-checker missing binary", "  Install @code-yeongyu/comment-checker"];
	}
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
	if (state.status === "missing") return "comment-checker: missing binary";
	if (state.status === "error") {
		const msg = state.errorMessage ? `: ${formatPreview(state.errorMessage)}` : "";
		return `✖ comment-checker error${msg}`;
	}
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
