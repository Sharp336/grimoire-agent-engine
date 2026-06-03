import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAtRefs } from "@oh-my-pi/pi-coding-agent/capability/resolve-at-refs";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

describe("resolveAtRefs", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-atrefs-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
		// Initialize a .git directory so findRepoRoot can discover the project root
		fs.mkdirSync(path.join(tempDir, ".git"), { recursive: true });
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("replaces a simple @-reference with file content", async () => {
		const pkgJson = { name: "my-project", version: "1.0.0" };
		fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));

		const agentsMd = `# Project\n\nSee package details:\n@package.json\n\nEnd.`;
		const agentsMdPath = path.join(tempDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		expect(result[0].content).toContain('"name": "my-project"');
		expect(result[0].content).toContain('"version": "1.0.0"');
		expect(result[0].content).not.toContain("@package.json");
	});

	it("resolves references relative to the context file's directory", async () => {
		const subDir = path.join(tempDir, "subdir");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(subDir, "config.yaml"), "key: value\n");

		const agentsMd = `Settings:\n@config.yaml`;
		const agentsMdPath = path.join(subDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		expect(result[0].content).toContain("key: value");
		expect(result[0].content).not.toContain("@config.yaml");
	});

	it("handles parent directory references with ../ within root", async () => {
		const subDir = path.join(tempDir, "deep");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(tempDir, "root.conf"), "root: true\n");

		const agentsMd = `Root config:\n@../root.conf`;
		const agentsMdPath = path.join(subDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		expect(result[0].content).toContain("root: true");
	});

	it("rejects absolute path @-references", async () => {
		const agentsMd = `@/etc/hosts.conf`;
		const agentsMdPath = path.join(tempDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		expect(result[0].content).toContain("absolute paths are not allowed");
	});

	it("rejects references that traverse above the root", async () => {
		fs.writeFileSync(path.join(tempDir, "..", "escape.txt"), "escaped\n");

		const agentsMd = `@../escape.txt`;
		const agentsMdPath = path.join(tempDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		expect(result[0].content).toContain("escapes project root");
	});

	it("leaves non-matching lines untouched", async () => {
		const agentsMd = `# Header\n\nSome text with @username in a sentence.\nNot a ref: email@example.com\n\nParagraph about things.`;
		const agentsMdPath = path.join(tempDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		expect(result[0].content).toBe(agentsMd);
	});

	it("produces comment placeholder for missing files", async () => {
		const agentsMd = `@nonexistent.file.txt`;
		const agentsMdPath = path.join(tempDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		expect(result[0].content).toContain("<!-- @nonexistent.file.txt: file not found -->");
	});

	it("detects and skips circular references", async () => {
		const circularDir = path.join(tempDir, "circular");
		fs.mkdirSync(circularDir, { recursive: true });

		const aPath = path.join(circularDir, "a.md");
		const bPath = path.join(circularDir, "b.md");

		fs.writeFileSync(aPath, `A start\n@b.md\nA end`);
		fs.writeFileSync(bPath, `B start\n@a.md\nB end`);

		const result = await resolveAtRefs([{ path: aPath, content: fs.readFileSync(aPath, "utf-8") }], {
			rootDir: tempDir,
		});

		expect(result[0].content).toContain("A start");
		expect(result[0].content).toContain("B start");
		expect(result[0].content).toContain("circular reference skipped");
	});

	it("respects maxDepth limit", async () => {
		const deepDir = path.join(tempDir, "deep");
		fs.mkdirSync(deepDir, { recursive: true });

		for (let i = 0; i <= 5; i++) {
			const next = i < 5 ? `@chain${i + 1}.txt` : "final content";
			fs.writeFileSync(path.join(deepDir, `chain${i}.txt`), `depth ${i}\n${next}`);
		}

		const chain0Path = path.join(deepDir, "chain0.txt");

		// With maxDepth=3, chain3.txt content is still resolved but it contains @chain4.txt
		const result = await resolveAtRefs([{ path: chain0Path, content: fs.readFileSync(chain0Path, "utf-8") }], {
			maxDepth: 3,
			rootDir: tempDir,
		});

		expect(result[0].content).toContain("depth 0");
		expect(result[0].content).toContain("depth 2");
		expect(result[0].content).toContain("@chain4.txt");
	});

	it("handles multiple @-references in the same file", async () => {
		fs.writeFileSync(path.join(tempDir, "alpha.txt"), "alpha content\n");
		fs.writeFileSync(path.join(tempDir, "beta.txt"), "beta content\n");

		const agentsMd = `Header\n@alpha.txt\nBetween\n@beta.txt\nFooter`;
		const agentsMdPath = path.join(tempDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		expect(result[0].content).toContain("alpha content");
		expect(result[0].content).toContain("beta content");
		expect(result[0].content).toContain("Header");
		expect(result[0].content).toContain("Footer");
		expect(result[0].content).toContain("Between");
	});

	it("does not match @-references without a file extension", async () => {
		fs.writeFileSync(path.join(tempDir, "has.txt"), "file content\n");
		const agentsMd = `@noext\n@has.txt`;
		const agentsMdPath = path.join(tempDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		// @noext should be left as-is (no dot extension)
		expect(result[0].content).toContain("@noext");
		// @has.txt should be resolved
		expect(result[0].content).toContain("file content");
	});

	it("does not match @-references with leading text on the same line", async () => {
		const agentsMd = `See @package.json for details.`;
		const agentsMdPath = path.join(tempDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		expect(result[0].content).toBe(agentsMd);
	});

	it("handles @-references with trailing whitespace", async () => {
		fs.writeFileSync(path.join(tempDir, "trail.txt"), "trailed\n");
		const agentsMd = `@trail.txt   `;
		const agentsMdPath = path.join(tempDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		expect(result[0].content).toContain("trailed");
	});

	it("preserves depth field in returned objects", async () => {
		const result = await resolveAtRefs([{ path: "/some/path/AGENTS.md", content: "no refs", depth: 2 }], {
			rootDir: "/some",
		});

		expect(result[0].depth).toBe(2);
	});

	it("rejects symlinks that escape the project root", async () => {
		const outsideDir = path.join(os.tmpdir(), "pi-atrefs-outside");
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret data\n");

		// Create a symlink inside the project that points outside the root
		const linkPath = path.join(tempDir, "link.txt");
		fs.symlinkSync(path.join(outsideDir, "secret.txt"), linkPath);

		const agentsMd = `@link.txt`;
		const agentsMdPath = path.join(tempDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		expect(result[0].content).toContain("escapes project root");

		// Cleanup
		fs.unlinkSync(path.join(outsideDir, "secret.txt"));
		fs.rmdirSync(outsideDir);
	});

	it("allows symlinks that stay within the project root", async () => {
		fs.writeFileSync(path.join(tempDir, "real.txt"), "real content\n");

		// Create a symlink inside the project that points to another file in the project
		const linkPath = path.join(tempDir, "link.txt");
		fs.symlinkSync(path.join(tempDir, "real.txt"), linkPath);

		const agentsMd = `@link.txt`;
		const agentsMdPath = path.join(tempDir, "AGENTS.md");

		const result = await resolveAtRefs([{ path: agentsMdPath, content: agentsMd }], { rootDir: tempDir });

		expect(result[0].content).toContain("real content");
	});

	it("uses an independent containment root for each context file", async () => {
		fs.mkdirSync(path.join(tempHomeDir, ".git"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, "rules.md"), "project rules\n");
		fs.writeFileSync(path.join(tempHomeDir, "rules.md"), "user rules\n");

		const result = await resolveAtRefs([
			{ path: path.join(tempDir, "AGENTS.md"), content: "@rules.md", depth: 1 },
			{ path: path.join(tempHomeDir, "AGENTS.md"), content: "@rules.md" },
		]);

		expect(result[0].content).toContain("project rules");
		expect(result[1].content).toContain("user rules");
	});
});
