import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compileCodingAgent, resolveCleanSourceCommit } from "../scripts/compile-binary";

function runGit(sourceRoot: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", sourceRoot, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}

async function createCommittedSourceRoot(): Promise<string> {
	const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-compile-binary-"));
	runGit(sourceRoot, ["init", "--quiet"]);
	runGit(sourceRoot, ["config", "user.email", "omp-test@example.test"]);
	runGit(sourceRoot, ["config", "user.name", "OMP Test"]);
	await fs.writeFile(path.join(sourceRoot, "README.md"), "fixture\n");
	runGit(sourceRoot, ["add", "README.md"]);
	runGit(sourceRoot, ["commit", "--quiet", "-m", "fixture"]);
	return sourceRoot;
}

describe("compiled binary source commit", () => {
	let sourceRoot = "";

	afterEach(async () => {
		if (sourceRoot) await fs.rm(sourceRoot, { recursive: true, force: true });
		sourceRoot = "";
	});

	it("derives the clean committed lowercase HEAD", async () => {
		sourceRoot = await createCommittedSourceRoot();

		const sourceCommit = resolveCleanSourceCommit(sourceRoot);
		expect(sourceCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(sourceCommit).toBe(runGit(sourceRoot, ["rev-parse", "HEAD"]));
	});

	it("rejects dirty tracked and untracked source roots", async () => {
		sourceRoot = await createCommittedSourceRoot();
		await fs.writeFile(path.join(sourceRoot, "README.md"), "changed\n");
		expect(() => resolveCleanSourceCommit(sourceRoot)).toThrow("Refusing to build a binary from a dirty worktree");

		runGit(sourceRoot, ["checkout", "--", "README.md"]);
		await fs.writeFile(path.join(sourceRoot, "untracked.txt"), "untracked\n");
		expect(() => resolveCleanSourceCommit(sourceRoot)).toThrow("Refusing to build a binary from a dirty worktree");
	});

	it("rejects an invalid embedded source commit before bundling", async () => {
		await expect(
			compileCodingAgent({
				repoRoot: "/unused",
				entrypoint: "/unused/cli.ts",
				outfile: "/unused/omp",
				transformersVersion: "0.0.0",
				sourceCommit: "A".repeat(40),
			}),
		).rejects.toThrow("Coding-agent binary source commit must be lowercase 40-hex");
	});
});
