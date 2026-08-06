import { describe, expect, it } from "bun:test";
import { sha256CouncilContent } from "@oh-my-pi/pi-coding-agent/council/hash";
import {
	type CouncilManifest,
	CouncilManifestError,
	isCouncilResumeCompatible,
	normalizeRecoveredCouncilManifest,
	parseCouncilInstructionSnapshot,
	parseCouncilManifest,
} from "@oh-my-pi/pi-coding-agent/council/state";

const now = "2026-08-05T12:00:00.000Z";
const instructionPath = "/repo/AGENTS.md";
const instructionContent = "Council rules";

function instructionSnapshot() {
	return {
		repoRoot: "/repo",
		contextFiles: [{ path: instructionPath, content: instructionContent, depth: 0 }],
		files: [{ path: instructionPath, sha256: sha256CouncilContent(instructionContent) }],
		totalBytes: Buffer.byteLength(instructionContent),
	};
}

function manifest(): CouncilManifest {
	return {
		version: 1,
		runId: "run-1",
		sessionId: "session-1",
		mainAgentId: "Main",
		state: "reviewing",
		task: "Review the implementation",
		repoRoot: "/repo",
		outputPath: "plans/review-the-implementation.md",
		timestamps: { createdAt: now, updatedAt: now, startedAt: now },
		config: { rounds: 1, members: [{ role: "council1", enabled: true, order: 0 }] },
		roster: [
			{
				role: "council1",
				enabled: true,
				order: 0,
				requestedSelector: "openai/gpt-5.6-sol:max",
				resolvedModel: "openai/gpt-5.6-sol:max",
				effort: "max",
				lens: "Adversarial correctness",
			},
		],
		planner: {
			requestedSelector: "openai/gpt-5.6-sol:max",
			resolvedModel: "openai/gpt-5.6-sol:max",
			effort: "max",
		},
		mainSnapshot: { model: "anthropic/claude-opus-4.1:high", effort: "high", capturedAt: now },
		instructionSnapshot: {
			artifact: {
				url: "local://council-run-1-instructions.json",
				sha256: "1".repeat(64),
				bytes: 256,
			},
			sha256: "1".repeat(64),
		},
		rounds: [
			{
				round: 1,
				status: "running",
				startedAt: now,
				finishedAt: null,
				members: [
					{
						role: "council1",
						order: 0,
						status: "running",
						attempts: 1,
						startedAt: now,
						finishedAt: null,
						artifact: null,
						resolvedModel: "openai/gpt-5.6-sol:max",
						authFallbackUsed: false,
						failureReason: null,
						findingIds: [],
					},
				],
			},
		],
		planVersions: [
			{
				version: 1,
				round: 0,
				kind: "draft",
				artifact: { url: "local://council-run-1-draft.md", sha256: "a".repeat(64), bytes: 5 },
				createdAt: now,
			},
		],
		usage: { requests: 2, tokens: 100, cost: 0.25 },
		adjudicationBudget: { injectedChars: 100, cap: 1_000 },
		warnings: [],
		degraded: false,
	};
}

function completedManifest(): CouncilManifest {
	const value = manifest();
	const member = value.rounds[0]!.members[0]!;
	member.status = "succeeded";
	member.finishedAt = now;
	member.artifact = { url: "local://council-run-1-round1-council1.md", sha256: "b".repeat(64), bytes: 7 };
	member.findingIds = ["finding-1"];
	const round = value.rounds[0]!;
	round.status = "settled";
	round.finishedAt = now;
	value.planVersions.push({
		version: 2,
		round: 1,
		kind: "final",
		artifact: { url: "local://council-run-1-round1.md", sha256: "c".repeat(64), bytes: 11 },
		createdAt: now,
	});
	value.published = {
		path: value.outputPath,
		sha256: "d".repeat(64),
		bytes: 11,
		publishedAt: now,
	};
	value.state = "completed";
	value.timestamps.finishedAt = now;
	return value;
}

function twoRoundManifest(): CouncilManifest {
	const value = manifest();
	value.config.rounds = 2;
	value.rounds.push({
		round: 2,
		status: "pending",
		startedAt: null,
		finishedAt: null,
		members: [
			{
				role: "council1",
				order: 0,
				status: "pending",
				attempts: 0,
				startedAt: null,
				finishedAt: null,
				artifact: null,
				resolvedModel: null,
				authFallbackUsed: false,
				failureReason: null,
				findingIds: [],
			},
		],
	});
	return value;
}

function expectCorrupt(value: unknown, field: string): void {
	try {
		parseCouncilManifest(JSON.parse(JSON.stringify(value)));
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(CouncilManifestError);
		expect((error as CouncilManifestError).field).toContain(field);
	}
}

describe("council manifest strict parsing", () => {
	it("accepts a complete durable identity and rejects valid-JSON omissions at every nested layer", () => {
		expect(parseCouncilManifest(manifest())).toEqual(manifest());
		const omissions: Array<[string, (value: CouncilManifest) => void]> = [
			["planner.effort", value => Reflect.deleteProperty(value.planner, "effort")],
			["mainSnapshot.effort", value => Reflect.deleteProperty(value.mainSnapshot, "effort")],
			["roster[0].lens", value => Reflect.deleteProperty(value.roster[0]!, "lens")],
			["config.members[0].enabled", value => Reflect.deleteProperty(value.config.members[0]!, "enabled")],
			["rounds[0].startedAt", value => Reflect.deleteProperty(value.rounds[0]!, "startedAt")],
			["rounds[0].members[0].startedAt", value => Reflect.deleteProperty(value.rounds[0]!.members[0]!, "startedAt")],
			["usage.requests", value => Reflect.deleteProperty(value.usage, "requests")],
			["adjudicationBudget.cap", value => Reflect.deleteProperty(value.adjudicationBudget, "cap")],
			["warnings", value => Reflect.deleteProperty(value, "warnings")],
		];
		for (const [field, mutate] of omissions) {
			const value = manifest();
			mutate(value);
			expectCorrupt(value, field);
		}
	});

	it("round-trips dispatch warnings and rejects malformed warning entries", () => {
		const value = manifest();
		value.warnings = ["Council roles first and second resolve to the same model."];
		value.degraded = true;

		const parsed = parseCouncilManifest(JSON.parse(JSON.stringify(value)));
		expect(parsed.warnings).toEqual(value.warnings);

		(parsed as { warnings: unknown }).warnings = [""];
		expect(() => parseCouncilManifest(parsed)).toThrow("warnings[0]");
	});

	it("rejects unknown keys at the root and every representative nested object", () => {
		const cases: Array<[string, (value: CouncilManifest) => object]> = [
			["root.extra", value => value],
			["timestamps.extra", value => value.timestamps],
			[
				"published.extra",
				value => {
					value.published = { path: value.outputPath, sha256: "d".repeat(64), bytes: 1, publishedAt: now };
					return value.published;
				},
			],
			["config.extra", value => value.config],
			["config.members[0].extra", value => value.config.members[0]!],
			["roster[0].extra", value => value.roster[0]!],
			["planner.extra", value => value.planner],
			["mainSnapshot.extra", value => value.mainSnapshot],
			["instructionSnapshot.extra", value => value.instructionSnapshot],
			["instructionSnapshot.artifact.extra", value => value.instructionSnapshot.artifact],
			["rounds[0].extra", value => value.rounds[0]!],
			["rounds[0].members[0].extra", value => value.rounds[0]!.members[0]!],
			[
				"rounds[0].members[0].artifact.extra",
				value => {
					value.rounds[0]!.members[0]!.artifact = {
						url: "local://council-run-1-member.md",
						sha256: "e".repeat(64),
						bytes: 1,
					};
					return value.rounds[0]!.members[0]!.artifact!;
				},
			],
			["planVersions[0].extra", value => value.planVersions[0]!],
			["usage.extra", value => value.usage],
			["adjudicationBudget.extra", value => value.adjudicationBudget],
			[
				"failure.extra",
				value => {
					value.failure = { phase: "review", reason: "stopped", code: "STOPPED", time: now };
					return value.failure;
				},
			],
		];
		for (const [field, target] of cases) {
			const value = manifest();
			Object.assign(target(value), { extra: true });
			expectCorrupt(value, field);
		}
	});

	it("rejects invalid timestamps, counts, ordering, plan kinds, and status metadata", () => {
		const cases: Array<[string, (value: CouncilManifest) => void]> = [
			["timestamps.createdAt", value => (value.timestamps.createdAt = "2026-02-31T12:00:00.000Z")],
			["attempts", value => (value.rounds[0]!.members[0]!.attempts = 1.5)],
			["roster[0]", value => (value.roster[0]!.order = 1)],
			["rounds[0].round", value => (value.rounds[0]!.round = 2)],
			[
				"planVersions[0].kind",
				value => Object.defineProperty(value.planVersions[0]!, "kind", { value: "revision" }),
			],
			[
				"rounds[0].members[0]",
				value => {
					value.rounds[0]!.members[0]!.status = "succeeded";
					value.rounds[0]!.members[0]!.finishedAt = now;
				},
			],
		];
		for (const [field, mutate] of cases) {
			const value = manifest();
			mutate(value);
			expectCorrupt(value, field);
		}
	});

	it("rejects terminal runs with active children", () => {
		const value = manifest();
		value.state = "completed";
		value.timestamps.finishedAt = now;
		expectCorrupt(value, "rounds");
	});

	it("accepts only canonical plan-version prefixes", () => {
		expect(parseCouncilManifest(twoRoundManifest()).planVersions).toHaveLength(1);

		const missingDraft = manifest();
		missingDraft.planVersions = [{ ...missingDraft.planVersions[0]!, round: 1, kind: "final" }];
		expectCorrupt(missingDraft, "planVersions[0]");

		const duplicateDraft = manifest();
		duplicateDraft.planVersions.push({ ...duplicateDraft.planVersions[0]!, version: 2 });
		expectCorrupt(duplicateDraft, "planVersions[1]");

		const duplicateRound = twoRoundManifest();
		duplicateRound.planVersions.push(
			{ ...duplicateRound.planVersions[0]!, version: 2, round: 1, kind: "round" },
			{ ...duplicateRound.planVersions[0]!, version: 3, round: 1, kind: "round" },
		);
		expectCorrupt(duplicateRound, "planVersions[2]");

		const roundTwoBeforeRoundOne = twoRoundManifest();
		roundTwoBeforeRoundOne.planVersions.push({
			...roundTwoBeforeRoundOne.planVersions[0]!,
			version: 2,
			round: 2,
			kind: "round",
		});
		expectCorrupt(roundTwoBeforeRoundOne, "planVersions[1]");

		const finalAtWrongPosition = twoRoundManifest();
		finalAtWrongPosition.planVersions.push({
			...finalAtWrongPosition.planVersions[0]!,
			version: 2,
			round: 1,
			kind: "final",
		});
		expectCorrupt(finalAtWrongPosition, "planVersions[1]");
	});
	it("accepts only durably published completed manifests", () => {
		expect(parseCouncilManifest(completedManifest())).toEqual(completedManifest());

		const unsettled = completedManifest();
		unsettled.rounds[0]!.status = "interrupted";
		expectCorrupt(unsettled, "rounds");

		const noFinal = completedManifest();
		noFinal.planVersions.pop();
		expectCorrupt(noFinal, "planVersions");

		const unpublished = completedManifest();
		Reflect.deleteProperty(unpublished, "published");
		expectCorrupt(unpublished, "published");

		const wrongPublication = completedManifest();
		wrongPublication.published!.path = "plans/wrong-output.md";
		expectCorrupt(wrongPublication, "published.path");
	});

	it("rejects succeeded members that violate their pinned roster identity", () => {
		const fallback = completedManifest();
		fallback.rounds[0]!.members[0]!.authFallbackUsed = true;
		expectCorrupt(fallback, "authFallbackUsed");

		const modelDrift = completedManifest();
		modelDrift.rounds[0]!.members[0]!.resolvedModel = "other/provider-model";
		expectCorrupt(modelDrift, "resolvedModel");
	});

	it("validates instruction artifact identity and parses canonical snapshot contents", () => {
		const referenceTamper = manifest();
		referenceTamper.instructionSnapshot.sha256 = "2".repeat(64);
		expectCorrupt(referenceTamper, "instructionSnapshot.sha256");

		const contentTamper = instructionSnapshot();
		contentTamper.contextFiles[0]!.content = "tampered";
		expect(() => parseCouncilInstructionSnapshot(contentTamper, "/repo")).toThrow("sha256");

		const byteTamper = instructionSnapshot();
		byteTamper.totalBytes++;
		expect(() => parseCouncilInstructionSnapshot(byteTamper, "/repo")).toThrow("totalBytes");

		const pathTamper = instructionSnapshot();
		pathTamper.files[0]!.path = "/repo/OTHER.md";
		expect(() => parseCouncilInstructionSnapshot(pathTamper, "/repo")).toThrow("path");

		const rootTamper = instructionSnapshot();
		rootTamper.repoRoot = "/other";
		expect(() => parseCouncilInstructionSnapshot(rootTamper, "/repo")).toThrow("repoRoot");
	});

	it("enforces direct bounded lowercase-kebab promised output paths", () => {
		for (const outputPath of [
			"plans/plan.md",
			"plans/review-plan.md",
			"plans/Review.md",
			"plans/nested/review.md",
			"plans\\review.md",
			`plans/${"a".repeat(81)}.md`,
		]) {
			const value = manifest();
			value.outputPath = outputPath;
			expectCorrupt(value, "outputPath");
		}
		const value = manifest();
		value.outputPath = `plans/${"a".repeat(80)}.md`;
		expect(parseCouncilManifest(value).outputPath).toBe(value.outputPath);
	});

	it("requires every captured instruction path to be absolute, normalized, and repository-contained", () => {
		for (const candidatePath of ["AGENTS.md", "/repo/nested/../AGENTS.md", "/other/AGENTS.md"]) {
			const value = instructionSnapshot();
			value.contextFiles[0]!.path = candidatePath;
			value.files[0]!.path = candidatePath;
			expect(() => parseCouncilInstructionSnapshot(value, "/repo")).toThrow("path");
		}
	});
});

describe("council recovery and resume identity", () => {
	it("uses one interrupted timestamp for the run, active round, and active member and preserves terminal runs", () => {
		const interruptedAt = "2026-08-05T12:05:00.000Z";
		const recovered = normalizeRecoveredCouncilManifest(parseCouncilManifest(manifest()), interruptedAt);
		expect(recovered).toMatchObject({
			state: "interrupted",
			timestamps: { updatedAt: interruptedAt, finishedAt: interruptedAt, interruptedAt },
		});
		expect(recovered.rounds[0]).toMatchObject({ status: "interrupted", finishedAt: interruptedAt });
		expect(recovered.rounds[0]!.members[0]).toMatchObject({ status: "interrupted", finishedAt: interruptedAt });
		expect(parseCouncilManifest(recovered)).toEqual(recovered);
		expect(normalizeRecoveredCouncilManifest(recovered, "2026-08-05T12:10:00.000Z")).toEqual(recovered);
	});

	it("compares member and planner identity while intentionally excluding Main", () => {
		const persisted = manifest();
		const identity = { roster: structuredClone(persisted.roster), planner: structuredClone(persisted.planner) };
		persisted.mainSnapshot.model = "openai/gpt-6:new-main";
		persisted.mainSnapshot.effort = null;
		expect(isCouncilResumeCompatible(persisted, identity)).toBeTrue();

		for (const field of ["role", "order", "requestedSelector", "resolvedModel", "effort", "lens"] as const) {
			const incompatible = structuredClone(identity);
			const member = incompatible.roster[0]!;
			if (field === "order") member.order++;
			else if (field === "effort") member.effort = null;
			else member[field] = `${member[field]}-changed`;
			expect(isCouncilResumeCompatible(persisted, incompatible)).toBeFalse();
		}

		for (const field of ["requestedSelector", "resolvedModel", "effort"] as const) {
			const incompatible = structuredClone(identity);
			if (field === "effort") incompatible.planner.effort = null;
			else incompatible.planner[field] = `${incompatible.planner[field]}-changed`;
			expect(isCouncilResumeCompatible(persisted, incompatible)).toBeFalse();
		}
	});
});
