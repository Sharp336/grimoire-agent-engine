import { describe, expect, it } from "bun:test";
import { parsePrimeSkills } from "../src/import/prime/skill-parser";
import type {
	PrimeImportLoss,
	PrimeImportSourceDiscovery,
	PrimeSourceFile,
	PrimeSourceRecord,
	PrimeSourceSymlink,
} from "../src/import/prime/types";

function file(sourceRef: string, content: string, mode = 0o644): PrimeSourceFile {
	return {
		kind: "file",
		domain: "skills",
		sourceRef,
		canonicalPath: `/prime/${sourceRef}`,
		mode,
		mtimeMs: 1,
		size: Buffer.byteLength(content),
		sha256: "a".repeat(64),
		contentBase64: Buffer.from(content).toString("base64"),
	};
}

function directory(sourceRef: string): PrimeSourceRecord {
	return {
		kind: "directory",
		domain: "skills",
		sourceRef,
		canonicalPath: `/prime/${sourceRef}`,
		mode: 0o755,
		mtimeMs: 1,
	};
}

function symlink(sourceRef: string, target: string, external: boolean): PrimeSourceSymlink {
	return {
		kind: "symlink",
		domain: "skills",
		sourceRef,
		canonicalPath: `/prime/${sourceRef}`,
		mode: 0o777,
		mtimeMs: 1,
		target,
		external,
	};
}

function discovery(
	records: readonly PrimeSourceRecord[],
	losses: readonly PrimeImportLoss[] = [],
): PrimeImportSourceDiscovery {
	const files = records.filter((record): record is PrimeSourceFile => record.kind === "file");
	return {
		snapshot: {
			schemaVersion: 1,
			snapshotId: "skills-snapshot",
			sourceRoot: "/prime",
			cwd: "/project",
			sessionRoot: "/prime/sessions",
			maxFileBytes: 1_000_000,
			maxTotalBytes: 1_000_000,
			maxEntries: 100,
			files: files.map(({ contentBase64: _contentBase64, ...metadata }) => metadata),
			treeEntries: records
				.filter((record): record is Exclude<PrimeSourceRecord, PrimeSourceFile> => record.kind !== "file")
				.map(({ mtimeMs: _mtimeMs, ...entry }) => entry),
		},
		inventory: { records, files, excluded: [] },
		losses,
	};
}

const skillMarkdown = (name: string, extra = "") =>
	`---\nname: ${name}\ndescription: A useful ${name} skill\n${extra}---\n\n# ${name}\n`;

describe("parsePrimeSkills", () => {
	it("inventories a whole global skill directory with bytes, modes, and Python payload", () => {
		const records: PrimeSourceRecord[] = [
			directory("global/skills/alpha"),
			file("global/skills/alpha/SKILL.md", skillMarkdown("alpha"), 0o751),
			directory("global/skills/alpha/src"),
			file("global/skills/alpha/src/__init__.py", "from .main import run\n", 0o640),
			file("global/skills/alpha/pyproject.toml", "[project]\nname='alpha'\n", 0o644),
			file("global/skills/alpha/.gitignore", "*.pyc\n", 0o600),
		];
		const result = parsePrimeSkills(discovery(records));
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]).toMatchObject({
			scope: "global",
			name: "alpha",
			directorySourceRef: "global/skills/alpha",
		});
		expect(result.candidates[0]?.files).toEqual([
			expect.objectContaining({ relativePath: ".gitignore", mode: 0o600, kind: "file" }),
			expect.objectContaining({ relativePath: "SKILL.md", mode: 0o751, kind: "file" }),
			expect.objectContaining({ relativePath: "pyproject.toml", kind: "file" }),
			expect.objectContaining({ relativePath: "src", kind: "directory" }),
			expect.objectContaining({ relativePath: "src/__init__.py", mode: 0o640, kind: "file" }),
		]);
		const skillFile = result.candidates[0]?.files.find(
			entry => entry.kind === "file" && entry.relativePath === "SKILL.md",
		);
		expect(skillFile?.kind).toBe("file");
		if (skillFile?.kind === "file") {
			expect(skillFile.contentBase64).toBe(Buffer.from(skillMarkdown("alpha")).toString("base64"));
		}
	});

	it("validates Agent Skills frontmatter and rejects invalid names and unknown fields", () => {
		const records: PrimeSourceRecord[] = [
			directory("global/skills/valid"),
			file("global/skills/valid/SKILL.md", skillMarkdown("valid")),
			directory("global/skills/BAD"),
			file("global/skills/BAD/SKILL.md", skillMarkdown("BAD")),
			directory("global/skills/unknown"),
			file("global/skills/unknown/SKILL.md", skillMarkdown("unknown", "unexpected: true\n")),
		];
		const result = parsePrimeSkills(discovery(records));
		expect(result.candidates.map(candidate => candidate.name)).toEqual(["valid"]);
		expect(result.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "skills-invalid-frontmatter", sourceRef: "global/skills/BAD/SKILL.md" }),
				expect.objectContaining({
					code: "skills-invalid-frontmatter",
					sourceRef: "global/skills/unknown/SKILL.md",
				}),
			]),
		);
	});

	it("keeps the project skill over a global duplicate", () => {
		const records: PrimeSourceRecord[] = [
			directory("global/skills/same"),
			file("global/skills/same/SKILL.md", skillMarkdown("same")),
			directory("project/skills/same"),
			file("project/skills/same/SKILL.md", skillMarkdown("same")),
			directory("global/skills/other"),
			file("global/skills/other/SKILL.md", skillMarkdown("other")),
		];
		const result = parsePrimeSkills(discovery(records));
		expect(result.candidates.map(candidate => [candidate.scope, candidate.name])).toEqual([
			["global", "other"],
			["project", "same"],
		]);
		expect(result.losses).toContainEqual(
			expect.objectContaining({ code: "skills-duplicate", sourceRef: "global/skills/same" }),
		);
	});
	it("recursively discovers nested roots, stops at roots, and honors snapshot ignore files", () => {
		const records: PrimeSourceRecord[] = [
			directory("global/skills/group"),
			file("global/skills/group/.gitignore", "ignored/\n"),
			directory("global/skills/group/nested"),
			file("global/skills/group/nested/SKILL.md", skillMarkdown("nested")),
			file("global/skills/group/nested/data.py", "print('ok')\n"),
			directory("global/skills/group/ignored"),
			file("global/skills/group/ignored/SKILL.md", skillMarkdown("ignored")),
			directory("global/skills/group/node_modules"),
			directory("global/skills/group/node_modules/dependency"),
			file("global/skills/group/node_modules/dependency/SKILL.md", skillMarkdown("dependency")),
		];
		const result = parsePrimeSkills(discovery(records));
		expect(result.candidates.map(candidate => candidate.name)).toEqual(["nested"]);
		expect(result.candidates[0]?.files.map(file => file.relativePath)).toEqual(["SKILL.md", "data.py"]);
		expect(result.losses).toContainEqual(
			expect.objectContaining({ code: "skills-ignored", sourceRef: "global/skills/group/ignored" }),
		);
	});

	it("records ignored hidden candidates and preserves internal but rejects external symlinks", () => {
		const records: PrimeSourceRecord[] = [
			directory("global/skills/.ignored"),
			file("global/skills/.ignored/SKILL.md", skillMarkdown("ignored")),
			directory("global/skills/links"),
			file("global/skills/links/SKILL.md", skillMarkdown("links")),
			symlink("global/skills/links/ref.py", "SKILL.md", false),
			symlink("global/skills/links/escape.py", "../other.py", false),
			symlink("global/skills/links/secrets.txt", "/tmp/secrets.txt", true),
		];
		const result = parsePrimeSkills(discovery(records));
		expect(result.candidates[0]?.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ relativePath: "ref.py", kind: "symlink", target: "SKILL.md" }),
			]),
		);
		expect(result.candidates.some(candidate => candidate.name === "ignored")).toBe(false);
		expect(result.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "skills-ignored", sourceRef: "global/skills/.ignored" }),
				expect.objectContaining({ code: "skills-external-symlink", sourceRef: "global/skills/links/escape.py" }),
				expect.objectContaining({ code: "skills-external-symlink", sourceRef: "global/skills/links/secrets.txt" }),
			]),
		);
	});
	it("rejects a candidate containing a discovered special file as a whole", () => {
		const records: PrimeSourceRecord[] = [
			directory("global/skills/special"),
			file("global/skills/special/SKILL.md", skillMarkdown("special")),
		];
		const result = parsePrimeSkills(
			discovery(records, [
				{
					code: "source-unsupported",
					domain: "skills",
					sourceRef: "global/skills/special/fifo",
				},
			]),
		);
		expect(result.candidates).toEqual([]);
		expect(result.losses).toContainEqual(
			expect.objectContaining({ code: "skills-special-file", sourceRef: "global/skills/special" }),
		);
	});
});
