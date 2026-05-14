import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { GitRefRecord } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import type { GitRefHead } from "../../../src/utils/git";
import * as git from "../../../src/utils/git";

beforeAll(() => initTheme());
afterEach(() => vi.restoreAllMocks());

function makeRefHead(branchName: string): GitRefHead {
	return {
		branchName,
		commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		commonDir: "/tmp/.git",
		gitDir: "/tmp/.git",
		gitEntryPath: "/tmp/.git",
		headContent: `ref: refs/heads/${branchName}\n`,
		headPath: "/tmp/.git/HEAD",
		kind: "ref",
		repoRoot: "/tmp",
		ref: `refs/heads/${branchName}`,
	};
}

interface Harness {
	ctx: InteractiveModeContext;
	chatChildren: unknown[];
	recordGitRefCalls: string[];
	chronology: GitRefRecord[];
}

function createHarness(chronology: GitRefRecord[]): Harness {
	const chatChildren: unknown[] = [];
	const recordGitRefCalls: string[] = [];
	const ctx = {
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			terminal: { columns: 120 },
		},
		session: {
			switchSession: vi.fn(async () => true),
		},
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionDir: () => "/tmp/project/sessions",
			getSessionFile: () => "/tmp/project/sessions/active.jsonl",
			recordGitRef: vi.fn((branch: string) => {
				recordGitRefCalls.push(branch);
				if (chronology.at(-1)?.branch !== branch) {
					chronology.push({ branch, at: new Date().toISOString() });
				}
			}),
			getGitRefChronology: vi.fn(() => chronology as readonly GitRefRecord[]),
		},
		chatContainer: {
			clear: vi.fn(() => {
				chatChildren.length = 0;
			}),
			addChild: vi.fn((child: unknown) => {
				chatChildren.push(child);
			}),
		},
		statusContainer: { clear: vi.fn() },
		pendingMessagesContainer: { clear: vi.fn() },
		compactionQueuedMessages: [] as unknown[],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: { clear: vi.fn() },
		loadingAnimation: undefined,
		statusLine: {
			invalidate: vi.fn(),
			setSessionStartTime: vi.fn(),
		},
		updateEditorBorderColor: vi.fn(),
		updateEditorTopBorder: vi.fn(),
		renderInitialMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		showStatus: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, chatChildren, recordGitRefCalls, chronology };
}

function findBannerText(children: unknown[]): string | undefined {
	for (const child of children) {
		if (child instanceof Text) {
			const text = Bun.stripANSI(child.getText());
			if (text.includes("Branch history:")) return text;
		}
	}
	return undefined;
}

describe("SelectorController.handleResumeSession branch banner", () => {
	it("records current HEAD and renders banner when chronology spans branches", async () => {
		vi.spyOn(git.head, "resolveSync").mockReturnValue(makeRefHead("feat/x"));
		const initialChronology: GitRefRecord[] = [{ branch: "main", at: "2026-05-14T08:00:00.000Z" }];
		const harness = createHarness(initialChronology);
		const controller = new SelectorController(harness.ctx);

		await controller.handleResumeSession("/tmp/project/sessions/resumed.jsonl");

		expect(harness.recordGitRefCalls).toEqual(["feat/x"]);
		expect(harness.chronology.map(r => r.branch)).toEqual(["main", "feat/x"]);
		const banner = findBannerText(harness.chatChildren);
		expect(banner).toBeDefined();
		expect(banner).toContain("main");
		expect(banner).toContain("feat/x (current)");
	});

	it("suppresses banner when chronology only has one branch after resume", async () => {
		vi.spyOn(git.head, "resolveSync").mockReturnValue(makeRefHead("main"));
		const initialChronology: GitRefRecord[] = [{ branch: "main", at: "2026-05-14T08:00:00.000Z" }];
		const harness = createHarness(initialChronology);
		const controller = new SelectorController(harness.ctx);

		await controller.handleResumeSession("/tmp/project/sessions/resumed.jsonl");

		// recordGitRef is still called, but it dedups against the previous "main".
		expect(harness.recordGitRefCalls).toEqual(["main"]);
		expect(harness.chronology.map(r => r.branch)).toEqual(["main"]);
		expect(findBannerText(harness.chatChildren)).toBeUndefined();
	});

	it("does not crash when HEAD resolution throws", async () => {
		vi.spyOn(git.head, "resolveSync").mockImplementation(() => {
			throw new Error("not a git repo");
		});
		const initialChronology: GitRefRecord[] = [];
		const harness = createHarness(initialChronology);
		const controller = new SelectorController(harness.ctx);

		await controller.handleResumeSession("/tmp/project/sessions/resumed.jsonl");

		expect(harness.recordGitRefCalls).toEqual([]);
		expect(findBannerText(harness.chatChildren)).toBeUndefined();
	});
});
