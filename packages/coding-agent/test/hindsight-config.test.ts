import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";

function load(
	overrides: Record<string, unknown> = {},
	env: NodeJS.ProcessEnv = {},
) {
	return loadHindsightConfig(Settings.isolated(overrides as never), env);
}

describe("loadHindsightConfig retain/recall seam", () => {
	it("omits retainStrategy when unset", () => {
		expect(load().retainStrategy).toBeNull();
	});

	it("loads retainStrategy from settings", () => {
		expect(load({ "hindsight.retainStrategy": "coding" }).retainStrategy).toBe("coding");
	});

	it("prefers HINDSIGHT_RETAIN_STRATEGY over settings", () => {
		expect(
			load({ "hindsight.retainStrategy": "coding" }, { HINDSIGHT_RETAIN_STRATEGY: "life-ops" }).retainStrategy,
		).toBe("life-ops");
	});

	it("loads additive recallTags and recallTagsMatch", () => {
		const config = load({
			"hindsight.recallTags": ["project:global", "project:global"],
			"hindsight.recallTagsMatch": "any_strict",
		});
		expect(config.recallTags).toEqual(["project:global"]);
		expect(config.recallTagsMatch).toBe("any_strict");
	});

	it("falls back to any when recallTagsMatch is invalid", () => {
		expect(load({ "hindsight.recallTagsMatch": "tag_groups" }).recallTagsMatch).toBe("any");
	});
});
