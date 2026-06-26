import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	findJjRoot,
	formatJjBranch,
	queryJjBranch,
} from "@oh-my-pi/pi-coding-agent/modes/components/status-line/jj-info";

describe("formatJjBranch", () => {
	test("trims and collapses internal whitespace to a single token", () => {
		expect(formatJjBranch("  feature-x   kvisqosn  \n")).toBe("feature-x kvisqosn");
	});

	test("returns the change-id alone when there is no bookmark", () => {
		expect(formatJjBranch("kvisqosn\n")).toBe("kvisqosn");
	});

	test("returns null for empty or whitespace-only output", () => {
		expect(formatJjBranch("")).toBeNull();
		expect(formatJjBranch("  \n\t ")).toBeNull();
	});
});

describe("findJjRoot", () => {
	test("walks up to the nearest ancestor holding .jj", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "jj-root-"));
		try {
			await fs.promises.mkdir(path.join(root, ".jj"));
			const nested = path.join(root, "packages", "coding-agent");
			await fs.promises.mkdir(nested, { recursive: true });
			expect(findJjRoot(nested)).toBe(root);
			expect(findJjRoot(root)).toBe(root);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("returns null when no .jj ancestor exists", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "no-jj-"));
		try {
			expect(findJjRoot(dir)).toBeNull();
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("queryJjBranch", () => {
	test("formats runner stdout on success", async () => {
		const desc = await queryJjBranch("/repo", async () => ({ exitCode: 0, stdout: "feat-x kvisqosn\n" }));
		expect(desc).toBe("feat-x kvisqosn");
	});

	test("returns null on non-zero exit (not a jj repo)", async () => {
		const desc = await queryJjBranch("/repo", async () => ({ exitCode: 1, stdout: "" }));
		expect(desc).toBeNull();
	});

	test("returns null when the runner throws (jj binary absent)", async () => {
		const desc = await queryJjBranch("/repo", async () => {
			throw new Error("spawn jj ENOENT");
		});
		expect(desc).toBeNull();
	});

	test("treats empty successful output as null", async () => {
		const desc = await queryJjBranch("/repo", async () => ({ exitCode: 0, stdout: "\n" }));
		expect(desc).toBeNull();
	});
});
