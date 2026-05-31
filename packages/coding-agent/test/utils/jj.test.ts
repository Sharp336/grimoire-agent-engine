import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { parseStatus, parseWorkingCopy, resolveSync } from "@oh-my-pi/pi-coding-agent/utils/jj";

describe("jj status helpers", () => {
	test("parses clean working copy status", () => {
		expect(
			parseStatus(`The working copy is clean
Working copy  (@) : abcdef12 empty (no description set)
Parent commit (@-): 12345678 main | initial
`),
		).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
	});

	test("counts modified and untracked files from jj status", () => {
		expect(
			parseStatus(`Working copy changes:
M src/index.ts
A src/new.ts
Untracked paths:
? scratch.txt
Working copy  (@) : abcdef12 dirty (no description set)
Parent commit (@-): 12345678 main | initial
`),
		).toEqual({ staged: 0, unstaged: 2, untracked: 1 });
	});

	test("counts repositories with only untracked paths", () => {
		expect(
			parseStatus(`Untracked paths:
? scratch.txt
Working copy  (@) : abcdef12 dirty (no description set)
Parent commit (@-): 12345678 main | initial
`),
		).toEqual({ staged: 0, unstaged: 0, untracked: 1 });
	});

	test("parses working copy identity", () => {
		expect(parseWorkingCopy("rwnytppy\n983a49b5\nUpdate dependencies\nmain feature\n")).toEqual({
			bookmarks: ["main", "feature"],
			changeId: "rwnytppy",
			commitId: "983a49b5",
			description: "Update dependencies",
		});
	});
});

describe("jj repository resolution", () => {
	test("uses colocated jj metadata at the nearest root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jj-resolve-"));
		try {
			await fs.mkdir(path.join(root, ".jj", "working_copy"), { recursive: true });
			await fs.mkdir(path.join(root, ".git"), { recursive: true });
			await fs.mkdir(path.join(root, "src"), { recursive: true });
			expect(resolveSync(path.join(root, "src"))).toMatchObject({ repoRoot: root });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("stops at a nearer standalone git repository", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jj-resolve-"));
		try {
			await fs.mkdir(path.join(root, ".jj", "working_copy"), { recursive: true });
			const nested = path.join(root, "vendor", "project");
			await fs.mkdir(path.join(nested, ".git"), { recursive: true });
			await fs.mkdir(path.join(nested, "src"), { recursive: true });
			expect(resolveSync(path.join(nested, "src"))).toBeNull();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
