import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { checkChangelogHistories, decodeChangelog, releasedHistoryViolation } from "./check-changelog-history";

const BASE_CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Pending feature.

## [1.0.0] - 2026-01-01

### Added

- Released feature.
`;

describe("releasedHistoryViolation", () => {
	it("allows targeted additions under Unreleased", () => {
		const head = BASE_CHANGELOG.replace("- Pending feature.", "- Pending feature.\n- Another pending feature.");
		expect(releasedHistoryViolation(BASE_CHANGELOG, head)).toBeUndefined();
	});

	it("rejects repeated insertions into released sections", () => {
		const head = BASE_CHANGELOG.replaceAll("### Added", "### Added\n\\n- Repeated mechanical insertion.");
		expect(releasedHistoryViolation(BASE_CHANGELOG, head)).toContain("changed immutable history");
	});

	it("rejects truncated released history", () => {
		const head = BASE_CHANGELOG.slice(0, BASE_CHANGELOG.indexOf("## [1.0.0]"));
		expect(releasedHistoryViolation(BASE_CHANGELOG, head)).toBe("removed every released section");
	});
});

describe("decodeChangelog", () => {
	it("rejects invalid UTF-8", () => {
		expect(() => decodeChangelog(Uint8Array.from([0xc3, 0x28]), "fixture")).toThrow("fixture is not valid UTF-8");
	});
});

describe("checkChangelogHistories", () => {
	it("checks the working changelog against a git base", async () => {
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "changelog-history-"));
		const git = (...args: string[]) =>
			$`git ${args}`
				.cwd(repoRoot)
				.quiet()
				.env({
					...process.env,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_SYSTEM: "/dev/null",
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@t",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@t",
				});
		try {
			const changelogPath = path.join(repoRoot, "packages/example/CHANGELOG.md");
			await git("init", "-b", "main");
			await Bun.write(changelogPath, BASE_CHANGELOG);
			await git("add", "-A");
			await git("commit", "-m", "base");

			await Bun.write(
				changelogPath,
				BASE_CHANGELOG.replace("- Pending feature.", "- Pending feature.\n- Valid addition."),
			);
			const valid = await checkChangelogHistories(repoRoot, "HEAD");
			expect(valid.checkedPaths).toEqual(["packages/example/CHANGELOG.md"]);
			expect(valid.violations).toEqual([]);

			await Bun.write(changelogPath, BASE_CHANGELOG.replace("- Released feature.", "- Rewritten history."));
			const invalid = await checkChangelogHistories(repoRoot, "HEAD");
			expect(invalid.violations).toEqual([
				{
					path: "packages/example/CHANGELOG.md",
					message: 'changed immutable history beginning at "## [1.0.0] - 2026-01-01"',
				},
			]);
		} finally {
			await fs.rm(repoRoot, { recursive: true, force: true });
		}
	});
});
