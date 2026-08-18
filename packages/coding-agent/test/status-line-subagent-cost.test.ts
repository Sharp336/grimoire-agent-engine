import { describe, expect, it } from "bun:test";
import { aggregateSubagentCost } from "../src/modes/components/agent-hub-projection";
import type { ObservableSession } from "../src/modes/session-observer-registry";
import type { AgentRef } from "../src/registry/agent-registry";

function makeRef(
	id: string,
	parentId: string | undefined,
	options: { sessionFile: string | null; historyCost?: number; session?: unknown },
): AgentRef {
	return {
		id,
		displayName: id,
		kind: "sub",
		parentId,
		status: "idle",
		session: (options.session as AgentRef["session"]) ?? null,
		sessionFile: options.sessionFile,
		createdAt: 0,
		lastActivity: 0,
		history:
			options.historyCost === undefined
				? undefined
				: {
						metrics: {
							tokens: 0,
							requests: 0,
							tools: 0,
							cost: options.historyCost,
							durationMs: 0,
						},
					},
	};
}

describe("aggregateSubagentCost", () => {
	it("sums current-session descendants and ignores retained refs from other generations", () => {
		const rows = [
			makeRef("Child", "Main", { sessionFile: "/sessions/main/Child.jsonl" }),
			makeRef("Nested", "Child", { sessionFile: "/sessions/main/Child/Nested.jsonl", historyCost: 0.75 }),
			makeRef("Old", "Main", { sessionFile: "/sessions/old/Old.jsonl", historyCost: 8 }),
			makeRef("OtherRoot", undefined, { sessionFile: "/sessions/main/OtherRoot.jsonl" }),
			makeRef("Other", "OtherRoot", { sessionFile: "/sessions/main/Other.jsonl", historyCost: 9 }),
		];
		const observedById = new Map<string, ObservableSession>([
			[
				"Child",
				{
					id: "Child",
					kind: "subagent",
					label: "Child",
					status: "completed",
					lastUpdate: 0,
					progress: { cost: 1.25 } as never,
				},
			],
		]);

		expect(
			aggregateSubagentCost({
				ownerId: "Main",
				ownerSessionFile: "/sessions/main.jsonl",
				rows,
				observedById,
			}),
		).toBeCloseTo(2, 8);
	});

	it("uses the durable child ledger before a fresh observer snapshot", () => {
		const session = {
			sessionManager: { getDirectUsageCost: () => 0.5 },
			agent: {
				state: {
					messages: [
						{ role: "assistant", usage: { cost: { total: 0.5 } } },
						{ role: "toolResult", toolName: "task", details: { usage: { cost: { total: 4 } } } },
					],
				},
			},
		};
		const rows = [makeRef("Live", "Main", { sessionFile: "/sessions/main/Live.jsonl", session })];
		const observedById = new Map<string, ObservableSession>([
			[
				"Live",
				{
					id: "Live",
					kind: "subagent",
					label: "Live",
					status: "active",
					lastUpdate: 0,
					progress: { cost: 0.1 } as never,
				},
			],
		]);

		expect(
			aggregateSubagentCost({
				ownerId: "Main",
				ownerSessionFile: "/sessions/main.jsonl",
				rows,
				observedById,
			}),
		).toBeCloseTo(0.5, 8);
	});
});
