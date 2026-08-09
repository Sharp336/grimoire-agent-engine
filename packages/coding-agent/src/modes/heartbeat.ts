/**
 * Heartbeat: a timer-based recurring prompt injection for the interactive mode.
 *
 * Unlike loop mode (which re-submits after every agent yield), a heartbeat
 * fires on a fixed interval — e.g. "every 10 minutes, check the deployment."
 * When the timer fires, the instruction is injected into the session queue.
 * If the agent is busy the injection is deferred until the current turn ends.
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
};

/** Minimum heartbeat interval to prevent excessive token burn. */
export const MIN_HEARTBEAT_INTERVAL_MS = 10_000;

export type HeartbeatStatus = "active" | "paused";

export interface HeartbeatState {
	/** Interval in milliseconds between heartbeat injections. */
	intervalMs: number;
	/** The instruction injected each tick. */
	instruction: string;
	/** Current lifecycle status. */
	status: HeartbeatStatus;
}

export type ParsedHeartbeatCommand =
	| { type: "status" }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "clear" }
	| { type: "set"; intervalMs: number; instruction: string };

const HEARTBEAT_USAGE =
	"Usage: /heartbeat <every INTERVAL> <instruction>\n" +
	"  /heartbeat every 10m Check the build status\n" +
	"  /heartbeat status\n" +
	"  /heartbeat pause\n" +
	"  /heartbeat resume\n" +
	"  /heartbeat clear";

/**
 * Parse a heartbeat interval token like `10m`, `90s`, `1h30m`, or `10 minutes`.
 * Returns the interval in milliseconds, or an error message string.
 */
export function parseHeartbeatInterval(token: string): number | string {
	const lower = token.toLowerCase();

	// Compound duration: "10m", "1h30m"
	if (/^(?:\d+[a-z]+)+$/.test(lower)) {
		const segments = lower.match(/\d+[a-z]+/g);
		if (!segments) return HEARTBEAT_USAGE;
		let totalMs = 0;
		for (const segment of segments) {
			const match = /^(\d+)([a-z]+)$/.exec(segment);
			if (!match) return HEARTBEAT_USAGE;
			const unitMs = TIME_UNITS_MS[match[2]];
			if (unitMs === undefined) {
				return "Heartbeat interval unit must be seconds, minutes, or hours.";
			}
			const amount = Number(match[1]);
			if (!Number.isSafeInteger(amount) || amount <= 0) {
				return "Heartbeat interval must be positive.";
			}
			totalMs += amount * unitMs;
		}
		if (totalMs < MIN_HEARTBEAT_INTERVAL_MS) {
			return `Heartbeat interval must be at least ${MIN_HEARTBEAT_INTERVAL_MS / 1_000} seconds.`;
		}
		return totalMs;
	}

	// Bare number + space + unit: "10 minutes", "5 seconds"
	const spaceMatch = /^(\d+)\s+([a-z]+)$/.exec(lower);
	if (spaceMatch) {
		const unitMs = TIME_UNITS_MS[spaceMatch[2]];
		if (unitMs === undefined) {
			return "Heartbeat interval unit must be seconds, minutes, or hours.";
		}
		const amount = Number(spaceMatch[1]);
		if (!Number.isSafeInteger(amount) || amount <= 0) {
			return "Heartbeat interval must be positive.";
		}
		const totalMs = amount * unitMs;
		if (totalMs < MIN_HEARTBEAT_INTERVAL_MS) {
			return `Heartbeat interval must be at least ${MIN_HEARTBEAT_INTERVAL_MS / 1_000} seconds.`;
		}
		return totalMs;
	}

	return HEARTBEAT_USAGE;
}

/**
 * Parse the arguments to `/heartbeat`.
 *
 * Subcommands: status, pause, resume, clear.
 * Set form: `/heartbeat every <INTERVAL> <instruction>` or
 *           `/heartbeat <INTERVAL> <instruction>`.
 *
 * Returns an error string on parse failure.
 */
export function parseHeartbeatCommand(args: string): ParsedHeartbeatCommand | string {
	const trimmed = args.trim();

	if (!trimmed) return HEARTBEAT_USAGE;

	const firstSpace = trimmed.search(/\s/);
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
	const lower = firstToken.toLowerCase();

	// Subcommands
	if (firstSpace === -1 || lower === "status" || lower === "pause" || lower === "resume" || lower === "clear") {
		switch (lower) {
			case "status":
				return { type: "status" };
			case "pause":
				return { type: "pause" };
			case "resume":
				return { type: "resume" };
			case "clear":
			case "off":
			case "stop":
				return { type: "clear" };
		}
	}

	// Strip optional leading "every"
	let intervalToken: string;
	let instructionText: string;

	if (lower === "every") {
		// /heartbeat every 10m <instruction>
		const nextSpace = rest.search(/\s/);
		if (nextSpace === -1) {
			return "Heartbeat requires an instruction. Example: /heartbeat every 10m Check the build status";
		}
		intervalToken = rest.slice(0, nextSpace);
		instructionText = rest.slice(nextSpace + 1).trim();
	} else {
		// /heartbeat 10m <instruction>
		intervalToken = firstToken;
		instructionText = rest;
	}

	if (!instructionText) {
		return "Heartbeat requires an instruction. Example: /heartbeat every 10m Check the build status";
	}

	const intervalMs = parseHeartbeatInterval(intervalToken);
	if (typeof intervalMs === "string") return intervalMs;

	return { type: "set", intervalMs, instruction: instructionText };
}

/** Human-readable description of an interval in milliseconds. */
export function describeHeartbeatInterval(intervalMs: number): string {
	if (intervalMs % 3_600_000 === 0) {
		const hours = intervalMs / 3_600_000;
		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	if (intervalMs % 60_000 === 0) {
		const minutes = intervalMs / 60_000;
		return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	}
	const seconds = Math.round(intervalMs / 1_000);
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/** Multi-line status report for `/heartbeat status`. */
export function formatHeartbeatStatus(state: HeartbeatState | undefined): string {
	if (!state) return "No heartbeat set. Use /heartbeat every <INTERVAL> <instruction> to create one.";
	const interval = describeHeartbeatInterval(state.intervalMs);
	const lines = [`Heartbeat: ${state.status}`, `Interval: every ${interval}`, `Instruction: ${state.instruction}`];
	return lines.join("\n");
}
