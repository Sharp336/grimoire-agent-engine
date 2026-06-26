import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { commands, isSubcommand } from "../src/cli-commands";
import { assessLoopReadiness } from "../src/loop-engineering/readiness";
import { executeLoopIteration, parsePorcelainStatusZ, pathMatches } from "../src/loop-engineering/runner";
import { scaffoldLoopProject } from "../src/loop-engineering/scaffold";
import { parseLoopSpec } from "../src/loop-engineering/schema";

async function makeTempDir(prefix = "@pi-loop-engineering-"): Promise<TempDir> {
	return TempDir.create(prefix);
}

async function runGit(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stdout}${stderr}`);
}

async function initCleanGitRepo(cwd: string): Promise<void> {
	await runGit(cwd, ["init"]);
	await runGit(cwd, ["config", "user.email", "loop-test@example.com"]);
	await runGit(cwd, ["config", "user.name", "Loop Test"]);
	await Bun.write(path.join(cwd, "baseline.txt"), "baseline\n");
	await runGit(cwd, ["add", "."]);
	await runGit(cwd, ["commit", "-m", "baseline"]);
}

describe("loop CLI registration", () => {
	it("registers loop as a top-level subcommand instead of leaking to launch prompts", () => {
		expect(commands.some(command => command.name === "loop")).toBe(true);
		expect(isSubcommand("loop")).toBe(true);
	});
});

describe("loop-engineering spec parsing", () => {
	it("normalizes an OMP loop spec with safe defaults", () => {
		const spec = parseLoopSpec(`
loop:
  name: daily-triage
  goal: Report repository issues that need human attention.
  level: assisted
  non_goals:
    - Do not edit code.
  scope:
    paths: ["."]
  trigger:
    type: manual
  runner:
    prompt: Summarize open risks.
  verifier:
    separate: true
    commands:
      - ["bun", "run", "check"]
  guardrails:
    max_iterations: 2
    max_files_changed: 0
  state:
    file: STATE.md
    run_log: loop-run-log.md
    budget: loop-budget.md
`);

		expect(spec.name).toBe("daily-triage");
		expect(spec.level).toBe("assisted");
		expect(spec.guardrails.maxIterations).toBe(2);
		expect(spec.guardrails.denylistPaths).toContain(".env");
		expect(spec.verifier.commands).toEqual([{ argv: ["bun", "run", "check"] }]);
	});

	it("parses NUL-delimited git porcelain paths including renames and spaces", () => {
		expect(parsePorcelainStatusZ("R  new name.ts\0old name.ts\0?? .env\0")).toEqual([
			"new name.ts",
			"old name.ts",
			".env",
		]);
	});

	it("matches default denylist glob patterns at root and nested paths", () => {
		expect(pathMatches("**/secrets/**", "secrets/token")).toBe(true);
		expect(pathMatches("**/secrets/**", "src/secrets/token")).toBe(true);
		expect(pathMatches("**/credentials/**", "src/credentials/key")).toBe(true);
		expect(pathMatches("**/*_secret*", "api_secret.txt")).toBe(true);
		expect(pathMatches("k8s/production/**", "k8s/production-old/file")).toBe(false);
	});

	it("flags verifier commands on report-only loops", () => {
		const spec = parseLoopSpec(`
loop:
  name: report-with-command
  goal: Report only.
  level: report
  non_goals: ["Do not edit code."]
  runner:
    prompt: Summarize.
  verifier:
    separate: true
    commands:
      - ["bun", "run", "check"]
  state:
    run_log: loop-run-log.md
`);
		expect(assessLoopReadiness(spec).issues).toContain("loop.verifier.commands must be empty for report loops");
	});

	it("rejects malformed verifier argv entries instead of silently rewriting commands", () => {
		expect(() =>
			parseLoopSpec(`
loop:
  name: malformed-verifier
  goal: Test command validation.
  level: assisted
  non_goals: ["Do not edit code."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - ["bun", 123]
  state:
    run_log: loop-run-log.md
`),
		).toThrow(/argv entries/);
	});

	it("rejects shell-string verifier commands and unsafe run-log targets", () => {
		expect(() =>
			parseLoopSpec(`
loop:
  name: string-verifier
  goal: Test command validation.
  level: assisted
  non_goals: ["Do not edit code."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - "bun run check"
  state:
    run_log: loop-run-log.md
`),
		).toThrow(/entries must be argv arrays/);
		expect(() =>
			parseLoopSpec(`
loop:
  name: unsafe-log
  goal: Test state validation.
  level: report
  non_goals: ["Do not edit code."]
  runner:
    prompt: Report.
  verifier:
    separate: true
  state:
    run_log: .env
`),
		).toThrow(/loop.state.run_log/);
		expect(() =>
			parseLoopSpec(`
loop:
  name: traversing-log
  goal: Test state validation.
  level: report
  non_goals: ["Do not edit code."]
  runner:
    prompt: Report.
  verifier:
    separate: true
  state:
    run_log: .omp/loop-runs/../../package.md
`),
		).toThrow(/loop.state.run_log/);
	});

	it("reports concrete validation issues for unsafe incomplete specs", () => {
		const spec = parseLoopSpec(`
loop:
  name: risky
  runner:
    prompt: Fix everything.
`);
		const assessment = assessLoopReadiness(spec);

		expect(assessment.ready).toBe(false);
		expect(assessment.issues).toContain("loop.goal is required");
		expect(assessment.issues).toContain("loop.non_goals must list at least one explicit non-goal");
		expect(assessment.issues).toContain("loop.verifier.separate must be true so implementer and verifier stay split");
		expect(assessment.issues).toContain("loop.state.run_log is required for durable audit history");
	});

	it("requires explicit human approval guardrails for autonomous loops", () => {
		const spec = parseLoopSpec(`
loop:
  name: autonomous
  goal: Make safe fixes.
  level: autonomous
  non_goals: ["Do not deploy."]
  runner:
    prompt: Fix one thing.
  verifier:
    separate: true
    commands:
      - ["bun", "run", "check"]
  guardrails:
    max_iterations: 1
    max_files_changed: 1
  state:
    run_log: loop-run-log.md
`);
		expect(assessLoopReadiness(spec).issues).toContain(
			"loop.guardrails.require_human_approval is required for autonomous loops",
		);
	});
});

describe("loop-engineering scaffold", () => {
	it("writes source-inspired OMP-native starter files and refuses accidental overwrite", async () => {
		const dir = await makeTempDir();
		try {
			const result = await scaffoldLoopProject({ cwd: dir.path(), name: "daily-triage", pattern: "daily-triage" });
			const root = await fs.realpath(dir.path());
			expect(result.created.map(item => path.relative(root, item)).sort()).toEqual([
				path.join(".omp", "loops", "daily-triage.loop.yaml"),
				"LOOP.md",
				"STATE.md",
				"loop-budget.md",
				"loop-run-log.md",
			]);

			const loopDoc = await Bun.file(path.join(dir.path(), "LOOP.md")).text();
			expect(loopDoc).toContain("Inspired by cobusgreyling/loop-engineering");
			const parsed = parseLoopSpec(
				await Bun.file(path.join(dir.path(), ".omp", "loops", "daily-triage.loop.yaml")).text(),
			);
			expect(parsed.name).toBe("daily-triage");
			expect(parsed.level).toBe("report");
			expect(parsed.verifier.commands).toEqual([]);

			await expect(
				scaffoldLoopProject({ cwd: dir.path(), name: "daily-triage", pattern: "daily-triage" }),
			).rejects.toThrow(/already exists/);
		} finally {
			await dir.remove();
		}
	});
});

describe("loop-engineering iteration runner", () => {
	it("runs one scheduled-safe iteration, verifier command, and durable logs", async () => {
		const dir = await makeTempDir();
		try {
			const verifier = path.join(dir.path(), "verify.ts");
			await Bun.write(verifier, "await Bun.write('verified.txt', 'ok');\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "bun verify.ts" } }),
			);
			const spec = parseLoopSpec(`
loop:
  name: ci-sweeper
  goal: Fix one failing CI issue and report the result.
  level: assisted
  non_goals:
    - Do not deploy.
  scope:
    paths: ["."]
  trigger:
    type: manual
  runner:
    prompt: Inspect CI and make one safe fix.
  verifier:
    separate: true
    commands:
      - ["bun", "run", "verify"]
  guardrails:
    max_iterations: 1
    max_files_changed: 5
  state:
    file: STATE.md
    run_log: loop-run-log.md
    budget: loop-budget.md
`);
			await Bun.write(path.join(dir.path(), "STATE.md"), "# State\n");
			await Bun.write(path.join(dir.path(), "loop-budget.md"), "# Budget\n");
			await initCleanGitRepo(dir.path());

			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async promptText => {
					expect(promptText).toContain("Fix one failing CI issue");
					await Bun.write(path.join(dir.path(), "agent-output.txt"), "done");
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("passed");
			expect(await Bun.file(path.join(dir.path(), "verified.txt")).text()).toBe("ok");
			const jsonl = await Bun.file(path.join(dir.path(), ".omp", "loop-runs", "ci-sweeper.jsonl")).text();
			expect(jsonl).toContain('"status":"passed"');
			const markdownLog = await Bun.file(path.join(dir.path(), "loop-run-log.md")).text();
			expect(markdownLog).toContain("ci-sweeper");
		} finally {
			await dir.remove();
		}
	});

	it("persists a failed run when a verifier executable is missing", async () => {
		const dir = await makeTempDir();
		try {
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: missing-verifier
  goal: Exercise verifier failure logging.
  level: assisted
  non_goals: ["Do not edit code."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - ["definitely-not-a-real-loop-verifier"]
  guardrails:
    max_iterations: 1
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => ({ exitCode: 0, output: "agent completed" }),
			});

			expect(result.status).toBe("failed");
			expect(result.error).toContain("package-script form");
			const jsonl = await Bun.file(path.join(dir.path(), ".omp", "loop-runs", "missing-verifier.jsonl")).text();
			expect(jsonl).toContain('"status":"failed"');
		} finally {
			await dir.remove();
		}
	});

	it("requires approval for out-of-scope and denylisted changes from the iteration", async () => {
		const dir = await makeTempDir();
		try {
			const verifier = path.join(dir.path(), "noop.ts");
			await Bun.write(verifier, "process.exit(0);\n");
			await Bun.write(path.join(dir.path(), "package.json"), JSON.stringify({ scripts: { verify: "bun noop.ts" } }));
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: guarded
  goal: Make a bounded safe change.
  level: assisted
  non_goals: ["Do not edit secrets."]
  scope:
    paths: ["src/**"]
  runner:
    prompt: Change only scoped files.
  verifier:
    separate: true
    commands:
      - ["bun", "run", "verify"]
  guardrails:
    max_iterations: 1
    max_files_changed: 5
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => {
					await Bun.write(path.join(dir.path(), "README.md"), "outside\n");
					await fs.mkdir(path.join(dir.path(), "secrets"), { recursive: true });
					await Bun.write(path.join(dir.path(), "secrets", "token"), "api_key=SECRET_TOKEN_123456\n");
					return {
						exitCode: 0,
						output:
							"agent completed with api_key=SECRET_TOKEN_123456 Authorization: Bearer ghp_1234567890abcdef1234567890abcdef1234 AWS_SECRET_ACCESS_KEY=ABCDEFGHIJKLMNOPQRST",
					};
				},
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons).toContain("changed out-of-scope path README.md");
			expect(result.approvalReasons).toContain("changed denylisted path secrets/token");
			const jsonl = await Bun.file(path.join(dir.path(), ".omp", "loop-runs", "guarded.jsonl")).text();
			expect(jsonl).toContain("[REDACTED_SECRET]");
			expect(jsonl).not.toContain("SECRET_TOKEN_123456");
			expect(jsonl).not.toContain("ghp_1234567890");
			expect(jsonl).not.toContain("ABCDEFGHIJKLMNOPQRST");
		} finally {
			await dir.remove();
		}
	});

	it("requires approval when assisted loops start from a dirty baseline", async () => {
		const dir = await makeTempDir();
		try {
			const verifier = path.join(dir.path(), "noop.ts");
			await Bun.write(verifier, "process.exit(0);\n");
			await Bun.write(path.join(dir.path(), "package.json"), JSON.stringify({ scripts: { verify: "bun noop.ts" } }));
			await initCleanGitRepo(dir.path());
			await Bun.write(path.join(dir.path(), "already-dirty.txt"), "dirty\n");
			const spec = parseLoopSpec(`
loop:
  name: dirty-baseline
  goal: Do nothing when dirty.
  level: assisted
  non_goals: ["Do not edit code."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - ["bun", "run", "verify"]
  guardrails:
    max_iterations: 1
    max_files_changed: 1
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => ({ exitCode: 0, output: "agent completed" }),
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons[0]).toContain("pre-existing changed files");
		} finally {
			await dir.remove();
		}
	});

	it("requires approval if the agent changes verifier package scripts before verification", async () => {
		const dir = await makeTempDir();
		try {
			await Bun.write(path.join(dir.path(), "noop.ts"), "process.exit(0);\n");
			await Bun.write(path.join(dir.path(), "changed.ts"), "await Bun.write('should-not-run.txt', 'bad');\n");
			await Bun.write(path.join(dir.path(), "package.json"), JSON.stringify({ scripts: { verify: "bun noop.ts" } }));
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-mutated
  goal: Do not trust mutated verifiers.
  level: assisted
  non_goals: ["Do not edit verifier scripts."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - ["bun", "run", "verify"]
  guardrails:
    max_iterations: 1
    max_files_changed: 2
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => {
					await Bun.write(
						path.join(dir.path(), "package.json"),
						JSON.stringify({ scripts: { verify: "bun changed.ts" } }),
					);
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons).toContain(
				"verifier package.json script verify changed before verifier execution",
			);
			await expect(fs.stat(path.join(dir.path(), "should-not-run.txt"))).rejects.toThrow();
		} finally {
			await dir.remove();
		}
	});

	it("rejects shell verifier executables without running them", async () => {
		const dir = await makeTempDir();
		try {
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: shell-verifier
  goal: Reject shell verifier.
  level: assisted
  non_goals: ["Do not edit code."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - ["sh", "-lc", "touch should-not-exist"]
  guardrails:
    max_iterations: 1
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => ({ exitCode: 0, output: "agent completed" }),
			});

			expect(result.status).toBe("failed");
			expect(result.error).toContain("not allowed");
			await expect(fs.stat(path.join(dir.path(), "should-not-exist"))).rejects.toThrow();
		} finally {
			await dir.remove();
		}
	});

	it("rejects absolute verifier runner paths", async () => {
		const dir = await makeTempDir();
		try {
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: absolute-verifier
  goal: Reject absolute verifier runner.
  level: assisted
  non_goals: ["Do not edit code."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - ["${process.execPath}", "run", "verify"]
  guardrails:
    max_iterations: 1
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => ({ exitCode: 0, output: "agent completed" }),
			});

			expect(result.status).toBe("failed");
			expect(result.error).toContain("bare package runner");
		} finally {
			await dir.remove();
		}
	});

	it("rejects verifier package script extra argv by default", async () => {
		const dir = await makeTempDir();
		try {
			await Bun.write(path.join(dir.path(), "noop.ts"), "process.exit(0);\n");
			await Bun.write(path.join(dir.path(), "package.json"), JSON.stringify({ scripts: { verify: "bun noop.ts" } }));
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-extra-args
  goal: Reject verifier arg mutation.
  level: assisted
  non_goals: ["Do not edit code."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - ["bun", "run", "verify", "--token", "ghp_1234567890abcdef1234567890abcdef1234"]
  guardrails:
    max_iterations: 1
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => ({ exitCode: 0, output: "agent completed" }),
			});

			expect(result.status).toBe("failed");
			expect(result.error).toContain("extra argv");
			const jsonl = await Bun.file(path.join(dir.path(), ".omp", "loop-runs", "verifier-extra-args.jsonl")).text();
			expect(jsonl).not.toContain("ghp_1234567890");
		} finally {
			await dir.remove();
		}
	});

	it("dry-run builds the prompt without touching durable state", async () => {
		const dir = await makeTempDir();
		try {
			const spec = parseLoopSpec(`
loop:
  name: report
  goal: Report only.
  level: report
  non_goals: ["Do not edit code."]
  runner:
    prompt: Summarize.
  verifier:
    separate: true
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				dryRun: true,
				runAgent: async () => {
					throw new Error("dry-run should not call the agent");
				},
			});

			expect(result.status).toBe("dry_run");
			expect(result.prompt).toContain("Report only.");
			await expect(fs.stat(path.join(dir.path(), ".omp", "loop-runs", "report.jsonl"))).rejects.toThrow();
		} finally {
			await dir.remove();
		}
	});
});
