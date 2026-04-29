#!/usr/bin/env bun

import * as path from "node:path";
import { readFileSync } from "node:fs";
import { $, Glob } from "bun";

interface PublishPackage {
	dir: string;
}

interface PackageJson {
	private?: boolean;
}

const repoRoot = path.join(import.meta.dir, "..");
const isDryRun = process.argv.includes("--dry-run");
// Derive package list from workspace config instead of hardcoding (#856)
const rootPkg = await Bun.file(path.join(repoRoot, "package.json")).json();
const workspacePatterns: string[] = rootPkg.workspaces?.packages ?? rootPkg.workspaces ?? [];
const packageDirs: PublishPackage[] = workspacePatterns
	.flatMap((pattern: string) => {
		const glob = new Glob(pattern);
		return Array.from(glob.scanSync({ cwd: repoRoot, onlyFiles: false }));
	})
	.filter((dir: string) => {
		try {
			const pkg = JSON.parse(readFileSync(path.join(repoRoot, dir, "package.json"), "utf8"));
			return !pkg.private;
		} catch {
			return false;
		}
	})
	.map((dir: string) => ({ dir }));

async function readPackageJson(packageDir: string): Promise<PackageJson> {
	return (await Bun.file(path.join(repoRoot, packageDir, "package.json")).json()) as PackageJson;
}

async function publishPackage(pkg: PublishPackage): Promise<void> {
	const packageJson = await readPackageJson(pkg.dir);
	const packageName = path.basename(pkg.dir);
	if (packageJson.private) {
		console.log(`Skipping ${packageName} (private)`);
		return;
	}

	if (isDryRun) {
		console.log(`DRY RUN bun publish --access public (${pkg.dir})`);
		return;
	}

	console.log(`Publishing ${packageName}...`);
	// --tolerate-republish exits 0 when version already exists (#857)
	const result = await $`bun publish --access public --tolerate-republish`.cwd(path.join(repoRoot, pkg.dir)).quiet().nothrow();
	const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
	if (result.exitCode === 0) {
		if (output) console.log(output);
		return;
	}
	// Only real failures reach here
	if (output) console.log(output);
	process.exit(result.exitCode ?? 1);
}

async function main(): Promise<void> {
	for (const pkg of packageDirs) {
		await publishPackage(pkg);
	}
}

await main();
