import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	CouncilCoordinatorSnapshot,
	CouncilMemberLiveProgress,
	CouncilSoloChild,
} from "@oh-my-pi/pi-coding-agent/council/coordinator";
import type { CouncilManifest, CouncilRoundMemberRecord } from "@oh-my-pi/pi-coding-agent/council/state";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import {
	CouncilTranscriptMirror,
	type CouncilTranscriptMirrorContext,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/council-transcript-mirror";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type SubagentEventPayload, TASK_SUBAGENT_EVENT_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { Component } from "@oh-my-pi/pi-tui";

const NOW = "2026-08-05T12:00:00.000Z";
const PLANNER_AGENT_ID = "council-planner-01";
const MEMBER_AGENT_ID = "council-security-r1";
/** Wide enough that the coalescing timer has certainly fired once advanced. */
const PAST_COALESCE_MS = 60;

beforeAll(async () => {
	await initTheme();
});

function memberRecord(role: string, order: number): CouncilRoundMemberRecord {
	return {
		role,
		order,
		status: "running",
		attempts: 1,
		startedAt: NOW,
		finishedAt: null,
		artifact: null,
		resolvedModel: `provider/${role}`,
		authFallbackUsed: false,
		failureReason: null,
		findingIds: [],
	};
}

function manifest(roles: readonly string[]): CouncilManifest {
	return {
		version: 2,
		runId: "run-mirror",
		sessionId: "session-1",
		mainAgentId: "Main",
		state: "reviewing",
		task: "Design the change",
		repoRoot: "/repo",
		outputPath: "council-design-the-change-plan.md",
		timestamps: { createdAt: NOW, updatedAt: NOW, startedAt: NOW },
		config: {
			members: roles.map((role, order) => ({ role, enabled: true, order })),
			rounds: 1,
			advisor: { planner: false, reviewers: false, adjudicator: false },
		},
		roster: roles.map((role, order) => ({
			role,
			enabled: true,
			order,
			rounds: [1],
			advisor: false,
			requestedSelector: "member",
			resolvedModel: `provider/${role}`,
			effort: null,
			lens: "correctness",
		})),
		planner: {
			role: "slow",
			requestedSelector: "planner",
			resolvedModel: "provider/planner",
			effort: null,
			advisor: false,
		},
		adjudicator: {
			mode: "main",
			requestedSelector: "@main",
			resolvedModel: "provider/main",
			effort: null,
			advisor: false,
			capturedAt: NOW,
		},
		instructionSnapshot: {
			artifact: { url: "local://council-run-mirror-instructions.json", sha256: "1".repeat(64), bytes: 64 },
			sha256: "1".repeat(64),
		},
		rounds: [
			{
				round: 1,
				status: "running",
				startedAt: NOW,
				finishedAt: null,
				members: roles.map((role, order) => memberRecord(role, order)),
			},
		],
		planVersions: [],
		usage: { requests: 0, tokens: 0, cost: 0 },
		adjudicationBudget: { injectedChars: 0, cap: 1_000 },
		warnings: [],
		degraded: false,
	};
}

const SOLO_MEMBER: CouncilSoloChild = {
	agentId: MEMBER_AGENT_ID,
	label: "Council security r1",
	kind: "member",
	round: 1,
	order: 0,
};

const SOLO_PLANNER: CouncilSoloChild = {
	agentId: PLANNER_AGENT_ID,
	label: "Council planner run-mirror",
	kind: "planner",
	round: 0,
	order: -1,
};

function snapshot(
	soloChild: CouncilSoloChild | undefined,
	members: CouncilMemberLiveProgress[] = [],
): CouncilCoordinatorSnapshot {
	const value: CouncilCoordinatorSnapshot = {
		manifest: manifest(["security", "testing"]),
		members,
		mainTurnOwned: false,
	};
	if (soloChild) value.soloChild = soloChild;
	return value;
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.parse(NOW),
	};
}

function messageEnd(id: string, text: string): SubagentEventPayload {
	return { id, event: { type: "message_end", message: assistantMessage([{ type: "text", text }]) } };
}

function grepStart(id: string, toolCallId: string, pattern: string): SubagentEventPayload {
	return {
		id,
		event: {
			type: "tool_execution_start",
			toolCallId,
			toolName: "grep",
			args: { pattern, i: "Finding the control lock" },
			intent: "Finding the control lock",
		},
	};
}

function grepEnd(id: string, toolCallId: string, output: string): SubagentEventPayload {
	return {
		id,
		event: {
			type: "tool_execution_end",
			toolCallId,
			toolName: "grep",
			result: { content: [{ type: "text", text: output }] },
			isError: false,
		},
	};
}

interface MirrorHarness {
	presented: Component[];
	mirror: CouncilTranscriptMirror;
	emit(payload: SubagentEventPayload): void;
	render(from?: number): string;
}

function harness(mirrorTranscript = true): MirrorHarness {
	const bus = new EventBus();
	const presented: Component[] = [];
	const chatContainer = new TranscriptContainer();
	const mount = (item: Component) => {
		presented.push(item);
		chatContainer.addChild(item);
	};
	const ctx = {
		settings: Settings.isolated({ "council.mirrorTranscript": mirrorTranscript }),
		eventBus: bus,
		ui: { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} },
		viewSession: { getToolByName: () => undefined, extensionRunner: undefined },
		sessionManager: { getCwd: () => "/repo" },
		chatContainer,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		toolOutputExpanded: false,
		hideToolActivity: false,
		present: (content: Component | readonly Component[]) => {
			if (Array.isArray(content)) for (const item of content) mount(item);
			else mount(content as Component);
		},
	} as unknown as CouncilTranscriptMirrorContext;
	return {
		presented,
		mirror: new CouncilTranscriptMirror(ctx),
		emit: payload => bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, payload),
		render: (from = 0) =>
			presented
				.slice(from)
				.flatMap(component => component.render(100))
				.map(line => Bun.stripANSI(line))
				.join("\n"),
	};
}

let h: MirrorHarness;

beforeEach(() => {
	vi.useFakeTimers();
	h = harness();
});

afterEach(() => {
	h.mirror.dispose();
	vi.useRealTimers();
});

describe("CouncilTranscriptMirror", () => {
	it("renders only the solo child's turns, and names it once in the header", () => {
		h.mirror.sync(snapshot(SOLO_MEMBER));

		h.emit(messageEnd("council-testing-r1", "a concurrent reviewer's turn"));
		h.emit(messageEnd("SubagentA", "an unrelated task subagent's turn"));
		h.emit(messageEnd("Main", "Main's own turn"));
		expect(h.presented).toHaveLength(0);

		h.emit(messageEnd(MEMBER_AGENT_ID, "the mirrored reviewer's verdict"));

		// One header card opening the phase, then the assistant card itself.
		expect(h.presented).toHaveLength(2);
		const header = h.render(0);
		// The durable roster id is `security`; the mirrored header shows its stable humanized label.
		expect(header).toContain("[Security]");
		expect(header).toContain(`history://${MEMBER_AGENT_ID}`);
		expect(header).toContain("provider/security");

		// The turn itself renders like Main's: no label tag, no agent id on the row.
		const turn = h.render(1);
		expect(turn).toContain("the mirrored reviewer's verdict");
		expect(turn).not.toContain("[security]");
		expect(turn).not.toContain(MEMBER_AGENT_ID);

		const all = h.render();
		expect(all).not.toContain("concurrent reviewer");
		expect(all).not.toContain("unrelated task subagent");
		expect(all).not.toContain("Main's own turn");
	});

	it("renders a tool call with its real renderer and settles the result into the same block", () => {
		h.mirror.sync(snapshot(SOLO_MEMBER));

		h.emit(grepStart(MEMBER_AGENT_ID, "tc-1", "IsControlLocked"));

		expect(h.presented).toHaveLength(2);
		expect(h.presented[1]).toBeInstanceOf(ToolExecutionComponent);
		const pending = h.render(1);
		expect(pending).toContain("Grep");
		expect(pending).toContain("IsControlLocked");
		expect(pending).not.toContain("src/input.ts:42");

		h.emit(grepEnd(MEMBER_AGENT_ID, "tc-1", "src/input.ts:42: if (IsControlLocked()) return;"));

		// The result updates the mounted block instead of appending another row.
		expect(h.presented).toHaveLength(2);
		const settled = h.render(1);
		expect(settled).toContain("src/input.ts:42");
		expect(settled).toContain("IsControlLocked()");
	});

	it("streams assistant text before the turn settles", () => {
		h.mirror.sync(snapshot(SOLO_MEMBER));

		const partial = assistantMessage([{ type: "text", text: "reading the equip handler" }]);
		h.emit({
			id: MEMBER_AGENT_ID,
			event: {
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "handler", partial },
			},
		});

		// Coalesced: nothing is rebuilt until the window closes.
		expect(h.presented).toHaveLength(0);
		vi.advanceTimersByTime(PAST_COALESCE_MS);

		expect(h.presented).toHaveLength(2);
		expect(h.render(1)).toContain("reading the equip handler");

		h.emit(messageEnd(MEMBER_AGENT_ID, "reading the equip handler, then the bank container"));
		expect(h.presented).toHaveLength(2);
		expect(h.render(1)).toContain("then the bank container");
	});

	it("keeps post-tool text below the tool block it follows", () => {
		h.mirror.sync(snapshot(SOLO_MEMBER));

		h.emit({
			id: MEMBER_AGENT_ID,
			event: {
				type: "message_end",
				message: assistantMessage([
					{ type: "text", text: "first I check the mover" },
					{ type: "toolCall", id: "tc-9", name: "grep", arguments: { pattern: "MoveItem" } },
					{ type: "text", text: "then I check the panel" },
				]),
			},
		});

		expect(h.presented).toHaveLength(4);
		expect(h.render(1)).toContain("first I check the mover");
		expect(h.presented[2]).toBeInstanceOf(ToolExecutionComponent);
		expect(h.render(2)).toContain("MoveItem");
		expect(h.render(3)).toContain("then I check the panel");
	});

	it("mirrors every turn of a long phase instead of eliding after a budget", () => {
		h.mirror.sync(snapshot(SOLO_MEMBER));

		for (let index = 0; index < 60; index++) {
			h.emit(grepStart(MEMBER_AGENT_ID, `tc-${index}`, `pattern${index}`));
		}

		expect(h.presented).toHaveLength(61);
		const text = h.render();
		expect(text).toContain("pattern0");
		expect(text).toContain("pattern59");
		expect(text).not.toContain("truncated");
	});

	it("mirrors a child that settles before its first progress tick", () => {
		// The solo child is targeted by its pre-allocated id, so no live-progress row exists yet.
		const early = snapshot(SOLO_PLANNER);
		expect(early.members).toEqual([]);
		h.mirror.sync(early);

		h.emit(messageEnd(PLANNER_AGENT_ID, "draft plan before any progress coalescing"));

		expect(h.presented).toHaveLength(2);
		const text = h.render();
		expect(text).toContain("[Planner]");
		expect(text).toContain("planning");
		expect(text).toContain("provider/planner");
		expect(text).toContain("draft plan before any progress coalescing");
	});

	it("opens a fresh header when the phase moves to another child", () => {
		h.mirror.sync(snapshot(SOLO_PLANNER));
		h.emit(messageEnd(PLANNER_AGENT_ID, "the plan"));
		expect(h.presented).toHaveLength(2);

		h.mirror.sync(snapshot(SOLO_MEMBER));
		h.emit(messageEnd(PLANNER_AGENT_ID, "a late planner event"));
		expect(h.presented).toHaveLength(2);

		h.emit(messageEnd(MEMBER_AGENT_ID, "the review"));
		expect(h.presented).toHaveLength(4);
		expect(h.render(2)).toContain("[Security]");
		expect(h.render(2)).toContain("review round 1");
		expect(h.render()).not.toContain("a late planner event");
	});

	it("mirrors nothing while no child is alone in its phase", () => {
		const members: CouncilMemberLiveProgress[] = [
			{
				agentId: MEMBER_AGENT_ID,
				round: 1,
				role: "security",
				order: 0,
				attempt: 1,
				status: "running",
				recentOutput: [],
				requests: 0,
				tokens: 0,
				cost: 0,
			},
			{
				agentId: "council-testing-r1",
				round: 1,
				role: "testing",
				order: 1,
				attempt: 1,
				status: "running",
				recentOutput: [],
				requests: 0,
				tokens: 0,
				cost: 0,
			},
		];
		h.mirror.sync(snapshot(undefined, members));

		h.emit(messageEnd(MEMBER_AGENT_ID, "one of two concurrent reviewers"));

		expect(h.presented).toHaveLength(0);
	});

	it("mirrors nothing when council.mirrorTranscript is disabled", () => {
		const disabled = harness(false);
		disabled.mirror.sync(snapshot(SOLO_MEMBER));

		disabled.emit(messageEnd(MEMBER_AGENT_ID, "a turn the operator opted out of"));

		expect(disabled.presented).toHaveLength(0);
		disabled.mirror.dispose();
	});

	it("seals an unresolved tool block and stops mirroring once disposed", () => {
		h.mirror.sync(snapshot(SOLO_MEMBER));
		h.emit(grepStart(MEMBER_AGENT_ID, "tc-live", "AbandonedSearch"));

		const card = h.presented[1] as ToolExecutionComponent;
		expect(card.isTranscriptBlockFinalized()).toBe(false);

		h.mirror.dispose();

		// A cancelled child must not leave a block spinning forever inside the live region.
		expect(card.isTranscriptBlockFinalized()).toBe(true);

		h.emit(messageEnd(MEMBER_AGENT_ID, "after dispose"));
		expect(h.presented).toHaveLength(2);
		expect(h.render()).not.toContain("after dispose");
	});
});
