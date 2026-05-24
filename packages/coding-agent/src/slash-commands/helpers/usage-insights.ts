import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";

interface RawMessage {
	sessionId: string;
	timestamp: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface PeriodRawData {
	messages: RawMessage[];
	sessionCosts: Map<string, number>;
}

interface SessionSpan {
	startMs: number;
	endMs: number;
}

interface Insight {
	percent: number;
	headline: string;
	advice: string;
}

interface ParsedSessionFile {
	sessionId: string;
	messages: RawMessage[];
}

interface PeriodStarts {
	todayMs: number;
	weekStartMs: number;
	lastWeekStartMs: number;
}

type PeriodName = "today" | "thisWeek" | "lastWeek" | "allTime";

const PERIOD_ORDER: readonly PeriodName[] = ["today", "thisWeek", "lastWeek", "allTime"];
const PARALLEL_WINDOW_MS = 2 * 60_000;
const PARALLEL_SESSION_THRESHOLD = 4;
const LARGE_CONTEXT_THRESHOLD = 150_000;
const LARGE_CACHE_MISS_THRESHOLD = 100_000;
const LONG_SESSION_MS = 8 * 60 * 60 * 1000;
const TOP_SESSION_COUNT = 5;
const MIN_MESSAGES_FOR_PARALLEL_INSIGHT = 10;
const MIN_PERCENT_TO_SHOW = 1;

function emptyPeriodRawData(): PeriodRawData {
	return { messages: [], sessionCosts: new Map() };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseTimestamp(entry: Record<string, unknown>, message: Record<string, unknown>): number {
	const direct = asNumber(message.timestamp);
	if (direct > 0) return direct;
	const raw = entry.timestamp;
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		return Number.isNaN(parsed) ? 0 : parsed;
	}
	return asNumber(raw);
}

function parseSessionLine(
	line: string,
	fallbackSessionId: string,
): { sessionId?: string; message?: RawMessage } | undefined {
	const entry = asRecord(JSON.parse(line));
	if (!entry) return undefined;
	if (entry.type === "session") {
		return typeof entry.id === "string" ? { sessionId: entry.id } : undefined;
	}
	if (entry.type !== "message") return undefined;
	const message = asRecord(entry.message);
	if (!message) return undefined;

	const usage =
		message.role === "assistant"
			? asRecord(message.usage)
			: message.role === "toolResult" && message.toolName === "task"
				? asRecord(asRecord(message.details)?.usage)
				: undefined;
	if (!usage) return undefined;

	const input = asNumber(usage.input);
	const output = asNumber(usage.output);
	const cacheRead = asNumber(usage.cacheRead);
	const cacheWrite = asNumber(usage.cacheWrite);
	const totalTokens = input + output + cacheRead + cacheWrite;
	if (totalTokens <= 0) return undefined;

	const cost = asNumber(asRecord(usage.cost)?.total);
	return {
		message: {
			sessionId: fallbackSessionId,
			timestamp: parseTimestamp(entry, message),
			cost,
			input,
			output,
			cacheRead,
			cacheWrite,
		},
	};
}
function buildMessageDedupKey(message: RawMessage): string {
	return [
		message.sessionId,
		message.timestamp,
		message.cost,
		message.input,
		message.output,
		message.cacheRead,
		message.cacheWrite,
	].join(":");
}

async function collectSessionFiles(dir: string, files: string[], signal?: AbortSignal): Promise<void> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (signal?.aborted) return;
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await collectSessionFiles(entryPath, files, signal);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(entryPath);
			}
		}
	} catch {
		// Ignore unreadable/missing session directories.
	}
}

async function parseSessionFile(
	filePath: string,
	seenHashes: Set<string>,
	signal?: AbortSignal,
): Promise<ParsedSessionFile | null> {
	try {
		const lines = (await Bun.file(filePath).text()).split("\n");
		let sessionId = path.basename(filePath, ".jsonl");
		const messages: RawMessage[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (signal?.aborted) return null;
			const line = lines[i]!.trim();
			if (!line) continue;
			try {
				const parsed = parseSessionLine(line, sessionId);
				if (parsed?.sessionId) {
					sessionId = parsed.sessionId;
					continue;
				}
				const message = parsed?.message;
				if (!message) continue;
				message.sessionId = sessionId;
				const hash = buildMessageDedupKey(message);
				if (seenHashes.has(hash)) continue;
				seenHashes.add(hash);
				messages.push(message);
			} catch {
				// Skip malformed lines.
			}
		}
		return { sessionId, messages };
	} catch {
		return null;
	}
}

function getPeriodStarts(now = new Date()): PeriodStarts {
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const week = new Date(now);
	const dayOfWeek = week.getDay();
	week.setDate(week.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
	week.setHours(0, 0, 0, 0);
	const lastWeek = new Date(week);
	lastWeek.setDate(lastWeek.getDate() - 7);
	return { todayMs: today.getTime(), weekStartMs: week.getTime(), lastWeekStartMs: lastWeek.getTime() };
}

function getPeriods(timestamp: number, starts: PeriodStarts): PeriodName[] {
	const periods: PeriodName[] = ["allTime"];
	if (timestamp >= starts.todayMs) periods.push("today");
	if (timestamp >= starts.weekStartMs) periods.push("thisWeek");
	else if (timestamp >= starts.lastWeekStartMs) periods.push("lastWeek");
	return periods;
}

function addMessage(rawByPeriod: Record<PeriodName, PeriodRawData>, message: RawMessage, starts: PeriodStarts): void {
	for (const period of getPeriods(message.timestamp, starts)) {
		const raw = rawByPeriod[period];
		raw.messages.push(message);
		raw.sessionCosts.set(message.sessionId, (raw.sessionCosts.get(message.sessionId) ?? 0) + message.cost);
	}
}

function computeParallelCostWeight(messages: RawMessage[]): number | null {
	const timed = messages.filter(message => message.timestamp > 0);
	if (timed.length < MIN_MESSAGES_FOR_PARALLEL_INSIGHT) return null;
	if (new Set(timed.map(message => message.sessionId)).size < PARALLEL_SESSION_THRESHOLD) return null;

	const sorted = timed.slice().sort((a, b) => a.timestamp - b.timestamp);
	const sessionCounts = new Map<string, number>();
	let uniqueSessions = 0;
	let left = 0;
	let right = 0;
	let cost = 0;

	for (let i = 0; i < sorted.length; i++) {
		const current = sorted[i]!;
		const high = current.timestamp + PARALLEL_WINDOW_MS;
		const low = current.timestamp - PARALLEL_WINDOW_MS;
		while (right < sorted.length && sorted[right]!.timestamp <= high) {
			const sessionId = sorted[right]!.sessionId;
			const next = (sessionCounts.get(sessionId) ?? 0) + 1;
			sessionCounts.set(sessionId, next);
			if (next === 1) uniqueSessions++;
			right++;
		}
		while (left < right && sorted[left]!.timestamp < low) {
			const sessionId = sorted[left]!.sessionId;
			const next = (sessionCounts.get(sessionId) ?? 0) - 1;
			if (next === 0) {
				sessionCounts.delete(sessionId);
				uniqueSessions--;
			} else {
				sessionCounts.set(sessionId, next);
			}
			left++;
		}
		if (uniqueSessions >= PARALLEL_SESSION_THRESHOLD) cost += current.cost;
	}
	return cost;
}

function formatThresholdTokens(n: number): string {
	if (n >= 1_000_000) return `${n / 1_000_000}M`;
	if (n >= 1_000) return `${n / 1_000}k`;
	return String(n);
}

function formatInsightPercent(percent: number): string {
	return percent >= 10 ? `${Math.round(percent)}%` : `${Math.round(percent * 10) / 10}%`;
}

function computeInsights(raw: PeriodRawData, longSessionIds: Set<string>): Insight[] {
	const total = raw.messages.reduce((sum, message) => sum + message.cost, 0);
	if (raw.messages.length === 0 || total <= 0) return [];
	const insights: Insight[] = [];

	const parallelWeight = computeParallelCostWeight(raw.messages);
	if (parallelWeight !== null) {
		insights.push({
			percent: (parallelWeight / total) * 100,
			headline: `of cost was while ${PARALLEL_SESSION_THRESHOLD}+ sessions ran in parallel`,
			advice: "All sessions share one rate limit; queue non-urgent work when capacity matters.",
		});
	}

	const largeContextWeight = raw.messages
		.filter(message => message.input + message.cacheRead + message.cacheWrite > LARGE_CONTEXT_THRESHOLD)
		.reduce((sum, message) => sum + message.cost, 0);
	insights.push({
		percent: (largeContextWeight / total) * 100,
		headline: `of cost was at >${formatThresholdTokens(LARGE_CONTEXT_THRESHOLD)} context`,
		advice: "Compact mid-task and clear when switching tasks to avoid paying for stale context.",
	});

	const uncachedWeight = raw.messages
		.filter(message => message.input + message.cacheWrite > LARGE_CACHE_MISS_THRESHOLD)
		.reduce((sum, message) => sum + message.cost, 0);
	insights.push({
		percent: (uncachedWeight / total) * 100,
		headline: `of cost came from >${formatThresholdTokens(LARGE_CACHE_MISS_THRESHOLD)} uncached prompts`,
		advice: "Compact before stepping away; cold-start prompts are often the expensive turns.",
	});

	const longWeight = raw.messages
		.filter(message => longSessionIds.has(message.sessionId))
		.reduce((sum, message) => sum + message.cost, 0);
	if (longWeight > 0) {
		insights.push({
			percent: (longWeight / total) * 100,
			headline: `of cost came from sessions active for ${LONG_SESSION_MS / 3_600_000}+ hours`,
			advice: "Background loops add up; make long-running sessions explicit.",
		});
	}

	if (raw.sessionCosts.size > TOP_SESSION_COUNT) {
		const sorted = [...raw.sessionCosts.values()].sort((a, b) => b - a);
		const topCount = Math.min(TOP_SESSION_COUNT, sorted.length);
		const topWeight = sorted.slice(0, topCount).reduce((sum, cost) => sum + cost, 0);
		insights.push({
			percent: (topWeight / total) * 100,
			headline: `of cost came from your top ${topCount} sessions`,
			advice: "A small number of sessions drives most spend; inspect those before optimizing globally.",
		});
	}

	return insights.filter(insight => insight.percent >= MIN_PERCENT_TO_SHOW).sort((a, b) => b.percent - a.percent);
}

function renderPeriodName(period: PeriodName): string {
	if (period === "today") return "Today";
	if (period === "thisWeek") return "This week";
	if (period === "lastWeek") return "Last week";
	return "All time";
}

export async function buildUsageInsightsText(signal?: AbortSignal): Promise<string> {
	const files: string[] = [];
	await collectSessionFiles(getSessionsDir(), files, signal);
	if (signal?.aborted || files.length === 0) return "";

	const starts = getPeriodStarts();
	const rawByPeriod: Record<PeriodName, PeriodRawData> = {
		today: emptyPeriodRawData(),
		thisWeek: emptyPeriodRawData(),
		lastWeek: emptyPeriodRawData(),
		allTime: emptyPeriodRawData(),
	};
	const spans = new Map<string, SessionSpan>();
	const seenHashes = new Set<string>();

	for (const file of files) {
		if (signal?.aborted) return "";
		const parsed = await parseSessionFile(file, seenHashes, signal);
		if (!parsed) continue;
		for (const message of parsed.messages) {
			if (message.timestamp > 0) {
				const span = spans.get(message.sessionId);
				if (span) {
					if (message.timestamp < span.startMs) span.startMs = message.timestamp;
					if (message.timestamp > span.endMs) span.endMs = message.timestamp;
				} else {
					spans.set(message.sessionId, { startMs: message.timestamp, endMs: message.timestamp });
				}
			}
			addMessage(rawByPeriod, message, starts);
		}
	}

	const longSessionIds = new Set<string>();
	for (const [sessionId, span] of spans) {
		if (span.endMs - span.startMs >= LONG_SESSION_MS) longSessionIds.add(sessionId);
	}

	const lines = ["", "Usage insights"];
	let rendered = false;
	for (const period of PERIOD_ORDER) {
		const insights = computeInsights(rawByPeriod[period], longSessionIds).slice(0, 3);
		if (insights.length === 0) continue;
		rendered = true;
		lines.push(`${renderPeriodName(period)}:`);
		for (const insight of insights) {
			lines.push(`- ${formatInsightPercent(insight.percent)} ${insight.headline}`);
			lines.push(`  ${insight.advice}`);
		}
	}
	return rendered ? lines.join("\n") : "";
}

export const _test = { buildMessageDedupKey, computeInsights, parseSessionLine };
