import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { GitRefRecord } from "../../session/session-manager";

export interface BranchLabelGlyphs {
	branch: string;
}

export function formatBranchLabel(
	args: { initial?: string; latest?: string },
	width: number,
	glyphs: BranchLabelGlyphs,
): string {
	let { initial, latest } = args;
	if (initial === undefined && latest === undefined) return "";
	latest ??= initial;
	initial ??= latest;
	const single = `${glyphs.branch} ${initial}`;
	if (initial === latest) {
		return visibleWidth(single) <= width ? single : truncateToWidth(single, width);
	}
	const combined = `${glyphs.branch} ${initial} → ${latest}`;
	if (visibleWidth(combined) <= width) return combined;
	const fallback = `${glyphs.branch} ${latest}`;
	return visibleWidth(fallback) <= width ? fallback : truncateToWidth(fallback, width);
}

export function formatBranchChain(chain: readonly string[], width: number, glyphs: BranchLabelGlyphs): string {
	if (chain.length === 0) return "";
	if (chain.length === 1) {
		return formatBranchLabel({ initial: chain[0], latest: chain[0] }, width, glyphs);
	}
	if (chain.length === 2) {
		return formatBranchLabel({ initial: chain[0], latest: chain[1] }, width, glyphs);
	}
	const full = `${glyphs.branch} ${chain.join(" → ")}`;
	if (visibleWidth(full) <= width) return full;
	const abbreviated = `${glyphs.branch} ${chain[0]} → … → ${chain.at(-1)}`;
	return visibleWidth(abbreviated) <= width ? abbreviated : truncateToWidth(abbreviated, width);
}

function formatDwell(dwellMs: number): string {
	if (dwellMs < 60_000) return "< 1m";
	const minutes = dwellMs / 60_000;
	if (minutes < 60) return `${Math.round(minutes)}m`;
	const hours = (minutes / 60).toFixed(1);
	return `${hours.endsWith(".0") ? hours.slice(0, -2) : hours}h`;
}

export function formatBranchHistory(
	chronology: readonly GitRefRecord[],
	now: Date,
	_glyphs: BranchLabelGlyphs,
): string {
	if (chronology.length <= 1) return "";
	const nowMs = now.getTime();
	const segments: string[] = [];
	for (let i = 0; i < chronology.length; i++) {
		const current = chronology[i];
		if (i === chronology.length - 1) {
			segments.push(`${current.branch} (current)`);
			continue;
		}
		if (current.at === undefined) {
			segments.push(current.branch);
			continue;
		}
		const currentMs = Date.parse(current.at);
		const nextAt = chronology[i + 1]?.at;
		const nextMs = nextAt === undefined ? nowMs : Date.parse(nextAt);
		if (!Number.isFinite(currentMs) || !Number.isFinite(nextMs)) {
			segments.push(current.branch);
			continue;
		}
		segments.push(`${current.branch} (${formatDwell(Math.max(0, nextMs - currentMs))})`);
	}
	return `Branch history: ${segments.join(" · ")}`;
}
