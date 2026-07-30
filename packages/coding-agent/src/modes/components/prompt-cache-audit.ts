import type { Component } from "@oh-my-pi/pi-tui";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import type { PromptCacheAudit, PromptCacheAuditRequest } from "../../session/cache-telemetry";
import { PREVIEW_LIMITS, replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

const METRIC_LABEL_WIDTH = 25;

function displayText(value: string): string {
	return replaceTabs(sanitizeText(value));
}

function localTimestamp(timestamp: number | undefined): string | undefined {
	if (timestamp === undefined) return undefined;
	const date = new Date(timestamp);
	return [date.getHours(), date.getMinutes(), date.getSeconds()]
		.map(value => String(value).padStart(2, "0"))
		.join(":");
}

function statusColor(status: PromptCacheAuditRequest["status"]): "accent" | "error" | "success" | "text" {
	if (status === "RECREATED") return "error";
	if (status === "REUSED + CREATED" || status === "WARM") return "success";
	if (status === "CACHE CREATED") return "accent";
	return "text";
}

function metricValue(value: number): string {
	return formatNumber(value);
}

function routeMetricLines(audit: PromptCacheAudit, width: number): string[] {
	const multiplier = audit.currentRoute.reuseMultiplier;
	return [
		metricRow("Cached requests", metricValue(audit.currentRoute.cachedRequests), width),
		metricRow("Cumulative cached input", metricValue(audit.currentRoute.cumulativeCachedInput), width),
		metricRow("Largest cached input", metricValue(audit.currentRoute.largestCachedInput), width),
		metricRow("Reuse multiplier", multiplier === undefined ? "—" : `${multiplier.toFixed(2)}×`, width),
		metricRow("Explicit recreations", metricValue(audit.currentRoute.explicitRecreations), width),
	];
}

function sessionMetricLines(audit: PromptCacheAudit, width: number): string[] {
	return [
		metricRow("Requests", metricValue(audit.sessionVolume.requests), width),
		metricRow("Cumulative cached input", metricValue(audit.sessionVolume.cumulativeCachedInput), width),
		metricRow("Cache creation", metricValue(audit.sessionVolume.cacheCreation), width),
		metricRow("Explicit recreations", metricValue(audit.sessionVolume.explicitRecreations), width),
	];
}

function metricRow(label: string, value: string, width: number): string {
	const plainLabel = displayText(label);
	const plainValue = displayText(value);
	const aligned = `  ${plainLabel.padEnd(METRIC_LABEL_WIDTH)}  ${plainValue}`;
	const useAligned = Bun.stringWidth(aligned, { countAnsiEscapeCodes: false }) <= width;
	const renderedLabel = theme.fg("muted", useAligned ? plainLabel.padEnd(METRIC_LABEL_WIDTH) : `${plainLabel}:`);
	return useAligned
		? `  ${renderedLabel}  ${theme.fg("text", plainValue)}`
		: `  ${renderedLabel} ${theme.fg("text", plainValue)}`;
}

function timelineHeading(
	timestamp: number | undefined,
	label: string,
	color: "accent" | "error" | "success" | "text",
): string {
	const time = localTimestamp(timestamp);
	const prefix = time ? `${theme.fg("dim", time)}  ` : "";
	return `${prefix}${theme.bold(theme.fg(color, label))}`;
}

function timelineDetail(
	label: string,
	value?: string,
	color: "accent" | "muted" | "text" | "warning" = "muted",
): string {
	const branch = theme.fg("dim", `    ${theme.tree.vertical}       `);
	const plainLabel = displayText(label);
	if (value === undefined) return `${branch}${theme.fg(color, plainLabel)}`;
	return `${branch}${theme.fg("muted", `${plainLabel}:`)} ${theme.fg(color, displayText(value))}`;
}

function requestLines(request: PromptCacheAuditRequest): string[] {
	const cachedInput = request.cacheReadDelta
		? `${metricValue(request.usage.cacheRead)}  +${metricValue(request.cacheReadDelta)} observed`
		: metricValue(request.usage.cacheRead);
	const lines = [
		timelineHeading(request.timestamp, request.status, statusColor(request.status)),
		timelineDetail("Cached input", cachedInput, "text"),
		timelineDetail("New input", metricValue(request.usage.input), "text"),
	];
	if (request.usage.cacheWrite > 0) {
		lines.push(timelineDetail("Cache creation", metricValue(request.usage.cacheWrite), "accent"));
	}
	if (request.usage.cacheRead > 0) {
		const cacheShare = Math.round((request.usage.cacheRead / request.promptInput) * 100);
		lines.push(timelineDetail("Cache share", `${cacheShare}%`, "text"));
	}
	if (request.recreation) {
		lines.push(timelineDetail("Reprocessed input", metricValue(request.recreation.reprocessedTokens), "text"));
	}
	for (const observation of request.observations) {
		lines.push(timelineDetail(observation.text, undefined, "warning"));
	}
	if (request.endAnnotation) {
		lines.push(timelineDetail(request.endAnnotation, undefined, "text"));
	}
	if (request.recreation) {
		lines.push(timelineDetail("Provider cause unknown", undefined, "warning"));
	}
	lines.push(theme.fg("dim", `    ${theme.tree.vertical}`));
	return lines;
}

export class PromptCacheAuditComponent implements Component {
	#expanded = false;
	#cache?: { width: number; lines: string[] };
	readonly #topBorder = new DynamicBorder();
	readonly #bottomBorder = new DynamicBorder();

	constructor(private readonly audit: PromptCacheAudit) {}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cache = undefined;
	}

	invalidate(): void {
		this.#cache = undefined;
		this.#topBorder.invalidate();
		this.#bottomBorder.invalidate();
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;

		const route = displayText(this.audit.routeLabel);
		const upstream = this.audit.upstreamProvider ? ` via ${displayText(this.audit.upstreamProvider)}` : "";
		const subtitle = `${route}${upstream} ${theme.sep.dot} current branch ${theme.sep.dot} main agent`;
		const visibleRequests = this.#expanded
			? this.audit.requests
			: this.audit.requests.slice(-PREVIEW_LIMITS.COLLAPSED_ITEMS);
		const omitted = this.audit.requests.length - visibleRequests.length;
		const lines = [
			...this.#topBorder.render(width),
			theme.bold(theme.fg("accent", "Prompt Cache Timeline")),
			theme.fg("muted", subtitle),
			"",
			theme.bold(theme.fg("accent", "Current route")),
			...routeMetricLines(this.audit, width),
			"",
			theme.bold(theme.fg("accent", "Session volume")),
			...sessionMetricLines(this.audit, width),
			"",
			timelineHeading(this.audit.routeStart.timestamp, "ROUTE STARTED", "accent"),
			timelineDetail(this.audit.routeStart.description),
			theme.fg("dim", `    ${theme.tree.vertical}`),
		];
		if (omitted > 0) {
			lines.push(theme.fg("dim", `    ${formatNumber(omitted)} earlier requests omitted`));
		}
		if (this.audit.requests.length === 0) {
			lines.push(theme.fg("muted", "No requests recorded for the current route."));
		} else {
			for (const request of visibleRequests) lines.push(...requestLines(request));
		}
		lines.push(
			"",
			theme.fg("muted", "Cached input repeats earlier context on every request."),
			theme.fg(
				"muted",
				"Reuse multiplier compares cumulative reads with the largest single read; it is not a hit rate.",
			),
			...this.#bottomBorder.render(width),
		);

		const rendered = lines.map(line => truncateToWidth(line, width));
		this.#cache = { width, lines: rendered };
		return rendered;
	}
}
