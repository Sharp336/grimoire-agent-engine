#!/usr/bin/env bun

import { getWorkingTreeChangedPaths, isCI, repoRoot } from "./git-changes";

const RUST_AFFECTING_FILE_NAMES = [
	"Cargo.toml",
	"Cargo.lock",
	"build.rs",
	"rust-toolchain",
	"rust-toolchain.toml",
	"clippy.toml",
	".clippy.toml",
	"rustfmt.toml",
	".rustfmt.toml",
] as const satisfies readonly string[];
const TASK_COMMANDS = {
	"check:rs": [
		["cargo", "fmt", "--all", "--", "--check"],
		["cargo", "clippy", "--workspace", "--", "-D", "warnings"],
	],
	"fix:rs": [
		["cargo", "fmt", "--all"],
		[
			"cargo",
			"clippy",
			"--workspace",
			"--fix",
			"--allow-dirty",
			"--all-targets",
			"--no-deps",
			"--allow-staged",
			"--broken-code",
			"--allow-no-vcs",
		],
	],
	"fmt:rs": [["cargo", "fmt", "--all"]],
	"lint:rs": [["cargo", "clippy", "--workspace", "--", "-D", "warnings"]],
	"test:rs": [["cargo", "nextest", "run", "--workspace", "--status-level=fail", "--final-status-level=fail"]],
} as const satisfies Record<string, readonly (readonly string[])[]>;

type RustTaskName = keyof typeof TASK_COMMANDS;

const taskName = process.argv[2];

if (!isRustTaskName(taskName)) {
	console.error(`Unknown Rust task: ${taskName ?? "(missing)"}`);
	process.exit(1);
}

if (!(isCI() || (await hasRustAffectingChanges()))) {
	console.log(`Skipping ${taskName} (not in CI and no Rust-affecting changes were found).`);
	process.exit(0);
}

for (const command of TASK_COMMANDS[taskName]) {
	const exitCode = await runCommand(command);
	if (exitCode !== 0) {
		process.exit(exitCode);
	}
}

function isRustTaskName(value: string | undefined): value is RustTaskName {
	return value != null && value in TASK_COMMANDS;
}

async function hasRustAffectingChanges(): Promise<boolean> {
	const changedPaths = await getWorkingTreeChangedPaths();
	if (changedPaths == null) {
		console.warn(`Warning: failed to inspect git status. Running ${taskName} conservatively.`);
		return true;
	}
	return changedPaths.some(isRustAffectingPath);
}

function isRustAffectingPath(changedPath: string): boolean {
	const normalized = changedPath.replace(/\\/g, "/");
	const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
	return (
		normalized.endsWith(".rs") ||
		normalized.startsWith(".cargo/") ||
		isOneOf(fileName, RUST_AFFECTING_FILE_NAMES)
	);
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
	return values.some(entry => entry === value);
}

async function runCommand(command: readonly string[]): Promise<number> {
	const proc = Bun.spawn([...command], {
		cwd: repoRoot,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exited;
}
