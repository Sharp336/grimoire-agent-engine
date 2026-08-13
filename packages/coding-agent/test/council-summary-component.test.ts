import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { COUNCIL_SUMMARY_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/council/events";
import type { CouncilManifest } from "@oh-my-pi/pi-coding-agent/council/state";
import { CouncilStorageError } from "@oh-my-pi/pi-coding-agent/council/storage";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import {
	CouncilSummaryComponent,
	type CouncilSummaryHydration,
	type CouncilSummaryManifestLoader,
	createCouncilSummaryManifestLoader,
} from "@oh-my-pi/pi-coding-agent/modes/components/council-summary";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TUI } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import councilSummaryTemplate from "../src/prompts/council/summary.md" with { type: "text" };

beforeAll(async () => {
	initTheme();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterAll(() => resetSettingsForTest());

function manifest(runId = "run-1", sessionId = "session-1"): CouncilManifest {
	const now = "2026-08-05T12:00:00.000Z";
	return {
		version: 2,
		runId,
		sessionId,
		mainAgentId: "Main",
		state: "completed-degraded",
		task: "Design the change",
		repoRoot: "/repo",
		outputPath: "council-final-plan.md",
		published: { path: "council-final-plan.md", sha256: "a".repeat(64), bytes: 5, publishedAt: now },
		timestamps: { createdAt: now, updatedAt: now, startedAt: now, finishedAt: now },
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
				requestedSelector: "member",
				resolvedModel: "provider/member",
				effort: null,
				lens: "correctness",
			},
		],
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
			capturedAt: now,
		},
		instructionSnapshot: {
			artifact: {
				url: "local://council-run-1-instructions.json",
				sha256: "1".repeat(64),
				bytes: 64,
			},
			sha256: "1".repeat(64),
		},
		rounds: [
			{
				round: 1,
				status: "settled",
				startedAt: now,
				finishedAt: now,
				members: [
					{
						role: "council1",
						order: 0,
						status: "failed",
						attempts: 2,
						startedAt: now,
						finishedAt: now,
						artifact: null,
						resolvedModel: "provider/member",
						authFallbackUsed: false,
						failureReason: "bounded warning",
						findingIds: [],
					},
				],
			},
		],
		planVersions: [],
		usage: { requests: 2, tokens: 100, cost: 0.1 },
		adjudicationBudget: { injectedChars: 50, cap: 1_000 },
		warnings: [],
		degraded: true,
		failure: { phase: "reviewing", reason: "member failed" },
	};
}

function message(content = "Provider-visible bounded summary"): CustomMessage<{ runId: string; manifestUrl: string }> {
	return {
		role: "custom",
		customType: COUNCIL_SUMMARY_MESSAGE_TYPE,
		content,
		display: true,
		timestamp: Date.now(),
		details: { runId: "run-1", manifestUrl: "local://council-run-1-manifest.json" },
	};
}

function rendered(component: { render(width: number): readonly string[] }): string {
	return Bun.stripANSI(component.render(100).join("\n"));
}

/**
 * The card's hydration and its one retry are both promise chains, so draining the microtask queue
 * is enough to reach the settled state. No wall clock: `runSynchronously` below stands in for the
 * component's deferred retry schedule.
 */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

/** Retry schedule seam that runs the retry inline, so the test never waits on a timer. */
function runSynchronously(retry: () => void): void {
	retry();
}

describe("CouncilSummaryComponent", () => {
	it("shows bounded provider content immediately, then hydrates durable outcomes and links", async () => {
		const deferred = Promise.withResolvers<CouncilSummaryHydration>();
		const component = new CouncilSummaryComponent(
			message(`summary\t${"x".repeat(4_000)}`),
			() => deferred.promise,
			() => {},
		);
		const immediate = rendered(component);
		expect(immediate).toContain("Council summary");
		expect(immediate).toContain("Loading durable council details");
		expect(immediate.length).toBeLessThan(2_900);
		expect(immediate).not.toContain("\t");

		const hydratedManifest = manifest();
		const homePath = `${os.homedir()}/private/council-summary.log`;
		hydratedManifest.rounds[0]!.members[0]!.failureReason = "warning\twith tab";
		hydratedManifest.warnings = [`manifest\twarning at ${homePath} ${"w".repeat(800)}`];
		deferred.resolve({ manifest: hydratedManifest });
		await Promise.resolve();
		await Promise.resolve();
		const hydrated = rendered(component);
		expect(hydrated).toContain("completed-degraded");
		expect(hydrated).toContain("Round 1 settled: Reviewer 1 failed (2 attempts)");
		expect(hydrated).toContain("Final: local://council-final-plan.md");
		expect(hydrated).toMatch(/Warning: Reviewer 1: warning +with tab/);
		expect(hydrated).toMatch(/Warning: manifest +warning/);
		expect(hydrated).not.toContain("w".repeat(600));
		expect(hydrated).not.toContain("\t");
		expect(hydrated).toContain("~/private/council-summary.log");
		expect(hydrated).not.toContain(os.homedir());
		component.dispose();
	});

	it("sanitizes ANSI, OSC, C0 controls, and tabs in immediate and hydrated dynamic fields", async () => {
		const deferred = Promise.withResolvers<CouncilSummaryHydration>();
		const osc = "\u001b]8;;https://evil.example\u0007";
		const csi = "\u001b[999m";
		const controls = `${osc}${csi}\u0000\u0001\t`;
		const component = new CouncilSummaryComponent(
			message(`immediate ${controls}${"x".repeat(4_000)}`),
			() => deferred.promise,
			() => {},
		);
		const immediateRaw = component.render(100).join("\n");
		expect(immediateRaw).not.toContain(osc);
		expect(immediateRaw).not.toContain(csi);
		expect(immediateRaw).not.toContain("\u0000");
		expect(immediateRaw).not.toContain("\u0001");
		expect(immediateRaw).not.toContain("\t");
		expect(immediateRaw.length).toBeLessThan(3_500);

		const unsafeManifest = manifest();
		const member = unsafeManifest.rounds[0]!.members[0]!;
		member.role = `member${controls}`;
		member.failureReason = `failure${controls}`;
		unsafeManifest.failure = { phase: `phase${controls}`, reason: `reason${controls}` };
		unsafeManifest.outputPath = `council-final${controls}-plan.md`;
		unsafeManifest.planVersions = [
			{
				version: 1,
				round: 1,
				kind: "final",
				artifact: { url: `local://final${controls}.md`, sha256: "b".repeat(64), bytes: 1 },
				createdAt: unsafeManifest.timestamps.createdAt,
			},
		];
		deferred.resolve({ manifest: unsafeManifest });
		await Promise.resolve();
		await Promise.resolve();
		const hydratedRaw = component.render(100).join("\n");
		expect(hydratedRaw).not.toContain(osc);
		expect(hydratedRaw).not.toContain(csi);
		expect(hydratedRaw).not.toContain("\u0000");
		expect(hydratedRaw).not.toContain("\u0001");
		expect(hydratedRaw).not.toContain("\t");
		expect(hydratedRaw.length).toBeLessThan(12_000);
		expect(Bun.stripANSI(hydratedRaw)).toContain("Final artifact: local://final");
		component.dispose();
	});

	it("keeps the immediate card with precise missing, corrupt, foreign, and malformed fallbacks", async () => {
		const cases: Array<[string, CouncilSummaryManifestLoader, string]> = [
			[
				"missing",
				async () => {
					throw new CouncilStorageError("COUNCIL_RUN_NOT_FOUND", "missing");
				},
				"Council manifest is missing.",
			],
			[
				"corrupt",
				async () => {
					throw new CouncilStorageError("COUNCIL_RECOVERY_CORRUPT", "bad JSON");
				},
				"Council manifest is corrupt.",
			],
			[
				"foreign session",
				async () => {
					throw new CouncilStorageError(
						"COUNCIL_RECOVERY_CORRUPT",
						"Council manifest sessionId foreign does not match active session local",
					);
				},
				"Council manifest belongs to a different session.",
			],
		];
		for (const [label, loader, expected] of cases) {
			// The card gets exactly one retry before it settles into the error state.
			const component = new CouncilSummaryComponent(message(label), loader, () => {}, runSynchronously);
			await settle();
			expect(rendered(component)).toContain(label);
			expect(rendered(component)).toContain(expected);
			component.dispose();
		}

		const fakeSession = {
			localProtocolOptions: {
				getArtifactsDir: () => null,
				getSessionId: () => "session-1",
			},
			sessionManager: { getSessionId: () => "session-1" },
		} as unknown as Pick<ToolSession, "localProtocolOptions" | "sessionManager">;
		const loader = createCouncilSummaryManifestLoader(fakeSession);
		const foreign = message("foreign URL");
		foreign.details!.manifestUrl = "local://other.json";
		const foreignComponent = new CouncilSummaryComponent(foreign, loader, () => {}, runSynchronously);
		await settle();
		expect(rendered(foreignComponent)).toContain("Council summary manifest link is foreign.");
		foreignComponent.dispose();
		const malformed = message("malformed metadata");
		malformed.details!.runId = "..";
		const malformedComponent = new CouncilSummaryComponent(malformed, loader, () => {}, runSynchronously);
		await settle();
		expect(rendered(malformedComponent)).toContain("Council summary metadata is malformed.");
		malformedComponent.dispose();
	});

	it("ignores stale hydration generations", async () => {
		const first = Promise.withResolvers<CouncilSummaryHydration>();
		const second = Promise.withResolvers<CouncilSummaryHydration>();
		let call = 0;
		const component = new CouncilSummaryComponent(
			message(),
			() => (++call === 1 ? first.promise : second.promise),
			() => {},
		);
		component.hydrate();
		const live = manifest("run-2");
		live.warnings = ["hydrated from run-2"];
		second.resolve({ manifest: live });
		await Promise.resolve();
		await Promise.resolve();
		const stale = manifest("run-stale");
		stale.warnings = ["hydrated from run-stale"];
		first.resolve({ manifest: stale });
		await Promise.resolve();
		await Promise.resolve();
		expect(rendered(component)).toContain("hydrated from run-2");
		expect(rendered(component)).not.toContain("run-stale");
		component.dispose();
	});

	it("renders the same single card after transcript rebuild without duplicating context", async () => {
		const loader: CouncilSummaryManifestLoader = async () => ({ manifest: manifest() });
		const direct = new CouncilSummaryComponent(message(), loader, () => {});
		const builder = new ChatTranscriptBuilder({
			ui: {} as TUI,
			cwd: "/repo",
			requestRender: () => {},
			loadCouncilManifest: loader,
		});
		const entry = { type: "message", message: message() } as SessionMessageEntry;
		builder.rebuild([entry]);
		await Promise.resolve();
		await Promise.resolve();
		expect(builder.container.children).toHaveLength(1);
		expect(rendered(builder.container)).toBe(rendered(direct));
		builder.rebuild([entry]);
		await Promise.resolve();
		await Promise.resolve();
		expect(builder.container.children).toHaveLength(1);
		expect(rendered(builder.container).match(/Provider-visible bounded summary/g)).toHaveLength(1);
		direct.dispose();
		builder.dispose();
	});

	it("keeps the resume command reachable in a warning-saturated card", () => {
		// The coordinator's own limits: eight warnings at 500 characters each, well past the card's
		// 2400-character immediate cap. The template's line order is what keeps the hint inside it.
		const warnings = Array.from({ length: 8 }, (_, index) => `${"w".repeat(499)}${index}`).join(" ");
		const content = prompt.render(councilSummaryTemplate, {
			outcome: "interrupted",
			taskPreview: "Design the change",
			succeeded: 0,
			failed: 4,
			finalUrl: "not published",
			manifestUrl: "local://council-run-1-manifest.json",
			warnings,
			resumeHint: "Resume: /council resume run-1",
		});
		expect(content.length).toBeGreaterThan(2_400);

		const component = new CouncilSummaryComponent(
			message(content),
			async () => ({ manifest: manifest() }),
			() => {},
			runSynchronously,
		);
		expect(rendered(component)).toContain("Resume: /council resume run-1");
		component.dispose();
	});

	it("links only the transcripts that still resolve", async () => {
		const withTranscripts = manifest();
		withTranscripts.planner.agentIds = ["planner-live"];
		withTranscripts.rounds[0]!.members[0]!.agentIds = ["member-dead-1", "member-dead-2"];
		const component = new CouncilSummaryComponent(
			message(),
			async () => ({ manifest: withTranscripts, resolvableAgentIds: new Set(["planner-live"]) }),
			() => {},
			runSynchronously,
		);
		await settle();

		const card = rendered(component);
		expect(card).toContain("history://planner-live");
		expect(card).not.toContain("history://member-dead-1");
		expect(card).not.toContain("history://member-dead-2");
		expect(card).toContain("transcript unavailable");
		component.dispose();
	});

	it("lists every finding with its role, title, and Main's decision", async () => {
		const judged = manifest();
		const member = judged.rounds[0]!.members[0]!;
		member.status = "succeeded";
		member.failureReason = null;
		member.findingIds = ["C1F1", "C1F2"];
		member.artifact = { url: "local://council-run-1-council1-r1.json", sha256: "c".repeat(64), bytes: 10 };
		const component = new CouncilSummaryComponent(
			message(),
			async () => ({
				manifest: judged,
				adjudications: new Map([
					[
						1,
						{
							plan: "# Plan",
							dispositions: [
								{ id: "C1F1", disposition: "accepted" as const, reason: "clear win", step: "Step 1" },
							],
						},
					],
				]),
				findingSummaries: new Map([
					["C1F1", "Race in the cache"],
					["C1F2", "Missing guard"],
				]),
			}),
			() => {},
			runSynchronously,
		);
		await settle();

		const card = rendered(component);
		expect(card).toContain("Findings (2):");
		expect(card).toContain("C1F1 Reviewer 1: Race in the cache -> accepted");
		expect(card).toContain("clear win");
		// A finding Main has not judged is shown as unjudged, never silently dropped.
		expect(card).toContain("C1F2 Reviewer 1: Missing guard -> not judged");
		// The pointer row is labelled `Reviewer 1`, but the artifact filename keeps the durable id.
		expect(card).toContain("Reviewer 1 r1: report local://council-run-1-council1-r1.json");
		expect(card).not.toContain("Dispositions unreadable");
		component.dispose();
	});

	it("says so when the dispositions could not be read, and only then", async () => {
		const withFindings = manifest();
		withFindings.rounds[0]!.members[0]!.findingIds = ["C1F1"];
		const unreadable = new CouncilSummaryComponent(
			message(),
			async () => ({ manifest: withFindings, adjudicationsUnreadable: true }),
			() => {},
			runSynchronously,
		);
		await settle();
		expect(rendered(unreadable)).toContain("Dispositions unreadable");
		unreadable.dispose();

		// No findings at all: an empty adjudication map is not corruption.
		const empty = new CouncilSummaryComponent(
			message(),
			async () => ({ manifest: manifest(), adjudicationsUnreadable: true }),
			() => {},
			runSynchronously,
		);
		await settle();
		expect(rendered(empty)).not.toContain("Dispositions unreadable");
		empty.dispose();
	});

	it("points at the newest plan of any kind when nothing was published", async () => {
		const now = "2026-08-05T12:00:00.000Z";
		const unpublished = manifest();
		unpublished.state = "interrupted";
		delete unpublished.published;
		unpublished.planVersions = [
			{
				version: 1,
				round: 0,
				kind: "draft",
				artifact: { url: "local://council-run-1-plan-v1.md", sha256: "d".repeat(64), bytes: 8 },
				createdAt: now,
			},
			{
				version: 2,
				round: 1,
				kind: "round",
				artifact: { url: "local://council-run-1-round1.md", sha256: "e".repeat(64), bytes: 9 },
				createdAt: now,
			},
		];
		const component = new CouncilSummaryComponent(
			message(),
			async () => ({ manifest: unpublished }),
			() => {},
			runSynchronously,
		);
		await settle();

		const card = rendered(component);
		expect(card).toContain("Latest round: local://council-run-1-round1.md");
		// One wording for "unpublished", produced by the coordinator; the card never coins a second.
		expect(card).not.toContain("Final: unavailable");
		expect(card).not.toContain("Final:");
		component.dispose();
	});

	it("does not re-emit the manifest link the immediate content already carries", async () => {
		const component = new CouncilSummaryComponent(
			message(),
			async () => ({ manifest: manifest() }),
			() => {},
			runSynchronously,
		);
		await settle();
		expect(rendered(component)).not.toContain("Manifest: local://council-run-1-manifest.json");
		component.dispose();
	});

	it("retries a failed hydration once, then names the run in the error", async () => {
		let calls = 0;
		const recovering = new CouncilSummaryComponent(
			message(),
			async () => {
				if (++calls === 1) throw new CouncilStorageError("COUNCIL_RUN_NOT_FOUND", "missing");
				return { manifest: manifest() };
			},
			() => {},
			runSynchronously,
		);
		await settle();
		expect(calls).toBe(2);
		expect(rendered(recovering)).toContain("State: completed-degraded");
		recovering.dispose();

		let failedCalls = 0;
		const failing = new CouncilSummaryComponent(
			message(),
			async () => {
				failedCalls++;
				throw new CouncilStorageError("COUNCIL_RUN_NOT_FOUND", "missing");
			},
			() => {},
			runSynchronously,
		);
		await settle();
		// Exactly one retry, not a loop.
		expect(failedCalls).toBe(2);
		expect(rendered(failing)).toContain("Council manifest is missing. (run run-1)");
		failing.dispose();
	});
});
