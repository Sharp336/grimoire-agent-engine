/**
 * Scheduled prompts: one-shot, recurring, and cron-based prompt injection.
 *
 * Complements the heartbeat feature (single recurring timer) with:
 * - One-shot: `/schedule in 30m Check the build` — fires once after a delay
 * - Recurring: `/schedule every 10m Check the build` — fires repeatedly
 * - Cron: `/schedule cron "0 9 * * 1-5" Review open work` — fires at wall-clock times
 *
 * Multiple schedules can be active simultaneously, each with a unique ID.
 */

const TIME_UNITS_MS: Record<string, number> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

export type ScheduleKind = "once" | "interval" | "cron";

export interface ScheduledItem {
	id: string;
	kind: ScheduleKind;
	/** Delay in ms for "once", interval in ms for "interval", undefined for "cron". */
	intervalMs?: number;
	/** Cron fields for "cron" kind. */
	cronFields?: CronFields;
	/** Next fire timestamp (ms epoch). */
	nextFireAt: number;
	/** Instruction injected when the schedule fires. */
	instruction: string;
	/** Whether this schedule is still active. */
	active: boolean;
}

export type ParsedScheduleCommand =
	| { type: "list" }
	| { type: "cancel"; id: string }
	| { type: "clear" }
	| { type: "add"; kind: ScheduleKind; intervalMs?: number; cronFields?: CronFields; instruction: string };

const SCHEDULE_USAGE =
	"Usage:\n" +
	"  /schedule in <DELAY> <instruction>     — one-shot\n" +
	"  /schedule every <INTERVAL> <instruction> — recurring\n" +
	'  /schedule cron "<EXPR>" <instruction>    — cron-based\n' +
	"  /schedule list\n" +
	"  /schedule cancel <id>\n" +
	"  /schedule clear\n" +
	"Examples:\n" +
	"  /schedule in 30m Check the build status\n" +
	"  /schedule every 10m Check the deployment\n" +
	'  /schedule cron "0 9 * * 1-5" Review open PRs';

let scheduleIdCounter = 0;

export function nextScheduleId(): string {
	scheduleIdCounter++;
	return `s${scheduleIdCounter.toString(36)}`;
}

export function parseScheduleCommand(args: string): ParsedScheduleCommand | string {
	const trimmed = args.trim();
	if (!trimmed) return SCHEDULE_USAGE;

	const firstSpace = trimmed.search(/\s/);
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
	const lower = firstToken.toLowerCase();

	// Subcommands
	if (lower === "list" || lower === "ls") return { type: "list" };
	if (lower === "clear" || lower === "off" || lower === "stop") return { type: "clear" };
	if (lower === "cancel" || lower === "rm") {
		if (!rest) return "Usage: /schedule cancel <id>";
		return { type: "cancel", id: rest.split(/\s/)[0] };
	}

	// One-shot: "in 30m <instruction>" or "in 2 hours <instruction>"
	if (lower === "in") {
		const parsed = splitDelayAndInstruction(rest);
		if (!parsed) return "Schedule requires an instruction. Example: /schedule in 30m Check the build";
		if (typeof parsed.delayMs === "string") return parsed.delayMs;
		return { type: "add", kind: "once", intervalMs: parsed.delayMs, instruction: parsed.instruction };
	}

	// Recurring: "every 10m <instruction>" or "every 2 hours <instruction>"
	if (lower === "every") {
		const parsed = splitDelayAndInstruction(rest);
		if (!parsed) return "Schedule requires an instruction. Example: /schedule every 10m Check the build";
		if (typeof parsed.delayMs === "string") return parsed.delayMs;
		return { type: "add", kind: "interval", intervalMs: parsed.delayMs, instruction: parsed.instruction };
	}

	// Cron: "cron \"0 9 * * 1-5\" <instruction>"
	if (lower === "cron") {
		const cronMatch = /^"([^"]+)"\s+(.+)$/.exec(rest) || /^'([^']+)'\s+(.+)$/.exec(rest);
		if (!cronMatch) {
			return 'Cron schedule requires a quoted expression. Example: /schedule cron "0 9 * * 1-5" Review open PRs';
		}
		const cronFields = parseCronExpression(cronMatch[1]);
		if (typeof cronFields === "string") return cronFields;
		const instruction = cronMatch[2].trim();
		if (!instruction) return "Schedule requires an instruction.";
		return { type: "add", kind: "cron", cronFields, instruction };
	}

	return SCHEDULE_USAGE;
}

/**
 * Parse a delay token like "30m", "1h30m", "2 hours", "45 minutes".
 * Returns the delay in ms or an error message string.
 */
export function parseDelayToken(token: string): number | string {
	const lower = token.toLowerCase();

	// Compound: "10m", "1h30m"
	if (/^(?:\d+[a-z]+)+$/.test(lower)) {
		const segments = lower.match(/\d+[a-z]+/g);
		if (!segments) return SCHEDULE_USAGE;
		let totalMs = 0;
		for (const segment of segments) {
			const match = /^(\d+)([a-z]+)$/.exec(segment);
			if (!match) return SCHEDULE_USAGE;
			const unitMs = TIME_UNITS_MS[match[2]];
			if (unitMs === undefined) return "Unknown time unit. Use seconds, minutes, hours, or days.";
			totalMs += Number(match[1]) * unitMs;
		}
		if (totalMs <= 0) return "Delay must be positive.";
		return totalMs;
	}

	// Space-separated: "30 minutes" (handled by caller splitting on space)
	const spaceMatch = /^(\d+)\s+([a-z]+)$/.exec(lower);
	if (spaceMatch) {
		const unitMs = TIME_UNITS_MS[spaceMatch[2]];
		if (unitMs === undefined) return "Unknown time unit. Use seconds, minutes, hours, or days.";
		const totalMs = Number(spaceMatch[1]) * unitMs;
		if (totalMs <= 0) return "Delay must be positive.";
		return totalMs;
	}

	return `Could not parse delay: "${token}". Examples: 30m, 1h, 2h30m`;
}

/**
 * Split a delay + instruction from text like "30m Check the build" or
 * "2 hours Review PRs". Tries compound form first (single token), then
 * word form (number + unit word). Returns null when no instruction remains.
 */
function splitDelayAndInstruction(text: string): { delayMs: number | string; instruction: string } | null {
	const firstSpace = text.search(/\s/);
	if (firstSpace === -1) return null;
	const firstToken = text.slice(0, firstSpace);
	const afterFirst = text.slice(firstSpace + 1).trim();

	// Try compound form: "30m", "1h30m"
	const compoundMs = parseDelayToken(firstToken);
	if (typeof compoundMs === "number") {
		if (!afterFirst) return null;
		return { delayMs: compoundMs, instruction: afterFirst };
	}

	// Try word form: "2 hours", "30 minutes"
	const secondSpace = afterFirst.search(/\s/);
	const secondToken = secondSpace === -1 ? afterFirst : afterFirst.slice(0, secondSpace);
	const twoTokens = `${firstToken} ${secondToken}`;
	const wordMs = parseDelayToken(twoTokens);
	if (typeof wordMs === "number") {
		const instruction = secondSpace === -1 ? "" : afterFirst.slice(secondSpace + 1).trim();
		if (!instruction) return null;
		return { delayMs: wordMs, instruction };
	}

	// Return the error from the compound attempt (most common form)
	return { delayMs: compoundMs, instruction: "" };
}

/** Human-readable description of a delay in ms. */
export function describeDelay(ms: number): string {
	if (ms % 86_400_000 === 0) {
		const days = ms / 86_400_000;
		return `${days} ${days === 1 ? "day" : "days"}`;
	}
	if (ms % 3_600_000 === 0) {
		const hours = ms / 3_600_000;
		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	if (ms % 60_000 === 0) {
		const minutes = ms / 60_000;
		return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	}
	const seconds = Math.round(ms / 1_000);
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

export function describeSchedule(item: ScheduledItem): string {
	const shortInstruction = item.instruction.length > 40 ? `${item.instruction.slice(0, 37)}...` : item.instruction;
	if (item.kind === "once") {
		return `in ${describeDelay(item.intervalMs!)} — ${shortInstruction}`;
	}
	if (item.kind === "interval") {
		return `every ${describeDelay(item.intervalMs!)} — ${shortInstruction}`;
	}
	return `cron — ${shortInstruction}`;
}

export function formatScheduleList(items: readonly ScheduledItem[]): string {
	const active = items.filter(i => i.active);
	if (active.length === 0) return "No active schedules.";
	const lines = active.map(item => {
		const fire = new Date(item.nextFireAt).toLocaleTimeString();
		return `  ${item.id}: ${describeSchedule(item)} (next: ${fire})`;
	});
	return `Active schedules (${active.length}):\n${lines.join("\n")}`;
}

// ─── Cron parsing ──────────────────────────────────────────────────────────

export interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
	/** Whether the day-of-month field was a wildcard (*). Controls DOM/DOW OR semantics. */
	domWildcard: boolean;
	/** Whether the day-of-week field was a wildcard (*). Controls DOM/DOW OR semantics. */
	dowWildcard: boolean;
}

/** Standard cron aliases. */
const CRON_ALIASES: Record<string, string> = {
	"@yearly": "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
	"@monthly": "0 0 1 * *",
	"@weekly": "0 0 * * 0",
	"@daily": "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@hourly": "0 * * * *",
};

const MAX_CRON_SCAN_ITERATIONS = 4 * 366 * 24 * 60; // ~4 years to cover leap cycles

export function parseCronExpression(expr: string): CronFields | string {
	const normalized = CRON_ALIASES[expr.toLowerCase()] ?? expr;
	const parts = normalized.trim().split(/\s+/);
	if (parts.length !== 5) {
		return `Cron expression must have 5 fields (minute hour day-of-month month day-of-week). Got: "${expr}"`;
	}
	try {
		return {
			minute: parseCronField(parts[0], 0, 59),
			hour: parseCronField(parts[1], 0, 23),
			dayOfMonth: parseCronField(parts[2], 1, 31),
			month: parseCronField(parts[3], 1, 12),
			dayOfWeek: parseCronField(parts[4], 0, 6),
			domWildcard: parts[2] === "*" || parts[2] === "?",
			dowWildcard: parts[4] === "*" || parts[4] === "?",
		};
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

function parseCronField(field: string, min: number, max: number): Set<number> {
	const result = new Set<number>();
	const dowNames: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
	const monthNames: Record<string, number> = {
		jan: 1,
		feb: 2,
		mar: 3,
		apr: 4,
		may: 5,
		jun: 6,
		jul: 7,
		aug: 8,
		sep: 9,
		oct: 10,
		nov: 11,
		dec: 12,
	};

	const resolveValue = (str: string): number => {
		const lower = str.toLowerCase();
		if (dowNames[lower] !== undefined) return dowNames[lower];
		if (monthNames[lower] !== undefined) return monthNames[lower];
		const n = Number(str);
		if (!Number.isInteger(n)) throw new Error(`Invalid cron value: "${str}"`);
		return n;
	};

	for (const part of field.split(",")) {
		const starStepMatch = /^\*\/(\d+)$/.exec(part);

		if (starStepMatch) {
			const step = Number(starStepMatch[1]);
			if (step <= 0) throw new Error(`Cron step must be positive: "${part}"`);
			for (let v = min; v <= max; v += step) result.add(v);
			continue;
		}

		// Range with optional step: "1-5" or "1-5/2"
		const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part);
		if (rangeMatch) {
			const start = Number(rangeMatch[1]);
			const end = Number(rangeMatch[2]);
			const step = rangeMatch[3] ? Number(rangeMatch[3]) : 1;
			if (step <= 0) throw new Error(`Cron step must be positive: "${part}"`);
			if (start > end || start < min || end > max) {
				throw new Error(`Cron range out of bounds: "${part}"`);
			}
			for (let v = start; v <= end; v += step) result.add(v);
			continue;
		}

		// Wildcard
		if (part === "*" || part === "?") {
			for (let v = min; v <= max; v++) result.add(v);
			continue;
		}

		// Single value
		const v = resolveValue(part);
		if (v < min || v > max) {
			throw new Error(`Cron value ${v} out of range [${min}, ${max}]`);
		}
		result.add(v);
	}

	if (result.size === 0) {
		throw new Error(`Empty cron field: "${field}"`);
	}
	return result;
}

/**
 * Compute the next time a cron expression fires after `from`.
 * Uses brute-force minute-by-minute scan. Returns `undefined` when no fire time
 * exists within the scan window (~4 years, covering leap-year cycles).
 *
 * Implements standard cron DOM/DOW semantics: when both day-of-month and
 * day-of-week are restricted (non-wildcard), the expression matches if EITHER
 * field matches (OR). When one is a wildcard, only the other restricts.
 */
export function computeNextCronFire(fields: CronFields, from: Date): number | undefined {
	const start = new Date(from);
	start.setSeconds(0, 0);
	start.setMinutes(start.getMinutes() + 1);

	for (let i = 0; i < MAX_CRON_SCAN_ITERATIONS; i++) {
		if (
			fields.minute.has(start.getMinutes()) &&
			fields.hour.has(start.getHours()) &&
			fields.month.has(start.getMonth() + 1) &&
			dayMatches(fields, start)
		) {
			return start.getTime();
		}
		start.setMinutes(start.getMinutes() + 1);
	}

	return undefined;
}

/**
 * Standard cron day-matching rule:
 * - Both wildcards → always match
 * - One wildcard → only the non-wildcard field restricts
 * - Both restricted → OR (match if either matches)
 */
function dayMatches(fields: CronFields, date: Date): boolean {
	const domMatch = fields.dayOfMonth.has(date.getDate());
	const dowMatch = fields.dayOfWeek.has(date.getDay());
	if (fields.domWildcard && fields.dowWildcard) return true;
	if (fields.domWildcard) return dowMatch;
	if (fields.dowWildcard) return domMatch;
	return domMatch || dowMatch;
}
