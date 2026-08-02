import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

function messageNode(
	id: string,
	parentId: string | null,
	role: "assistant" | "toolResult",
	options: { text?: string; stopReason?: "stop" | "aborted" } = {},
): SessionTreeNode {
	const message: AgentMessage =
		role === "assistant"
			? ({
					role,
					content: options.text ? [{ type: "text", text: options.text }] : [],
					timestamp: 0,
					stopReason: options.stopReason ?? "stop",
				} as AgentMessage)
			: ({
					role,
					toolCallId: `${id}-call`,
					toolName: "hub",
					content: [{ type: "text", text: options.text ?? "side branch" }],
					isError: false,
					timestamp: 0,
				} as AgentMessage);
	return {
		entry: {
			type: "message",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:00.000Z",
			message,
		},
		children: [],
	};
}

function modelChangeNode(id: string, parentId: string): SessionTreeNode {
	const entry: SessionEntry = {
		type: "model_change",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		model: "fixture/model",
		role: "temporary",
	};
	return { entry, children: [] };
}

describe("filtered tree connector projection", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("promotes a visible aborted descendant when its active branch head is hidden", () => {
		const root = messageNode("root", null, "assistant", { text: "common parent" });
		const sideBranch = messageNode("side", root.entry.id, "toolResult");
		const hiddenActiveHead = modelChangeNode("active-head", root.entry.id);
		const aborted = messageNode("aborted", hiddenActiveHead.entry.id, "assistant", { stopReason: "aborted" });
		root.children.push(sideBranch, hiddenActiveHead);
		hiddenActiveHead.children.push(aborted);

		const selector = new TreeSelectorComponent(
			[root],
			aborted.entry.id,
			20,
			() => {},
			() => {},
		);
		const rows = selector.render(120).map(line => Bun.stripANSI(line));
		const abortedRow = rows.find(line => line.includes("assistant: Operation aborted"));
		const sideRow = rows.find(line => line.includes("[hub]"));
		if (!abortedRow || !sideRow) throw new Error("Expected both visible branches to render");

		expect(abortedRow.slice(2)).toMatch(/^├─ /);
		expect(sideRow.slice(2)).toMatch(/^└─ /);
		expect(abortedRow.slice(2)).not.toMatch(/^│/);
	});
});
