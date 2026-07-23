/**
 * Display metadata for a `TimeRange` — keeps chart labels, sparkline bucket
 * counts, and x-axis date formatting in sync with the server-side bucketing
 * defined in `aggregator.ts`.
 */

import { format } from "date-fns";
import type { TranslationFn } from "../i18n";
import type { TimeRange } from "../types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIVE_MIN_MS = 5 * 60 * 1000;

export interface RangeMeta {
	/** Human label used in chart subtitles ("the last 24 hours"). */
	windowLabel: string;
	/** Short prefix used in compact column headers ("24h Trend"). */
	trendLabel: string;
	/** Bucket size matching the server query for this range. */
	bucketMs: number;
	/** Number of buckets the server is expected to return for this range. */
	bucketCount: number;
	/** date-fns format string for x-axis labels and tooltip headings. */
	tickFormat: string;
}

const RANGE_META_BASE: Record<TimeRange, Omit<RangeMeta, "windowLabel">> = {
	"1h": {
		trendLabel: "1h Trend",
		bucketMs: FIVE_MIN_MS,
		bucketCount: 12,
		tickFormat: "HH:mm",
	},
	"24h": {
		trendLabel: "24h Trend",
		bucketMs: HOUR_MS,
		bucketCount: 24,
		tickFormat: "HH:mm",
	},
	"7d": {
		trendLabel: "7d Trend",
		bucketMs: DAY_MS,
		bucketCount: 7,
		tickFormat: "MMM d",
	},
	"30d": {
		trendLabel: "30d Trend",
		bucketMs: DAY_MS,
		bucketCount: 30,
		tickFormat: "MMM d",
	},
	"90d": {
		trendLabel: "90d Trend",
		bucketMs: DAY_MS,
		bucketCount: 90,
		tickFormat: "MMM d",
	},
	all: { trendLabel: "Trend", bucketMs: DAY_MS, bucketCount: 0, tickFormat: "MMM d" },
};

const WINDOW_LABEL_KEY: Record<TimeRange, string> = {
	"1h": "range.lastHour",
	"24h": "range.last24h",
	"7d": "range.last7d",
	"30d": "range.last30d",
	"90d": "range.last90d",
	all: "range.allTime",
};

export interface RangeBucketMeta {
	/** Bucket size matching the server query for this range. */
	bucketMs: number;
	/** Number of buckets the server is expected to return for this range. */
	bucketCount: number;
}

/** Get bucketing metadata without translation - for data processing functions. */
export function rangeBucketMeta(range: TimeRange): RangeBucketMeta {
	const base = RANGE_META_BASE[range];
	return {
		bucketMs: base.bucketMs,
		bucketCount: base.bucketCount,
	};
}

export function rangeMeta(range: TimeRange, t: TranslationFn): RangeMeta {
	const base = RANGE_META_BASE[range];
	return {
		...base,
		windowLabel: t(WINDOW_LABEL_KEY[range]),
		trendLabel: t(`trend.${range}`),
	};
}

/** Format a timestamp using the range's tick format. */
export function formatRangeTick(timestamp: number, range: TimeRange): string {
	return format(new Date(timestamp), RANGE_META_BASE[range].tickFormat);
}
