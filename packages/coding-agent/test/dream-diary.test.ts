import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendDreamDiaryEntry,
	type DreamDiaryEntry,
	readLastDreamTimeSec,
	readRecentDreamEntries,
} from "@oh-my-pi/pi-coding-agent/dream";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";

let sharedRoot: TempDir | undefined;

beforeAll(async () => {
	sharedRoot = await TempDir.create(`@dream-diary-${Snowflake.next()}`);
});

afterAll(async () => {
	if (sharedRoot) {
		await Bun.sleep(0);
		await sharedRoot.remove();
	}
	sharedRoot = undefined;
});

async function makeDiaryPath(): Promise<string> {
	const base = sharedRoot?.path() ?? os.tmpdir();
	const dir = path.join(base, `diary-${Snowflake.next()}`);
	await fs.mkdir(dir, { recursive: true });
	return path.join(dir, "DREAMS.md");
}

function entryAt(atSec: number, overrides?: Partial<DreamDiaryEntry>): DreamDiaryEntry {
	return {
		atSec,
		trigger: "idle",
		facts: ["Backend: local", `Marker: ${atSec}`],
		...overrides,
	};
}

describe("dream diary", () => {
	test("first append creates the file with a header and a parseable entry", async () => {
		const diaryPath = await makeDiaryPath();
		await appendDreamDiaryEntry(
			diaryPath,
			entryAt(1_700_000_000, {
				trigger: "manual",
				reflection: "I reviewed  the refactor\nsessions.",
				synopses: ["Fixed the flaky CI test", "  "],
			}),
			10,
		);

		const text = await fs.readFile(diaryPath, "utf8");
		expect(text).toStartWith("# Dream Diary");
		expect(text).toContain("## 2023-11-14T22:13:20Z — manual dream");
		expect(text).toContain("- Backend: local");
		// Reflection whitespace is collapsed to one line; blank synopses are dropped.
		expect(text).toContain("I reviewed the refactor sessions.");
		expect(text).toContain("- Fixed the flaky CI test");
		expect(await readLastDreamTimeSec(diaryPath)).toBe(1_700_000_000);
	});

	test("entries are newest-first and capped at maxEntries", async () => {
		const diaryPath = await makeDiaryPath();
		await appendDreamDiaryEntry(diaryPath, entryAt(1_700_000_000), 2);
		await appendDreamDiaryEntry(diaryPath, entryAt(1_700_010_000), 2);
		await appendDreamDiaryEntry(diaryPath, entryAt(1_700_020_000), 2);

		const text = await fs.readFile(diaryPath, "utf8");
		expect(text).not.toContain("Marker: 1700000000");
		const newest = text.indexOf("Marker: 1700020000");
		const older = text.indexOf("Marker: 1700010000");
		expect(newest).toBeGreaterThan(-1);
		expect(older).toBeGreaterThan(newest);
		expect(await readLastDreamTimeSec(diaryPath)).toBe(1_700_020_000);
	});

	test("hand-written content above the first entry survives appends", async () => {
		const diaryPath = await makeDiaryPath();
		const custom = "# My Dreams\n\nKeep this note.";
		await fs.writeFile(diaryPath, `${custom}\n\n## 2023-11-14T22:13:20Z — idle dream\n\n- Marker: old\n`);
		await appendDreamDiaryEntry(diaryPath, entryAt(1_700_020_000), 10);

		const text = await fs.readFile(diaryPath, "utf8");
		expect(text).toStartWith(custom);
		expect(text).toContain("Marker: old");
		expect(text.indexOf("Marker: 1700020000")).toBeLessThan(text.indexOf("Marker: old"));
	});

	test("missing or entry-less diaries read as undefined", async () => {
		const diaryPath = await makeDiaryPath();
		expect(await readLastDreamTimeSec(diaryPath)).toBeUndefined();
		expect(await readRecentDreamEntries(diaryPath, 3)).toBeUndefined();

		await fs.writeFile(diaryPath, "# Dream Diary\n\nNo entries yet.\n");
		expect(await readLastDreamTimeSec(diaryPath)).toBeUndefined();
		expect(await readRecentDreamEntries(diaryPath, 3)).toBeUndefined();
	});

	test("readRecentDreamEntries returns only the newest N entries", async () => {
		const diaryPath = await makeDiaryPath();
		await appendDreamDiaryEntry(diaryPath, entryAt(1_700_000_000), 10);
		await appendDreamDiaryEntry(diaryPath, entryAt(1_700_010_000), 10);
		await appendDreamDiaryEntry(diaryPath, entryAt(1_700_020_000), 10);

		const recent = await readRecentDreamEntries(diaryPath, 2);
		expect(recent).toBeDefined();
		expect(recent).toContain("Marker: 1700020000");
		expect(recent).toContain("Marker: 1700010000");
		expect(recent).not.toContain("Marker: 1700000000");
		expect(recent).not.toContain("# Dream Diary");
	});
});
