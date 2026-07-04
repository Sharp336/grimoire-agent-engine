import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { resolveCompactionStrategyForModel } from "../src/compaction/compaction";

describe("resolveCompactionStrategyForModel", () => {
	it("downgrades snapcompact to context-full for text-only models", () => {
		const model = { input: ["text"] } as Pick<Model, "input">;
		expect(resolveCompactionStrategyForModel("snapcompact", model)).toBe("context-full");
	});

	it("preserves snapcompact for vision-capable models", () => {
		const model = { input: ["text", "image"] } as Pick<Model, "input">;
		expect(resolveCompactionStrategyForModel("snapcompact", model)).toBe("snapcompact");
	});

	it("preserves non-snapcompact strategies", () => {
		expect(resolveCompactionStrategyForModel("shake", { input: ["text"] } as Pick<Model, "input">)).toBe(
			"shake",
		);
	});
});
