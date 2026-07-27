import { describe, expect, it } from "bun:test";
import { parseSkillUrlTarget } from "../src/internal-url";

describe("parseSkillUrlTarget", () => {
	it("returns the decoded skill and original target for skill URLs", () => {
		expect(parseSkillUrlTarget("skill://review")).toEqual({ skill: "review", target: "skill://review" });
		expect(parseSkillUrlTarget("skill://superpowers:brainstorming:raw:1-5")).toEqual({
			skill: "superpowers:brainstorming",
			target: "skill://superpowers:brainstorming:raw:1-5",
		});
		expect(parseSkillUrlTarget("skill://review%3Aguide:raw")).toEqual({
			skill: "review:guide",
			target: "skill://review%3Aguide:raw",
		});
	});

	it("rejects non-skill URLs and empty skill authorities", () => {
		expect(parseSkillUrlTarget("local://review")).toBeUndefined();
		expect(parseSkillUrlTarget("skill://")).toBeUndefined();
	});
});
