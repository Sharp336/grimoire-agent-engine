import { describe, expect, test } from "bun:test";
import { type MissionFeature, type MissionMilestone, type MissionState, nextMissionFeature } from "../../src/missions";

function milestone(id: string, featureIds: string[]): MissionMilestone {
	return { id, description: id, featureIds, validators: ["scrutiny"], kind: "planned" };
}

function implementation(
	id: string,
	milestoneId: string,
	status: MissionFeature["status"],
	preconditions: string[] = [],
): MissionFeature {
	return {
		id,
		description: id,
		milestoneId,
		preconditions,
		expectedBehavior: ["works"],
		kind: "implementation",
		status,
		workerSessionIds: [],
		retryBudgetUsed: 0,
	};
}

function validation(
	id: string,
	milestoneId: string,
	status: MissionFeature["status"],
	preconditions: string[],
): MissionFeature {
	return { ...implementation(id, milestoneId, status, preconditions), kind: "validation", validator: "scrutiny" };
}

function state(milestones: MissionMilestone[], features: MissionFeature[]): MissionState {
	return {
		version: 1,
		id: "mission-test",
		ownerSessionId: "owner",
		revision: 0,
		goal: "Ship the mission runtime",
		autoAccept: false,
		status: "running",
		runbook: { setup: [], services: [], userTests: [] },
		milestones,
		features,
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("nextMissionFeature", () => {
	test("confines selection to the earliest unfinished milestone", () => {
		// Milestone 1's implementation is done but its validator still pends; a runnable
		// milestone-2 feature sits earlier in the feature array. Selection must return the
		// milestone-1 validator, never the later-milestone work, so nothing builds on an
		// integration head this milestone has not yet validated.
		const milestones = [milestone("m1", ["a1", "v1"]), milestone("m2", ["b1"])];
		const features = [
			implementation("a1", "m1", "completed"),
			implementation("b1", "m2", "pending"),
			validation("v1", "m1", "pending", ["a1"]),
		];

		const result = nextMissionFeature(state(milestones, features));

		expect(result.feature?.id).toBe("v1");
	});

	test("returns nothing while the earliest milestone is still working", () => {
		// Milestone 1 holds an in_progress implementation; a runnable milestone-2 feature
		// must not be scheduled ahead of it.
		const milestones = [milestone("m1", ["a1"]), milestone("m2", ["b1"])];
		const features = [implementation("a1", "m1", "in_progress"), implementation("b1", "m2", "pending")];

		const result = nextMissionFeature(state(milestones, features));

		expect(result.feature).toBeNull();
	});
});
