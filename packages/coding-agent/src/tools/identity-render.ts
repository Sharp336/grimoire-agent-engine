import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { formatErrorMessage, formatEmptyMessage, PREVIEW_LIMITS, renderStatusLine } from "./render-utils";

export const identityToolRenderer = {
	renderCall(args: { action?: string }, _options: RenderResultOptions, uiTheme: Theme): Component {
		const action = args.action ?? "unknown";
		const text = renderStatusLine({ icon: "pending", title: "Identity", description: action }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		_args?: unknown,
	): Component {
		const textContent = result.content?.find(c => c.type === "text")?.text ?? "";

		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Identity" }, uiTheme);
			return {
				render() {
					return [header, formatErrorMessage(textContent, uiTheme)];
				},
				invalidate() {},
			};
		}

		if (!textContent) {
			const header = renderStatusLine({ icon: "warning", title: "Identity" }, uiTheme);
			return {
				render() {
					return [header, formatEmptyMessage("No identity data", uiTheme)];
				},
				invalidate() {},
			};
		}

		const header = renderStatusLine({ icon: "success", title: "Identity" }, uiTheme);
		return {
			render() {
				const lines = textContent.split("\n");
				if (lines.length > PREVIEW_LIMITS.EXPANDED_LINES) {
					const shown = lines.slice(0, PREVIEW_LIMITS.EXPANDED_LINES);
					return [header, ...shown, `... (${lines.length - PREVIEW_LIMITS.EXPANDED_LINES} more lines)`];
				}
				return [header, ...lines];
			},
			invalidate() {},
		};
	},
};
