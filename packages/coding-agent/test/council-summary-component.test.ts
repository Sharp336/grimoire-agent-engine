import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { CouncilManifest } from "@oh-my-pi/pi-coding-agent/council/state";
import { CouncilStorageError } from "@oh-my-pi/pi-coding-agent/council/storage";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import {
	CouncilSummaryComponent,
	type CouncilSummaryManifestLoader,
	createCouncilSummaryManifestLoader,
} from "@oh-my-pi/pi-coding-agent/modes/components/council-summary";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TUI } from "@oh-my-pi/pi-tui";

beforeAll(() => initTheme());

function manifest(runId = "run-1", sessionId = "session-1"): CouncilManifest {
	const now = "2026-08-05T12:00:00.000Z";
	return {
		version: 1,
		runId,
		sessionId,
		mainAgentId: "Main",
		state: "completed-degraded",
		task: "Design the change",
		repoRoot: "/repo",
		outputPath: "plans/final.md",
		published: { path: "plans/final.md", sha256: "a".repeat(64), bytes: 5, publishedAt: now },
		timestamps: { createdAt: now, updatedAt: now, startedAt: now, finishedAt: now },
		config: {
			members: [{ role: "council1", enabled: true, order: 0 }],
			rounds: 1,
		},
		roster: [
			{
				role: "council1",
				enabled: true,
				order: 0,
				requestedSelector: "member",
				resolvedModel: "provider/member",
				effort: null,
				lens: "correctness",
			},
		],
		planner: { requestedSelector: "planner", resolvedModel: "provider/planner", effort: null },
		mainSnapshot: { model: "provider/main", effort: null, capturedAt: now },
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
		customType: "council-summary",
		content,
		display: true,
		timestamp: Date.now(),
		details: { runId: "run-1", manifestUrl: "local://council-run-1-manifest.json" },
	};
}

function rendered(component: { render(width: number): readonly string[] }): string {
	return Bun.stripANSI(component.render(100).join("\n"));
}

describe("CouncilSummaryComponent", () => {
	it("shows bounded provider content immediately, then hydrates durable outcomes and links", async () => {
		const deferred = Promise.withResolvers<CouncilManifest>();
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
		deferred.resolve(hydratedManifest);
		await Promise.resolve();
		await Promise.resolve();
		const hydrated = rendered(component);
		expect(hydrated).toContain("completed-degraded");
		expect(hydrated).toContain("Round 1 settled: council1 failed (2 attempts)");
		expect(hydrated).toContain("Final: plans/final.md");
		expect(hydrated).toMatch(/Warning: council1: warning +with tab/);
		expect(hydrated).toMatch(/Warning: manifest +warning/);
		expect(hydrated).not.toContain("w".repeat(600));
		expect(hydrated).not.toContain("\t");
		expect(hydrated).toContain("~/private/council-summary.log");
		expect(hydrated).not.toContain(os.homedir());
		component.dispose();
	});

	it("sanitizes ANSI, OSC, C0 controls, and tabs in immediate and hydrated dynamic fields", async () => {
		const deferred = Promise.withResolvers<CouncilManifest>();
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
		unsafeManifest.outputPath = `plans/final${controls}.md`;
		unsafeManifest.planVersions = [
			{
				version: 1,
				round: 1,
				kind: "final",
				artifact: { url: `local://final${controls}.md`, sha256: "b".repeat(64), bytes: 1 },
				createdAt: unsafeManifest.timestamps.createdAt,
			},
		];
		deferred.resolve(unsafeManifest);
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
			const component = new CouncilSummaryComponent(message(label), loader, () => {});
			await Promise.resolve();
			await Promise.resolve();
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
		const foreignComponent = new CouncilSummaryComponent(foreign, loader, () => {});
		await Promise.resolve();
		await Promise.resolve();
		expect(rendered(foreignComponent)).toContain("Council summary manifest link is foreign.");
		foreignComponent.dispose();
		const malformed = message("malformed metadata");
		malformed.details!.runId = "..";
		const malformedComponent = new CouncilSummaryComponent(malformed, loader, () => {});
		await Promise.resolve();
		await Promise.resolve();
		expect(rendered(malformedComponent)).toContain("Council summary metadata is malformed.");
		malformedComponent.dispose();
	});

	it("ignores stale hydration generations", async () => {
		const first = Promise.withResolvers<CouncilManifest>();
		const second = Promise.withResolvers<CouncilManifest>();
		let call = 0;
		const component = new CouncilSummaryComponent(
			message(),
			() => (++call === 1 ? first.promise : second.promise),
			() => {},
		);
		component.hydrate();
		second.resolve(manifest("run-2"));
		await Promise.resolve();
		await Promise.resolve();
		first.resolve(manifest("run-stale"));
		await Promise.resolve();
		await Promise.resolve();
		expect(rendered(component)).toContain("local://council-run-2-manifest.json");
		expect(rendered(component)).not.toContain("run-stale");
		component.dispose();
	});

	it("renders the same single card after transcript rebuild without duplicating context", async () => {
		const loader: CouncilSummaryManifestLoader = async () => manifest();
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
});
