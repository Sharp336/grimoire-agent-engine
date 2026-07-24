import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	parsePatch,
	type WriteResult,
} from "@oh-my-pi/hashline";

const PATH = "src/old.ts";
const DEST = "src/new.ts";
const CONTENT = "one\ntwo\nthree\n";

describe("hashline file ops", () => {
	it("parses REM and rejects line ops in the same section", () => {
		expect(parsePatch("REM").fileOp).toEqual({ kind: "rem" });
		expect(() => parsePatch(`SWAP 1.=1:\n+one\nREM`)).toThrow(/REM.*line ops/);
	});

	it("parses MV with a normalized destination path", () => {
		const section = Patch.parseSingle(`[${PATH}#AB12]\nMV ${DEST}`);
		expect(section.fileOp).toEqual({ kind: "move", dest: DEST });
	});

	it("deletes a tagged file with REM", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nREM`));

		expect(result.sections[0]?.op).toBe("delete");
		expect(fs.get(PATH)).toBeUndefined();
		expect(snapshots.byHash(PATH, tag)).toBeNull();
	});

	it("moves a file without content edits", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT, [1, 2]);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nMV ${DEST}`));

		expect(result.sections[0]?.op).toBe("update");
		expect(result.sections[0]?.moveDest).toBe(DEST);
		expect(fs.get(PATH)).toBeUndefined();
		expect(fs.get(DEST)).toBe(CONTENT);
		expect(snapshots.byHash(DEST, tag)?.text).toBe(CONTENT);
		expect(snapshots.byHash(DEST, tag)?.seenLines).toEqual(new Set([1, 2]));
		expect(snapshots.byHash(PATH, tag)).toBeNull();
	});

	it("applies line edits then moves the updated content", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nSWAP 2.=2:\n+TWO\nMV ${DEST}`));

		expect(result.sections[0]?.moveDest).toBe(DEST);
		expect(fs.get(PATH)).toBeUndefined();
		expect(fs.get(DEST)).toBe("one\nTWO\nthree\n");
		expect(result.sections[0]?.fileHash).toBe(computeFileHash("one\nTWO\nthree\n"));
		expect(snapshots.head(DEST)?.hash).toBe(result.sections[0]?.fileHash);
	});

	it("derives hashes, snapshots, and reusable headers from filesystem-returned logical text", async () => {
		class TransformingFilesystem extends InMemoryFilesystem {
			override async writeText(path: string, content: string): Promise<WriteResult> {
				const logical = content.replace("TWO", String.raw`TWO\uD800`);
				await super.writeText(path, logical);
				return { text: logical, escapedCodeUnits: 1 };
			}
		}

		const fs = new TransformingFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT);
		const patcher = new Patcher({ fs, snapshots });
		const first = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nSWAP 2.=2:\n+TWO`));
		const firstResult = first.sections[0];
		if (!firstResult) throw new Error("expected one transformed section");

		const logical = `one\n${String.raw`TWO\uD800`}\nthree\n`;
		expect(firstResult.after).toBe(logical);
		expect(firstResult.escapedCodeUnits).toBe(1);
		expect(firstResult.fileHash).toBe(computeFileHash(logical));
		expect(snapshots.head(PATH)?.text).toBe(logical);

		const second = await patcher.apply(Patch.parse(`${firstResult.header}\nSWAP 1.=1:\n+ONE`));
		expect(second.sections[0]?.op).toBe("update");
	});

	it("leaves source and snapshot ownership intact when a destination move fails", async () => {
		class FailingMoveFilesystem extends InMemoryFilesystem {
			override async move(from: string, to: string, content: string): Promise<WriteResult>;
			override async move(from: string, to: string, content?: undefined): Promise<undefined>;
			override async move(_from: string, _to: string, _content?: string): Promise<WriteResult | undefined> {
				throw new Error("destination write failed");
			}
		}

		const fs = new FailingMoveFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT, [1, 2]);
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nMV ${DEST}`))).rejects.toThrow(
			"destination write failed",
		);
		expect(fs.get(PATH)).toBe(CONTENT);
		expect(fs.get(DEST)).toBeUndefined();
		expect(snapshots.byHash(PATH, tag)?.text).toBe(CONTENT);
		expect(snapshots.byHash(DEST, tag)).toBeNull();
	});
});
