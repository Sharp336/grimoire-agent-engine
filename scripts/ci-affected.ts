#!/usr/bin/env bun

import * as path from "node:path";
import { getPullRequestChangedPaths, getWorkingTreeChangedPaths, repoRoot } from "./git-changes";

const WORKSPACE_PACKAGE_JSON_GLOB = "packages/*/package.json";
const NATIVE_WORKSPACE_DIR = "packages/natives";
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const ROOT_FULL_COMMANDS = {
	check: "ci:check:full",
	test: "ci:test:full",
} as const;
const ROOT_TOOLING_PREFIXES = [".github/workflows/", "scripts/"] as const;
const ROOT_RUST_PATH_PREFIXES = [".cargo/", "crates/"] as const;
const ROOT_RUST_FILE_NAMES = new Set([
	"Cargo.toml",
	"Cargo.lock",
	"build.rs",
	"rust-toolchain",
	"rust-toolchain.toml",
	"clippy.toml",
	".clippy.toml",
	"rustfmt.toml",
	".rustfmt.toml",
]);
const ROOT_TOOLING_FILE_PATTERNS = [/^package\.json$/, /^bun\.lockb?$/, /^tsconfig(?:\.[^/]+)?\.json$/, /^biome(?:\.[^/]+)?\.jsonc?$/, /^prettier(?:\.[^/]+)?(?:\.json)?$/];
const ROOT_DOC_PATTERNS = [/^docs\//, /^README(?:\.[^/]+)?$/i, /^LICENSE(?:\.[^/]+)?$/i, /^CHANGELOG(?:\.[^/]+)?$/i, /^.+\.md$/i];

type CiAction = keyof typeof ROOT_FULL_COMMANDS;

interface CliOptions {
	action: CiAction;
	dryRun: boolean;
	overrideChangedPaths: string[];
}

interface WorkspaceManifest {
	name?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

interface WorkspaceInfo {
	name: string;
	dir: string;
	scripts: Set<string>;
	workspaceDependencies: string[];
}

interface ChangedPathResult {
	changedPaths: string[];
	source: "override" | "pull_request" | "working_tree";
}

interface AffectedResolution {
	mode: "full" | "scoped" | "none";
	reason: string;
	workspaces: WorkspaceInfo[];
}

const options = parseArgs(process.argv.slice(2));
const allWorkspaces = await loadWorkspaces();
const changedPathResult = await detectChangedPaths(options.overrideChangedPaths);
const resolution = resolveAffectedWorkspaces(allWorkspaces, changedPathResult.changedPaths);

switch (resolution.mode) {
	case "none":
		console.log(`${options.action}: no affected workspaces (${changedPathResult.source}).`);
		process.exit(0);
	case "full":
		console.log(`${options.action}: running full workspace (${resolution.reason}).`);
		await runCommand(["bun", "run", ROOT_FULL_COMMANDS[options.action]], options.dryRun);
		break;
	case "scoped": {
		const runnableWorkspaces = resolution.workspaces.filter(workspace => workspace.scripts.has(options.action));
		if (runnableWorkspaces.length === 0) {
			console.log(`${options.action}: no affected workspaces define ${options.action}.`);
			process.exit(0);
		}

		console.log(
			`${options.action}: ${runnableWorkspaces.length} affected workspace${runnableWorkspaces.length === 1 ? "" : "s"} (${changedPathResult.source}).`,
		);
		for (const workspace of runnableWorkspaces) {
			console.log(`- ${workspace.name}`);
			await runCommand(["bun", "--cwd", workspace.dir, "run", options.action], options.dryRun);
		}
		break;
	}
}

function parseArgs(args: string[]): CliOptions {
	const [rawAction, ...rest] = args;
	if (rawAction !== "check" && rawAction !== "test") {
		console.error(`Usage: bun scripts/ci-affected.ts <check|test> [--dry-run] [--changed-path <path>]...`);
		process.exit(1);
	}

	const overrideChangedPaths: string[] = [];
	let dryRun = false;

	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--changed-path") {
			const changedPath = rest[index + 1];
			if (!changedPath) {
				console.error("Missing value for --changed-path.");
				process.exit(1);
			}
			overrideChangedPaths.push(normalizePath(changedPath));
			index += 1;
			continue;
		}

		console.error(`Unknown argument: ${arg}`);
		process.exit(1);
	}

	return {
		action: rawAction,
		dryRun,
		overrideChangedPaths: uniqueSorted(overrideChangedPaths),
	};
}

async function loadWorkspaces(): Promise<WorkspaceInfo[]> {
	const packageJsonPaths: string[] = [];
	for await (const packageJsonPath of new Bun.Glob(WORKSPACE_PACKAGE_JSON_GLOB).scan({ cwd: repoRoot })) {
		packageJsonPaths.push(normalizePath(packageJsonPath));
	}
	packageJsonPaths.sort((left, right) => left.localeCompare(right));

	const packageNames = new Set<string>();
	const workspaceDrafts: Array<{ dir: string; manifest: WorkspaceManifest; name: string }> = [];
	for (const packageJsonPath of packageJsonPaths) {
		const manifest = (await Bun.file(path.join(repoRoot, packageJsonPath)).json()) as WorkspaceManifest;
		const name = manifest.name?.trim();
		if (!name) {
			throw new Error(`Missing package name in ${packageJsonPath}`);
		}
		packageNames.add(name);
		workspaceDrafts.push({ dir: path.dirname(packageJsonPath), manifest, name });
	}

	return workspaceDrafts.map(({ dir, manifest, name }) => ({
		name,
		dir,
		scripts: new Set(Object.keys(manifest.scripts ?? {})),
		workspaceDependencies: DEPENDENCY_FIELDS.flatMap((field) => {
			const dependencies = manifest[field] ?? {};
			return Object.keys(dependencies).filter(dependencyName => packageNames.has(dependencyName));
		}),
	}));
}

async function detectChangedPaths(overrideChangedPaths: readonly string[]): Promise<ChangedPathResult> {
	if (overrideChangedPaths.length > 0) {
		return { changedPaths: uniqueSorted(overrideChangedPaths), source: "override" };
	}

	const pullRequestChangedPaths = await getPullRequestChangedPaths();
	if (pullRequestChangedPaths != null) {
		return { changedPaths: pullRequestChangedPaths, source: "pull_request" };
	}

	const workingTreeChangedPaths = await getWorkingTreeChangedPaths();
	if (workingTreeChangedPaths != null) {
		return { changedPaths: workingTreeChangedPaths, source: "working_tree" };
	}

	throw new Error("Unable to determine changed files from pull request context or local git status.");
}

function resolveAffectedWorkspaces(allWorkspaces: readonly WorkspaceInfo[], changedPaths: readonly string[]): AffectedResolution {
	if (changedPaths.length === 0) {
		return { mode: "none", reason: "no changed files", workspaces: [] };
	}

	const workspacesByDir = new Map(allWorkspaces.map(workspace => [workspace.dir, workspace]));
	const dependentWorkspaceNames = buildDependentWorkspaceMap(allWorkspaces);
	const affectedWorkspaceNames = new Set<string>();

	for (const changedPath of changedPaths) {
		if (isIgnoredRootDocumentationPath(changedPath)) {
			continue;
		}

		if (isRootToolingChange(changedPath)) {
			return { mode: "full", reason: `unsafe root/tooling change: ${changedPath}`, workspaces: [] };
		}

		if (isNativeChange(changedPath)) {
			affectedWorkspaceNames.add(workspacesByDir.get(NATIVE_WORKSPACE_DIR)?.name ?? "");
			continue;
		}

		const workspace = getWorkspaceForPath(changedPath, workspacesByDir);
		if (workspace) {
			affectedWorkspaceNames.add(workspace.name);
			continue;
		}

		return { mode: "full", reason: `unscoped change: ${changedPath}`, workspaces: [] };
	}

	affectedWorkspaceNames.delete("");
	if (affectedWorkspaceNames.size === 0) {
		return { mode: "none", reason: "no relevant workspace changes", workspaces: [] };
	}

	const expandedWorkspaceNames = expandDependents(affectedWorkspaceNames, dependentWorkspaceNames);
	const workspaces = allWorkspaces
		.filter(workspace => expandedWorkspaceNames.has(workspace.name))
		.sort((left, right) => left.name.localeCompare(right.name));
	return { mode: workspaces.length === 0 ? "none" : "scoped", reason: "workspace-scoped change", workspaces };
}

function buildDependentWorkspaceMap(allWorkspaces: readonly WorkspaceInfo[]): Map<string, string[]> {
	const dependents = new Map<string, string[]>();
	for (const workspace of allWorkspaces) {
		for (const dependencyName of workspace.workspaceDependencies) {
			const entries = dependents.get(dependencyName) ?? [];
			entries.push(workspace.name);
			dependents.set(dependencyName, entries);
		}
	}
	for (const [dependencyName, entries] of dependents) {
		entries.sort((left, right) => left.localeCompare(right));
		dependents.set(dependencyName, entries);
	}
	return dependents;
}

function expandDependents(seedWorkspaceNames: ReadonlySet<string>, dependentWorkspaceNames: ReadonlyMap<string, readonly string[]>): Set<string> {
	const expanded = new Set(seedWorkspaceNames);
	const queue = [...seedWorkspaceNames].sort((left, right) => left.localeCompare(right));

	while (queue.length > 0) {
		const workspaceName = queue.shift();
		if (!workspaceName) continue;
		for (const dependentWorkspaceName of dependentWorkspaceNames.get(workspaceName) ?? []) {
			if (expanded.has(dependentWorkspaceName)) continue;
			expanded.add(dependentWorkspaceName);
			queue.push(dependentWorkspaceName);
		}
		queue.sort((left, right) => left.localeCompare(right));
	}

	return expanded;
}

function getWorkspaceForPath(changedPath: string, workspacesByDir: ReadonlyMap<string, WorkspaceInfo>): WorkspaceInfo | null {
	if (!changedPath.startsWith("packages/")) {
		return null;
	}

	const segments = changedPath.split("/");
	if (segments.length < 3) {
		return null;
	}

	return workspacesByDir.get(`packages/${segments[1]}`) ?? null;
}

function isRootToolingChange(changedPath: string): boolean {
	if (ROOT_TOOLING_PREFIXES.some(prefix => changedPath.startsWith(prefix))) {
		return true;
	}
	if (changedPath.includes("/")) {
		return false;
	}
	return ROOT_TOOLING_FILE_PATTERNS.some(pattern => pattern.test(changedPath));
}

function isNativeChange(changedPath: string): boolean {
	if (ROOT_RUST_PATH_PREFIXES.some(prefix => changedPath.startsWith(prefix))) {
		return true;
	}
	if (changedPath.startsWith("packages/natives/")) {
		return true;
	}
	if (changedPath.includes("/")) {
		return false;
	}
	return ROOT_RUST_FILE_NAMES.has(changedPath);
}

function isIgnoredRootDocumentationPath(changedPath: string): boolean {
	if (changedPath.startsWith("packages/") || changedPath.startsWith("crates/")) {
		return false;
	}
	return ROOT_DOC_PATTERNS.some(pattern => pattern.test(changedPath));
}

function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function uniqueSorted(paths: readonly string[]): string[] {
	return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

async function runCommand(command: readonly string[], dryRun: boolean): Promise<void> {
	if (dryRun) {
		console.log(`DRY RUN ${command.join(" ")}`);
		return;
	}

	const proc = Bun.spawn([...command], {
		cwd: repoRoot,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		process.exit(exitCode);
	}
}
