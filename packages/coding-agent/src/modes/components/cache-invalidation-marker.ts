import type { Component } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";
import type { CacheInvalidation } from "../../session/cache-telemetry";

const CACHE_INVALIDATION_RULE_WIDTH = 10;

/**
 * Slim left-aligned divider rendered above an assistant turn whose request lost
 * the prompt cache. Mirrors the compaction divider's banner styling but spans
 * only a short rule plus label (not the full width) and carries no expandable
 * detail:
 *
 *   ────────── ⊘ cache miss · 50.9k tokens
 */
export class CacheInvalidationMarkerComponent implements Component {
	#cache?: { width: number; lines: string[] };

	constructor(private readonly info: CacheInvalidation) {}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) {
			return this.#cache.lines;
		}
		const lines = ["", this.#divider(width), ""];
		this.#cache = { width, lines };
		return lines;
	}

	#divider(width: number): string {
		const icon = theme.icon.cacheMiss;
		const head = icon ? `${icon} cache miss` : "cache miss";
		const tokens = this.info.reprocessedTokens;
		const label = tokens > 0 ? `${head} ${theme.sep.dot.trim()} ${formatNumber(tokens)} tokens` : head;
		const labelWidth = Bun.stringWidth(label, { countAnsiEscapeCodes: false });
		const ruleWidth = Math.min(CACHE_INVALIDATION_RULE_WIDTH, width - labelWidth - 1);
		if (ruleWidth < 1) {
			// Too narrow to frame — emit the bare label.
			return theme.fg("muted", label);
		}
		return `${theme.fg("dim", theme.tree.horizontal.repeat(ruleWidth))} ${theme.fg("muted", label)}`;
	}
}
