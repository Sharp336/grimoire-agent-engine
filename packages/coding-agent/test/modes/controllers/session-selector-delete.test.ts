import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { SessionSelectorComponent } from "../../../src/modes/components/session-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { SessionInfo } from "../../../src/session/session-manager";

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createSession(id: string, title: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 0,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
	};
}

function createSelector(onDelete: (session: SessionInfo) => Promise<boolean>): SessionSelectorComponent {
	return new SessionSelectorComponent(
		[createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
		() => {},
		() => {},
		() => {},
		onDelete,
	);
}

function renderText(selector: SessionSelectorComponent): string {
	return selector.render(120).join("\n");
}

describe("SessionSelectorComponent delete confirmation", () => {
	it("keeps the session visible and shows the error when delete fails after confirmation", async () => {
		const onDelete = vi.fn(async () => {
			throw new Error("disk failed");
		});
		const selector = createSelector(onDelete);

		selector.handleInput("\x1b[3~");
		expect(renderText(selector)).toContain("Delete session?");
		expect(renderText(selector)).toContain("Alpha");

		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(rendered).toContain("Error: disk failed");
		expect(rendered).toContain("Alpha");
		expect(rendered).toContain("Beta");
		expect(rendered).not.toContain("Delete session?");
	});

	it("keeps the session visible when delete is canceled upstream", async () => {
		const onDelete = vi.fn(async () => false);
		const selector = createSelector(onDelete);

		selector.handleInput("\x1b[3~");
		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(rendered).toContain("Alpha");
		expect(rendered).toContain("Beta");
		expect(rendered).not.toContain("Error:");
	});

	it("removes the session row after a successful delete", async () => {
		const onDelete = vi.fn(async () => true);
		const selector = createSelector(onDelete);

		selector.handleInput("\x1b[3~");
		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(rendered).not.toContain("Alpha");
		expect(rendered).toContain("Beta");
	});
});

function createForkedSession(id: string, title: string, parentSessionPath: string): SessionInfo {
	const base = createSession(id, title);
	return { ...base, parentSessionPath };
}

describe("SessionSelectorComponent fork indicator", () => {
	it("shows fork prefix and forked tag for child sessions", () => {
		const sessions = [
			createSession("root", "Root Session"),
			createForkedSession("fork-a", "Root Session", "/tmp/root.jsonl"),
		];
		const selector = new SessionSelectorComponent(
			sessions,
			() => {},
			() => {},
			() => {},
		);
		const rendered = renderText(selector);
		expect(rendered).toContain("↳");
		expect(rendered).toContain("forked");
		const lines = rendered.split("\n");
		const forkLines = lines.filter(l => l.includes("↳"));
		expect(forkLines.length).toBe(1);
	});

	it("does not show fork indicator for root sessions", () => {
		const sessions = [createSession("root", "Clean Session")];
		const selector = new SessionSelectorComponent(
			sessions,
			() => {},
			() => {},
			() => {},
		);
		const rendered = renderText(selector);
		expect(rendered).not.toContain("↳");
		expect(rendered).not.toContain("forked");
	});

	it("shows fork indicator for untitled child sessions", () => {
		const sessions = [
			createSession("root", "Root"),
			{
				...createSession("fork-b", "Forked child"),
				parentSessionPath: "/tmp/root.jsonl",
			},
		];
		sessions[1] = { ...sessions[1], title: undefined };
		const selector = new SessionSelectorComponent(
			sessions,
			() => {},
			() => {},
			() => {},
		);
		const rendered = renderText(selector);
		expect(rendered).toContain("↳");
		expect(rendered).toContain("forked");
	});

	it("truncates forked session titles to stay within display width", () => {
		const longTitle = "A".repeat(200);
		const sessions = [createForkedSession("fork-long", longTitle, "/tmp/root.jsonl")];
		const selector = new SessionSelectorComponent(
			sessions,
			() => {},
			() => {},
			() => {},
		);
		const width = 60;
		const rendered = selector.render(width).join("\n");
		// Each visible line should not exceed the display width
		const stripped = rendered.replace(/\x1b\[[0-9;]*m/g, "");
		for (const line of stripped.split("\n")) {
			if (line.trim().length > 0) {
				expect(line.length).toBeLessThanOrEqual(width + 10);
			}
		}
		expect(rendered).toContain("↳");
	});
});
