import { describe, expect, it } from "bun:test";
import {
	COUNCIL_DISPOSITIONS,
	type CouncilAdjudication,
	type CouncilDisposition,
} from "@oh-my-pi/pi-coding-agent/council/schema";
import type {
	CouncilManifest,
	CouncilRoundMemberRecord,
	CouncilRoundRecord,
	CouncilUsage,
} from "@oh-my-pi/pi-coding-agent/council/state";
import {
	type CouncilRoleStats,
	type CouncilRunStats,
	loadCouncilAdjudications,
	summarizeCouncilRun,
} from "@oh-my-pi/pi-coding-agent/council/stats";

const NOW = "2026-08-05T12:00:00.000Z";
const ROLES = ["security", "testing"] as const;

interface MemberSpec {
	findingIds: string[];
	attempts?: number;
	usage?: CouncilUsage;
}

/** One round's slot state, one entry per roster member in roster order. */
function round(number: number, specs: readonly MemberSpec[]): CouncilRoundRecord {
	return {
		round: number,
		status: "settled",
		startedAt: NOW,
		finishedAt: NOW,
		members: specs.map((spec, order): CouncilRoundMemberRecord => {
			const role = ROLES[order]!;
			const record: CouncilRoundMemberRecord = {
				role,
				order,
				status: "succeeded",
				attempts: spec.attempts ?? 1,
				startedAt: NOW,
				finishedAt: NOW,
				artifact: null,
				resolvedModel: `provider/${role}`,
				authFallbackUsed: false,
				failureReason: null,
				findingIds: spec.findingIds,
			};
			if (spec.usage) record.usage = spec.usage;
			return record;
		}),
	};
}

interface ManifestSpec {
	rounds: CouncilRoundRecord[];
	plannerUsage?: CouncilUsage;
	adjudicatorUsage?: CouncilUsage;
	usage?: CouncilUsage;
}

function manifest(spec: ManifestSpec): CouncilManifest {
	const value: CouncilManifest = {
		version: 2,
		runId: "run-stats",
		sessionId: "session-1",
		mainAgentId: "Main",
		state: "completed",
		task: "Design the change",
		repoRoot: "/repo",
		outputPath: "council-design-the-change-plan.md",
		timestamps: { createdAt: NOW, updatedAt: NOW, startedAt: NOW, finishedAt: NOW },
		config: {
			members: ROLES.map((role, order) => ({ role, enabled: true, order })),
			rounds: 2,
			advisor: { planner: false, reviewers: false, adjudicator: false },
		},
		roster: ROLES.map((role, order) => ({
			role,
			enabled: true,
			order,
			rounds: [1, 2],
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
			effort: "high",
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
			artifact: { url: "local://council-run-stats-instructions.json", sha256: "1".repeat(64), bytes: 64 },
			sha256: "1".repeat(64),
		},
		// Deep-copied: `TWO_ROUNDS` is a module constant and several tests mutate a slot's status, so
		// sharing the array would leak that state into every later test in file order.
		rounds: structuredClone(spec.rounds),
		planVersions: [
			{
				version: 1,
				round: 0,
				kind: "draft",
				artifact: { url: "local://council-run-stats-plan-v1.md", sha256: "2".repeat(64), bytes: 32 },
				createdAt: NOW,
			},
		],
		usage: spec.usage ?? { requests: 0, tokens: 0, cost: 0 },
		adjudicationBudget: { injectedChars: 100, cap: 1_000 },
		warnings: [],
		degraded: false,
	};
	if (spec.plannerUsage) value.plannerUsage = spec.plannerUsage;
	if (spec.adjudicatorUsage) value.adjudicatorUsage = spec.adjudicatorUsage;
	return value;
}

function adjudication(dispositions: ReadonlyArray<[string, CouncilDisposition, string?]>): CouncilAdjudication {
	return {
		plan: "# Plan",
		dispositions: dispositions.map(([id, disposition, duplicateOf]) => ({
			id,
			disposition,
			reason: `${id} ${disposition}`,
			step: "Step 1",
			...(duplicateOf ? { duplicateOf } : {}),
		})),
	};
}

/** Every disposition key that is not listed, so a stray tally cannot hide behind a spot check. */
function zeroExcept(expected: Partial<Record<CouncilDisposition, number>>): Record<CouncilDisposition, number> {
	const tally = {} as Record<CouncilDisposition, number>;
	for (const disposition of COUNCIL_DISPOSITIONS) tally[disposition] = expected[disposition] ?? 0;
	return tally;
}

function roleOf(stats: CouncilRunStats, key: string): CouncilRoleStats {
	const role = stats.roles.find(candidate => candidate.key === key);
	expect(role).toBeDefined();
	return role!;
}

const TWO_ROUNDS: CouncilRoundRecord[] = [
	round(1, [{ findingIds: ["A1", "A2"] }, { findingIds: ["B1", "B2"] }]),
	round(2, [{ findingIds: ["A3", "A4"] }, { findingIds: ["B3", "B4"] }]),
];

const ROUND_ONE_ADJUDICATION = adjudication([
	["A1", "accepted"],
	["A2", "rejected"],
	["B1", "accepted"],
	["B2", "rejected"],
]);

describe("summarizeCouncilRun", () => {
	it("tallies both rounds' dispositions under the reviewer that raised them", () => {
		const stats = summarizeCouncilRun(
			manifest({ rounds: TWO_ROUNDS }),
			new Map([
				[1, ROUND_ONE_ADJUDICATION],
				[
					2,
					adjudication([
						["A3", "accepted"],
						["A4", "rejected"],
						["B3", "accepted"],
						["B4", "accepted with modification"],
					]),
				],
			]),
		);

		expect(stats.rounds).toBe(2);
		// Two rounds, two roster members: two reviewers, not four member-rounds.
		expect(stats.reviewersTotal).toBe(2);
		expect(stats.reviewersSucceeded).toBe(2);
		expect(stats.roles.map(role => role.key)).toEqual(["planner", "security", "testing", "adjudicator"]);

		const security = roleOf(stats, "security");
		expect(security.findings).toBe(4);
		expect(security.dispositions).toEqual(zeroExcept({ accepted: 2, rejected: 2 }));

		const testing = roleOf(stats, "testing");
		expect(testing.findings).toBe(4);
		expect(testing.dispositions).toEqual(zeroExcept({ accepted: 2, rejected: 1, "accepted with modification": 1 }));
	});

	it("folds a round-two duplicate into the outcome its canonical round-one finding got", () => {
		const roundOneOnly = summarizeCouncilRun(
			manifest({ rounds: TWO_ROUNDS }),
			new Map([[1, ROUND_ONE_ADJUDICATION]]),
		);
		expect(roleOf(roundOneOnly, "testing").dispositions).toEqual(zeroExcept({ accepted: 1, rejected: 1 }));

		const stats = summarizeCouncilRun(
			manifest({ rounds: TWO_ROUNDS }),
			new Map([
				[1, ROUND_ONE_ADJUDICATION],
				[
					2,
					adjudication([
						["A3", "accepted"],
						["A4", "rejected"],
						["B3", "accepted"],
						// Round two restates a finding Main already accepted from round one.
						["B4", "duplicate", "A1"],
					]),
				],
			]),
		);

		const testing = roleOf(stats, "testing");
		// `duplicate` is never a bucket of its own: A1 was accepted, so its restatement counts as
		// accepted rather than as a third kind of outcome nobody can act on.
		expect(testing.dispositions).toEqual(zeroExcept({ accepted: 3, rejected: 1 }));
		// The round-one accepted/rejected pair survives untouched beneath the round-two findings.
		expect(testing.dispositions.rejected).toBe(roleOf(roundOneOnly, "testing").dispositions.rejected);
		expect(roleOf(stats, "security").dispositions).toEqual(zeroExcept({ accepted: 2, rejected: 2 }));
	});

	it("folds a duplicate of a rejected finding into rejected, not accepted", () => {
		const stats = summarizeCouncilRun(
			manifest({ rounds: TWO_ROUNDS }),
			new Map([
				[1, ROUND_ONE_ADJUDICATION],
				[
					2,
					adjudication([
						["A3", "accepted"],
						["A4", "rejected"],
						["B3", "accepted"],
						["B4", "duplicate", "A2"],
					]),
				],
			]),
		);

		expect(roleOf(stats, "testing").dispositions).toEqual(zeroExcept({ accepted: 2, rejected: 2 }));
	});

	it("sums a schema-retried member's attempts and reports the adjudicator's own charge", () => {
		const stats = summarizeCouncilRun(
			manifest({
				plannerUsage: { requests: 1, tokens: 1_000, cost: 0.01 },
				adjudicatorUsage: { requests: 2, tokens: 4_000, cost: 0.04 },
				rounds: [
					round(1, [
						{ findingIds: ["A1"], usage: { requests: 1, tokens: 500, cost: 0.005 } },
						// One slot, two attempts: the schema retry's charge is already folded in.
						{ findingIds: ["B1"], attempts: 2, usage: { requests: 2, tokens: 900, cost: 0.009 } },
					]),
					round(2, [
						{ findingIds: ["A2"], usage: { requests: 1, tokens: 300, cost: 0.003 } },
						{ findingIds: ["B2"], usage: { requests: 1, tokens: 200, cost: 0.002 } },
					]),
				],
			}),
		);

		expect(roleOf(stats, "planner").usage).toEqual({ requests: 1, tokens: 1_000, cost: 0.01 });
		expect(roleOf(stats, "security").attempts).toBe(2);
		expect(roleOf(stats, "security").usage).toEqual({ requests: 2, tokens: 800, cost: 0.008 });

		const testing = roleOf(stats, "testing");
		expect(testing.attempts).toBe(3);
		expect(testing.usage.requests).toBe(3);
		expect(testing.usage.tokens).toBe(1_100);
		expect(testing.usage.cost).toBeCloseTo(0.011, 10);

		const adjudicator = roleOf(stats, "adjudicator");
		expect(adjudicator.kind).toBe("adjudicator");
		expect(adjudicator.model).toBe("provider/main");
		expect(adjudicator.status).toBe("succeeded");
		expect(adjudicator.attempts).toBe(2);
		expect(adjudicator.usage).toEqual({ requests: 2, tokens: 4_000, cost: 0.04 });
	});

	it("reads a delegated adjudicator's advisor and attempts from the manifest, ignoring the live-session option", () => {
		// Advisor traffic is folded into the same bucket as the principal, so a delegated
		// `adjudicatorUsage.requests` counts child *and* advisor requests and is not an attempt count.
		const delegated = manifest({
			rounds: TWO_ROUNDS,
			adjudicatorUsage: { requests: 7, tokens: 900, cost: 0.5 },
		});
		delegated.adjudicator = {
			mode: "delegated",
			requestedSelector: "@adjudicator",
			resolvedModel: "provider/adjudicator",
			effort: "high",
			advisor: false,
			capturedAt: NOW,
			agentIds: ["Counciladjudicatorr1"],
		};

		// The caller's own session has an advisor attached; that says nothing about the child.
		const stats = summarizeCouncilRun(delegated, new Map([[1, ROUND_ONE_ADJUDICATION]]), {
			adjudicatorAdvisor: true,
		});

		const adjudicator = roleOf(stats, "adjudicator");
		expect(adjudicator.advisor).toBe(false);
		expect(adjudicator.attempts).toBe(1);
		expect(adjudicator.model).toBe("provider/adjudicator");
		expect(adjudicator.effort).toBe("high");
		// The inflated bucket still lands whole, so role rows reconcile against the run total.
		expect(adjudicator.usage).toEqual({ requests: 7, tokens: 900, cost: 0.5 });
		expect(stats.total.requests).toBe(7);
		expect(stats.total.cost).toBeCloseTo(0.5, 10);
	});

	it("totals every role bucket, so the adjudicator's charge is visible where manifest.usage omitted it", () => {
		const withoutAdjudicator: CouncilUsage = { requests: 6, tokens: 2_900, cost: 0.029 };
		const stats = summarizeCouncilRun(
			manifest({
				plannerUsage: { requests: 1, tokens: 1_000, cost: 0.01 },
				adjudicatorUsage: { requests: 2, tokens: 4_000, cost: 0.04 },
				usage: withoutAdjudicator,
				rounds: [
					round(1, [
						{ findingIds: ["A1"], usage: { requests: 1, tokens: 500, cost: 0.005 } },
						{ findingIds: ["B1"], attempts: 2, usage: { requests: 2, tokens: 900, cost: 0.009 } },
					]),
					round(2, [
						{ findingIds: ["A2"], usage: { requests: 1, tokens: 300, cost: 0.003 } },
						{ findingIds: ["B2"], usage: { requests: 1, tokens: 200, cost: 0.002 } },
					]),
				],
			}),
		);

		// 1 + 2 + 3 + 2 requests, 1000 + 800 + 1100 + 4000 tokens, 0.01 + 0.008 + 0.011 + 0.04 cost.
		expect(stats.total.requests).toBe(8);
		expect(stats.total.tokens).toBe(6_900);
		expect(stats.total.cost).toBeCloseTo(0.069, 10);

		const summed = stats.roles.reduce(
			(accumulator, role) => ({
				requests: accumulator.requests + role.usage.requests,
				tokens: accumulator.tokens + role.usage.tokens,
				cost: accumulator.cost + role.usage.cost,
			}),
			{ requests: 0, tokens: 0, cost: 0 },
		);
		expect(stats.total.requests).toBe(summed.requests);
		expect(stats.total.tokens).toBe(summed.tokens);
		expect(stats.total.cost).toBeCloseTo(summed.cost, 10);

		expect(stats.total.requests).not.toBe(withoutAdjudicator.requests);
		expect(stats.total.tokens).not.toBe(withoutAdjudicator.tokens);
		expect(stats.total.tokens - withoutAdjudicator.tokens).toBe(4_000);
	});

	it("degrades to findings-only counts when no adjudication is readable", () => {
		const stats = summarizeCouncilRun(manifest({ rounds: TWO_ROUNDS }), new Map());

		const security = roleOf(stats, "security");
		expect(security.findings).toBe(4);
		expect(security.dispositions).toEqual(zeroExcept({}));
		const testing = roleOf(stats, "testing");
		expect(testing.findings).toBe(4);
		expect(testing.dispositions).toEqual(zeroExcept({}));
		expect(stats.reviewersTotal).toBe(2);
	});

	it("reports zeroed buckets for a manifest written before per-role accounting", () => {
		const stats = summarizeCouncilRun(
			manifest({ rounds: TWO_ROUNDS, usage: { requests: 9, tokens: 99, cost: 0.9 } }),
		);

		for (const role of stats.roles) {
			expect(role.usage).toEqual({ requests: 0, tokens: 0, cost: 0 });
		}
		expect(roleOf(stats, "adjudicator").attempts).toBe(0);
		expect(stats.total).toEqual({ requests: 0, tokens: 0, cost: 0 });
		expect(stats.outputPath).toBe("council-design-the-change-plan.md");
		expect(stats.state).toBe("completed");
		expect(stats.degraded).toBe(false);
		expect(stats.warnings).toEqual([]);
	});

	it("counts one reviewer per roster member however many rounds they ran", () => {
		const roles = ["security", "testing", "docs"] as const;
		const base = manifest({ rounds: [] });
		const threeMembers: CouncilManifest = {
			...base,
			config: {
				members: roles.map((role, order) => ({ role, enabled: true, order })),
				rounds: 2,
				advisor: { planner: false, reviewers: false, adjudicator: false },
			},
			roster: roles.map((role, order) => ({
				role,
				enabled: true,
				order,
				rounds: [1, 2],
				advisor: false,
				requestedSelector: "member",
				resolvedModel: `provider/${role}`,
				effort: null,
				lens: "correctness",
			})),
			rounds: [1, 2].map(number => ({
				round: number,
				status: "settled" as const,
				startedAt: NOW,
				finishedAt: NOW,
				members: roles.map(
					(role, order): CouncilRoundMemberRecord => ({
						role,
						order,
						status: "succeeded",
						attempts: 1,
						startedAt: NOW,
						finishedAt: NOW,
						artifact: null,
						resolvedModel: `provider/${role}`,
						authFallbackUsed: false,
						failureReason: null,
						findingIds: [],
					}),
				),
			})),
		};

		const stats = summarizeCouncilRun(threeMembers);
		expect(stats.rounds).toBe(2);
		expect(stats.reviewersTotal).toBe(3);
		expect(stats.reviewersSucceeded).toBe(3);
	});

	it("does not count a reviewer as succeeded when only one of its rounds succeeded", () => {
		const mixed = manifest({ rounds: TWO_ROUNDS });
		mixed.rounds[1]!.members[0]!.status = "failed";
		mixed.rounds[1]!.members[0]!.failureReason = "second round failed";

		const stats = summarizeCouncilRun(mixed);
		expect(stats.reviewersTotal).toBe(2);
		expect(stats.reviewersSucceeded).toBe(1);
		expect(roleOf(stats, "security").status).toBe("failed");
	});

	it("carries the adjudicator's rank per reviewer, letting the newest graded round win", () => {
		const graded = summarizeCouncilRun(
			manifest({ rounds: TWO_ROUNDS }),
			new Map([
				[1, { ...ROUND_ONE_ADJUDICATION, grades: [{ slot: 1, grade: "C" as const, reason: "thin" }] }],
				[
					2,
					{
						...adjudication([
							["A3", "accepted"],
							["A4", "rejected"],
							["B3", "accepted"],
							["B4", "rejected"],
						]),
						grades: [
							{ slot: 1, grade: "S" as const, reason: "found the critical defect" },
							{ slot: 2, grade: "B" as const, reason: "useful improvements" },
						],
					},
				],
			]),
		);

		// Slot 1 is the first roster member; its round-two `S` supersedes the round-one `C`.
		expect(roleOf(graded, "security").grade).toBe("S");
		expect(roleOf(graded, "testing").grade).toBe("B");
		expect(roleOf(graded, "planner").grade).toBeUndefined();
		expect(roleOf(graded, "adjudicator").grade).toBeUndefined();
	});

	it("keys grades by roster index, so a disabled member ahead of a reviewer cannot misaddress its rank", () => {
		// A disabled member occupies config order 0, leaving the one enabled reviewer at order 1 while
		// it is still the first (and only) roster entry, i.e. slot 1. Reading `order + 1` would send
		// slot 2's grade to it and drop slot 1's on the floor.
		const skewed = manifest({ rounds: [round(1, [{ findingIds: ["A1", "A2"] }])] });
		skewed.config.rounds = 1;
		skewed.config.members = [
			{ role: "skipped", enabled: false, order: 0 },
			{ role: "security", enabled: true, order: 1 },
		];
		skewed.roster = [{ ...skewed.roster[0]!, order: 1, rounds: [1] }];
		skewed.rounds[0]!.members[0]!.order = 1;

		const stats = summarizeCouncilRun(
			skewed,
			new Map([
				[
					1,
					{
						...ROUND_ONE_ADJUDICATION,
						grades: [
							{ slot: 1, grade: "A" as const, reason: "caught the auth bypass" },
							{ slot: 2, grade: "D" as const, reason: "addressed to a slot nobody occupies" },
						],
					},
				],
			]),
		);

		expect(stats.roles.filter(role => role.kind === "reviewer").map(role => role.key)).toEqual(["security"]);
		expect(roleOf(stats, "security").grade).toBe("A");
	});

	it("grades a reviewer that never finished as F, whatever the adjudicator said", () => {
		const mixed = manifest({ rounds: TWO_ROUNDS });
		mixed.rounds[1]!.members[0]!.status = "failed";
		mixed.rounds[1]!.members[0]!.failureReason = "second round failed";

		const stats = summarizeCouncilRun(
			mixed,
			new Map([[1, { ...ROUND_ONE_ADJUDICATION, grades: [{ slot: 1, grade: "A" as const, reason: "solid" }] }]]),
		);

		expect(roleOf(stats, "security").grade).toBe("F");
	});

	it("leaves reviewers unranked for a run adjudicated before grading existed", () => {
		const stats = summarizeCouncilRun(manifest({ rounds: TWO_ROUNDS }), new Map([[1, ROUND_ONE_ADJUDICATION]]));
		expect(roleOf(stats, "security").grade).toBeUndefined();
		expect(roleOf(stats, "testing").grade).toBeUndefined();
	});

	it("measures the run from launch to settle, falling back to the last update while it moves", () => {
		const settled = manifest({ rounds: TWO_ROUNDS });
		settled.timestamps.startedAt = "2026-08-05T12:00:00.000Z";
		settled.timestamps.finishedAt = "2026-08-05T12:01:23.000Z";
		// A later `updatedAt` must not extend a settled run: the settle time is the end.
		settled.timestamps.updatedAt = "2026-08-05T13:00:00.000Z";
		expect(summarizeCouncilRun(settled).durationMs).toBe(83_000);

		const running = manifest({ rounds: TWO_ROUNDS });
		running.state = "reviewing";
		running.timestamps.startedAt = "2026-08-05T12:00:00.000Z";
		delete running.timestamps.finishedAt;
		running.timestamps.updatedAt = "2026-08-05T12:00:30.000Z";
		expect(summarizeCouncilRun(running).durationMs).toBe(30_000);

		// No start recorded: the run is measured from when it was created, never negatively.
		const unstarted = manifest({ rounds: TWO_ROUNDS });
		unstarted.timestamps.createdAt = "2026-08-05T12:00:00.000Z";
		delete unstarted.timestamps.startedAt;
		unstarted.timestamps.finishedAt = "2026-08-05T11:59:00.000Z";
		expect(summarizeCouncilRun(unstarted).durationMs).toBe(0);
	});

	it("keeps the adjudication credited while the plan is being written out", () => {
		const publishing = manifest({ rounds: TWO_ROUNDS, adjudicatorUsage: { requests: 1, tokens: 10, cost: 0.001 } });
		publishing.state = "publishing";

		expect(roleOf(summarizeCouncilRun(publishing), "adjudicator").status).toBe("succeeded");
	});

	it("flags unreadable dispositions only when findings exist and the read threw", () => {
		const withFindings = manifest({ rounds: TWO_ROUNDS });
		expect(
			summarizeCouncilRun(withFindings, new Map(), { adjudicationsUnreadable: true }).dispositionsUnavailable,
		).toBe(true);
		// A readable adjudication that simply had nothing to say yet is not corruption.
		expect(summarizeCouncilRun(withFindings, new Map()).dispositionsUnavailable).toBeUndefined();
		// Neither is a run that raised no findings at all.
		const noFindings = manifest({ rounds: [round(1, [{ findingIds: [] }, { findingIds: [] }])] });
		expect(
			summarizeCouncilRun(noFindings, new Map(), { adjudicationsUnreadable: true }).dispositionsUnavailable,
		).toBeUndefined();
	});

	it("names roles in warning rows by their stable label, never by the durable id", () => {
		const degraded = manifest({ rounds: TWO_ROUNDS });
		degraded.roster[0]!.role = "council1";
		for (const councilRound of degraded.rounds) {
			const member = councilRound.members[0]!;
			member.role = "council1";
			member.authFallbackUsed = true;
		}
		degraded.rounds[1]!.members[0]!.failureReason = "provider refused the request";

		const stats = summarizeCouncilRun(degraded);
		expect(stats.warnings).toContain("Reviewer 1 used an authentication fallback");
		expect(stats.warnings).toContain("Reviewer 1 round 2: provider refused the request");
		expect(stats.warnings.some(warning => warning.includes("council1"))).toBeFalse();
		// The role key stays the durable id: it addresses the roster, not the operator.
		expect(stats.roles.map(role => role.key)).toContain("council1");
		expect(roleOf(stats, "council1").label).toBe("Reviewer 1");
	});
});

describe("loadCouncilAdjudications", () => {
	it("degrades a throwing read to an empty map and reports that it degraded", async () => {
		const load = await loadCouncilAdjudications(
			{
				readAdjudications: async () => {
					throw new Error("artifact is semantically invalid");
				},
			},
			manifest({ rounds: TWO_ROUNDS }),
		);

		expect(load.unreadable).toBe(true);
		expect(load.adjudications.size).toBe(0);
	});

	it("passes a successful read through untouched", async () => {
		const load = await loadCouncilAdjudications(
			{ readAdjudications: async () => new Map([[1, ROUND_ONE_ADJUDICATION]]) },
			manifest({ rounds: TWO_ROUNDS }),
		);

		expect(load.unreadable).toBe(false);
		expect(load.adjudications.get(1)).toBe(ROUND_ONE_ADJUDICATION);
	});
});
