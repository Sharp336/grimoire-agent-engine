import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import {
	buildRoutineExecutionPlan,
	loadRoutines,
	parseRoutineFile,
	parseRoutineInvocation,
} from "@oh-my-pi/pi-coding-agent/extensibility/routines";
import type { FileSlashCommand } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const source: SourceMeta = {
	provider: "test",
	providerName: "Test",
	path: "/tmp/review-all.yaml",
	level: "user",
};

function parse(content: string, name = "review-all.yaml") {
	return parseRoutineFile({ name, content, path: `/tmp/${name}`, source });
}

function fileCommand(name: string, content: string): FileSlashCommand {
	return { name, description: `${name} command`, content, source: "test" };
}

describe("routines", () => {
	test("parses a valid routine with command and message steps", () => {
		const routine = parse(`description: Run reviews
steps:
  - command: pr-local-readability
    args: --strict
  - message: Review $ARGUMENTS now
`);

		expect(routine.name).toBe("review-all");
		expect(routine.description).toBe("Run reviews");
		expect(routine.level).toBe("user");
		expect(routine.steps).toEqual([
			{ command: "pr-local-readability", args: "--strict" },
			{ message: "Review $ARGUMENTS now" },
		]);
	});

	const invalidRoutineCases: Array<{ label: string; content: string; message: string; name?: string }> = [
		{ label: "frontmatter", content: "---\ndescription: Run\n---\nsteps: []", message: "plain YAML" },
		{ label: "empty steps", content: "description: Run\nsteps: []", message: "non-empty array" },
		{
			label: "extra root key",
			content: "description: Run\nsteps:\n  - command: one\nname: bad",
			message: "unsupported key",
		},
		{
			label: "extra step key",
			content: "description: Run\nsteps:\n  - command: one\n    typo: true",
			message: "unsupported key",
		},
		{
			label: "both step kinds",
			content: "description: Run\nsteps:\n  - command: one\n    message: two",
			message: "exactly one",
		},
		{ label: "missing step kind", content: "description: Run\nsteps:\n  - args: two", message: "exactly one" },
		{
			label: "bad routine name",
			content: "description: Run\nsteps:\n  - command: one",
			message: "Invalid routine name",
			name: "Bad_Name.yaml",
		},
		{
			label: "bad step command name",
			content: "description: Run\nsteps:\n  - command: Bad Command",
			message: "Invalid routine command step",
		},
	];

	for (const invalid of invalidRoutineCases) {
		test(`rejects ${invalid.label}`, () => {
			expect(() => parse(invalid.content, invalid.name ?? "review-all.yaml")).toThrow(invalid.message);
		});
	}

	test("message steps replace $ARGUMENTS without appending invocation args", () => {
		const routine = parse(`description: Run
steps:
  - message: |
      First $ARGUMENTS
      Done
`);
		const invocation = parseRoutineInvocation("/review-all src/foo.ts", [routine]);

		expect(invocation).not.toBeNull();
		const plan = buildRoutineExecutionPlan(invocation!, []);

		expect(plan.steps).toEqual([
			{
				kind: "message",
				label: "message",
				text: "First src/foo.ts\nDone\n",
			},
		]);
	});

	test("command steps compose step args and invocation args with a blank line", () => {
		const routine = parse(`description: Run
steps:
  - command: review
    args: |
      --mode strict
      Check this first
`);
		const invocation = parseRoutineInvocation("/review-all src/foo.ts", [routine]);
		const plan = buildRoutineExecutionPlan(invocation!, [fileCommand("review", "Args:\n$ARGUMENTS")]);

		expect(plan.steps).toEqual([
			{
				kind: "command",
				label: "/review",
				text: "Args:\n--mode strict\nCheck this first\n\nsrc/foo.ts",
			},
		]);
	});

	test("command steps preserve raw bare argument aliases while parsing slices", () => {
		const routine = parse("description: Run\nsteps:\n  - command: review\n");
		const payload = '"alpha beta" gamma\n"delta epsilon"';
		const invocation = parseRoutineInvocation(`/review-all ${payload}`, [routine]);
		const command = fileCommand("review", ["Raw $@", "Alias $ARGUMENTS", "Slice $@[2]"].join("\n"));

		const plan = buildRoutineExecutionPlan(invocation!, [command]);

		expect(plan.steps).toEqual([
			{
				kind: "command",
				label: "/review",
				text: `Raw ${payload}\nAlias ${payload}\nSlice gamma\ndelta epsilon`,
			},
		]);
	});

	test("preflight rejects unknown commands before rendering later steps", () => {
		const routine = parse(`description: Run
steps:
  - command: missing
  - command: known
`);
		const invocation = parseRoutineInvocation("/review-all src/foo.ts", [routine]);

		expect(() => buildRoutineExecutionPlan(invocation!, [fileCommand("known", "Known $ARGUMENTS")])).toThrow(
			"Unknown routine command step: missing",
		);
	});

	test("preflight rejects routine-in-routine before rendering any steps", () => {
		const routine = parse(`description: Run
steps:
  - command: child
  - command: known
`);
		const invocation = parseRoutineInvocation("/review-all src/foo.ts", [routine]);

		expect(() =>
			buildRoutineExecutionPlan(
				invocation!,
				[fileCommand("child", "Child"), fileCommand("known", "Known")],
				new Set(["child"]),
			),
		).toThrow("Routine steps cannot target routines: child");
	});

	test("invocation parser supports slash whitespace and colon separators", () => {
		const routine = parse("description: Run\nsteps:\n  - message: Hi\n");

		expect(parseRoutineInvocation("/review-all src/foo.ts", [routine])?.argsText).toBe("src/foo.ts");
		expect(parseRoutineInvocation("/review-all:src/foo.ts", [routine])?.argsText).toBe("src/foo.ts");
		expect(parseRoutineInvocation("/other src/foo.ts", [routine])).toBeNull();
	});

	test("fails visibly when a discovered routine file is invalid", async () => {
		const originalAgentDir = getAgentDir();
		const tempDir = TempDir.createSync("@pi-invalid-routine-");
		try {
			setAgentDir(path.join(tempDir.path(), "agent"));
			resetCapabilities();
			await Bun.write(
				path.join(getAgentDir(), "routines", "bad.yaml"),
				"description: Bad\nsteps:\n  - typo: true\n",
			);

			await expect(loadRoutines({ cwd: tempDir.path() })).rejects.toThrow("Failed to load routines:");
		} finally {
			setAgentDir(originalAgentDir);
			resetCapabilities();
			tempDir.removeSync();
		}
	});
});
