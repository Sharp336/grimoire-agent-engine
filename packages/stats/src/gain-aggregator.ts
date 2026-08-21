/**
 * Aggregates token-savings data for the Gain dashboard.
 *
 * Sources:
 *   1. Bash minimizer: ~/.omp/agent/minimizer-gain.jsonl
 *   2. Snapcompact:    colocated with stats.db as snapcompact-savings.jsonl
 *
 * Missing files are treated as zero records — never an error.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getStatsDbPath, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { getTimeRangeConfig } from "./aggregator";
import { initDb } from "./db";
import type {
	GainDashboardStats,
	GainMissedCommand,
	GainSourceTotals,
	GainTimeSeriesPoint,
	GainTopFilter,
} from "./shared-types";

const BYTES_PER_TOKEN_ESTIMATE = 4;
const SQLITE_VARIABLE_CHUNK_SIZE = 500;

// ---------------------------------------------------------------------------
// Minimizer record schema
// ---------------------------------------------------------------------------

interface MinimizerRecord {
	timestamp: string; // ISO
	filter: string;
	command?: string;
	inputBytes: number;
	outputBytes: number;
	savedBytes: number;
	savedTokens?: number;
	kind: "saved" | "missed";
	sessionId?: string;
	/** Session project that originated the command when its execution cwd is external. */
	sessionCwd?: string;
	cwd: string;
}

// Paths that carry no tuning signal — temp/internal locations.
const TEMP_PATH_RE =
	/\/T(?:\/|$)|\/tmp(?:\/|$)|\/pi-bash-exec(?:\/|$)|\/omp-bash-exec(?:\/|$)|\/pi-bash-detach(?:\/|$)|^\/var\/folders(?:\/|$)/;

// ---------------------------------------------------------------------------
// Project-match helper
// ---------------------------------------------------------------------------

function canonicalProjectPath(p: string): string {
	const normalized = p.replaceAll("\\", "/").replace(/\/+$/u, "");
	return normalized || "/";
}

/** True when `candidate` exactly equals `parent` or is a separator-bounded sub-path. */
function isSameOrSubPath(candidate: string, parent: string): boolean {
	const normalizedCandidate = canonicalProjectPath(candidate);
	const normalizedParent = canonicalProjectPath(parent);
	return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`);
}

/**
 * True when `cwd` (or its normalized project root) exactly equals `project`
 * or is a direct sub-path of it.
 *
 * Normalization is applied so that a cwd of `/repo/.worktrees/lane/src`
 * matches a project root of `/repo` — the selector shows normalized roots, so
 * the filter must compare apples-to-apples. Backslashes are normalized first
 * so Windows realpath records are matched correctly.
 */
function matchesProject(cwd: string | undefined, project: string): boolean {
	if (!cwd) return false;
	const normalizedCwd = normalizeProjectPath(cwd) ?? canonicalProjectPath(cwd);
	const normalizedProject = normalizeProjectPath(project) ?? canonicalProjectPath(project);
	return isSameOrSubPath(normalizedCwd, normalizedProject) || isSameOrSubPath(cwd, normalizedProject);
}

/** Returns the project that should receive a record's gain attribution. */
function attributedProjectCwd(record: MinimizerRecord): string {
	if (record.sessionCwd && !matchesProject(record.cwd, record.sessionCwd)) return record.sessionCwd;
	return record.cwd;
}

// ---------------------------------------------------------------------------
// Minimizer JSONL — stat-keyed parsed cache, three derived result sets
// ---------------------------------------------------------------------------

interface ParsedMinimizerRecord extends MinimizerRecord {
	timestampMs: number;
}

interface MinimizerSets {
	records: ParsedMinimizerRecord[];
	missed: ParsedMinimizerRecord[];
	projects: Set<string>;
}

interface MinimizerCache {
	key: string;
	records: ParsedMinimizerRecord[];
}

let minimizerCache: MinimizerCache | undefined;

// This is the exact UTC millisecond format emitted by the telemetry writer's
// `new Date().toISOString()`. Require both this shape and a round-trip match so
// loose Date coercions cannot turn malformed JSON into historical buckets.
const WRITER_ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function parseWriterTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string" || !WRITER_ISO_TIMESTAMP_RE.test(value)) return undefined;
	const timestampMs = new Date(value).getTime();
	return Number.isFinite(timestampMs) && new Date(timestampMs).toISOString() === value ? timestampMs : undefined;
}

async function readMinimizerRecords(): Promise<ParsedMinimizerRecord[]> {
	const filePath = path.join(getAgentDir(), "minimizer-gain.jsonl");

	let stat: Stats;
	try {
		stat = await fs.stat(filePath);
	} catch (err) {
		if (isEnoent(err)) minimizerCache = undefined;
		else logger.debug("gain-aggregator: failed to stat minimizer-gain.jsonl", { err: String(err) });
		return [];
	}

	const cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}`;
	if (minimizerCache?.key === cacheKey) return minimizerCache.records;

	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) minimizerCache = undefined;
		else logger.debug("gain-aggregator: failed to read minimizer-gain.jsonl", { err: String(err) });
		return [];
	}

	const records: ParsedMinimizerRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line) as MinimizerRecord;
			const timestampMs = parseWriterTimestamp(rec.timestamp);
			if (timestampMs !== undefined) records.push({ ...rec, timestampMs });
		} catch {
			/* skip malformed line */
		}
	}
	minimizerCache = { key: cacheKey, records };
	return records;
}

/**
 * Derive all three minimizer result sets from cached, writer-validated records.
 * The stat key prevents unchanged dashboard polls from re-reading or re-parsing
 * the lifetime JSONL file.
 */
async function readMinimizerSets(cutoff: number | null, project: string | null): Promise<MinimizerSets> {
	const records = await readMinimizerRecords();
	const sets: MinimizerSets = { records: [], missed: [], projects: new Set() };

	for (const rec of records) {
		if (cutoff !== null && rec.timestampMs < cutoff) continue;

		// Collect range-scoped project cwds before the per-project filter so the
		// selector still shows other projects in the active time range. Explicit
		// external execution cwds belong to the session project that launched them.
		const projectCwd = attributedProjectCwd(rec);
		if (projectCwd) sets.projects.add(projectCwd);

		if (project !== null && !matchesProject(projectCwd, project)) continue;

		if (rec.kind === "missed") {
			// Missed records from meaningful cwds are filter-tuning candidates.
			if (!TEMP_PATH_RE.test(rec.cwd ?? "")) {
				sets.missed.push(rec);
			}
		} else {
			sets.records.push(rec);
		}
	}
	return sets;
}

// ---------------------------------------------------------------------------
// Project normalization & deduplication
// ---------------------------------------------------------------------------

/**
 * Collapse worktree sub-paths to their logical project root.
 *
 * Rules are generic: omp internal wt paths are dropped; conventional worktree
 * suffixes (`.wt/`, `-wt/`, `.worktrees/`, `-worktrees/`) are stripped. No
 * author-specific IDE or tool paths are baked in.
 *
 * Returns null to drop temp/internal paths entirely.
 */
export function normalizeProjectPath(p: string): string | null {
	const clean = canonicalProjectPath(p);
	if (TEMP_PATH_RE.test(clean)) return null;
	// omp internal worktrees — not meaningful project roots
	if (/\/\.omp\/wt\//.test(clean)) return null;

	// Generic worktree layouts — strip the worktree suffix/subpath.
	// Matches: <root>/.wt/<lane>/..., <root>-wt/<lane>/...,
	//          <root>.wt/<lane>/..., <root>/.worktrees/<lane>/...,
	//          <root>-worktrees/<lane>/..., <root>/.<dotdir>/worktrees/<name>/...
	const m = clean.match(
		/^(.+?)(?:\/\.wt\/|\/\.worktrees\/|-worktrees\/|-wt\/|\.wt\/|\/\.[^/]+\/worktrees\/)[^/]+(?:\/.*)?$/,
	);
	if (m) return m[1];

	return clean;
}

/**
 * Given a raw set of paths, normalize worktree paths and remove sub-paths
 * that are already covered by a shorter parent at depth ≥ 4.
 * Returns a sorted, deduped list of meaningful project roots.
 */
export function dedupeProjects(rawPaths: Set<string>): string[] {
	const normalized = new Set<string>();
	for (const p of rawPaths) {
		const n = normalizeProjectPath(p);
		if (n) normalized.add(n);
	}
	const sorted = Array.from(normalized).sort();
	return sorted.filter(p => {
		// Drop p if a shorter path is a proper prefix of it AND that parent is deep enough
		// to be a meaningful scope boundary (depth ≥ 4), not a catch-all like /Users/x.
		return !sorted.some(
			other =>
				other !== p &&
				other.length < p.length &&
				p.startsWith(other.endsWith("/") ? other : `${other}/`) &&
				other.split("/").filter(Boolean).length >= 4,
		);
	});
}

// ---------------------------------------------------------------------------
// Snapcompact record schema
// ---------------------------------------------------------------------------

interface SnapcompactRecord {
	ts: number; // epoch ms
	session: string;
	provider: string;
	model: string;
	toolCallId: string;
	savedTokens: number;
}

interface SnapcompactSets {
	records: SnapcompactRecord[];
	projects: Set<string>;
}

/**
 * Map snapcompact session IDs to the project folder(s) they belong to,
 * using the stats DB `messages(session_file, folder)` join. This preserves
 * the per-project snapcompact view that existed before the minimizer source
 * was added.
 */
async function readProjectsBySession(sessions: readonly string[]): Promise<Map<string, Set<string>>> {
	const uniqueSessions = Array.from(new Set(sessions.filter(Boolean)));
	const projectsBySession = new Map<string, Set<string>>();
	if (uniqueSessions.length === 0) return projectsBySession;

	const database = await initDb();
	for (let i = 0; i < uniqueSessions.length; i += SQLITE_VARIABLE_CHUNK_SIZE) {
		const chunk = uniqueSessions.slice(i, i + SQLITE_VARIABLE_CHUNK_SIZE);
		const placeholders = chunk.map(() => "?").join(",");
		const rows = database
			.prepare(`SELECT DISTINCT session_file, folder FROM messages WHERE session_file IN (${placeholders})`)
			.all(...chunk) as Array<{ session_file: string; folder: string }>;
		for (const row of rows) {
			if (!row.folder) continue;
			let projects = projectsBySession.get(row.session_file);
			if (!projects) {
				projects = new Set<string>();
				projectsBySession.set(row.session_file, projects);
			}
			projects.add(row.folder);
		}
	}
	return projectsBySession;
}

interface SnapcompactCache {
	key: string;
	records: SnapcompactRecord[];
}

let snapcompactCache: SnapcompactCache | undefined;

/**
 * Parse the snapcompact JSONL, resolve session → project folder via the stats
 * DB, and filter to the requested project. Returns both the filtered records
 * and the full set of snapcompact project folders (for the project selector).
 */
async function readSnapcompactSets(cutoff: number | null, project: string | null): Promise<SnapcompactSets> {
	const filePath = path.join(path.dirname(getStatsDbPath()), "snapcompact-savings.jsonl");

	let stat: Stats;
	try {
		stat = await fs.stat(filePath);
	} catch (err) {
		if (isEnoent(err)) return { records: [], projects: new Set() };
		logger.debug("gain-aggregator: failed to stat snapcompact-savings.jsonl", { err: String(err) });
		return { records: [], projects: new Set() };
	}

	const cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}`;
	let parsed: SnapcompactRecord[];
	if (snapcompactCache?.key === cacheKey) {
		parsed = snapcompactCache.records;
	} else {
		let text: string;
		try {
			text = await Bun.file(filePath).text();
		} catch (readErr) {
			if (isEnoent(readErr)) return { records: [], projects: new Set() };
			logger.debug("gain-aggregator: failed to read snapcompact-savings.jsonl", { err: String(readErr) });
			return { records: [], projects: new Set() };
		}

		parsed = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const rec = JSON.parse(line) as SnapcompactRecord;
				parsed.push(rec);
			} catch {
				/* skip malformed line */
			}
		}
		snapcompactCache = { key: cacheKey, records: parsed };
	}

	const filtered = cutoff === null ? parsed : parsed.filter(rec => rec.ts >= cutoff);
	const seen = new Set<string>();
	const deduped: SnapcompactRecord[] = [];
	for (const rec of filtered) {
		const key = `${rec.session}:${rec.toolCallId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(rec);
	}
	const projectsBySession = await readProjectsBySession(deduped.map(rec => rec.session));
	const projects = new Set<string>();
	const records: SnapcompactRecord[] = [];
	for (const rec of deduped) {
		const sessionProjects = projectsBySession.get(rec.session);
		if (sessionProjects) {
			for (const sessionProject of sessionProjects) projects.add(sessionProject);
		}
		if (project !== null) {
			if (
				!sessionProjects ||
				!Array.from(sessionProjects).some(sessionProject => matchesProject(sessionProject, project))
			) {
				continue;
			}
		}
		records.push(rec);
	}

	return { records, projects };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function emptyTotals(): GainSourceTotals {
	return {
		savedTokens: 0,
		savedBytes: 0,
		hits: 0,
		outputBytes: 0,
		originalBytes: 0,
		reductionPercent: null,
	};
}

function finalizeReductionPercent(totals: GainSourceTotals): GainSourceTotals {
	if (totals.originalBytes > 0) {
		totals.reductionPercent = totals.savedBytes / totals.originalBytes;
	}
	return totals;
}

/** ISO date string from epoch ms, bucketed to the day. */
function toDateBucket(epochMs: number): string {
	return new Date(epochMs).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ---------------------------------------------------------------------------
// Main aggregation function
// ---------------------------------------------------------------------------

export async function getGainDashboardStats(
	range?: string | null,
	project?: string | null,
): Promise<GainDashboardStats> {
	const { cutoff: effectiveCutoff } = getTimeRangeConfig(range);
	const effectiveProject: string | null = project?.trim() || null;

	const [minimizerSets, snapcompactSets] = await Promise.all([
		readMinimizerSets(effectiveCutoff, effectiveProject),
		readSnapcompactSets(effectiveCutoff, effectiveProject),
	]);

	const { records: minimizerRecords, missed: missedRecords, projects: minimizerProjects } = minimizerSets;
	const { records: snapcompactRecords, projects: snapcompactProjects } = snapcompactSets;

	const minimizerTotals = emptyTotals();
	const filterMap = new Map<string, GainTopFilter>();
	const timeMap = new Map<string, { minimizer: number; snapcompact: number }>();

	for (const rec of minimizerRecords) {
		const tokens = rec.savedTokens ?? Math.floor((rec.savedBytes ?? 0) / BYTES_PER_TOKEN_ESTIMATE);
		const savedBytes = rec.savedBytes ?? 0;
		const inputBytes = rec.inputBytes ?? 0;

		minimizerTotals.savedTokens += tokens;
		minimizerTotals.savedBytes += savedBytes;
		minimizerTotals.hits += 1;
		minimizerTotals.originalBytes += inputBytes;
		minimizerTotals.outputBytes += rec.outputBytes ?? 0;

		const existing = filterMap.get(rec.filter);
		if (existing) {
			existing.savedTokens += tokens;
			existing.savedBytes += savedBytes;
			existing.hits += 1;
		} else {
			filterMap.set(rec.filter, { filter: rec.filter, savedTokens: tokens, savedBytes, hits: 1 });
		}

		const date = toDateBucket(rec.timestampMs);
		const bucket = timeMap.get(date) ?? { minimizer: 0, snapcompact: 0 };
		bucket.minimizer += tokens;
		timeMap.set(date, bucket);
	}
	finalizeReductionPercent(minimizerTotals);

	const cmdMap = new Map<string, GainMissedCommand>();
	for (const rec of missedRecords) {
		const fullKey = rec.command ?? "";
		const existing = cmdMap.get(fullKey);
		if (existing) {
			existing.hits += 1;
			existing.inputBytes += rec.inputBytes ?? 0;
		} else {
			cmdMap.set(fullKey, { command: fullKey, hits: 1, inputBytes: rec.inputBytes ?? 0 });
		}
	}
	const missedCommands: GainMissedCommand[] = Array.from(cmdMap.values())
		.sort((a, b) => b.hits - a.hits)
		.slice(0, 25);

	const snapcompactTotals = emptyTotals();
	for (const rec of snapcompactRecords) {
		snapcompactTotals.savedTokens += rec.savedTokens;
		const approxBytes = rec.savedTokens * BYTES_PER_TOKEN_ESTIMATE;
		snapcompactTotals.savedBytes += approxBytes;
		snapcompactTotals.hits += 1;

		const date = toDateBucket(rec.ts);
		const bucket = timeMap.get(date) ?? { minimizer: 0, snapcompact: 0 };
		bucket.snapcompact += rec.savedTokens;
		timeMap.set(date, bucket);
	}

	const overall: GainSourceTotals = {
		savedTokens: minimizerTotals.savedTokens + snapcompactTotals.savedTokens,
		savedBytes: minimizerTotals.savedBytes + snapcompactTotals.savedBytes,
		hits: minimizerTotals.hits + snapcompactTotals.hits,
		outputBytes: minimizerTotals.outputBytes,
		originalBytes: minimizerTotals.originalBytes,
		reductionPercent: snapcompactTotals.hits > 0 ? null : minimizerTotals.reductionPercent,
	};

	const timeSeries: GainTimeSeriesPoint[] = Array.from(timeMap.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, bucket]) => ({
			date,
			minimizer: bucket.minimizer,
			snapcompact: bucket.snapcompact,
			total: bucket.minimizer + bucket.snapcompact,
		}));

	const topFilters: GainTopFilter[] = Array.from(filterMap.values())
		.sort((a, b) => b.savedTokens - a.savedTokens)
		.slice(0, 10);

	// Merge minimizer cwds and snapcompact session-folder paths into the project selector.
	const allProjectPaths = new Set<string>([...minimizerProjects, ...snapcompactProjects]);
	const projects = dedupeProjects(allProjectPaths);

	return {
		overall,
		bySource: {
			minimizer: minimizerTotals,
			snapcompact: snapcompactTotals,
		},
		timeSeries,
		topFilters,
		missedCommands,
		project: effectiveProject,
		projects,
	};
}
