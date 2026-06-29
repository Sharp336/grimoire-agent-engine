import { describe, expect, test } from "bun:test";
import {
	MAX_EDIT_SNAPSHOT_TEXT_CHARS,
	pruneOversizedEditDetails,
} from "@oh-my-pi/pi-coding-agent/edit/snapshot-details";

describe("edit snapshot details", () => {
	test("preserves small oldText and newText snapshots", () => {
		const details = pruneOversizedEditDetails({
			diff: "@@\n-before\n+after",
			path: "small.ts",
			oldText: "before\n",
			newText: "after\n",
		});

		expect(details.oldText).toBe("before\n");
		expect(details.newText).toBe("after\n");
	});

	test("omits oversized oldText and newText snapshots without dropping diff metadata", () => {
		const oversizedText = "x".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS + 1);
		const details = pruneOversizedEditDetails({
			diff: "@@\n-before\n+after",
			path: "large.ts",
			firstChangedLine: 12,
			oldText: oversizedText,
			newText: "after\n",
		});

		expect(details.diff).toBe("@@\n-before\n+after");
		expect(details.path).toBe("large.ts");
		expect(details.firstChangedLine).toBe(12);
		expect("oldText" in details).toBe(false);
		expect("newText" in details).toBe(false);
	});

	test("omits oversized snapshots from per-file edit results", () => {
		const oversizedText = "x".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS + 1);
		const details = pruneOversizedEditDetails({
			diff: "@@\n-a\n+b",
			perFileResults: [
				{
					path: "large.ts",
					diff: "@@\n-a\n+b",
					oldText: oversizedText,
					newText: "b\n",
				},
				{
					path: "small.ts",
					diff: "@@\n-before\n+after",
					oldText: "before\n",
					newText: "after\n",
				},
			],
		});

		expect(details.perFileResults?.[0]?.diff).toBe("@@\n-a\n+b");
		expect("oldText" in (details.perFileResults?.[0] ?? {})).toBe(false);
		expect("newText" in (details.perFileResults?.[0] ?? {})).toBe(false);
		expect(details.perFileResults?.[1]?.oldText).toBe("before\n");
		expect(details.perFileResults?.[1]?.newText).toBe("after\n");
	});
});
