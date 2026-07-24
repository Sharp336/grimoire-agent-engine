import { describe, expect, it } from "bun:test";
import { type CompactionPreparation, compact, DEFAULT_COMPACTION_SETTINGS } from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

describe("managed compaction ownership", () => {
	it("rejects direct core compaction so only coding-agent can orchestrate managed state", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		const preparation = {
			settings: { ...DEFAULT_COMPACTION_SETTINGS, strategy: "managed" as const },
		} as CompactionPreparation;
		await expect(compact(preparation, model!, "test-key")).rejects.toThrow(
			"Managed compaction must be orchestrated by the coding-agent context manager",
		);
	});
});
