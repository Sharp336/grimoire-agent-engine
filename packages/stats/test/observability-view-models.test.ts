import { describe, expect, it } from "bun:test";
import {
	behaviorTimelineItems,
	displaySessionTitle,
	normalizeObservabilityOutcome,
	observabilityResourceUri,
} from "../src/client/data/view-models";
import type { TimelineItem } from "../src/shared-types";

function timelineItem(kind: string): TimelineItem {
	return {
		entryId: `entry-${kind}`,
		parentId: null,
		timestamp: 1,
		kind,
		runId: null,
		decisionId: null,
		executionId: "session-1",
		payload: {},
		softAvailable: [],
	};
}

describe("observability view models", () => {
	it("uses Unknown for every missing outcome axis", () => {
		expect(normalizeObservabilityOutcome(undefined)).toEqual({
			execution: "Unknown",
			contract: "Unknown",
			verification: "Unknown",
			humanAcceptance: "Unknown",
		});
	});

	it("falls back to Untitled session when the stored title is empty", () => {
		expect(displaySessionTitle("Plan macOS menu bar app")).toBe("Plan macOS menu bar app");
		expect(displaySessionTitle("")).toBe("Untitled session");
		expect(displaySessionTitle("   ")).toBe("Untitled session");
		expect(displaySessionTitle(null)).toBe("Untitled session");
	});

	it("builds stats protocol copy targets without UI tabs", () => {
		expect(observabilityResourceUri("sessions", "session/a", "failures")).toBe("stats://sessions/session%2Fa");
		expect(observabilityResourceUri("runs", "run-1", "timeline")).toBe("stats://runs/run-1");
	});

	it("keeps Behavior empty unless segment or progress facts exist", () => {
		expect(behaviorTimelineItems([timelineItem("model_request"), timelineItem("failure")])).toEqual([]);
		expect(behaviorTimelineItems([timelineItem("segment"), timelineItem("progress")]).map(item => item.kind)).toEqual([
			"segment",
			"progress",
		]);
	});
});
