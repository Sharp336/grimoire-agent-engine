#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const WORKER_RELATIVE_PATH = "packages/coding-agent/bench/agent-memory-worker.ts";
const PROMPT_RELATIVE_PATH = "packages/coding-agent/bench/agent-memory-task.md";
const DEFAULT_REF = "upstream/main";
const DEFAULT_AGENT_COUNT = 15;
const DEFAULT_IDLE_TTL_MS = 420_000;
const DEFAULT_SAMPLE_INTERVAL_MS = 100;
const OUTPUT_PREFIX = "omp-agent-memory";
const CLEARED_ENVIRONMENT_KEYS: Record<string, true> = {
	BUN_INSPECT: true,
	BUN_OPTIONS: true,
	CARGO_BUILD_TARGET: true,
	CARGO_ENCODED_RUSTFLAGS: true,
	CARGO_TARGET_DIR: true,
	GLIBC_TUNABLES: true,
	LD_PRELOAD: true,
	NODE_OPTIONS: true,
	RUSTFLAGS: true,
};
const CLEARED_ENVIRONMENT_PREFIXES = ["GIT_", "JSC_", "MALLOC_", "MIMALLOC_", "OMP_", "PI_"];

interface DriverOptions {
	ref: string;
	agentCount: number;
	idleTtlMs: number;
	sampleIntervalMs: number;
	outputDir: string;
	keepWorktree: boolean;
	dryRun: boolean;
	heapSnapshot: boolean;
}

function printLine(message: string): void {
	process.stdout.write(`${message}\n`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseInteger(name: string, value: string, minimum: number): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) {
		throw new Error(`${name} must be an integer >= ${minimum}, got ${value}`);
	}
	return parsed;
}

function nextValue(argv: string[], index: number, flag: string): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function defaultOutputDir(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(os.tmpdir(), `${OUTPUT_PREFIX}-${timestamp}`);
}

function parseArgs(argv: string[]): DriverOptions | null {
	let ref = DEFAULT_REF;
	let agentCount = DEFAULT_AGENT_COUNT;
	let idleTtlMs = DEFAULT_IDLE_TTL_MS;
	let sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
	let outputDir: string | undefined;
	let keepWorktree = false;
	let dryRun = false;
	let heapSnapshot = true;

	for (let index = 2; index < argv.length; index++) {
		const arg = argv[index]!;
		switch (arg) {
			case "--ref":
				ref = nextValue(argv, index, arg);
				index++;
				break;
			case "--agents":
				agentCount = parseInteger(arg, nextValue(argv, index, arg), 1);
				index++;
				break;
			case "--idle-ttl-ms":
				idleTtlMs = parseInteger(arg, nextValue(argv, index, arg), 0);
				index++;
				break;
			case "--sample-ms":
				sampleIntervalMs = parseInteger(arg, nextValue(argv, index, arg), 1);
				index++;
				break;
			case "--out":
				outputDir = path.resolve(REPO_ROOT, nextValue(argv, index, arg));
				index++;
				break;
			case "--keep-worktree":
				keepWorktree = true;
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--no-heap-snapshot":
				heapSnapshot = false;
				break;
			case "--help":
			case "-h":
				printLine(`Usage: bun scripts/probe-agent-memory.ts [options]

Runs a real concurrent scout batch from an isolated target-ref worktree and records
Linux RSS/PSS, anonymous mappings, Bun heap counters, lifecycle state, and a final
post-GC heap snapshot.

Options:
  --ref <git-ref>          Target ref (default: ${DEFAULT_REF})
  --agents <count>         Concurrent scouts (default: ${DEFAULT_AGENT_COUNT})
  --idle-ttl-ms <ms>       Retention TTL before parking (default: ${DEFAULT_IDLE_TTL_MS})
  --sample-ms <ms>         Running RSS/PSS interval (default: ${DEFAULT_SAMPLE_INTERVAL_MS})
  --out <path>             New artifact directory (default: /tmp/${OUTPUT_PREFIX}-*)
  --no-heap-snapshot       Skip the terminal V8 heap snapshot
  --keep-worktree          Preserve the temporary target checkout
  --dry-run                Resolve the ref and print the plan without mutation
  -h, --help               Show this help`);
				return null;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}

	return {
		ref,
		agentCount,
		idleTtlMs,
		sampleIntervalMs,
		outputDir: outputDir ?? defaultOutputDir(),
		keepWorktree,
		dryRun,
		heapSnapshot,
	};
}

async function assertLinuxProcfs(): Promise<void> {
	if (process.platform !== "linux") throw new Error("The agent memory probe requires Linux /proc");
	try {
		await Bun.file("/proc/self/smaps_rollup").text();
	} catch (error) {
		throw new Error("Cannot read /proc/self/smaps_rollup", { cause: error });
	}
}

async function resolveCommit(ref: string): Promise<string> {
	const result = await $`git rev-parse --verify ${`${ref}^{commit}`}`
		.cwd(REPO_ROOT)
		.env(probeEnvironment())
		.quiet()
		.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`Cannot resolve ${ref}: ${result.stderr.toString().trim()}`);
	}
	return result.text().trim();
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function writeJson(target: string, value: unknown): Promise<void> {
	await Bun.write(target, `${JSON.stringify(value, null, 2)}\n`);
}

function probeEnvironment(extra: Record<string, string> = {}): Record<string, string | undefined> {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (
			CLEARED_ENVIRONMENT_KEYS[key] === true ||
			CLEARED_ENVIRONMENT_PREFIXES.some(prefix => key.startsWith(prefix))
		) {
			delete env[key];
		}
	}
	return { ...env, ...extra };
}

async function runInherited(command: string[], cwd: string, env?: Record<string, string | undefined>): Promise<number> {
	const child = Bun.spawn(command, {
		cwd,
		env: env ?? probeEnvironment(),
		stdout: "inherit",
		stderr: "inherit",
	});
	return child.exited;
}

async function copyProbeAssets(worktree: string): Promise<void> {
	for (const relativePath of [WORKER_RELATIVE_PATH, PROMPT_RELATIVE_PATH]) {
		await Bun.write(path.join(worktree, relativePath), Bun.file(path.join(REPO_ROOT, relativePath)));
	}
}

async function removeWorktree(worktree: string, tempRoot: string, added: boolean): Promise<void> {
	if (!added) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		return;
	}

	const result = await $`git worktree remove --force ${worktree}`
		.cwd(REPO_ROOT)
		.env(probeEnvironment())
		.quiet()
		.nothrow();
	if (result.exitCode === 0) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		return;
	}

	await fs.rm(tempRoot, { recursive: true, force: true });
	const pruneResult = await $`git worktree prune`.cwd(REPO_ROOT).env(probeEnvironment()).quiet().nothrow();
	if (pruneResult.exitCode !== 0) {
		throw new Error(
			`Failed to remove probe worktree: ${result.stderr.toString().trim()}; ` +
				`git worktree prune failed: ${pruneResult.stderr.toString().trim()}`,
		);
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv);
	if (!options) return;
	await assertLinuxProcfs();
	const commit = await resolveCommit(options.ref);

	if (options.dryRun) {
		printLine(`ref=${options.ref}`);
		printLine(`commit=${commit}`);
		printLine(`agents=${options.agentCount}`);
		printLine(`idle_ttl_ms=${options.idleTtlMs}`);
		printLine(`sample_ms=${options.sampleIntervalMs}`);
		printLine(`heap_snapshot=${options.heapSnapshot}`);
		printLine(`output=${options.outputDir}`);
		return;
	}

	if (await pathExists(options.outputDir)) throw new Error(`Output path already exists: ${options.outputDir}`);
	await fs.mkdir(options.outputDir, { recursive: true, mode: 0o700 });
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${OUTPUT_PREFIX}-worktree-`));
	const worktree = path.join(tempRoot, "checkout");
	const metadataPath = path.join(options.outputDir, "driver.json");
	const startedAt = new Date().toISOString();
	let worktreeAdded = false;
	let failure: unknown;
	let workerExitCode: number | undefined;

	await writeJson(metadataPath, {
		status: "running",
		startedAt,
		targetRef: options.ref,
		targetCommit: commit,
		worktree,
		...options,
	});

	try {
		printLine(`target=${options.ref}@${commit.slice(0, 12)}`);
		printLine(`output=${options.outputDir}`);
		const addResult = await $`git worktree add --detach ${worktree} ${commit}`
			.cwd(REPO_ROOT)
			.env(probeEnvironment())
			.quiet()
			.nothrow();
		if (addResult.exitCode !== 0) {
			throw new Error(`Failed to create probe worktree: ${addResult.stderr.toString().trim()}`);
		}
		worktreeAdded = true;

		printLine("install=running");
		const installExitCode = await runInherited([process.execPath, "install", "--frozen-lockfile"], worktree);
		if (installExitCode !== 0) throw new Error(`bun install exited ${installExitCode}`);
		printLine("native_build=running");
		const nativeBuildExitCode = await runInherited([process.execPath, "run", "build:native"], worktree);
		if (nativeBuildExitCode !== 0) throw new Error(`bun run build:native exited ${nativeBuildExitCode}`);
		await copyProbeAssets(worktree);

		const workerArgs = [
			process.execPath,
			WORKER_RELATIVE_PATH,
			"--agents",
			String(options.agentCount),
			"--idle-ttl-ms",
			String(options.idleTtlMs),
			"--sample-ms",
			String(options.sampleIntervalMs),
		];
		if (!options.heapSnapshot) workerArgs.push("--no-heap-snapshot");

		printLine("workload=running");
		workerExitCode = await runInherited(
			workerArgs,
			worktree,
			probeEnvironment({
				OMP_MEMORY_PROBE_OUTPUT: options.outputDir,
				OMP_MEMORY_PROBE_REF: options.ref,
				OMP_MEMORY_PROBE_COMMIT: commit,
			}),
		);
		if (workerExitCode !== 0) throw new Error(`Probe worker exited ${workerExitCode}`);
	} catch (error) {
		failure = error;
	}

	if (!options.keepWorktree) {
		try {
			await removeWorktree(worktree, tempRoot, worktreeAdded);
		} catch (error) {
			failure ??= error;
		}
	} else {
		printLine(`worktree=${worktree}`);
	}

	await writeJson(metadataPath, {
		status: failure ? "failed" : "completed",
		startedAt,
		completedAt: new Date().toISOString(),
		targetRef: options.ref,
		targetCommit: commit,
		worktree: options.keepWorktree ? worktree : null,
		workerExitCode,
		error: failure ? errorMessage(failure) : null,
		...options,
	});

	if (failure) throw failure;
	printLine(`completed=${options.outputDir}`);
}

main().catch(error => {
	process.stderr.write(`agent-memory probe failed: ${errorMessage(error)}\n`);
	process.exitCode = 1;
});
