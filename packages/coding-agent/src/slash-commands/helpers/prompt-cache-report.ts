import { replaceTabs } from "@oh-my-pi/pi-tui";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	buildPromptCacheAudit,
	type PromptCacheAudit,
	type PromptCacheAuditRequest,
} from "../../session/cache-telemetry";
import type { SlashCommandRuntime } from "../types";

const MAIN_AGENT_ONLY_MESSAGE = "Prompt cache audit is available only for main-agent sessions.";
const NO_MODEL_MESSAGE = "Prompt cache audit unavailable: no model is selected.";

function displayText(value: string): string {
	return replaceTabs(sanitizeText(value));
}

function timestampPrefix(timestamp: number | undefined): string {
	return timestamp === undefined ? "" : `${new Date(timestamp).toISOString()}  `;
}

function metricLine(label: string, value: string): string {
	return `  ${label}: ${value}`;
}

function requestLines(request: PromptCacheAuditRequest): string[] {
	const cachedInput = request.cacheReadDelta
		? `${formatNumber(request.usage.cacheRead)}  +${formatNumber(request.cacheReadDelta)} observed`
		: formatNumber(request.usage.cacheRead);
	const lines = [
		`${timestampPrefix(request.timestamp)}${request.status}`,
		metricLine("Cached input", cachedInput),
		metricLine("New input", formatNumber(request.usage.input)),
	];
	if (request.usage.cacheWrite > 0) {
		lines.push(metricLine("Cache creation", formatNumber(request.usage.cacheWrite)));
	}
	if (request.usage.cacheRead > 0) {
		lines.push(metricLine("Cache share", `${Math.round((request.usage.cacheRead / request.promptInput) * 100)}%`));
	}
	if (request.recreation) {
		lines.push(metricLine("Reprocessed input", formatNumber(request.recreation.reprocessedTokens)));
	}
	for (const observation of request.observations) lines.push(`  ${displayText(observation.text)}`);
	if (request.endAnnotation) lines.push(`  ${request.endAnnotation}`);
	if (request.recreation) lines.push("  Provider cause unknown");
	return lines;
}

export function renderPromptCacheAuditText(audit: PromptCacheAudit): string {
	const route = displayText(audit.routeLabel);
	const upstream = audit.upstreamProvider ? ` via ${displayText(audit.upstreamProvider)}` : "";
	const multiplier = audit.currentRoute.reuseMultiplier;
	const lines = [
		"Prompt Cache Timeline",
		`${route}${upstream} · current branch · main agent`,
		"",
		"Current route",
		metricLine("Cached requests", formatNumber(audit.currentRoute.cachedRequests)),
		metricLine("Cumulative cached input", formatNumber(audit.currentRoute.cumulativeCachedInput)),
		metricLine("Largest cached input", formatNumber(audit.currentRoute.largestCachedInput)),
		metricLine("Reuse multiplier", multiplier === undefined ? "—" : `${multiplier.toFixed(2)}×`),
		metricLine("Explicit recreations", formatNumber(audit.currentRoute.explicitRecreations)),
		"",
		"Session volume",
		metricLine("Requests", formatNumber(audit.sessionVolume.requests)),
		metricLine("Cumulative cached input", formatNumber(audit.sessionVolume.cumulativeCachedInput)),
		metricLine("Cache creation", formatNumber(audit.sessionVolume.cacheCreation)),
		metricLine("Explicit recreations", formatNumber(audit.sessionVolume.explicitRecreations)),
		"",
		`${timestampPrefix(audit.routeStart.timestamp)}ROUTE STARTED`,
		`  ${audit.routeStart.description}`,
	];
	if (audit.requests.length === 0) {
		lines.push("No requests recorded for the current route.");
	} else {
		for (const request of audit.requests) lines.push("", ...requestLines(request));
	}
	lines.push(
		"",
		"Cached input repeats earlier context on every request.",
		"Reuse multiplier compares cumulative reads with the largest single read; it is not a hit rate.",
	);
	return lines.join("\n");
}

export function buildPromptCacheAuditReportText(runtime: SlashCommandRuntime): string {
	if (runtime.session.agentKind() !== "main") return MAIN_AGENT_ONLY_MESSAGE;
	if (!runtime.session.model) return NO_MODEL_MESSAGE;
	const audit = buildPromptCacheAudit(runtime.sessionManager.getBranch(), runtime.session.model);
	return audit ? renderPromptCacheAuditText(audit) : NO_MODEL_MESSAGE;
}
