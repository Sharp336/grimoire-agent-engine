import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { sha256CouncilContent } from "@oh-my-pi/pi-coding-agent/council/hash";
import {
	CouncilInstructionSnapshotError,
	captureCouncilInstructionSnapshot,
} from "@oh-my-pi/pi-coding-agent/council/instructions";
import * as workspaceTree from "@oh-my-pi/pi-coding-agent/workspace-tree";
import { TempDir } from "@oh-my-pi/pi-utils";
import { directorySymlinkType, isWindows, symlinksSupported } from "./helpers/platform";

function workspace(rootPath: string, agentsMdFiles: string[]) {
	return { rootPath, rendered: "", truncated: false, totalLines: 0, agentsMdFiles };
}

/**
 * A canonical temp root. `os.tmpdir()` is `/var/folders/...` on macOS, whose realpath is
 * `/private/var/folders/...`, so a raw `TempDir` path would differ from every path the snapshot
 * returns and every assertion below would compare two spellings of the same file.
 */
function canonical(temp: TempDir, ...segments: string[]): string {
	return path.join(fs.realpathSync(temp.path()), ...segments);
}

afterEach(() => {
	mock.restore();
});

describe("council instruction snapshots", () => {
	it("centrally reads nested instructions, deduplicates, hashes, and orders shallow to deep", async () => {
		using temp = TempDir.createSync("@omp-council-instructions-");
		const repoRoot = canonical(temp, "repo");
		const nestedDirectory = path.join(repoRoot, "packages", "app");
		fs.mkdirSync(nestedDirectory, { recursive: true });
		const rootInstructions = path.join(repoRoot, "AGENTS.md");
		const nestedInstructions = path.join(nestedDirectory, "AGENTS.md");
		fs.writeFileSync(rootInstructions, "root rules");
		fs.writeFileSync(nestedInstructions, "nested rules");

		const snapshot = await captureCouncilInstructionSnapshot(
			{
				contextFiles: [{ path: rootInstructions, content: "root rules", depth: 0 }],
				workspaceTree: workspace(repoRoot, [nestedInstructions, rootInstructions, nestedInstructions]),
			},
			repoRoot,
		);

		expect(snapshot.repoRoot).toBe(repoRoot);
		expect(snapshot.contextFiles.map(entry => entry.path)).toEqual([rootInstructions, nestedInstructions]);
		expect(snapshot.contextFiles.map(entry => entry.content)).toEqual(["root rules", "nested rules"]);
		expect(snapshot.files).toEqual([
			{ path: rootInstructions, sha256: sha256CouncilContent("root rules") },
			{ path: nestedInstructions, sha256: sha256CouncilContent("nested rules") },
		]);
		expect(snapshot.totalBytes).toBe(Buffer.byteLength("root rulesnested rules"));
	});

	it("discovers sibling nested instructions from the canonical repository root", async () => {
		using temp = TempDir.createSync("@omp-council-instructions-sibling-");
		const repoRoot = canonical(temp, "repo");
		const sessionCwd = path.join(repoRoot, "packages", "a");
		const siblingDirectory = path.join(repoRoot, "packages", "b");
		fs.mkdirSync(sessionCwd, { recursive: true });
		fs.mkdirSync(siblingDirectory, { recursive: true });
		const siblingInstructions = path.join(siblingDirectory, "AGENTS.md");
		fs.writeFileSync(siblingInstructions, "sibling rules");

		const snapshot = await captureCouncilInstructionSnapshot(
			{ contextFiles: [], workspaceTree: workspace(sessionCwd, []) },
			repoRoot,
		);

		expect(snapshot.contextFiles).toEqual([{ path: siblingInstructions, content: "sibling rules" }]);
		expect(snapshot.files).toEqual([{ path: siblingInstructions, sha256: sha256CouncilContent("sibling rules") }]);
	});

	it("fails closed when complete nested instruction discovery fails", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-discovery-");
		const repoRoot = canonical(temp, "repo");
		fs.mkdirSync(repoRoot);
		const scan = spyOn(workspaceTree, "buildWorkspaceTree").mockRejectedValue(new Error("scanner timed out"));

		await expect(captureCouncilInstructionSnapshot({}, repoRoot)).rejects.toThrow(
			"Council instruction discovery failed: scanner timed out",
		);
		expect(scan).toHaveBeenCalledWith(repoRoot, { strict: true });
	});

	it("rejects a discovered instruction file outside the canonical repository", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-containment-");
		const repoRoot = canonical(temp, "repo");
		fs.mkdirSync(repoRoot);
		const outside = canonical(temp, "outside-AGENTS.md");
		fs.writeFileSync(outside, "outside");

		await expect(
			captureCouncilInstructionSnapshot({ workspaceTree: workspace(repoRoot, [outside]) }, repoRoot),
		).rejects.toThrow("resolves outside repository root");
	});

	it.skipIf(!symlinksSupported())("rejects a discovered instruction file that is itself a symlink", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-symlink-");
		const repoRoot = canonical(temp, "repo");
		fs.mkdirSync(repoRoot);
		const target = path.join(repoRoot, "real-AGENTS.md");
		const linked = path.join(repoRoot, "AGENTS.md");
		fs.writeFileSync(target, "inside");
		fs.symlinkSync(target, linked);

		await expect(
			captureCouncilInstructionSnapshot({ workspaceTree: workspace(repoRoot, [linked]) }, repoRoot),
		).rejects.toThrow("uses a symlink");
	});

	it.skipIf(!symlinksSupported())("captures instructions reached through a symlinked ancestor", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-ancestor-");
		const actualRoot = canonical(temp, "actual", "repo");
		const nestedDirectory = path.join(actualRoot, "packages", "app");
		fs.mkdirSync(nestedDirectory, { recursive: true });
		fs.writeFileSync(path.join(actualRoot, "AGENTS.md"), "root rules");
		fs.writeFileSync(path.join(nestedDirectory, "AGENTS.md"), "nested rules");
		fs.symlinkSync(canonical(temp, "actual"), canonical(temp, "link"), directorySymlinkType);
		const linkedRoot = canonical(temp, "link", "repo");

		const snapshot = await captureCouncilInstructionSnapshot(
			{
				contextFiles: [{ path: path.join(linkedRoot, "AGENTS.md"), content: "root rules", depth: 0 }],
				workspaceTree: workspace(linkedRoot, [path.join(linkedRoot, "packages", "app", "AGENTS.md")]),
			},
			linkedRoot,
		);

		expect(snapshot.repoRoot).toBe(actualRoot);
		expect(snapshot.contextFiles).toEqual([
			{ path: path.join(actualRoot, "AGENTS.md"), content: "root rules", depth: 0 },
			{ path: path.join(nestedDirectory, "AGENTS.md"), content: "nested rules" },
		]);
		expect(snapshot.totalBytes).toBe(Buffer.byteLength("root rulesnested rules"));
	});

	it("keeps inherited user-level instructions from outside the repository, ordered first", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-user-level-");
		const repoRoot = canonical(temp, "repo");
		const nestedDirectory = path.join(repoRoot, "packages", "app");
		fs.mkdirSync(nestedDirectory, { recursive: true });
		fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "root rules");
		fs.writeFileSync(path.join(nestedDirectory, "AGENTS.md"), "nested rules");
		const userLevel = canonical(temp, "home", ".claude", "CLAUDE.md");
		fs.mkdirSync(path.dirname(userLevel), { recursive: true });
		fs.writeFileSync(userLevel, "global rules");

		const snapshot = await captureCouncilInstructionSnapshot(
			{
				contextFiles: [
					{ path: path.join(repoRoot, "AGENTS.md"), content: "root rules", depth: 0 },
					{ path: userLevel, content: "global rules" },
				],
				workspaceTree: workspace(repoRoot, [path.join(nestedDirectory, "AGENTS.md")]),
			},
			repoRoot,
		);

		expect(snapshot.contextFiles).toEqual([
			{ path: userLevel, content: "global rules", depth: undefined },
			{ path: path.join(repoRoot, "AGENTS.md"), content: "root rules", depth: 0 },
			{ path: path.join(nestedDirectory, "AGENTS.md"), content: "nested rules" },
		]);
		expect(snapshot.totalBytes).toBe(Buffer.byteLength("global rulesroot rulesnested rules"));
	});

	it("keeps an inherited instruction whose path no longer resolves", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-vanished-");
		const repoRoot = canonical(temp, "repo");
		fs.mkdirSync(repoRoot);
		const vanished = canonical(temp, "gone", "AGENTS.md");

		const snapshot = await captureCouncilInstructionSnapshot(
			{ contextFiles: [{ path: vanished, content: "already loaded" }] },
			repoRoot,
		);

		expect(snapshot.contextFiles).toEqual([{ path: vanished, content: "already loaded", depth: undefined }]);
	});

	it.skipIf(!symlinksSupported())(
		"refuses a file swapped to a symlink between canonicalization and the lstat gate",
		async () => {
			using temp = TempDir.createSync("@omp-council-instruction-swap-");
			const repoRoot = canonical(temp, "repo");
			const nestedDirectory = path.join(repoRoot, "packages", "app");
			fs.mkdirSync(nestedDirectory, { recursive: true });
			const instructions = path.join(nestedDirectory, "AGENTS.md");
			const original = path.join(nestedDirectory, "original-AGENTS.md");
			const outside = canonical(temp, "outside-AGENTS.md");
			fs.writeFileSync(instructions, "inside");
			fs.writeFileSync(outside, "outside");
			const realpath = fsPromises.realpath;
			let swapped = false;
			const swappingRealpath = async (candidate: fs.PathLike): Promise<string> => {
				const resolved = await realpath(candidate);
				if (!swapped && resolved === nestedDirectory) {
					swapped = true;
					fs.renameSync(instructions, original);
					fs.symlinkSync(outside, instructions);
				}
				return resolved;
			};
			spyOn(fsPromises, "realpath").mockImplementation(swappingRealpath as typeof fsPromises.realpath);

			await expect(
				captureCouncilInstructionSnapshot({ workspaceTree: workspace(repoRoot, [instructions]) }, repoRoot),
			).rejects.toThrow("uses a symlink");
		},
	);

	it.skipIf(!symlinksSupported())(
		"refuses a file swapped to a symlink between the lstat gate and the open",
		async () => {
			using temp = TempDir.createSync("@omp-council-instruction-open-swap-");
			const repoRoot = canonical(temp, "repo");
			fs.mkdirSync(repoRoot);
			const instructions = path.join(repoRoot, "AGENTS.md");
			const original = path.join(repoRoot, "original-AGENTS.md");
			const outside = canonical(temp, "outside-AGENTS.md");
			fs.writeFileSync(instructions, "inside");
			fs.writeFileSync(outside, "outside");
			const open = fsPromises.open;
			let swapped = false;
			spyOn(fsPromises, "open").mockImplementation(async (candidate, flags, mode) => {
				if (!swapped && String(candidate) === instructions) {
					swapped = true;
					fs.renameSync(instructions, original);
					fs.symlinkSync(outside, instructions);
				}
				return open(candidate, flags, mode);
			});

			// `O_NOFOLLOW` rejects the swapped symlink outright on POSIX; on Windows the flag does not exist
			// and the device/inode equality check against the earlier `lstat` is what catches it.
			await expect(
				captureCouncilInstructionSnapshot({ workspaceTree: workspace(repoRoot, [instructions]) }, repoRoot),
			).rejects.toThrow(isWindows ? "changed during capture" : "uses a symlink");
		},
	);

	it.skipIf(!symlinksSupported())("rejects a parent directory swapped to an outside symlink before open", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-parent-swap-");
		const repoRoot = canonical(temp, "repo");
		const nestedDirectory = path.join(repoRoot, "packages", "app");
		const movedDirectory = path.join(repoRoot, "packages", "app-original");
		const outsideDirectory = canonical(temp, "outside");
		fs.mkdirSync(nestedDirectory, { recursive: true });
		fs.mkdirSync(outsideDirectory);
		const nested = path.join(nestedDirectory, "AGENTS.md");
		fs.writeFileSync(nested, "inside");
		fs.writeFileSync(path.join(outsideDirectory, "AGENTS.md"), "outside");
		const open = fsPromises.open;
		let swapped = false;
		spyOn(fsPromises, "open").mockImplementation(async (candidate, flags, mode) => {
			if (!swapped && String(candidate) === nested) {
				swapped = true;
				fs.renameSync(nestedDirectory, movedDirectory);
				fs.symlinkSync(outsideDirectory, nestedDirectory, directorySymlinkType);
			}
			return open(candidate, flags, mode);
		});

		await expect(
			captureCouncilInstructionSnapshot({ workspaceTree: workspace(repoRoot, [nested]) }, repoRoot),
		).rejects.toThrow("changed during capture");
	});

	it("fails before dispatch when the total snapshot exceeds its byte bound", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-limit-");
		const repoRoot = canonical(temp, "repo");
		fs.mkdirSync(repoRoot);
		const instructions = path.join(repoRoot, "AGENTS.md");
		fs.writeFileSync(instructions, "12345");
		try {
			await captureCouncilInstructionSnapshot(
				{ contextFiles: [{ path: instructions, content: "12345" }] },
				repoRoot,
				4,
			);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CouncilInstructionSnapshotError);
			expect((error as CouncilInstructionSnapshotError).spending).toBeFalse();
			expect((error as Error).message).toContain("exceeds 4 bytes");
		}
	});

	it("bounds nested reads by the aggregate remaining byte budget", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-nested-limit-");
		const repoRoot = canonical(temp, "repo");
		fs.mkdirSync(repoRoot);
		const inherited = path.join(repoRoot, "ROOT.md");
		const nested = path.join(repoRoot, "AGENTS.md");
		fs.writeFileSync(inherited, "12");
		fs.writeFileSync(nested, "345");

		await expect(
			captureCouncilInstructionSnapshot(
				{
					contextFiles: [{ path: inherited, content: "12" }],
					workspaceTree: workspace(repoRoot, [nested]),
				},
				repoRoot,
				4,
			),
		).rejects.toThrow("exceeds 4 bytes");
	});

	it("rejects invalid UTF-8 without expansion and accepts a multibyte file at the exact byte boundary", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-utf8-");
		const repoRoot = canonical(temp, "repo");
		fs.mkdirSync(repoRoot);
		const nested = path.join(repoRoot, "AGENTS.md");
		fs.writeFileSync(nested, Uint8Array.of(0xff));

		await expect(
			captureCouncilInstructionSnapshot({ workspaceTree: workspace(repoRoot, [nested]) }, repoRoot, 1),
		).rejects.toThrow("not valid UTF-8");

		fs.writeFileSync(nested, "€");
		const snapshot = await captureCouncilInstructionSnapshot(
			{ workspaceTree: workspace(repoRoot, [nested]) },
			repoRoot,
			3,
		);
		expect(snapshot.contextFiles).toEqual([{ path: nested, content: "€" }]);
		expect(snapshot.totalBytes).toBe(3);
	});
});
