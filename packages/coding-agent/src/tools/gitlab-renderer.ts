import { type Component, Text } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine } from "../tui";
import { formatErrorDetail, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";

type GitlabToolRenderArgs = {
	op?: string;
	repo?: string;
	branch?: string;
	mr?: string;
	title?: string;
};

const OP_TITLES: Record<string, string> = {
	mr_create: "GitLab MR Create",
	mr_checkout: "GitLab MR Checkout",
};

function formatOpTitle(op: string | undefined): string {
	if (!op) return "GitLab";
	return OP_TITLES[op] ?? `GitLab ${op.replaceAll("_", " ")}`;
}

function formatMetaValue(value: string, length: number): string {
	return truncateToWidth(replaceTabs(value), length);
}

function buildMeta(args: GitlabToolRenderArgs | undefined): string[] {
	const meta: string[] = [];
	if (!args) return meta;
	for (const value of [args.repo, args.branch, args.mr]) {
		if (value) meta.push(formatMetaValue(value, TRUNCATE_LENGTHS.SHORT));
	}
	if (args.title) meta.push(formatMetaValue(args.title, TRUNCATE_LENGTHS.CONTENT));
	return meta;
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	const parts: string[] = [];
	for (const item of content) {
		if (item.type === "text" && item.text) parts.push(item.text);
	}
	return parts.join("\n").trim();
}

function renderPreview(text: string, theme: Theme, maxLines: number): string[] {
	return text
		.split("\n")
		.filter(line => line.trim().length > 0)
		.slice(0, maxLines)
		.map(line => theme.fg("toolOutput", truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.LINE)));
}

export const gitlabToolRenderer = {
	renderCall(args: GitlabToolRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const header = renderStatusLine(
			{
				icon: options.spinnerFrame !== undefined ? "running" : "pending",
				spinnerFrame: options.spinnerFrame,
				title: formatOpTitle(args?.op),
				meta: buildMeta(args),
			},
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GitlabToolRenderArgs,
	): Component {
		const text = extractText(result.content);
		const header = renderStatusLine(
			result.isError
				? { icon: "error", title: formatOpTitle(args?.op), meta: buildMeta(args) }
				: {
						iconOverride: uiTheme.styledSymbol("tool.gh", "accent"),
						title: formatOpTitle(args?.op),
						meta: buildMeta(args),
					},
			uiTheme,
		);
		if (!text) return new Text(header, 0, 0);
		if (result.isError) return new Text([header, formatErrorDetail(text, uiTheme)].join("\n"), 0, 0);
		return new Text([header, ...renderPreview(text, uiTheme, options.expanded ? 12 : 4)].join("\n"), 0, 0);
	},
};
