import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { SessionSelectorComponent } from "../../../src/modes/components/session-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { GitRefRecord, SessionInfo } from "../../../src/session/session-manager";

beforeAll(() => initTheme());
afterEach(() => vi.restoreAllMocks());

function makeSession(opts: {
	id: string;
	title: string;
	gitRefs?: GitRefRecord[];
	gitBranchInitial?: string;
	gitBranchLatest?: string;
}): SessionInfo {
	const gitBranchInitial = opts.gitBranchInitial ?? opts.gitRefs?.[0]?.branch;
	const gitBranchLatest = opts.gitBranchLatest ?? opts.gitRefs?.at(-1)?.branch;
	return {
		path: `/tmp/${opts.id}.jsonl`,
		id: opts.id,
		cwd: "/tmp",
		title: opts.title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 1024,
		firstMessage: `${opts.title} first message`,
		allMessagesText: `${opts.title} first message`,
		gitBranchInitial,
		gitBranchLatest,
		gitRefs: opts.gitRefs,
	};
}

function createSelector(sessions: SessionInfo[]): SessionSelectorComponent {
	return new SessionSelectorComponent(
		sessions,
		() => {},
		() => {},
		() => {},
		async () => true,
	);
}

function renderText(selector: SessionSelectorComponent, width = 120): string {
	return Bun.stripANSI(selector.render(width).join("\n"));
}

describe("SessionSelectorComponent focused-row chronology", () => {
	it("renders the full chain for the focused multi-branch row", () => {
		const selector = createSelector([
			makeSession({
				id: "session-a",
				title: "Alpha",
				gitRefs: [{ branch: "main" }, { branch: "feat/x" }, { branch: "feat/y" }],
			}),
		]);

		expect(renderText(selector)).toContain("⑂ main → feat/x → feat/y");
	});

	it("does not render a chain line for an unfocused row", () => {
		const selector = createSelector([
			makeSession({ id: "session-a", title: "Alpha", gitRefs: [{ branch: "main" }] }),
			makeSession({
				id: "session-b",
				title: "Beta",
				gitRefs: [{ branch: "a" }, { branch: "b" }, { branch: "c" }],
			}),
		]);

		expect(renderText(selector)).not.toContain("a → b → c");
	});

	it("suppresses the focused chronology line when only one branch is known", () => {
		const selector = createSelector([
			makeSession({ id: "session-a", title: "Alpha", gitRefs: [{ branch: "main" }] }),
		]);

		expect(renderText(selector).match(/⑂ main/g)).toHaveLength(1);
	});

	it("middle-truncates a long focused chain under width pressure", () => {
		const selector = createSelector([
			makeSession({
				id: "session-a",
				title: "Alpha",
				gitRefs: [
					{ branch: "alpha-root" },
					{ branch: "mid-branch-one" },
					{ branch: "mid-branch-two" },
					{ branch: "mid-branch-three" },
					{ branch: "omega-tip" },
				],
			}),
		]);

		const chainLine = selector
			.render(30)
			.map(line => Bun.stripANSI(line))
			.find(line => line.startsWith("  ⑂"));

		expect(chainLine).toBe("  ⑂ alpha-root → … → omega-tip");
	});
});
