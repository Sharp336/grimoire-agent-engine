import { describe, expect, it, vi } from "bun:test";
import { ADVISOR_CODE_INVESTIGATIONS_DISABLED_MESSAGE, type EvidenceBroker } from "../broker";
import { RequestInvestigationTool, type RequestInvestigationParams } from "../request-investigation-tool";
import type { InvestigationRecord } from "../types";

function makeRecord(args: RequestInvestigationParams): InvestigationRecord {
	return {
		...args,
		id: "ev-test-1",
		status: "queued",
		requestedBy: "advisor",
		createdAt: 1,
		updatedAt: 1,
		advisorDelivery: "pending",
	};
}

function makeBroker(request: EvidenceBroker["request"]): EvidenceBroker {
	return { request } as unknown as EvidenceBroker;
}

describe("RequestInvestigationTool", () => {
	it("returns queued details from the broker request", async () => {
		const params: RequestInvestigationParams = {
			question: "Which docs apply?",
			objective: "The answer can change guidance.",
			mode: "docs",
			risk: "could_change_direction",
			constraints: ["version 1.2"],
		};
		const request = vi.fn(async (input: RequestInvestigationParams) => makeRecord(input));
		const tool = new RequestInvestigationTool(makeBroker(request));

		const result = await tool.execute("tc-1", params);

		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0]?.[0]).toEqual(params);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Queued investigation ev-test-1. Continue reviewing; a later update will surface the artifact if it changes your guidance.",
			},
		]);
		expect(result.details).toEqual({
			id: "ev-test-1",
			status: "queued",
			mode: "docs",
			risk: "could_change_direction",
		});
		expect(result.useless).toBe(true);
	});

	it("returns the exact disabled-exec tool error", async () => {
		const params: RequestInvestigationParams = {
			question: "Can this command reproduce the bug?",
			objective: "A repro would change the advice.",
			mode: "code_experiment",
			risk: "potential_blocker",
		};
		const request = vi.fn(async (_input: RequestInvestigationParams) => {
			throw new Error(ADVISOR_CODE_INVESTIGATIONS_DISABLED_MESSAGE);
		});
		const tool = new RequestInvestigationTool(makeBroker(request));

		const result = await tool.execute("tc-1", params);

		expect(request).toHaveBeenCalledTimes(1);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: ADVISOR_CODE_INVESTIGATIONS_DISABLED_MESSAGE }]);
	});

	it("accepts docs, web, and source modes through one broker request each", async () => {
		const modes = ["docs", "web", "source"] as const;
		for (const mode of modes) {
			const params: RequestInvestigationParams = {
				question: `Question for ${mode}`,
				objective: "The answer can change guidance.",
				mode,
				risk: "background",
			};
			const request = vi.fn(async (input: RequestInvestigationParams) => makeRecord(input));
			const tool = new RequestInvestigationTool(makeBroker(request));

			const result = await tool.execute("tc-1", params);

			expect(result.isError).toBeUndefined();
			expect(request).toHaveBeenCalledTimes(1);
			expect(request.mock.calls[0]?.[0]).toEqual(params);
		}
	});
});
