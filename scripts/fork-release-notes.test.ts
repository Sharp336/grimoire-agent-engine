import { describe, expect, it } from "bun:test";
import { extractForkReleaseSection, renderForkReleaseNotes } from "./fork-release-notes";
import type { ForkReleaseMetadata } from "./publish-fork-package";

const metadata: ForkReleaseMetadata = {
	schemaVersion: 1,
	forkVersion: "17.2.11-cn.1",
	upstreamVersion: "17.2.11",
	nativeVersion: "17.2.11",
	upstreamCommit: "0123456789abcdef0123456789abcdef01234567",
};

describe("fork release notes", () => {
	it("reads only the requested released section", () => {
		const changelog =
			"# Fork\n\n## [Unreleased]\n\n- Future.\n\n## [17.2.11-cn.1] - 2026-08-09\n\n### Fixed\n\n- Release fix.\n\n## [17.2.11] - 2026-08-08\n\n- Old.\n";
		expect(extractForkReleaseSection(changelog, metadata.forkVersion)).toBe("### Fixed\n\n- Release fix.");
	});

	it("renders the fork and upstream provenance without consulting package changelogs", () => {
		const notes = renderForkReleaseNotes(metadata, "### Fixed\n\n- Release fix.");
		expect(notes).toContain(`# omp-cn ${metadata.forkVersion}`);
		expect(notes).toContain(`上游版本：\`${metadata.upstreamVersion}\``);
		expect(notes).toContain(`原生模块版本：\`${metadata.nativeVersion}\``);
		expect(notes).toContain(`上游提交：\`${metadata.upstreamCommit}\``);
		expect(notes).toContain(`标签：\`omp-cn-v${metadata.forkVersion}\``);
	});
});
