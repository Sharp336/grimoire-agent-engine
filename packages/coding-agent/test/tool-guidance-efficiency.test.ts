import { describe, expect, test } from "bun:test";
import * as prompt from "../../utils/src/prompt";
import bashPrompt from "../src/prompts/tools/bash.md" with { type: "text" };
import globPrompt from "../src/prompts/tools/glob.md" with { type: "text" };
import grepPrompt from "../src/prompts/tools/grep.md" with { type: "text" };

const bash = prompt.render(bashPrompt, {
	asyncEnabled: true,
	autoBackgroundEnabled: true,
	autoBackgroundThresholdSeconds: 60,
	hasAstEdit: true,
	hasAstGrep: true,
	hasEval: true,
	hasGlob: true,
	hasGrep: true,
	hasLaunch: true,
	hasRead: true,
	hasShellBuiltins: true,
	isWindows: false,
});
const glob = prompt.render(globPrompt);
const grep = prompt.render(grepPrompt);

describe("tool guidance efficiency", () => {
	test("routes shell work without contradicting the eval boundary", () => {
		expect(bash).toMatch(/order-dependent[^\n]*`&&`[^\n]*one call/iu);
		expect(bash).not.toMatch(/inline scripts[^\n]*`&&`/iu);

		const advertisedUtilities = bash.split("\n").find(line => line.includes("aux utils available"));
		expect(advertisedUtilities).toBeDefined();
		expect(advertisedUtilities).not.toMatch(/\b(?:fd|find|grep|ls|rg)\b/u);
	});

	test("prevents broad grep timeouts before execution", () => {
		expect(grep).toMatch(/broad searches[^\n]*time out[^\n]*(?:narrow|scope)/iu);
	});

	test("routes remote and internal URI discovery away from glob", () => {
		expect(glob).toMatch(/local filesystem/iu);
		expect(glob).toMatch(/`ssh:\/\/`[^\n]*`read`/iu);
		expect(glob).toMatch(/internal URI/iu);
	});

	test("keeps the corrected guidance smaller than the previous prompt set", () => {
		expect(bash.length + grep.length + glob.length).toBeLessThan(3_050);
	});
});
