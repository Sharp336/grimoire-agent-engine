import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";

/** Below this the rate is nonsense (cached/instant responses yield absurd tok/s). */
const MIN_DURATION_MS = 100;

/** Local `YYYY-MM-DD HH:mm:ss` stamp for the per-turn usage row. */
function formatUsageTimestamp(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	return `${date} ${time}`;
}

/** Format the metrics shared by standalone usage blocks and compact tool groups. */
export function formatUsageRow(
	usage: Usage,
	durationMs?: number,
	ttftMs?: number,
	timestamp?: number,
	model?: string,
	thinkingLevel?: string,
): string {
	const totalInput = usage.input + usage.cacheWrite;
	const parts: string[] = [];
	// Lead with the turn's local wall-clock time (down to the second), log-line style.
	if (timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0) {
		parts.push(formatUsageTimestamp(timestamp));
	}
	parts.push(`${theme.icon.input} ${formatNumber(totalInput)}`);
	parts.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
	if (usage.cacheRead > 0) {
		parts.push(`${theme.icon.cache} ${formatNumber(usage.cacheRead)}`);
	}
	if (ttftMs && ttftMs > 0) {
		parts.push(`${theme.icon.time} ${(ttftMs / 1000).toFixed(1)}s`);
	}
	if (durationMs && durationMs > MIN_DURATION_MS && usage.output > 0) {
		// TPS over the total request duration — the post-TTFT window undercounts
		// generation time when reasoning tokens are hidden before the first
		// visible byte, inflating the rate.
		const tokPerSec = (usage.output / durationMs) * 1000;
		parts.push(`${theme.icon.throughput} ${tokPerSec.toFixed(1)}/s`);
	}
	if (model) {
		parts.push(model);
	}
	if (thinkingLevel !== undefined && thinkingLevel !== ThinkingLevel.Off) {
		parts.push(thinkingLevel);
	}
	return parts.join("  ");
}

// `timestamp` is optional and trails the throughput args to preserve the existing
// (usage, durationMs, ttftMs) call contract; `model` and `thinkingLevel` trail
// `timestamp` for the same reason — this function is part of the package's
// public export surface (./modes/components/*).
export function createUsageRowBlock(
	usage: Usage,
	durationMs?: number,
	ttftMs?: number,
	timestamp?: number,
	model?: string,
	thinkingLevel?: string,
): Container {
	const block = new Container();
	block.addChild(new Spacer(1));
	block.addChild(
		new Text(theme.fg("dim", formatUsageRow(usage, durationMs, ttftMs, timestamp, model, thinkingLevel)), 1, 0),
	);
	return block;
}
