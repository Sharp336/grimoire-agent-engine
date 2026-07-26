import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "../session/session-entries";
import {
	assertMissionStateInvariants,
	canAcceptPendingHandoff,
	loadMissionState,
	MissionStateError,
	nextMissionFeature,
	validateMissionPlan,
} from "./state";
import type { MissionFeature, MissionHandoff, MissionPlan, MissionState, MissionValidatorHandoff } from "./types";
import { MISSION_PROGRESS_CUSTOM_TYPE, MISSION_STATE_CUSTOM_TYPE } from "./types";

const workerHandoff: MissionHandoff = {
	kind: "implementation",
	outcome: "success",
	summary: "done",
	implementation: [],
	remaining: [],
	verification: { commands: [], interactiveChecks: [] },
	tests: { added: [], coverageNotes: [] },
	issues: [],
	skillDeviations: [],
	commits: [],
};

function implementation(id: string, status: MissionFeature["status"] = "pending"): MissionFeature {
	return {
		id,
		description: id,
		milestoneId: "milestone",
		preconditions: [],
		expectedBehavior: [id],
		kind: "implementation",
		status,
		workerSessionIds: [],
		retryBudgetUsed: 0,
	};
}

function state(overrides: Partial<MissionState> = {}): MissionState {
	return {
		version: 1,
		id: "mission",
		ownerSessionId: "owner",
		revision: 1,
		goal: "goal",
		autoAccept: false,
		status: "running",
		runbook: { setup: [], services: [], userTests: [] },
		milestones: [],
		features: [],
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function stateEntry(data: unknown): SessionEntry {
	return {
		type: "custom",
		id: "state",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: MISSION_STATE_CUSTOM_TYPE,
		data,
	};
}

describe("mission domain state invariants", () => {
	it("rejects completed missions with unfinished features", () => {
		expect(() =>
			assertMissionStateInvariants(state({ status: "completed", features: [implementation("work")] })),
		).toThrow(MissionStateError);
	});

	it("requires a reason for paused missions", () => {
		expect(() => assertMissionStateInvariants(state({ status: "paused" }))).toThrow(MissionStateError);
	});

	it("requires a ready feature workspace before integration", () => {
		const feature = implementation("work", "in_progress");
		feature.currentWorkerSessionId = "worker";
		feature.workerSessionIds = ["worker"];
		feature.workspace = {
			kind: "feature",
			id: "workspace",
			ownerSessionId: "owner",
			repoRoot: "/repo",
			path: "/repo/workspace",
			featureId: "work",
			phase: "reserved",
			branch: "work",
			baseSha: "base",
		};
		expect(() =>
			assertMissionStateInvariants(
				state({
					features: [feature],
					pendingHandoff: workerHandoff,
					repository: {
						repoRoot: "/repo",
						parentBranch: "main",
						baseSha: "base",
						integrationBranch: "integration",
						integrationHead: "base",
					},
					integrationPending: { featureId: "work", expectedOldHead: "base", newHead: "base" },
				}),
			),
		).toThrow(MissionStateError);
	});

	it("requires generation-zero validators to validate the integration head", () => {
		const validator = {
			...implementation("milestone/scrutiny", "completed"),
			kind: "validation" as const,
			validator: "scrutiny" as const,
			validatedHead: "other",
			workspace: {
				kind: "validator" as const,
				id: "validator-workspace",
				ownerSessionId: "owner",
				repoRoot: "/repo",
				path: "/repo/validator-workspace",
				featureId: "milestone/scrutiny",
				phase: "ready" as const,
				head: "other",
			},
		};
		expect(() =>
			assertMissionStateInvariants(
				state({
					features: [validator],
					milestones: [
						{
							id: "milestone",
							description: "milestone",
							featureIds: [],
							validators: ["scrutiny"],
							kind: "planned",
						},
					],
					repository: {
						repoRoot: "/repo",
						parentBranch: "main",
						baseSha: "base",
						integrationBranch: "integration",
						integrationHead: "integration",
						publishCheck: {
							parentHead: "parent",
							integrationHead: "integration",
							generation: 0,
							phase: "validated",
						},
					},
				}),
			),
		).toThrow(MissionStateError);
	});

	it("does not accept a passing validation handoff with blocking issues", () => {
		const handoff: MissionValidatorHandoff = {
			kind: "validation",
			role: "scrutiny",
			verdict: "pass",
			summary: "pass",
			checks: [],
			issues: [{ severity: "blocking", description: "must fix" }],
		};
		expect(canAcceptPendingHandoff(handoff)).toBe(false);
	});

	it("wraps malformed feature arrays as mission state errors", () => {
		const malformed: Record<string, unknown> = {
			...state(),
			features: [{ ...implementation("work"), workerSessionIds: "not-an-array" }],
		};
		expect(() => loadMissionState([stateEntry(malformed)])).toThrow(MissionStateError);
	});

	it("ignores malformed progress entries for other missions", () => {
		const unrelatedProgress: SessionEntry = {
			type: "custom",
			id: "progress",
			parentId: "state",
			timestamp: "2026-01-01T00:00:01.000Z",
			customType: MISSION_PROGRESS_CUSTOM_TYPE,
			data: { missionId: "other" },
		};
		expect(loadMissionState([stateEntry(state()), unrelatedProgress])?.id).toBe("mission");
	});

	it("reports malformed preconditions without throwing a native type error", () => {
		const plan: MissionPlan = {
			goal: "goal",
			runbook: { setup: [], services: [], userTests: [] },
			milestones: [{ id: "milestone", description: "milestone", featureIds: ["work"], validators: ["scrutiny"] }],
			features: [
				{
					id: "work",
					description: "work",
					milestoneId: "milestone",
					preconditions: null as never,
					expectedBehavior: ["works"],
				},
			],
		};
		expect(validateMissionPlan(plan)).toEqual({
			valid: false,
			errors: ['Feature "work" preconditions must be an array'],
		});
	});

	it("cancels implementations blocked by cancelled validation prerequisites", () => {
		const validator = {
			...implementation("validation", "cancelled"),
			kind: "validation" as const,
			validator: "scrutiny" as const,
		};
		const dependent = { ...implementation("dependent"), preconditions: ["validation"] };
		const result = nextMissionFeature(state({ features: [validator, dependent] }));
		expect(result.feature).toBeNull();
		expect(result.state.features[1]?.status).toBe("cancelled");
	});
});
