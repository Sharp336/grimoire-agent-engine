import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getUi, Settings, TAB_GROUPS } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	COUNCIL_LEAD_ROLES,
	COUNCIL_MAX_ACTIVE_REVIEWERS,
	CouncilConfigError,
	councilMemberRounds,
	countActiveCouncilMembers,
	parseCouncilConfig,
} from "@oh-my-pi/pi-coding-agent/council/config";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("council configuration", () => {
	it("uses the named default roster and one round when council settings are absent", () => {
		const settings = Settings.isolated();

		expect(parseCouncilConfig(settings)).toEqual({
			members: [
				{ role: "council1", enabled: true, order: 0 },
				{ role: "council2", enabled: true, order: 1 },
				{ role: "council3", enabled: true, order: 2 },
				{ role: "council4", enabled: true, order: 3 },
			],
			rounds: 1,
			advisor: { planner: false, reviewers: false, adjudicator: false },
		});
		expect(getUi("council.members")).toBeUndefined();
		expect(getUi("council.rounds")?.options).toEqual([
			{ value: "1", label: "1", description: "One review round" },
			{ value: "2", label: "2", description: "Two review rounds" },
		]);
		expect(TAB_GROUPS.tasks).toContain("Council");
	});

	it.each([
		["non-array roster", { "council.members": "council1" }, "council.members: expected an array"],
		[
			"non-object member",
			{ "council.members": ["council1"] },
			"council.members[0]: expected { role: string, enabled: boolean, round?: 1 | 2 }, got string",
		],
		[
			"extra member field",
			{ "council.members": [{ role: "council1", enabled: true, model: "x" }] },
			"council.members[0]: expected { role: string, enabled: boolean, round?: 1 | 2 }, got object",
		],
		[
			"invalid role grammar",
			{ "council.members": [{ role: "Council_one", enabled: true }] },
			'council.members[0].role: "Council_one" must match /^[a-z][a-z0-9]{0,63}$/',
		],
		[
			"non-boolean enabled",
			{ "council.members": [{ role: "council1", enabled: "yes" }] },
			"council.members[0]: expected { role: string, enabled: boolean, round?: 1 | 2 }, got object",
		],
	] as const)("rejects a present malformed %s", (_name, overrides, diagnostic) => {
		const settings = Settings.isolated(overrides);

		const parse = () => parseCouncilConfig(settings);
		expect(parse).toThrow(CouncilConfigError);
		expect(parse).toThrow(diagnostic);
		try {
			parse();
		} catch (error) {
			expect((error as CouncilConfigError).settingPath).toBe(diagnostic.split(":")[0]);
		}
	});

	it.each([
		["project rounds override", { rounds: 2 }],
		["empty project council object", {}],
	] as const)("rejects a malformed global council parent with a %s", async (_name, projectCouncil) => {
		using tempDir = TempDir.createSync("@omp-council-malformed-parent-");
		const cwd = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ council: "invalid" }));
		await Bun.write(path.join(cwd, ".omp", "config.yml"), YAML.stringify({ council: projectCouncil }));
		const settings = await Settings.loadReadOnly({ cwd, agentDir });

		expect(() => parseCouncilConfig(settings)).toThrow("council.members: expected an array");
	});

	it("accepts a 64-character role and rejects a 65-character role", () => {
		const acceptedRole = `a${"1".repeat(63)}`;
		const rejectedRole = `a${"1".repeat(64)}`;

		expect(
			parseCouncilConfig(
				Settings.isolated({
					"council.members": [{ role: acceptedRole, enabled: true }],
				}),
			).members[0]?.role,
		).toBe(acceptedRole);
		expect(() =>
			parseCouncilConfig(
				Settings.isolated({
					"council.members": [{ role: rejectedRole, enabled: true }],
				}),
			),
		).toThrow(`council.members[0].role: "${rejectedRole}" must match /^[a-z][a-z0-9]{0,63}$/`);
	});

	it("rejects duplicate roles even when one duplicate is disabled", () => {
		const settings = Settings.isolated({
			"council.members": [
				{ role: "reviewer", enabled: true },
				{ role: "reviewer", enabled: false },
			],
		});

		expect(() => parseCouncilConfig(settings)).toThrow(
			"council.members[1].role: reviewer duplicates council.members[0].role",
		);
	});

	it("accepts empty and all-disabled rosters", () => {
		const empty = Settings.isolated({ "council.members": [] });
		const disabled = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: false }],
		});

		expect(parseCouncilConfig(empty).members).toEqual([]);
		expect(parseCouncilConfig(disabled).members).toEqual([{ role: "reviewer", enabled: false, order: 0 }]);
	});

	it("treats project council.members as terminal and names the global config path", async () => {
		using tempDir = TempDir.createSync("@omp-council-project-config-");
		const cwd = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yaml"), YAML.stringify({ council: { rounds: 2 } }));
		await Bun.write(
			path.join(cwd, ".omp", "config.yml"),
			YAML.stringify({ council: { members: [{ role: "project-reviewer", enabled: true }] } }),
		);
		const settings = await Settings.loadReadOnly({ cwd, agentDir });

		expect(() => parseCouncilConfig(settings)).toThrow(
			"council.members: defined in project settings, which council does not support; move it to",
		);
		expect(() => parseCouncilConfig(settings)).toThrow(path.join(agentDir, "config.yaml"));
	});

	const terminalSelectorDiagnostic = "council.members[0].role: role 'reviewer' maps to";
	const terminalSelectorRequirement = "council members need exactly one concrete provider/model.";

	it.each([
		["empty string", ""],
		["whitespace string", "   "],
		["non-string", 42],
		["object", { selector: "anthropic/claude-sonnet" }],
		["empty array", []],
		["multiple-selector array", ["anthropic/claude-sonnet", "openai/gpt-5"]],
		["comma-delimited string", "anthropic/claude-sonnet,openai/gpt-5"],
	])("rejects a roster role backed by an invalid %s selector", (_name, roleValue) => {
		const settings = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: { reviewer: roleValue },
		});

		expect(() => parseCouncilConfig(settings)).toThrow(terminalSelectorDiagnostic);
		expect(() => parseCouncilConfig(settings)).toThrow(terminalSelectorRequirement);
	});

	it("names how many models a roster role actually resolves to", () => {
		const settings = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: { reviewer: ["anthropic/claude-sonnet", "openai/gpt-5"] },
		});

		expect(() => parseCouncilConfig(settings)).toThrow(
			"council.members[0].role: role 'reviewer' maps to 2 models through modelRoles; council members need exactly one concrete provider/model.",
		);
	});

	it("accepts a roster role backed by one direct selector", () => {
		const settings = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: { reviewer: "anthropic/claude-sonnet" },
		});

		expect(parseCouncilConfig(settings).members[0]?.role).toBe("reviewer");
	});

	it("accepts a roster role whose alias resolves transitively to one selector", () => {
		const settings = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: {
				reviewer: "@critic",
				critic: "@judge",
				judge: "anthropic/claude-sonnet",
			},
		});

		expect(parseCouncilConfig(settings).members[0]?.role).toBe("reviewer");
	});

	it.each([
		["comma list", "anthropic/claude-sonnet,openai/gpt-5"],
		["string-array list", ["anthropic/claude-sonnet", "openai/gpt-5"]],
	] as const)("rejects an alias resolving to a %s", (_name, critic) => {
		const settings = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: { reviewer: "@critic", critic },
		});

		expect(() => parseCouncilConfig(settings)).toThrow(terminalSelectorDiagnostic);
	});

	it("rejects an alias to an unconfigured role", () => {
		const settings = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: { reviewer: "@missing" },
		});

		expect(() => parseCouncilConfig(settings)).toThrow(terminalSelectorDiagnostic);
	});

	it("rejects an alias cycle", () => {
		const settings = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: { reviewer: "@critic", critic: "@reviewer" },
		});

		expect(() => parseCouncilConfig(settings)).toThrow(terminalSelectorDiagnostic);
	});

	it("accepts an unconfigured built-in roster role without expanding its default priorities", () => {
		const settings = Settings.isolated({
			"council.members": [{ role: "slow", enabled: true }],
		});

		expect(parseCouncilConfig(settings).members[0]?.role).toBe("slow");
	});

	it("rejects a configured alias to an unconfigured built-in role instead of using its default priorities", () => {
		const settings = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: { reviewer: "@slow" },
		});

		const parse = () => parseCouncilConfig(settings);
		expect(parse).toThrow(terminalSelectorDiagnostic);
		try {
			parse();
		} catch (error) {
			expect((error as CouncilConfigError).settingPath).toBe("council.members[0].role");
		}
	});

	it("does not validate absent or unassigned model roles during config parsing", () => {
		const absent = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
		});
		const unassigned = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: { other: [] },
		});

		expect(parseCouncilConfig(absent).members[0]?.role).toBe("reviewer");
		expect(parseCouncilConfig(unassigned).members[0]?.role).toBe("reviewer");
	});

	it.each([0, 3, 1.5, "1"] as const)("rejects invalid council.rounds value %p", rounds => {
		const settings = Settings.isolated({ "council.rounds": rounds });

		expect(() => parseCouncilConfig(settings)).toThrow(`council.rounds: expected 1 or 2, got ${String(rounds)}`);
	});

	it("accepts two rounds and preserves every roster entry's source order", () => {
		const settings = Settings.isolated({
			"council.members": [
				{ role: "first", enabled: true },
				{ role: "disabled", enabled: false },
				{ role: "second", enabled: true },
			],
			"council.rounds": 2,
		});

		expect(parseCouncilConfig(settings)).toEqual({
			members: [
				{ role: "first", enabled: true, order: 0 },
				{ role: "disabled", enabled: false, order: 1 },
				{ role: "second", enabled: true, order: 2 },
			],
			rounds: 2,
			advisor: { planner: false, reviewers: false, adjudicator: false },
		});
	});

	it("resolves an omitted round to every configured round and a pinned round to only that round", () => {
		const twoRounds = Settings.isolated({
			"council.members": [
				{ role: "floating", enabled: true },
				{ role: "pinned", enabled: true, round: 2 },
			],
			"council.rounds": 2,
		});
		const oneRound = Settings.isolated({
			"council.members": [{ role: "floating", enabled: true }],
			"council.rounds": 1,
		});

		const two = parseCouncilConfig(twoRounds);
		const one = parseCouncilConfig(oneRound);

		expect(two.members).toEqual([
			{ role: "floating", enabled: true, order: 0 },
			{ role: "pinned", enabled: true, order: 1, round: 2 },
		]);
		expect(two.members.map(member => councilMemberRounds(member, two.rounds))).toEqual([[1, 2], [2]]);
		expect(one.members.map(member => councilMemberRounds(member, one.rounds))).toEqual([[1]]);
	});

	it("keeps a member pinned above council.rounds and resolves it to no rounds at all", () => {
		const settings = Settings.isolated({
			"council.members": [
				{ role: "always", enabled: true },
				{ role: "late", enabled: true, round: 2 },
			],
			"council.rounds": 1,
		});

		const config = parseCouncilConfig(settings);

		expect(config.members).toEqual([
			{ role: "always", enabled: true, order: 0 },
			{ role: "late", enabled: true, order: 1, round: 2 },
		]);
		expect(config.members.map(member => councilMemberRounds(member, config.rounds))).toEqual([[1], []]);
	});

	const activeRoster = (
		count: number,
		extra: Array<{ role: string; enabled: boolean; round?: 1 | 2 }> = [],
	): Array<{ role: string; enabled: boolean; round?: 1 | 2 }> => [
		...Array.from({ length: count }, (_unused, index) => ({ role: `council${index + 1}`, enabled: true })),
		...extra,
	];

	it("counts only the members that would actually run toward the active reviewer limit", () => {
		const settings = Settings.isolated({
			"council.members": [
				{ role: "running", enabled: true },
				{ role: "off", enabled: false },
				{ role: "offpinned", enabled: false, round: 2 },
				{ role: "parked", enabled: true, round: 2 },
			],
			"council.rounds": 1,
		});

		const config = parseCouncilConfig(settings);

		expect(countActiveCouncilMembers(config.members, config.rounds)).toBe(1);
		// A second configured round un-parks the round-2 pin, and never the disabled rows.
		expect(countActiveCouncilMembers(config.members, 2)).toBe(2);
	});

	it("accepts exactly the maximum number of active reviewers", () => {
		const settings = Settings.isolated({ "council.members": activeRoster(COUNCIL_MAX_ACTIVE_REVIEWERS) });

		const config = parseCouncilConfig(settings);

		expect(config.members).toHaveLength(COUNCIL_MAX_ACTIVE_REVIEWERS);
		expect(countActiveCouncilMembers(config.members, config.rounds)).toBe(COUNCIL_MAX_ACTIVE_REVIEWERS);
	});

	it("leaves a roster of any size alone while only the maximum would actually run", () => {
		const settings = Settings.isolated({
			"council.members": activeRoster(COUNCIL_MAX_ACTIVE_REVIEWERS, [
				{ role: "parked", enabled: true, round: 2 },
				{ role: "off", enabled: false },
				{ role: "offpinned", enabled: false, round: 2 },
			]),
			"council.rounds": 1,
		});

		const config = parseCouncilConfig(settings);

		expect(config.members).toHaveLength(COUNCIL_MAX_ACTIVE_REVIEWERS + 3);
		expect(countActiveCouncilMembers(config.members, config.rounds)).toBe(COUNCIL_MAX_ACTIVE_REVIEWERS);
	});

	it("refuses one reviewer above the limit and names the count, the limit, and the global remedy", () => {
		const settings = Settings.isolated({ "council.members": activeRoster(COUNCIL_MAX_ACTIVE_REVIEWERS + 1) });
		const globalPath = settings.getGlobalConfigPath();

		try {
			parseCouncilConfig(settings);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CouncilConfigError);
			expect((error as CouncilConfigError).settingPath).toBe("council.members");
			expect((error as Error).message).toBe(
				`council.members: 65 reviewers would run in 1 configured round(s), above the 64-reviewer limit an adjudication can grade. Disable or park 1 member(s) in ${globalPath}, or pin them to a round above council.rounds.`,
			);
		}
	});

	it("counts a round-2 pin only once the second round is configured", () => {
		const members = activeRoster(COUNCIL_MAX_ACTIVE_REVIEWERS, [{ role: "late", enabled: true, round: 2 }]);

		const parked = parseCouncilConfig(Settings.isolated({ "council.members": members, "council.rounds": 1 }));

		expect(parked.members).toHaveLength(COUNCIL_MAX_ACTIVE_REVIEWERS + 1);
		expect(countActiveCouncilMembers(parked.members, parked.rounds)).toBe(COUNCIL_MAX_ACTIVE_REVIEWERS);
		expect(() => parseCouncilConfig(Settings.isolated({ "council.members": members, "council.rounds": 2 }))).toThrow(
			"65 reviewers would run in 2 configured round(s)",
		);
	});

	it("refuses a malformed council.rounds before counting active reviewers", () => {
		const settings = Settings.isolated({
			"council.members": activeRoster(COUNCIL_MAX_ACTIVE_REVIEWERS + 1),
			"council.rounds": 3,
		});

		expect(() => parseCouncilConfig(settings)).toThrow("council.rounds: expected 1 or 2, got 3");
	});

	it.each([...COUNCIL_LEAD_ROLES])("rejects a roster member named %s because the lead id is reserved", role => {
		const settings = Settings.isolated({
			"council.members": [
				{ role: "reviewer", enabled: true },
				{ role, enabled: true },
			],
		});

		const parse = () => parseCouncilConfig(settings);
		expect(parse).toThrow(CouncilConfigError);
		expect(parse).toThrow(`council.members[1].role: '${role}' is reserved for the council ${role} lead`);
		try {
			parse();
		} catch (error) {
			expect((error as CouncilConfigError).settingPath).toBe("council.members[1].role");
		}
	});

	it.each([0, 3, 1.5, "1", null] as const)("rejects a round pin of %p outside 1 | 2", round => {
		const settings = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true, round }],
		});

		const parse = () => parseCouncilConfig(settings);
		expect(parse).toThrow(CouncilConfigError);
		expect(parse).toThrow(`council.members[0].round: expected 1 or 2, got ${String(round)}`);
		try {
			parse();
		} catch (error) {
			expect((error as CouncilConfigError).settingPath).toBe("council.members[0].round");
		}
	});

	it("reads every council.advisor scope independently into the parsed config", () => {
		const settings = Settings.isolated({
			"council.advisor.planner": true,
			"council.advisor.reviewers": false,
			"council.advisor.adjudicator": true,
		});

		expect(parseCouncilConfig(settings).advisor).toEqual({ planner: true, reviewers: false, adjudicator: true });
	});

	it.each(["planner", "reviewers", "adjudicator"] as const)("rejects a non-boolean council.advisor.%s", scope => {
		const settings = Settings.isolated({ [`council.advisor.${scope}`]: "yes" });

		const parse = () => parseCouncilConfig(settings);
		expect(parse).toThrow(CouncilConfigError);
		expect(parse).toThrow(`council.advisor.${scope}: expected true or false, got yes`);
		try {
			parse();
		} catch (error) {
			expect((error as CouncilConfigError).settingPath).toBe(`council.advisor.${scope}`);
		}
	});
});
