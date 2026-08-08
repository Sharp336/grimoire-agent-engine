#!/usr/bin/env bun

/**
 * Publish the localized CLI as a separate npm package.
 *
 * The workspace keeps the upstream-compatible package name so internal imports
 * and the monorepo remain stable. This command temporarily changes only the
 * packed coding-agent manifest to `omp-cn`, then restores the working tree.
 *
 * Usage:
 *   bun scripts/publish-fork-package.ts
 *   bun scripts/publish-fork-package.ts --dry-run
 *   bun scripts/publish-fork-package.ts --skip-check
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { applyPublishBin, inspectPackedTarball, packAndPublish, packages } from "./ci-release-publish.ts";

export const FORK_NPM_PACKAGE = "omp-cn";
export const FORK_REPOSITORY = "yequ172672/oh-my-pi-cn";
export const FORK_PACKAGE_DESCRIPTION =
	"omp coding agent 的简体中文本地化分支，包含设置、供应商配置、提示和 CLI 文案中文化";

const repoRoot = path.join(import.meta.dir, "..");
const packageRelDir = "packages/coding-agent";
const packageDir = path.join(repoRoot, packageRelDir);
const manifestPath = path.join(packageDir, "package.json");
const skipCheck = process.argv.includes("--skip-check");
const isDryRun = process.argv.includes("--dry-run");

interface Manifest {
	[key: string]: unknown;
}

export function createForkManifest(manifest: Manifest): Manifest {
	return {
		...manifest,
		name: FORK_NPM_PACKAGE,
		description: FORK_PACKAGE_DESCRIPTION,
		author: "yequ172672",
		contributors: ["Mario Zechner", "Can Boluk"],
		homepage: `https://github.com/${FORK_REPOSITORY}`,
		repository: {
			type: "git",
			url: `git+https://github.com/${FORK_REPOSITORY}.git`,
			directory: packageRelDir,
		},
		bugs: { url: `https://github.com/${FORK_REPOSITORY}/issues` },
		publishConfig: { access: "public" },
	};
}

async function runChecks(): Promise<void> {
	if (skipCheck) {
		console.log("Skipping TypeScript checks (--skip-check)");
		return;
	}
	console.log("Running TypeScript checks before publishing omp-cn…");
	const result = await $`bun run check:ts`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`TypeScript checks failed with exit code ${result.exitCode}`);
	}
}

async function assertNpmAuthentication(): Promise<void> {
	if (isDryRun) return;
	const result = await $`npm whoami`.quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error("npm is not authenticated; run `npm login` before publishing omp-cn");
	}
	console.log(`Publishing omp-cn as ${result.text().trim()}`);
}

async function packForDryRun(): Promise<void> {
	const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cn-pack-"));
	try {
		const result = await $`bun pm pack --quiet --destination ${packDir}`.cwd(packageDir).quiet().nothrow();
		if (result.exitCode !== 0) {
			throw new Error(`bun pm pack failed with exit code ${result.exitCode}: ${result.stderr.toString().trim()}`);
		}
		const tarballName = (await fs.readdir(packDir)).find(entry => entry.endsWith(".tgz"));
		if (!tarballName) throw new Error("bun pm pack produced no tarball");
		const packed = await inspectPackedTarball(path.join(packDir, tarballName));
		console.log(`DRY RUN packed ${packed.name}@${packed.version}`);
	} finally {
		await fs.rm(packDir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const packageEntry = packages.find(pkg => pkg.dir === packageRelDir);
	if (!packageEntry) throw new Error(`Publish configuration is missing ${packageRelDir}`);

	await assertNpmAuthentication();
	await runChecks();
	const originalManifest = await Bun.file(manifestPath).text();
	try {
		// Published packages must point their bin at the generated worker-host bundle.
		await applyPublishBin(packageRelDir, true);
		const manifest = (await Bun.file(manifestPath).json()) as Manifest;
		await Bun.write(manifestPath, `${JSON.stringify(createForkManifest(manifest), null, "\t")}\n`);
		if (isDryRun) {
			await packForDryRun();
		} else {
			await packAndPublish(packageDir, FORK_NPM_PACKAGE);
		}
	} finally {
		await Bun.write(manifestPath, originalManifest);
	}
}

if (import.meta.main) await main();
