import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import {
	CouncilInstructionSnapshotError,
	captureCouncilInstructionSnapshot,
	sha256Text,
} from "@oh-my-pi/pi-coding-agent/council/instructions";
import * as workspaceTree from "@oh-my-pi/pi-coding-agent/workspace-tree";
import { TempDir } from "@oh-my-pi/pi-utils";

function workspace(rootPath: string, agentsMdFiles: string[]) {
	return { rootPath, rendered: "", truncated: false, totalLines: 0, agentsMdFiles };
}

afterEach(() => {
	mock.restore();
});

describe("council instruction snapshots", () => {
	it("centrally reads nested instructions, deduplicates, hashes, and orders shallow to deep", async () => {
		using temp = TempDir.createSync("@omp-council-instructions-");
		const repoRoot = temp.join("repo");
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

		expect(snapshot.repoRoot).toBe(fs.realpathSync(repoRoot));
		expect(snapshot.contextFiles.map(entry => entry.path)).toEqual([rootInstructions, nestedInstructions]);
		expect(snapshot.contextFiles.map(entry => entry.content)).toEqual(["root rules", "nested rules"]);
		expect(snapshot.files).toEqual([
			{ path: rootInstructions, sha256: sha256Text("root rules") },
			{ path: nestedInstructions, sha256: sha256Text("nested rules") },
		]);
		expect(snapshot.totalBytes).toBe(Buffer.byteLength("root rulesnested rules"));
	});

	it("discovers sibling nested instructions from the canonical repository root", async () => {
		using temp = TempDir.createSync("@omp-council-instructions-sibling-");
		const repoRoot = temp.join("repo");
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
		expect(snapshot.files).toEqual([{ path: siblingInstructions, sha256: sha256Text("sibling rules") }]);
	});

	it("fails closed when complete nested instruction discovery fails", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-discovery-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const scan = spyOn(workspaceTree, "buildWorkspaceTree").mockRejectedValue(new Error("scanner timed out"));

		await expect(captureCouncilInstructionSnapshot({}, repoRoot)).rejects.toThrow(
			"Council instruction discovery failed: scanner timed out",
		);
		expect(scan).toHaveBeenCalledWith(fs.realpathSync(repoRoot), { strict: true });
	});

	it("rejects nested symlinks and files outside the canonical repository", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-containment-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const target = path.join(repoRoot, "real-AGENTS.md");
		const linked = path.join(repoRoot, "AGENTS.md");
		const outside = temp.join("outside-AGENTS.md");
		fs.writeFileSync(target, "inside");
		fs.writeFileSync(outside, "outside");
		fs.symlinkSync(target, linked);

		await expect(
			captureCouncilInstructionSnapshot({ workspaceTree: workspace(repoRoot, [linked]) }, repoRoot),
		).rejects.toThrow("uses a symlink");
		await expect(
			captureCouncilInstructionSnapshot({ contextFiles: [{ path: outside, content: "outside" }] }, repoRoot),
		).rejects.toThrow("resolves outside repository root");
	});

	it("refuses a file swapped to a symlink between canonicalization and the no-follow open", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-swap-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const instructions = path.join(repoRoot, "AGENTS.md");
		const original = path.join(repoRoot, "original-AGENTS.md");
		const outside = temp.join("outside-AGENTS.md");
		fs.writeFileSync(instructions, "inside");
		fs.writeFileSync(outside, "outside");
		const realpath = fsPromises.realpath;
		let swapped = false;
		const swappingRealpath = async (candidate: fs.PathLike): Promise<string> => {
			const canonical = await realpath(candidate);
			if (!swapped && canonical === instructions) {
				swapped = true;
				fs.renameSync(instructions, original);
				fs.symlinkSync(outside, instructions);
			}
			return canonical;
		};
		spyOn(fsPromises, "realpath").mockImplementation(swappingRealpath as typeof fsPromises.realpath);

		await expect(
			captureCouncilInstructionSnapshot({ workspaceTree: workspace(repoRoot, [instructions]) }, repoRoot),
		).rejects.toThrow("uses a symlink");
	});

	it("rejects a parent directory swapped to an outside symlink before open", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-parent-swap-");
		const repoRoot = temp.join("repo");
		const nestedDirectory = path.join(repoRoot, "packages", "app");
		const movedDirectory = path.join(repoRoot, "packages", "app-original");
		const outsideDirectory = temp.join("outside");
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
				fs.symlinkSync(outsideDirectory, nestedDirectory, "dir");
			}
			return open(candidate, flags, mode);
		});

		await expect(
			captureCouncilInstructionSnapshot({ workspaceTree: workspace(repoRoot, [nested]) }, repoRoot),
		).rejects.toThrow("changed during capture");
	});

	it("fails before dispatch when the total snapshot exceeds its byte bound", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-limit-");
		const repoRoot = temp.join("repo");
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
		const repoRoot = temp.join("repo");
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
		const repoRoot = temp.join("repo");
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
