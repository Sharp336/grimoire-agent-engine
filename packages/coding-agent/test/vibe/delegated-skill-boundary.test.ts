import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildVibeDelegatedAssignment } from "../../src/vibe/delegated-skill-boundary";

const root = resolve(import.meta.dir, "../..");
const director = readFileSync(resolve(root, "src/prompts/system/vibe-mode-active.md"), "utf8");

describe("delegated skill dependency boundary", () => {
	test("worker assignment seam returns one original assignment with contract", () => {
		const result = buildVibeDelegatedAssignment("run gap-analysis --dalio");
		expect(result.match(/Assignment:/g)?.length).toBe(1);
		expect(result).toContain("run gap-analysis --dalio");
		expect(result).toContain('"type":"dependency_required"');
		expect(result).toContain('"execution_owner":"parent_active_session"');
		expect(result).toContain('"status":"not_run"');
		expect(result).toContain('"reason":"delegated_worker_boundary"');
	});

	test("director-facing spawn instructions carry parent dispatch contract", () => {
		const spawn = readFileSync(resolve(root, "src/prompts/tools/vibe-spawn.md"), "utf8");
		expect(spawn).toContain("dependency_required");
		expect(spawn).toContain("/skill:<name> <args>");
		expect(spawn).toContain("skill-dispatch-result/v1");
		expect(spawn).toContain("Never probe");
	});

	test("director consumes dependency and validates parent dispatch evidence", () => {
		expect(director).toContain("dependency_required");
		expect(director).toContain("/skill:<skill> <args>");
		expect(director).toContain("skill-dispatch-result/v1");
		expect(director).toContain("Never describe");
	});
});
