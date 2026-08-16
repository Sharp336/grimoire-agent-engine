/**
 * Dream diary — the human-inspectable record of dreaming passes.
 *
 * `DREAMS.md` lives in the project's memory root next to `MEMORY.md`, so
 * `/memory clear` wipes it together with the artifacts it narrates. The file
 * is a plain markdown log: a prose header followed by `## `-delimited entries,
 * newest first. Hand-written content above the first entry heading survives
 * every append byte-for-byte; the entry list itself is managed (prepend + cap).
 *
 * The diary is never injected into prompts — it exists for the user, and its
 * newest entry timestamp doubles as the persisted dream cooldown marker.
 */
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { getMemoryRoot } from "../memories";

export const DREAM_DIARY_FILE = "DREAMS.md";

const DIARY_HEADER = [
	"# Dream Diary",
	"",
	"Background memory consolidation log, newest first. Each entry records one",
	"dreaming pass over recent session history while the agent sat idle.",
	"Generated content — safe to delete; `/memory clear` removes it too.",
].join("\n");

/** Cap synopsis bullets per entry so one busy dream cannot bloat the diary. */
const MAX_SYNOPSES_PER_ENTRY = 8;
const MAX_SYNOPSIS_CHARS = 300;
const MAX_REFLECTION_CHARS = 1_500;

export interface DreamDiaryEntry {
	/** Unix seconds the dreaming pass started. */
	atSec: number;
	trigger: "idle" | "manual";
	/** Pre-formatted fact bullets (backend, counts, outcome). */
	facts: string[];
	/** Optional model-written reflection paragraph. */
	reflection?: string;
	/** Optional synopses of the sessions reviewed in this pass. */
	synopses?: string[];
}

export function getDreamDiaryPath(agentDir: string, cwd: string): string {
	return path.join(getMemoryRoot(agentDir, cwd), DREAM_DIARY_FILE);
}

function formatTimestamp(atSec: number): string {
	return new Date(atSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Collapse a synopsis to one bounded line so entry structure stays parseable. */
function formatSynopsisLine(synopsis: string): string {
	const flat = synopsis.replace(/\s+/g, " ").trim();
	if (flat.length <= MAX_SYNOPSIS_CHARS) return flat;
	return `${flat.slice(0, MAX_SYNOPSIS_CHARS)}…`;
}

function renderEntry(entry: DreamDiaryEntry): string {
	const lines: string[] = [`## ${formatTimestamp(entry.atSec)} — ${entry.trigger} dream`, ""];
	for (const fact of entry.facts) lines.push(`- ${fact}`);

	const reflection = entry.reflection?.replace(/\s+/g, " ").trim();
	if (reflection) {
		lines.push(
			"",
			reflection.length <= MAX_REFLECTION_CHARS ? reflection : `${reflection.slice(0, MAX_REFLECTION_CHARS)}…`,
		);
	}

	const synopses = (entry.synopses ?? []).map(formatSynopsisLine).filter(Boolean);
	if (synopses.length > 0) {
		lines.push("", "Session synopses:", "");
		for (const synopsis of synopses.slice(0, MAX_SYNOPSES_PER_ENTRY)) lines.push(`- ${synopsis}`);
	}
	return lines.join("\n");
}

function splitDiary(text: string): { header: string; entries: string[] } {
	const lines = text.split("\n");
	const starts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) starts.push(i);
	}
	if (starts.length === 0) return { header: text.trimEnd(), entries: [] };
	const header = lines.slice(0, starts[0]).join("\n").trimEnd();
	const entries = starts.map((start, k) => {
		const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
		return lines.slice(start, end).join("\n").trimEnd();
	});
	return { header, entries };
}

/** Per-path write chains serializing diary read-modify-write. */
const diaryWriteChains = new Map<string, Promise<unknown>>();

/**
 * Prepend one entry to the diary (newest-first, capped at `maxEntries`).
 * Creates the file with the standard header when missing; preserves any
 * existing pre-entry header content on later writes.
 */
export async function appendDreamDiaryEntry(
	filePath: string,
	entry: DreamDiaryEntry,
	maxEntries: number,
): Promise<void> {
	// Serialize per file: a manual `/dream now` racing an idle dream in another
	// session sharing the project memory root must not drop the other's entry.
	const run = (diaryWriteChains.get(filePath) ?? Promise.resolve()).then(() =>
		writeEntry(filePath, entry, maxEntries),
	);
	const guarded = run.catch(() => {});
	diaryWriteChains.set(filePath, guarded);
	try {
		await run;
	} finally {
		if (diaryWriteChains.get(filePath) === guarded) diaryWriteChains.delete(filePath);
	}
}

async function writeEntry(filePath: string, entry: DreamDiaryEntry, maxEntries: number): Promise<void> {
	let existing = "";
	try {
		existing = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	const { header, entries } = splitDiary(existing);
	const kept = [renderEntry(entry), ...entries].slice(0, Math.max(1, maxEntries));
	const body = `${header || DIARY_HEADER}\n\n${kept.join("\n\n")}\n`;
	await Bun.write(filePath, body);
}

/**
 * Newest recorded dream time in unix seconds, or undefined when the diary is
 * missing or has no parseable entry. Scans all entry headings (not just the
 * first) so a hand-reordered file still yields the latest pass.
 */
export async function readLastDreamTimeSec(filePath: string): Promise<number | undefined> {
	let text = "";
	try {
		text = await Bun.file(filePath).text();
	} catch {
		return undefined;
	}
	let latest: number | undefined;
	for (const entry of splitDiary(text).entries) {
		const match = entry.match(/^## (\S+)/);
		if (!match) continue;
		const parsed = Date.parse(match[1]);
		if (!Number.isFinite(parsed)) continue;
		const sec = Math.floor(parsed / 1000);
		if (latest === undefined || sec > latest) latest = sec;
	}
	return latest;
}

/** The newest `count` diary entries as markdown, or undefined when none exist. */
export async function readRecentDreamEntries(filePath: string, count: number): Promise<string | undefined> {
	let text = "";
	try {
		text = await Bun.file(filePath).text();
	} catch {
		return undefined;
	}
	const { entries } = splitDiary(text);
	if (entries.length === 0) return undefined;
	return entries.slice(0, Math.max(1, count)).join("\n\n");
}
