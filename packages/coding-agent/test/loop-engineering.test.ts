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
			const verifier = path.join(dir.path(), "verify.js");
			await Bun.write(
				verifier,
				[
					"const data = require('./fixture.json');",
					"const fs = require('fs');",
					"const path = require('path');",
					"const expected = ['ok'];",
					"const label = 'binding';",
					"const config = { binding: true };",
					"const { process: proc } = globalThis;",
					"proc.cwd();",
					"function binding() { return label; }",
					"binding();",
					"if (true) { ['o', 'k'].join(''); }",
					"const outputPath = path.join(process.cwd(), 'verified.txt');",
					"fs.writeFileSync(outputPath, data.expected || ['o', 'k'].join('') || expected[0] || config.binding);",
					"",
				].join("\n"),
			);
			await Bun.write(path.join(dir.path(), "fixture.json"), JSON.stringify({ expected: "ok" }));
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node verify.js" } }),
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

	it("ignores project-local runtime shims created before verifier execution", async () => {
		const dir = await makeTempDir();
		const originalPath = process.env.PATH;
		try {
			await Bun.write(path.join(dir.path(), "verify.js"), "require('fs').writeFileSync('verified.txt', 'ok');\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node verify.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: runtime-shim
  goal: Do not trust local runtime shims.
  level: assisted
  non_goals: ["Do not edit verifier files."]
  scope:
    paths: ["."]
  runner:
    prompt: Try nothing.
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
			process.env.PATH = [".", "bin", originalPath ?? ""].join(path.delimiter);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => {
					for (const shim of [
						path.join(dir.path(), "node"),
						path.join(dir.path(), "bin", "node"),
						path.join(dir.path(), "node_modules", ".bin", "node"),
					]) {
						await fs.mkdir(path.dirname(shim), { recursive: true });
						await Bun.write(shim, "#!/bin/sh\necho hijacked > hijacked.txt\n");
						await fs.chmod(shim, 0o755);
					}
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("passed");
			expect(await Bun.file(path.join(dir.path(), "verified.txt")).text()).toBe("ok");
			await expect(fs.stat(path.join(dir.path(), "hijacked.txt"))).rejects.toThrow();
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			await dir.remove();
		}
	});

	it("ignores project-local runtime shims when launched through a symlinked project cwd", async () => {
		const dir = await makeTempDir();
		const originalPath = process.env.PATH;
		try {
			const real = path.join(dir.path(), "real");
			const link = path.join(dir.path(), "link");
			await fs.mkdir(real, { recursive: true });
			await fs.symlink("real", link, "dir");
			await Bun.write(path.join(real, "verify.js"), "require('fs').writeFileSync('verified.txt', 'ok');\n");
			await Bun.write(path.join(real, "package.json"), JSON.stringify({ scripts: { verify: "node verify.js" } }));
			await initCleanGitRepo(real);
			const spec = parseLoopSpec(`
loop:
  name: symlink-cwd-runtime-shim
  goal: Do not trust local runtime shims from real cwd paths.
  level: assisted
  non_goals: ["Do not edit verifier files."]
  scope:
    paths: ["."]
  runner:
    prompt: Try nothing.
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
			process.env.PATH = [path.join(real, "bin"), originalPath ?? ""].join(path.delimiter);
			const result = await executeLoopIteration(spec, {
				cwd: link,
				runAgent: async () => {
					const shim = path.join(real, "bin", "node");
					await fs.mkdir(path.dirname(shim), { recursive: true });
					await Bun.write(shim, "#!/bin/sh\necho hijacked > hijacked.txt\n");
					await fs.chmod(shim, 0o755);
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("passed");
			expect(await Bun.file(path.join(real, "verified.txt")).text()).toBe("ok");
			await expect(fs.stat(path.join(real, "hijacked.txt"))).rejects.toThrow();
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			await dir.remove();
		}
	});

	it("freezes verifier runtime path before agents can add external PATH shims", async () => {
		const dir = await makeTempDir();
		const external = await makeTempDir();
		const originalPath = process.env.PATH;
		try {
			await Bun.write(path.join(dir.path(), "verify.js"), "require('fs').writeFileSync('verified.txt', 'ok');\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node verify.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: external-path-runtime-shim
  goal: Do not trust external runtime shims created by an agent.
  level: assisted
  non_goals: ["Do not edit verifier files."]
  scope:
    paths: ["."]
  runner:
    prompt: Try nothing.
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
			const nonExecutableShim = path.join(external.path(), "node");
			await Bun.write(nonExecutableShim, "#!/bin/sh\necho should-not-run > hijacked.txt\n");
			await fs.chmod(nonExecutableShim, 0o644);
			process.env.PATH = [external.path(), originalPath ?? ""].join(path.delimiter);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => {
					const shim = path.join(external.path(), "node");
					await Bun.write(shim, "#!/bin/sh\necho hijacked > hijacked.txt\n");
					await fs.chmod(shim, 0o755);
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("passed");
			expect(await Bun.file(path.join(dir.path(), "verified.txt")).text()).toBe("ok");
			await expect(fs.stat(path.join(dir.path(), "hijacked.txt"))).rejects.toThrow();
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			await external.remove();
			await dir.remove();
		}
	});

	it("skips external runtime symlinks that resolve back into the project", async () => {
		const dir = await makeTempDir();
		const external = await makeTempDir();
		const originalPath = process.env.PATH;
		try {
			const localRuntime = path.join(dir.path(), "node");
			await Bun.write(localRuntime, "#!/bin/sh\necho hijacked > hijacked.txt\n");
			await fs.chmod(localRuntime, 0o755);
			await fs.symlink(localRuntime, path.join(external.path(), "node"));
			await Bun.write(path.join(dir.path(), "verify.js"), "require('fs').writeFileSync('verified.txt', 'ok');\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node verify.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: project-runtime-symlink
  goal: Ignore PATH runtimes that resolve back into the project.
  level: assisted
  non_goals: ["Do not edit verifier files."]
  scope:
    paths: ["."]
  runner:
    prompt: Try nothing.
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
			process.env.PATH = [external.path(), originalPath ?? ""].join(path.delimiter);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => ({ exitCode: 0, output: "agent completed" }),
			});

			expect(result.status).toBe("passed");
			expect(await Bun.file(path.join(dir.path(), "verified.txt")).text()).toBe("ok");
			await expect(fs.stat(path.join(dir.path(), "hijacked.txt"))).rejects.toThrow();
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			await external.remove();
			await dir.remove();
		}
	});

	it("rejects verifier runtime paths replaced after preflight", async () => {
		const dir = await makeTempDir();
		const external = await makeTempDir();
		const originalPath = process.env.PATH;
		try {
			const runtimeShim = path.join(external.path(), "bun");
			await Bun.write(runtimeShim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
			await fs.chmod(runtimeShim, 0o755);
			await Bun.write(path.join(dir.path(), "verify.js"), "require('fs').writeFileSync('verified.txt', 'ok');\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "bun verify.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: replaced-runtime-shim
  goal: Fail if an agent mutates the resolved verifier runtime.
  level: assisted
  non_goals: ["Do not edit verifier files."]
  scope:
    paths: ["."]
  runner:
    prompt: Try nothing.
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
			process.env.PATH = [external.path(), originalPath ?? ""].join(path.delimiter);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => {
					await Bun.write(runtimeShim, "#!/bin/sh\necho hijacked > hijacked.txt\n");
					await fs.chmod(runtimeShim, 0o755);
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons).toContain("verifier runtime changed before verifier execution");
			await expect(fs.stat(path.join(dir.path(), "verified.txt"))).rejects.toThrow();
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			await external.remove();
			await dir.remove();
		}
	});

	it("scrubs verifier runtime option environment variables before execution", async () => {
		const dir = await makeTempDir();
		const originalNodeOptions = process.env.NODE_OPTIONS;
		try {
			await Bun.write(path.join(dir.path(), "verify.js"), "require('fs').writeFileSync('verified.txt', 'ok');\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node verify.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: env-injection
  goal: Do not trust parent runtime option env vars.
  level: assisted
  non_goals: ["Do not edit verifier files."]
  scope:
    paths: ["."]
  runner:
    prompt: Try nothing.
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
			process.env.NODE_OPTIONS = "--require ./hijack.js";
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => {
					await Bun.write(
						path.join(dir.path(), "hijack.js"),
						"require('fs').writeFileSync('hijacked.txt', 'bad');\n",
					);
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("passed");
			expect(await Bun.file(path.join(dir.path(), "verified.txt")).text()).toBe("ok");
			await expect(fs.stat(path.join(dir.path(), "hijacked.txt"))).rejects.toThrow();
		} finally {
			if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = originalNodeOptions;
			await dir.remove();
		}
	});

	it("fails closed before the agent when verifier PATH has no safe runtime entries", async () => {
		const dir = await makeTempDir();
		const originalPath = process.env.PATH;
		try {
			await Bun.write(path.join(dir.path(), "verify.js"), "require('fs').writeFileSync('verified.txt', 'ok');\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node verify.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: empty-safe-path
  goal: Do not spawn verifiers without a safe PATH.
  level: assisted
  non_goals: ["Do not edit verifier files."]
  scope:
    paths: ["."]
  runner:
    prompt: Try nothing.
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
			process.env.PATH = dir.path();
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => {
					await Bun.write(path.join(dir.path(), "node"), "#!/bin/sh\necho hijacked > hijacked.txt\n");
					await fs.chmod(path.join(dir.path(), "node"), 0o755);
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("failed");
			expect(result.error).toContain("verifier PATH has no safe absolute runtime entries");
			await expect(fs.stat(path.join(dir.path(), "hijacked.txt"))).rejects.toThrow();
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
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
			const verifier = path.join(dir.path(), "noop.js");
			await Bun.write(verifier, "process.exit(0);\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node noop.js" } }),
			);
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
					const slackToken = ["xoxb", "1234567890", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-");
					return {
						exitCode: 0,
						output: `agent completed with api_key=SECRET_TOKEN_123456 Authorization: Bearer ghp_1234567890abcdef1234567890abcdef1234 AWS_SECRET_ACCESS_KEY=ABCDEFGHIJKLMNOPQRST SLACK_BOT_TOKEN=${slackToken} bare_slack ${slackToken}`,
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
			expect(jsonl).not.toContain(["xoxb", "1234567890"].join("-"));
		} finally {
			await dir.remove();
		}
	});

	it("requires approval when assisted loops start from a dirty baseline", async () => {
		const dir = await makeTempDir();
		try {
			const verifier = path.join(dir.path(), "noop.js");
			await Bun.write(verifier, "process.exit(0);\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node noop.js" } }),
			);
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
			await Bun.write(path.join(dir.path(), "noop.js"), "process.exit(0);\n");
			await Bun.write(
				path.join(dir.path(), "changed.js"),
				"require('fs').writeFileSync('should-not-run.txt', 'bad');\n",
			);
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node noop.js" } }),
			);
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
						JSON.stringify({ scripts: { verify: "node changed.js" } }),
					);
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons).toContain("verifier package.json changed before verifier execution");
			await expect(fs.stat(path.join(dir.path(), "should-not-run.txt"))).rejects.toThrow();
		} finally {
			await dir.remove();
		}
	});

	it("requires approval if the agent changes verifier implementation files before verification", async () => {
		const dir = await makeTempDir();
		try {
			await Bun.write(path.join(dir.path(), "verify.js"), "require('fs').writeFileSync('verified.txt', 'ok');\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node verify.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-file-mutated
  goal: Do not trust mutated verifier files.
  level: assisted
  non_goals: ["Do not edit verifier files."]
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
					await Bun.write(path.join(dir.path(), "verify.js"), "process.exit(0);\n");
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons).toContain(
				"verifier referenced file verify.js changed before verifier execution",
			);
			await expect(fs.stat(path.join(dir.path(), "verified.txt"))).rejects.toThrow();
		} finally {
			await dir.remove();
		}
	});

	it("requires approval if the agent changes verifier helper dependencies before verification", async () => {
		const dir = await makeTempDir();
		try {
			await Bun.write(
				path.join(dir.path(), "verify.js"),
				"require('./helper.js');\nrequire('fs').writeFileSync('verified.txt', 'ok');\n",
			);
			await Bun.write(path.join(dir.path(), "helper.js"), "module.exports = true;\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node verify.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-helper-mutated
  goal: Do not trust mutated verifier helpers.
  level: assisted
  non_goals: ["Do not edit verifier helpers."]
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
					await Bun.write(path.join(dir.path(), "helper.js"), "module.exports = false;\n");
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons).toContain(
				"verifier referenced file helper.js changed before verifier execution",
			);
			await expect(fs.stat(path.join(dir.path(), "verified.txt"))).rejects.toThrow();
		} finally {
			await dir.remove();
		}
	});

	it("requires approval if the agent changes extensionless verifier implementation files", async () => {
		const dir = await makeTempDir();
		try {
			await fs.mkdir(path.join(dir.path(), "scripts"), { recursive: true });
			await Bun.write(
				path.join(dir.path(), "scripts", "check.js"),
				"require('fs').writeFileSync('verified.txt', 'ok');\n",
			);
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node scripts/check.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-extensionless-mutated
  goal: Do not trust extensionless verifier files.
  level: assisted
  non_goals: ["Do not edit verifier files."]
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
					await Bun.write(path.join(dir.path(), "scripts", "check.js"), "process.exit(0);\n");
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons).toContain(
				"verifier referenced file scripts/check.js changed before verifier execution",
			);
			await expect(fs.stat(path.join(dir.path(), "verified.txt"))).rejects.toThrow();
		} finally {
			await dir.remove();
		}
	});

	it("requires approval if the agent changes bare extensionless verifier operands", async () => {
		const dir = await makeTempDir();
		try {
			await Bun.write(path.join(dir.path(), "check.js"), "require('fs').writeFileSync('verified.txt', 'ok');\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node check.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-bare-extensionless-mutated
  goal: Do not trust bare verifier operands.
  level: assisted
  non_goals: ["Do not edit verifier files."]
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
					await Bun.write(path.join(dir.path(), "check.js"), "process.exit(0);\n");
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons).toContain(
				"verifier referenced file check.js changed before verifier execution",
			);
			await expect(fs.stat(path.join(dir.path(), "verified.txt"))).rejects.toThrow();
		} finally {
			await dir.remove();
		}
	});

	it("rejects pre-entrypoint runner flags before running an agent", async () => {
		const dir = await makeTempDir();
		try {
			await Bun.write(
				path.join(dir.path(), "loader.mjs"),
				"export async function resolve(s,c,n){return n(s,c);} export async function load(u,c,n){return n(u,c);}\n",
			);
			await Bun.write(path.join(dir.path(), "check.js"), "require('fs').writeFileSync('verified.txt', 'ok');\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node --loader ./loader.mjs check" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-flagged-bare-mutated
  goal: Do not trust bare verifier operands hidden behind flags.
  level: assisted
  non_goals: ["Do not edit verifier files."]
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
					throw new Error("agent should not run after verifier preflight failure");
				},
			});

			expect(result.status).toBe("failed");
			expect(result.error).toContain(
				"verifier package scripts must execute a local verifier file through an approved runtime",
			);
			await expect(fs.stat(path.join(dir.path(), "verified.txt"))).rejects.toThrow();
		} finally {
			await dir.remove();
		}
	});

	it("requires approval if the agent creates an absent verifier implementation file before verification", async () => {
		const dir = await makeTempDir();
		try {
			await fs.mkdir(path.join(dir.path(), "scripts"), { recursive: true });
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node scripts/check.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-absent-file-created
  goal: Do not trust newly created verifier files.
  level: assisted
  non_goals: ["Do not edit verifier files."]
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
					await Bun.write(path.join(dir.path(), "scripts", "check.js"), "process.exit(0);\n");
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons).toContain(
				"verifier referenced file scripts/check.js changed before verifier execution",
			);
		} finally {
			await dir.remove();
		}
	});

	it("requires approval if the agent adds verifier lifecycle hooks before verification", async () => {
		const dir = await makeTempDir();
		try {
			await Bun.write(path.join(dir.path(), "noop.js"), "process.exit(0);\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node noop.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-hook-mutated
  goal: Do not trust mutated verifier hooks.
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
						JSON.stringify({ scripts: { preverify: "node should-not-run.js", verify: "node noop.js" } }),
					);
					await Bun.write(
						path.join(dir.path(), "should-not-run.js"),
						"require('fs').writeFileSync('hook-ran.txt', 'bad');\n",
					);
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons).toContain("verifier package.json changed before verifier execution");
			await expect(fs.stat(path.join(dir.path(), "hook-ran.txt"))).rejects.toThrow();
		} finally {
			await dir.remove();
		}
	});

	it("rejects unsafe package verifier script shapes before running an agent", async () => {
		const cases: Array<{
			name: string;
			scripts: Record<string, string>;
			files?: Record<string, string>;
			dirs?: string[];
			error: string;
		}> = [
			{
				name: "existing-lifecycle",
				scripts: { preverify: "node precheck.js", verify: "node noop.js" },
				files: { "noop.js": "process.exit(0);\n", "precheck.js": "process.exit(0);\n" },
				error: "verifier lifecycle script preverify is not allowed",
			},
			{
				name: "relative-runtime",
				scripts: { verify: "./node verify.js" },
				error: "verifier package scripts must execute a local verifier file through an approved runtime",
			},
			{
				name: "absolute-runtime",
				scripts: { verify: "/tmp/node verify.js" },
				error: "verifier package scripts must execute a local verifier file through an approved runtime",
			},
			{
				name: "dynamic-require",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "const helper = './helper.js';\nrequire(helper);\n" },
				error: "verifier dependencies must use literal imports",
			},
			{
				name: "dynamic-import",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "const helper = './helper.js';\nawait import(helper);\n" },
				error: "verifier dependencies must use literal imports",
			},
			{
				name: "dynamic-computed-import",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "await import('./' + 'helper.mjs');\n" },
				error: "verifier dependencies must use literal imports",
			},
			{
				name: "dynamic-commented-require",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "const helper = './helper.js';\nrequire/**/(helper);\n" },
				error: "verifier dependencies must use literal imports",
			},
			{
				name: "dynamic-commented-import",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "const helper = './helper.js';\nawait import/**/(helper);\n" },
				error: "verifier dependencies must use literal imports",
			},
			{
				name: "module-require",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "module.require('./helper.js');\n" },
				error: "verifier dependency ./helper.js could not be resolved",
			},
			{
				name: "dynamic-optional-require",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "const helper = './helper.js';\nrequire?.(helper);\n" },
				error: "verifier dependencies must use literal imports",
			},
			{
				name: "dynamic-bracket-require",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "module['require']('./helper.js');\n" },
				error: "verifier dependencies must use literal imports",
			},
			{
				name: "dynamic-require-call",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "require.call(null, './helper.js');\n" },
				error: "verifier dependencies must use literal imports",
			},
			{
				name: "dangerous-builtin",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": "require('child_process').execFileSync('node', ['./helper.js']);\n",
				},
				error: "verifier dependencies must not import dangerous builtins",
			},
			{
				name: "process-builtin-require-binding-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "const p = require('process');\np.binding('spawn_sync');\n" },
				error: "verifier dependencies must not import dangerous builtins",
			},
			{
				name: "node-process-builtin-require-binding-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "const p = require('node:process');\np.binding('spawn_sync');\n" },
				error: "verifier dependencies must not import dangerous builtins",
			},
			{
				name: "dynamic-code-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "Function('return 1')();\n" },
				error: "verifier dependencies must not use dynamic code APIs",
			},
			{
				name: "dynamic-code-api-comment",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "eval/**/('1');\n" },
				error: "verifier dependencies must not use dynamic code APIs",
			},
			{
				name: "dynamic-code-api-optional",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "Function?.('return 1')();\n" },
				error: "verifier dependencies must not use dynamic code APIs",
			},
			{
				name: "dynamic-code-api-call",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "eval.call(null, '1');\n" },
				error: "verifier dependencies must not use dynamic code APIs",
			},
			{
				name: "dynamic-code-constructor",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "({}).constructor.constructor('return 1')();\n" },
				error: "verifier dependencies must not use dynamic code APIs",
			},
			{
				name: "escaped-dynamic-code-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "\\u0065val('1');\n" },
				error: "verifier dependencies must not use escaped identifiers",
			},
			{
				name: "dynamic-property-global",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "globalThis?.['Fun' + 'ction']('return 1')();\n" },
				error: "verifier dependencies must not use dynamic property access",
			},
			{
				name: "dynamic-property-variable-key",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "const key = 'Fun' + 'ction';\nglobalThis[key]('return 1')();\n" },
				error: "verifier dependencies must not use dynamic property access",
			},
			{
				name: "dynamic-property-unicode-receiver",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const π = process;\nπ["bind" + "ing"]("spawn_sync");\n' },
				error: "verifier dependencies must not use dynamic property access",
			},
			{
				name: "dynamic-code-worker",
				scripts: { verify: "bun verify.js" },
				files: { "verify.js": "new Worker('./helper.js');\n" },
				error: "verifier dependencies must not use dynamic code APIs",
			},
			{
				name: "dynamic-code-webassembly",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js":
						"const fs = require('fs');\n(async () => WebAssembly.instantiate(await fs.promises.readFile('./addon.wasm')))();\n",
					"addon.wasm": "",
				},
				error: "verifier dependencies must not use dynamic code APIs",
			},
			{
				name: "process-binding-optional-bracket-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "process?.['binding']('spawn_sync');\n" },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-comment-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "process/**/.binding('spawn_sync');\n" },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'Reflect.get(process, "binding")("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-descriptor-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'Object.getOwnPropertyDescriptor(process, "binding")?.value("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-alias-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const p = process;\np.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-logical-alias-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const p = process || {};\np.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-conditional-alias-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const p = true ? globalThis.process : {};\np.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-alias-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const p = Reflect.get(globalThis, "process");\np.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-call-argument-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": '((p) => p.binding("spawn_sync"))(process);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-named-call-argument-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'function f(p) { p.binding("spawn_sync"); }\nf(process);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-parameter-destructure-call-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'function f({ binding }) { binding("spawn_sync"); }\nf(process);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-spread-call-argument-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": '((p) => p.binding("spawn_sync"))(...[process]);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-array-alias-spread-call-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const a = [process];\nfunction f(p) { p.binding("spawn_sync"); }\nf(...a);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-wrapped-call-argument-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": '((o) => o.p.binding("spawn_sync"))({ p: process });\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-function-return-call-argument-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": '((get) => get().binding("spawn_sync"))(() => process);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-function-local-alias-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'function f() { const p = process; p.binding("spawn_sync"); }\nf();\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-shadow-reassigned-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js":
						'function f(process) { process = globalThis.process; process.binding("spawn_sync"); }\nf({});\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-shadow-closure-reassigned-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js":
						'function f(process) { const assign = () => { process = globalThis.process; }; assign(); process.binding("spawn_sync"); }\nf({});\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-shadow-closure-local-reassigned-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js":
						'function f(process) { let p = {}; const assign = () => { p = globalThis.process; }; assign(); p.binding("spawn_sync"); }\nf({});\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-shadow-closure-destructure-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js":
						'function f() { let p; const assign = () => { ({ process: p } = globalThis); }; assign(); p.binding("spawn_sync"); }\nf();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-closure-reassigned-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js":
						'function f(g) { const assign = () => { g = globalThis; }; assign(); g.process.binding("spawn_sync"); }\nf({});\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-method-call-argument-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": '((o) => o.get().binding("spawn_sync"))({ get() { return process; } });\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-parameter-default-call-argument-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": '((fn) => fn().binding("spawn_sync"))((x = process) => x);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-alias-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const g = globalThis;\ng.process.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-object-destructure-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { globalThis: { process: p } } = globalThis;\np.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-self-property-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'globalThis.globalThis.process.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-bun-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'globalThis.Bun.spawnSync(["true"]);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-deno-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'globalThis.Deno.Command("true").outputSync();\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-global-bun-alias-api",
				scripts: { verify: "bun verify.js" },
				files: { "verify.js": 'const g = globalThis;\nReflect.get(g, "Bun").spawnSync(["true"]);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-reflect-global-bun-api",
				scripts: { verify: "bun verify.js" },
				files: { "verify.js": 'const g = globalThis;\nglobalThis.Reflect.get(g, "Bun").spawnSync(["true"]);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-apply-global-process-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": 'Reflect.apply(Reflect.get, Reflect, [globalThis, "process"]).binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-get-sequence-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": '(0, Reflect.get)(globalThis, "process").binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-get-sequence-target-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": 'Reflect.get((0, globalThis), "process").binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "dynamic-constructor-chain-computed-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": '({})["con" + "structor"]["con" + "structor"]("return 1")();\n',
				},
				error: "verifier dependencies must not use dynamic property access",
			},
			{
				name: "process-binding-global-object-container-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": 'const holder = { g: globalThis };\nholder.g.process.binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-return-function-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js": 'const getGlobal = () => globalThis;\ngetGlobal().Bun.spawnSync(["true"]);\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-call-argument-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": '((g) => g.process.binding("spawn_sync"))(globalThis);\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-throw-global-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js": 'try { throw globalThis; } catch (g) { g.Bun.spawnSync(["true"]); }\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-global-wrapper-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": 'Object(globalThis).process.binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-global-bun-wrapper-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js": 'Object(globalThis).Bun.spawnSync(["true"]);\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-create-global-wrapper-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": 'Object.create(globalThis).process.binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-parameter-default-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": '((g = globalThis) => g.process.binding("spawn_sync"))();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-tagged-template-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js": ['((_, g) => g.Bun.spawnSync(["true"]))`', "$", "{globalThis}", "`;\n"].join(""),
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-bun-literal-destructure-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js": 'const { "Bun": b } = globalThis;\nb.spawnSync(["true"]);\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-deno-assignment-destructure-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": 'let d;\n({ Deno: d } = globalThis);\nd.Command("true").outputSync();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-member-assignment-container-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": 'const holder = {};\nholder.g = globalThis;\nholder.g.process.binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-array-assignment-container-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js": 'const holder = [];\nholder[0] = globalThis;\nholder[0].Bun.spawnSync(["true"]);\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-method-member-assignment-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js":
						'const holder = {};\nholder.get = Reflect.get;\nholder.get(globalThis, "process").binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-method-container-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js":
						'const holder = { get: Reflect.get };\nholder.get(globalThis, "process").binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-object-alias-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": 'const R = Reflect;\nR.get(globalThis, "process").binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-object-container-alias-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js": 'const holder = { R: Reflect };\nholder.R.get(globalThis, "Bun").spawnSync(["true"]);\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-object-alias-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js":
						'const O = Object;\nO.getOwnPropertyDescriptor(globalThis, "process").value.getBuiltinModule("child_process").execSync("true");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-tagged-template-process-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": [
						'((_, p) => p.getBuiltinModule("child_process").execSync("true"))`',
						"$",
						"{process}",
						"`;\n",
					].join(""),
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-throw-process-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js":
						'try { throw process; } catch (p) { p.getBuiltinModule("child_process").execSync("true"); }\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-yield-process-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": 'function* leak(){ yield process; }\nleak().next().value.binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-class-field-process-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": 'class Leak { static p = process; }\nLeak.p.binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-exported-process-dependency-api",
				scripts: { verify: "node verify.mjs" },
				files: {
					"verify.mjs": 'import p from "./proc.mjs";\np.binding("spawn_sync");\n',
					"proc.mjs": "export default process;\n",
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-get-sequence-alias-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": 'const get = (0, Reflect.get);\nget(globalThis, "process").binding("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-global-bun-dynamic-key-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js": 'const g = globalThis;\nconst key = "Bun";\nReflect.get(g, key).spawnSync(["true"]);\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-global-bun-method-alias-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js": 'const g = globalThis;\nconst get = Reflect.get;\nget(g, "Bun").spawnSync(["true"]);\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-descriptor-global-bun-method-alias-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js":
						'function f() { const g = globalThis; const desc = Object.getOwnPropertyDescriptor; desc(g, "Bun").value.spawnSync(["true"]); }\nf();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-global-bun-method-destructure-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js": 'const g = globalThis;\nconst { get } = Reflect;\nget(g, "Bun").spawnSync(["true"]);\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-reflect-method-destructure-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js":
						'const g = globalThis;\nconst { get } = globalThis.Reflect;\nget(g, "Bun").spawnSync(["true"]);\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-descriptor-global-bun-method-destructure-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js":
						'function f() { const g = globalThis; const { getOwnPropertyDescriptor: desc } = Object; desc(g, "Bun").value.spawnSync(["true"]); }\nf();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-global-bun-call-api",
				scripts: { verify: "bun verify.js" },
				files: { "verify.js": 'const g = globalThis;\nReflect.get.call(Reflect, g, "Bun").spawnSync(["true"]);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-global-bun-bind-api",
				scripts: { verify: "bun verify.js" },
				files: { "verify.js": 'const g = globalThis;\nReflect.get.bind(Reflect)(g, "Bun").spawnSync(["true"]);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-descriptor-global-bun-bind-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js":
						'function f() { const g = globalThis; Object.getOwnPropertyDescriptor.bind(Object)(g, "Bun").value.spawnSync(["true"]); }\nf();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-global-bun-apply-args-alias-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js":
						'const g = globalThis;\nconst args = [g, "Bun"];\nReflect.get.apply(Reflect, args).spawnSync(["true"]);\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-descriptor-global-bun-apply-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js":
						'function f() { const g = globalThis; Object.getOwnPropertyDescriptor.apply(Object, [g, "Bun"]).value.spawnSync(["true"]); }\nf();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-descriptor-global-bun-alias-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js":
						'function f() { const g = globalThis; Reflect.getOwnPropertyDescriptor(g, "Bun").value.spawnSync(["true"]); }\nf();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-descriptor-global-bun-alias-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js":
						'function f() { const g = globalThis; Object.getOwnPropertyDescriptor(g, "Bun").value.spawnSync(["true"]); }\nf();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-descriptors-global-bun-alias-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js":
						'function f() { const g = globalThis; Object.getOwnPropertyDescriptors(g).Bun.value.spawnSync(["true"]); }\nf();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-descriptors-map-global-bun-alias-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js":
						'function f() { const g = globalThis; const d = Object.getOwnPropertyDescriptors(g); d.Bun.value.spawnSync(["true"]); }\nf();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-values-global-bun-alias-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js":
						'function f() { const g = globalThis; Object.values(g).find(v => v?.spawnSync)?.spawnSync(["true"]); }\nf();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-assign-global-bun-source-api",
				scripts: { verify: "bun verify.js" },
				files: {
					"verify.js":
						'function f() { const g = globalThis; Object.assign({}, g).Bun.spawnSync(["true"]); }\nf();\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-alias-process-alias-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const g = globalThis;\nconst p = g.process;\np.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-member-assignment-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const o = {};\no.p = process;\no.p.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-named-supplier-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const get = () => process;\nget().binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-function-declaration-supplier-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'function get() { return process; }\nget().binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-reflect-apply-argument-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const fn = (p) => p.binding("spawn_sync");\nReflect.apply(fn, null, [process]);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-object-call-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'Object(process).binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-destructure-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { binding } = process;\nbinding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-computed-destructure-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { ["bind" + "ing"]: b } = process;\nb("spawn_sync");\n' },
				error: "verifier dependencies must not use dynamic property access",
			},
			{
				name: "process-binding-computed-global-this-destructure-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { ["bind" + "ing"]: b } = globalThis.process;\nb("spawn_sync");\n' },
				error: "verifier dependencies must not use dynamic property access",
			},
			{
				name: "process-binding-computed-global-destructure-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { ["bind" + "ing"]: b } = global.process;\nb("spawn_sync");\n' },
				error: "verifier dependencies must not use dynamic property access",
			},
			{
				name: "process-binding-computed-nested-destructure-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { process: { ["bind" + "ing"]: b } } = globalThis;\nb("spawn_sync");\n' },
				error: "verifier dependencies must not use dynamic property access",
			},
			{
				name: "process-binding-global-destructure-alias-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { process: p } = globalThis;\np.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-global-destructure-default-alias-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { process: p = null } = globalThis;\np.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-assignment-alias-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'let p;\np = globalThis.process;\np.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-destructure-assignment-alias-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'let p;\n({ process: p } = globalThis);\np.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-direct-destructure-assignment-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'let binding;\n({ binding } = process);\nbinding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-nested-global-destructure-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { process: { binding } } = globalThis;\nbinding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-nested-global-default-destructure-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { process: { binding } = {} } = globalThis;\nbinding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-rest-destructure-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { ...p } = process;\np.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-nested-global-rest-destructure-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { process: { ...p } } = globalThis;\np.binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-computed-after-nested-object-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const { env: {}, ["bind" + "ing"]: b } = process;\nb("spawn_sync");\n' },
				error: "verifier dependencies must not use dynamic property access",
			},
			{
				name: "process-binding-computed-parameter-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'function f({ ["bind" + "ing"]: b }) { b("spawn_sync"); }\nf(process);\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-computed-bracket-string-destructure-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js": 'const { ["bind]".replace("]", "") + "ing"]: b } = process;\nb("spawn_sync");\n',
				},
				error: "verifier dependencies must not use dynamic property access",
			},
			{
				name: "process-get-builtin-module-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "process.getBuiltinModule('child_process').execSync('true');\n" },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-execution-api",
				scripts: { verify: "bun verify.js" },
				files: { "verify.js": "Bun?.spawnSync(['node', './helper.js']);\n" },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "process?.binding('spawn_sync');\n" },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-member-alias-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'const b = process.binding;\nb("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-sequence-call-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": '(0, process.binding)("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-call-method-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'process.binding.call(process, "spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-with-api",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": 'with (process) binding("spawn_sync");\n' },
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "process-binding-enumeration-api",
				scripts: { verify: "node verify.js" },
				files: {
					"verify.js":
						'const fn = Object.values(process).find(value => value?.name === "bind" + "ing");\nfn("spawn_sync");\n',
				},
				error: "verifier dependencies must not use process execution APIs",
			},
			{
				name: "native-verifier-dependency",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "require('./addon.node');\n", "addon.node": "" },
				error: "verifier dependencies must not use native or WebAssembly files",
			},
			{
				name: "wasm-verifier-dependency",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "require('./addon.wasm');\n", "addon.wasm": "" },
				error: "verifier dependencies must not use native or WebAssembly files",
			},
			{
				name: "native-verifier-entrypoint",
				scripts: { verify: "node ./addon.node" },
				files: { "addon.node": "" },
				error: "verifier package scripts must execute a local verifier file through an approved runtime",
			},
			{
				name: "wasm-verifier-entrypoint",
				scripts: { verify: "bun ./addon.wasm" },
				files: { "addon.wasm": "" },
				error: "verifier package scripts must not invoke nested package scripts",
			},
			{
				name: "nested-package-runner",
				scripts: { verify: "bun run check", check: "node scripts/check.js" },
				files: { "scripts/check.js": "process.exit(0);\n" },
				error: "verifier package scripts must not invoke nested package scripts",
			},
			{
				name: "directory-operand",
				scripts: { verify: "node ./scripts" },
				dirs: ["scripts"],
				files: { "scripts/index.js": "process.exit(0);\n" },
				error: "verifier referenced file must be a file",
			},
			{
				name: "unsupported-runner-subcommand",
				scripts: { verify: "deno unknown" },
				error: "verifier package scripts must not use runner subcommands",
			},
			{
				name: "glob-expansion",
				scripts: { verify: "node scripts/*.js" },
				error: "verifier package scripts must not use shell expansion, escaping, or metacharacters",
			},
			{
				name: "escaped-path",
				scripts: { verify: "node verify\\.js" },
				error: "verifier package scripts must not use shell expansion, escaping, or metacharacters",
			},
			{
				name: "node-run-delegation",
				scripts: { verify: "node --run check", check: "node check.js" },
				error: "verifier package scripts must not delegate through node --run",
			},
			{
				name: "node-eval-short-circuit",
				scripts: { verify: "node -e 0 verify.js" },
				error: "verifier package scripts must execute a local verifier file through an approved runtime",
			},
			{
				name: "node-double-dash-dash-script",
				scripts: { verify: "node -- -e verify.js" },
				error: "verifier package scripts must execute a local verifier file through an approved runtime",
			},
			{
				name: "newline-command",
				scripts: { verify: "node verify.js\nnode other.js" },
				error: "verifier package scripts must not use shell expansion, escaping, or metacharacters",
			},
			{
				name: "extensionless-entrypoint",
				scripts: { verify: "node check" },
				error: "verifier package scripts must execute a local verifier file through an approved runtime",
			},
			{
				name: "extensionless-verifier-dependency",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "require('./pkg');\n", "pkg/index.js": "module.exports = true;\n" },
				error: "verifier dependencies must use explicit file extensions",
			},
			{
				name: "bare-package-import",
				scripts: { verify: "node verify.js" },
				files: { "verify.js": "require('left-pad');\n" },
				error: "verifier dependencies must use relative or node: imports",
			},
			{
				name: "bare-tool-command",
				scripts: { verify: "biome check" },
				error: "verifier package scripts must execute a local verifier file through an approved runtime",
			},
			{
				name: "url-bun-operand",
				scripts: { verify: "bun https://example.com/check.js" },
				error: "verifier package scripts must not use shell expansion, escaping, or metacharacters",
			},
		];

		for (const testCase of cases) {
			const dir = await makeTempDir();
			try {
				for (const relativeDir of testCase.dirs ?? []) {
					await fs.mkdir(path.join(dir.path(), relativeDir), { recursive: true });
				}
				for (const [relativeFile, content] of Object.entries(testCase.files ?? {})) {
					await fs.mkdir(path.dirname(path.join(dir.path(), relativeFile)), { recursive: true });
					await Bun.write(path.join(dir.path(), relativeFile), content);
				}
				await Bun.write(path.join(dir.path(), "package.json"), JSON.stringify({ scripts: testCase.scripts }));
				await initCleanGitRepo(dir.path());
				const spec = parseLoopSpec(`
loop:
  name: ${testCase.name}
  goal: Reject unsafe verifier script shapes.
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
  state:
    run_log: loop-run-log.md
`);
				const result = await executeLoopIteration(spec, {
					cwd: dir.path(),
					runAgent: async () => {
						throw new Error("agent should not run after verifier preflight failure");
					},
				});

				expect(result.status).toBe("failed");
				expect(result.error).toContain(testCase.error);
			} finally {
				await dir.remove();
			}
		}
	}, 60_000);

	it("allows verifier scripts to shadow process and global aliases in local parameters", async () => {
		const dir = await makeTempDir();
		try {
			await Bun.write(
				path.join(dir.path(), "verify.js"),
				[
					"function local(process) { return process.binding('spawn_sync'); }",
					"const p = process;",
					"function localAlias(p) { const q = p; return q.binding('spawn_sync'); }",
					"const g = globalThis;",
					"function localGlobal(g) { return g.process.binding('spawn_sync'); }",
					"function outer() { function nested(process) { return process.binding('spawn_sync'); } return 'ok'; }",
					"Object.getOwnPropertyDescriptor(globalThis, 'fetch');",
					"const result = local({ binding: () => 'ok' }) + localAlias({ binding: () => 'ok' }) + localGlobal({ process: { binding: () => 'ok' } }) + outer();",
					"require('fs').writeFileSync('verified.txt', result);",
					"",
				].join("\n"),
			);
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node verify.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: process-shadow-local-param
  goal: Allow local parameter names without exposing global process.
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
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => ({ exitCode: 0, output: "agent completed" }),
			});

			expect(result.error).toBeNull();
			expect(result.status).toBe("passed");
			await expect(Bun.file(path.join(dir.path(), "verified.txt")).text()).resolves.toBe("okokokok");
		} finally {
			await dir.remove();
		}
	}, 15000);

	it("requires approval if a subpackage verifier root config changes before verification", async () => {
		const dir = await makeTempDir();
		try {
			await fs.mkdir(path.join(dir.path(), "pkg", "scripts"), { recursive: true });
			await Bun.write(path.join(dir.path(), "biome.json"), JSON.stringify({ formatter: { enabled: true } }));
			await Bun.write(
				path.join(dir.path(), "pkg", "scripts", "check"),
				"require('fs').writeFileSync('verified.txt', 'ok');\n",
			);
			await Bun.write(
				path.join(dir.path(), "pkg", "package.json"),
				JSON.stringify({ scripts: { verify: "node scripts/check.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-root-config-mutated
  goal: Do not trust mutated root verifier config.
  level: assisted
  non_goals: ["Do not edit verifier config."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - argv: ["bun", "run", "verify"]
        cwd: pkg
  guardrails:
    max_iterations: 1
    max_files_changed: 2
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => {
					await Bun.write(path.join(dir.path(), "biome.json"), JSON.stringify({ formatter: { enabled: false } }));
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons).toContain(
				"verifier referenced file ../biome.json changed before verifier execution",
			);
			await expect(fs.stat(path.join(dir.path(), "pkg", "verified.txt"))).rejects.toThrow();
		} finally {
			await dir.remove();
		}
	});

	it("requires approval if the agent adds an absent root verifier config before verification", async () => {
		const dir = await makeTempDir();
		try {
			await fs.mkdir(path.join(dir.path(), "pkg", "scripts"), { recursive: true });
			await Bun.write(
				path.join(dir.path(), "pkg", "scripts", "check"),
				"require('fs').writeFileSync('verified.txt', 'ok');\n",
			);
			await Bun.write(
				path.join(dir.path(), "pkg", "package.json"),
				JSON.stringify({ scripts: { verify: "node scripts/check.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-root-config-created
  goal: Do not trust newly created root verifier config.
  level: assisted
  non_goals: ["Do not edit verifier config."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - argv: ["bun", "run", "verify"]
        cwd: pkg
  guardrails:
    max_iterations: 1
    max_files_changed: 2
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => {
					await Bun.write(path.join(dir.path(), "biome.json"), JSON.stringify({ formatter: { enabled: false } }));
					return { exitCode: 0, output: "agent completed" };
				},
			});

			expect(result.status).toBe("needs_approval");
			expect(result.approvalReasons).toContain(
				"verifier referenced file ../biome.json changed before verifier execution",
			);
			await expect(fs.stat(path.join(dir.path(), "pkg", "verified.txt"))).rejects.toThrow();
		} finally {
			await dir.remove();
		}
	});

	it("rejects symlinked verifier package.json before running an agent", async () => {
		const dir = await makeTempDir();
		try {
			await Bun.write(path.join(dir.path(), "noop.js"), "process.exit(0);\n");
			await Bun.write(
				path.join(dir.path(), "real-package.json"),
				JSON.stringify({ scripts: { verify: "node noop.js" } }),
			);
			await fs.symlink("real-package.json", path.join(dir.path(), "package.json"));
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-package-symlink
  goal: Reject symlinked verifier package.
  level: assisted
  non_goals: ["Do not edit verifier package."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - ["bun", "run", "verify"]
  guardrails:
    max_iterations: 1
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => {
					throw new Error("agent should not run after verifier preflight failure");
				},
			});

			expect(result.status).toBe("failed");
			expect(result.error).toContain("verifier package.json must not be a symlink");
		} finally {
			await dir.remove();
		}
	});

	it("rejects symlinked verifier cwd before running an agent", async () => {
		const dir = await makeTempDir();
		try {
			const realPkg = path.join(dir.path(), "pkg");
			await fs.mkdir(realPkg, { recursive: true });
			await Bun.write(path.join(realPkg, "noop.js"), "process.exit(0);\n");
			await Bun.write(path.join(realPkg, "package.json"), JSON.stringify({ scripts: { verify: "node noop.js" } }));
			await fs.symlink("pkg", path.join(dir.path(), "pkg-link"), "dir");
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-cwd-symlink
  goal: Reject symlinked verifier cwd.
  level: assisted
  non_goals: ["Do not edit verifier cwd."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - argv: ["bun", "run", "verify"]
        cwd: pkg-link
  guardrails:
    max_iterations: 1
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => {
					throw new Error("agent should not run after verifier preflight failure");
				},
			});

			expect(result.status).toBe("failed");
			expect(result.error).toContain("verifier cwd must not pass through a symlink");
		} finally {
			await dir.remove();
		}
	});

	it("allows verifier cwd scripts to reference files elsewhere inside the project", async () => {
		const dir = await makeTempDir();
		try {
			await fs.mkdir(path.join(dir.path(), "pkg"), { recursive: true });
			await Bun.write(path.join(dir.path(), "verify.js"), "require('fs').writeFileSync('verified.txt', 'ok');\n");
			await Bun.write(
				path.join(dir.path(), "pkg", "package.json"),
				JSON.stringify({ scripts: { verify: "node ../verify.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-cwd
  goal: Support package cwd verifiers.
  level: assisted
  non_goals: ["Do not edit verifier files."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - argv: ["bun", "run", "verify"]
        cwd: pkg
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

			expect(result.status).toBe("passed");
			expect(await Bun.file(path.join(dir.path(), "pkg", "verified.txt")).text()).toBe("ok");
		} finally {
			await dir.remove();
		}
	});

	it("rejects verifier script references that escape the project even when absent", async () => {
		const dir = await makeTempDir();
		try {
			await fs.mkdir(path.join(dir.path(), "pkg"), { recursive: true });
			await Bun.write(
				path.join(dir.path(), "pkg", "package.json"),
				JSON.stringify({ scripts: { verify: "node ../../outside.js" } }),
			);
			await initCleanGitRepo(dir.path());
			const spec = parseLoopSpec(`
loop:
  name: verifier-outside-reference
  goal: Reject outside verifier references.
  level: assisted
  non_goals: ["Do not edit verifier files."]
  runner:
    prompt: Try nothing.
  verifier:
    separate: true
    commands:
      - argv: ["bun", "run", "verify"]
        cwd: pkg
  guardrails:
    max_iterations: 1
  state:
    run_log: loop-run-log.md
`);
			const result = await executeLoopIteration(spec, {
				cwd: dir.path(),
				runAgent: async () => {
					throw new Error("agent should not run after verifier preflight failure");
				},
			});

			expect(result.status).toBe("failed");
			expect(result.error).toContain("verifier referenced file must stay inside the project");
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
			await Bun.write(path.join(dir.path(), "noop.js"), "process.exit(0);\n");
			await Bun.write(
				path.join(dir.path(), "package.json"),
				JSON.stringify({ scripts: { verify: "node noop.js" } }),
			);
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
