import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { COUNCIL_RUN_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/council/events";
import type { CouncilManifest } from "@oh-my-pi/pi-coding-agent/council/state";
import { type CouncilRunStats, summarizeCouncilRun } from "@oh-my-pi/pi-coding-agent/council/stats";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import {
	CouncilRunEventComponent,
	type CouncilRunEventDetails,
	type CouncilRunStatsLoader,
	createCouncilRunStatsLoader,
} from "@oh-my-pi/pi-coding-agent/modes/components/council-run-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TUI } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	initTheme();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterAll(() => resetSettingsForTest());

const NOW = "2026-08-08T12:00:00.000Z";

function manifest(state: CouncilManifest["state"] = "interrupted"): CouncilManifest {
	return {
		version: 2,
		runId: "run-42",
		sessionId: "session-1",
		mainAgentId: "Main",
		state,
		task: "Design the change",
		repoRoot: "/repo",
		outputPath: "council-design-plan.md",
		timestamps: { createdAt: NOW, updatedAt: NOW, startedAt: NOW, finishedAt: NOW, interruptedAt: NOW },
		config: {
			members: [{ role: "council1", enabled: true, order: 0 }],
			rounds: 1,
			advisor: { planner: false, reviewers: false, adjudicator: false },
		},
		roster: [
			{
				role: "council1",
				enabled: true,
				order: 0,
				rounds: [1],
				advisor: false,
				requestedSelector: "anthropic/opus",
				resolvedModel: "anthropic/opus",
				effort: null,
				lens: "Correctness",
			},
		],
		planner: {
			role: "slow",
			requestedSelector: "openai/o3",
			resolvedModel: "openai/o3",
			effort: null,
			advisor: false,
		},
		adjudicator: {
			mode: "main",
			requestedSelector: "@main",
			resolvedModel: "anthropic/sonnet",
			effort: null,
			advisor: false,
			capturedAt: NOW,
			instructionSha256: "a".repeat(64),
		},
		instructionSnapshot: {
			artifact: { url: "local://instructions.json", sha256: "b".repeat(64), bytes: 12 },
			sha256: "b".repeat(64),
		},
		rounds: [
			{
				round: 1,
				status: "interrupted",
				startedAt: NOW,
				finishedAt: NOW,
				members: [
					{
						role: "council1",
						order: 0,
						status: "interrupted",
						attempts: 1,
						startedAt: NOW,
						finishedAt: NOW,
						artifact: null,
						resolvedModel: "anthropic/opus",
						authFallbackUsed: false,
						failureReason: "Council run cancelled",
						findingIds: [],
					},
				],
			},
		],
		planVersions: [],
		usage: { requests: 3, tokens: 900, cost: 0.42 },
		adjudicationBudget: { injectedChars: 10, cap: 1_000 },
		warnings: ["roster drifted"],
		degraded: false,
		failure: { phase: "cancel", reason: "Council run cancelled", code: "COUNCIL_INTERRUPTED", time: NOW },
	};
}

function event(
	eventKind: string,
	content: string,
	extra: Partial<CouncilRunEventDetails> = {},
): CustomMessage<CouncilRunEventDetails> {
	return {
		role: "custom",
		customType: COUNCIL_RUN_MESSAGE_TYPE,
		content,
		display: true,
		details: { runId: "run-42", eventKind, manifestUrl: "local://council/run-42/manifest.json", ...extra },
		timestamp: Date.parse(NOW),
	};
}

function rendered(component: { render(width: number): readonly string[] }, width = 100): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

describe("CouncilRunEventComponent", () => {
	it("renders a lifecycle line and no stats block for a non-terminal event", () => {
		const component = new CouncilRunEventComponent(
			event("round-settle", "Council round 1 settled: 2/3 reviewers succeeded, 4 findings.", { round: 1 }),
			() => {
				throw new Error("a non-terminal event must not hydrate");
			},
			() => {},
		);
		const text = rendered(component);
		expect(text).toContain("Council round 1 settled: 2/3 reviewers succeeded, 4 findings.");
		expect(text).not.toContain("reviewers ·");
		component.dispose();
	});

	it("lays the terminal stats projection out at the live width from the persisted payload alone", () => {
		const stats = summarizeCouncilRun(manifest());
		const component = new CouncilRunEventComponent(
			event(
				"terminal",
				"Council run-42 interrupted: 0/1 reviewers succeeded. Final: not published; resumable: /council resume run-42.",
				{ stats },
			),
			// No loader: the agent-transcript path has no council storage, so the card must be complete
			// from `details.stats`.
			undefined,
			() => {},
		);

		const wide = rendered(component, 160);
		expect(wide).toContain("resumable: /council resume run-42");
		expect(wide).toContain("interrupted");
		expect(wide).toContain("Reviewer 1");
		expect(wide).not.toContain("council1");
		const wideRows = component.render(160);
		// Rows are laid out per render, so a narrower frame re-lays the table instead of replaying
		// columns that were baked when the run settled.
		const narrow = component.render(48);
		expect(narrow).not.toEqual(wideRows);
		for (const row of narrow) expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(48);
		component.dispose();
	});

	it("prefers a freshly hydrated projection over the persisted snapshot", async () => {
		const resettled = manifest("completed");
		resettled.rounds[0]!.status = "settled";
		resettled.rounds[0]!.members[0]!.status = "succeeded";
		resettled.warnings = ["hydrated after the resume"];
		const loader: CouncilRunStatsLoader = async () => summarizeCouncilRun(resettled);
		const stale: CouncilRunStats = summarizeCouncilRun(manifest());
		const component = new CouncilRunEventComponent(
			event("terminal", "Council run-42 interrupted.", { stats: stale }),
			loader,
			() => {},
		);

		expect(rendered(component)).toContain("roster drifted");
		await Promise.resolve();
		await Promise.resolve();
		expect(rendered(component)).toContain("hydrated after the resume");
		expect(rendered(component)).not.toContain("roster drifted");
		component.dispose();
	});

	it("rejects malformed and foreign persisted metadata before touching council storage", async () => {
		const fakeSession = {
			localProtocolOptions: { getArtifactsDir: () => null, getSessionId: () => "session-1" },
			sessionManager: { getSessionId: () => "session-1" },
		} as unknown as Pick<ToolSession, "localProtocolOptions" | "sessionManager">;
		const loader = createCouncilRunStatsLoader(fakeSession);
		const settle = async (): Promise<void> => {
			for (let tick = 0; tick < 6; tick++) await Promise.resolve();
		};

		// A terminal card written by some earlier build may carry anything at all.
		const missing = event("terminal", "Council run-42 interrupted.");
		missing.details!.manifestUrl = undefined;
		const missingComponent = new CouncilRunEventComponent(missing, loader, () => {});
		await settle();
		expect(rendered(missingComponent)).toContain("Council run event metadata is malformed.");
		missingComponent.dispose();

		const traversal = event("terminal", "Council run-42 interrupted.");
		traversal.details!.runId = "..";
		const traversalComponent = new CouncilRunEventComponent(traversal, loader, () => {});
		await settle();
		expect(rendered(traversalComponent)).toContain("Council run event metadata is malformed.");
		traversalComponent.dispose();

		const foreign = event("terminal", "Council run-42 interrupted.");
		foreign.details!.manifestUrl = "local://other.json";
		const foreignComponent = new CouncilRunEventComponent(foreign, loader, () => {});
		await settle();
		expect(rendered(foreignComponent)).toContain("Council run manifest link is foreign.");
		foreignComponent.dispose();
	});

	it("renders exactly one card per persisted lifecycle event through a transcript rebuild", () => {
		const entries = [
			{ type: "message", message: event("kickoff", "Council run-42 started: 1 member(s).") },
			{ type: "message", message: event("round-settle", "Council round 1 settled.", { round: 1 }) },
		] as SessionMessageEntry[];
		const builder = new ChatTranscriptBuilder({ ui: {} as TUI, cwd: "/repo", requestRender: () => {} });

		builder.rebuild(entries);
		expect(builder.container.children).toHaveLength(2);
		const first = rendered(builder.container);
		builder.rebuild(entries);
		expect(builder.container.children).toHaveLength(2);
		expect(rendered(builder.container)).toBe(first);
		expect(first).toContain("Council run-42 started");
		expect(first).toContain("Council round 1 settled.");
	});
});
