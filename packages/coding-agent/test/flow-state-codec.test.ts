import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	createFlowStateMessage,
	extractLatestFlowState,
	isFlowStateMessage,
} from "@oh-my-pi/pi-coding-agent/flow/flow-state-codec";
import { FLOW_STATE_CUSTOM_TYPE, type FlowState } from "@oh-my-pi/pi-coding-agent/flow/types";

function sampleState(cursor = "start"): FlowState {
	return {
		version: 2,
		flowId: "test",
		cursor,
		frameStack: [],
		executionLog: [],
	};
}

describe("createFlowStateMessage", () => {
	test("wraps a FlowState into a non-display custom message", () => {
		const state = sampleState();
		const msg = createFlowStateMessage(state);
		expect(msg.role).toBe("custom");
		expect(msg.customType).toBe(FLOW_STATE_CUSTOM_TYPE);
		expect(msg.display).toBe(false);
		expect(msg.details).toEqual(state);
		expect(typeof msg.timestamp).toBe("number");
	});
});

describe("isFlowStateMessage", () => {
	test("returns true for flow-state custom messages", () => {
		const msg = createFlowStateMessage(sampleState());
		expect(isFlowStateMessage(msg)).toBe(true);
	});

	test("returns false for other custom types", () => {
		const msg = {
			role: "custom" as const,
			customType: "something-else",
			content: "",
			display: true,
			timestamp: 0,
		};
		expect(isFlowStateMessage(msg as unknown as AgentMessage)).toBe(false);
	});

	test("returns false for non-custom messages", () => {
		const msg = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "hi" }],
			timestamp: 0,
		};
		expect(isFlowStateMessage(msg)).toBe(false);
	});
});

describe("extractLatestFlowState", () => {
	test("returns undefined for empty history", () => {
		expect(extractLatestFlowState([])).toBeUndefined();
	});

	test("returns undefined when no flow-state messages are present", () => {
		const history: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }];
		expect(extractLatestFlowState(history)).toBeUndefined();
	});

	test("returns the state from the only flow-state message", () => {
		const state = sampleState();
		const history: AgentMessage[] = [createFlowStateMessage(state)];
		expect(extractLatestFlowState(history)).toEqual(state);
	});

	test("returns the most recent flow-state when multiple exist", () => {
		const first = sampleState("a");
		const second = sampleState("b");
		const history: AgentMessage[] = [
			createFlowStateMessage(first),
			{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
			createFlowStateMessage(second),
		];
		expect(extractLatestFlowState(history)?.cursor).toBe("b");
	});

	test("ignores unrelated custom messages", () => {
		const state = sampleState();
		const history: AgentMessage[] = [
			{
				role: "custom",
				customType: "other",
				content: "foo",
				display: true,
				timestamp: 0,
			},
			createFlowStateMessage(state),
		];
		expect(extractLatestFlowState(history)).toEqual(state);
	});
});
