import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { resolveAndContain } from "./containment";
import { findAgentsMdUp } from "./find-agents-md-up";
import { formatDirectoryContext } from "./format";
import { injectDirectoryContext } from "./inject-directory-context";
import { InjectionCache } from "./injection-cache";
import { truncateBytes } from "./truncate";

describe("nested AGENTS.md context injection", () => {
	it("finds ancestor AGENTS.md files root-to-leaf while skipping the root directory", async () => {
		using tmp = TempDir.createSync("@nested-agents-find-");
		const root = tmp.path();
		const parentDir = path.join(root, "parent");
		const childDir = path.join(parentDir, "child");
		await fs.mkdir(childDir, { recursive: true });
		await Bun.write(path.join(root, "AGENTS.md"), "root should be skipped");
		await Bun.write(path.join(parentDir, "AGENTS.md"), "parent context");
		await Bun.write(path.join(childDir, "AGENTS.md"), "child context");

		const result = await findAgentsMdUp({ startDir: childDir, rootDir: root });

		expect(result).toEqual([path.join(parentDir, "AGENTS.md"), path.join(childDir, "AGENTS.md")]);
	});

	it("injects each directory once for a session", async () => {
		using tmp = TempDir.createSync("@nested-agents-inject-");
		const root = tmp.path();
		const parentDir = path.join(root, "parent");
		const childDir = path.join(parentDir, "child");
		const filePath = path.join(childDir, "target.ts");
		await fs.mkdir(childDir, { recursive: true });
		await Bun.write(path.join(root, "AGENTS.md"), "root should be skipped");
		await Bun.write(path.join(parentDir, "AGENTS.md"), "parent context");
		await Bun.write(path.join(childDir, "AGENTS.md"), "child context");
		await Bun.write(filePath, "export const target = true;\n");
		const cache = new InjectionCache();

		const first = await injectDirectoryContext({ filePath, rootDir: root, cache, sessionKey: "session-a" });
		const second = await injectDirectoryContext({ filePath, rootDir: root, cache, sessionKey: "session-a" });

		expect(first.errors).toEqual([]);
		expect(first.injectedFiles.map(file => file.directory)).toEqual([parentDir, childDir]);
		expect(first.injectedText).toContain("parent context");
		expect(first.injectedText).toContain("child context");
		expect(first.injectedText).not.toContain("root should be skipped");
		expect(cache.getCacheSize("session-a")).toBe(2);
		expect(second.injectedText).toBe("");
		expect(second.injectedFiles).toEqual([]);
		expect(second.errors).toEqual([]);
	});

	it("rejects paths outside root and the root directory itself", async () => {
		using tmp = TempDir.createSync("@nested-agents-contain-");
		const root = path.join(tmp.path(), "root");
		const outside = path.join(tmp.path(), "outside.ts");
		await fs.mkdir(root, { recursive: true });
		await Bun.write(outside, "outside");

		const outsideResult = await resolveAndContain({ filePath: outside, rootDir: root });
		const rootResult = await resolveAndContain({ filePath: root, rootDir: root });

		expect(outsideResult).toBeUndefined();
		expect(rootResult).toBeUndefined();
	});

	it("truncates oversized UTF-8 content and leaves short content unchanged", () => {
		const oversized = truncateBytes("alpha🙂omega", 8);
		const short = truncateBytes("short", 16);

		expect(oversized.truncated).toBe(true);
		expect(oversized.resultBytes).toBeLessThanOrEqual(8);
		expect(oversized.result).not.toContain("\uFFFD");
		expect(short).toEqual({
			result: "short",
			truncated: false,
			originalBytes: 5,
			resultBytes: 5,
		});
	});

	it("wraps directory context with an absolute path header", () => {
		const absolutePath = "/workspace/project/parent/AGENTS.md";

		const result = formatDirectoryContext({ absolutePath, content: "Use local conventions.", truncated: false });

		expect(result).toBe("\n\n[Directory Context: /workspace/project/parent/AGENTS.md]\nUse local conventions.");
	});
});
