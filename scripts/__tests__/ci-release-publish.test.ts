import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "../..");

/**
 * Ground-truth oracle: discover non-private workspace packages
 * by reading package.json files from the filesystem.
 */
function discoverNonPrivatePackageNames(): string[] {
	const rootPkg = JSON.parse(
		fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
	);
	const workspacePatterns: string[] =
		rootPkg.workspaces?.packages ?? rootPkg.workspaces ?? [];

	return workspacePatterns
		.flatMap((pattern: string) => {
			const baseDir = path.join(repoRoot, pattern.replace("/*", ""));
			return fs
				.readdirSync(baseDir, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => path.join(baseDir, d.name));
		})
		.reduce<string[]>((names, dir) => {
			try {
				const pkg = JSON.parse(
					fs.readFileSync(path.join(dir, "package.json"), "utf8"),
				);
				if (!pkg.private) names.push(pkg.name);
			} catch {
				// skip dirs without a valid package.json
			}
			return names;
		}, [])
		.sort();
}

describe("workspace introspection", () => {
	it("run-ci.sh discover_packages output matches workspace oracle", async () => {
		// Extract just the two function definitions from run-ci.sh and call
		// discover_packages — no top-level side effects are triggered.
		const scriptPath = path.join(
			repoRoot,
			"scripts/install-tests/run-ci.sh",
		);
		const shellOutput =
			await $`bash -c 'eval "$(sed -n "/^find_tarball()/,/^}/p;/^discover_packages()/,/^}/p" "$1")"; ROOT_DIR=$2 discover_packages' -- ${scriptPath} ${repoRoot}`
				.text();
		const shellNames = shellOutput
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((dir) => {
				const pkg = JSON.parse(
					fs.readFileSync(path.join(dir.trim(), "package.json"), "utf8"),
				);
				return pkg.name;
			})
			.sort();

		const expected = discoverNonPrivatePackageNames();
		expect(shellNames).toEqual(expected);
		expect(shellNames.length).toBeGreaterThan(0);
	});

	it("run-ci.sh builds overrides dynamically via OVERRIDES array", () => {
		const script = fs.readFileSync(
			path.join(repoRoot, "scripts/install-tests/run-ci.sh"),
			"utf8",
		);
		// Overrides must be built from the TARBALLS associative array
		expect(script).toContain("declare -A TARBALLS");
		expect(script).toContain("OVERRIDES+=(");
		// The node script must use Object.fromEntries with dynamic args
		expect(script).toContain("Object.fromEntries(process.argv.slice(1)");
		expect(script).toContain('"${OVERRIDES[@]}"');
		// No hardcoded @oh-my-pi package names in the discovery+overrides block
		const dynamicBlock = script.slice(script.indexOf("declare -A TARBALLS"));
		expect(dynamicBlock).not.toMatch(/@oh-my-pi\/[\w-]+/);
	});
});

describe("publish script", () => {
	it("bun publish is called with --tolerate-republish and --access public", () => {
		const script = fs.readFileSync(
			path.join(repoRoot, "scripts/ci-release-publish.ts"),
			"utf8",
		);
		const cmdRe = /\$`bun publish([^`]*)`/;
		const match = script.match(cmdRe);
		expect(match).toBeTruthy();
		expect(match![1]).toContain("--tolerate-republish");
		expect(match![1]).toContain("--access public");
	});

	it("dry-run publishes exactly the non-private workspace packages", async () => {
		const output =
			await $`bun scripts/ci-release-publish.ts --dry-run`
				.cwd(repoRoot)
				.text();
		const publishedNames = output
			.trim()
			.split("\n")
			.filter((line) => line.includes("DRY RUN"))
			.map((line) => {
				const dir = line.match(/\(([^)]+)\)/)?.[1] ?? "";
				if (!dir) return null;
				const pkg = JSON.parse(
					fs.readFileSync(path.join(repoRoot, dir, "package.json"), "utf8"),
				);
				return pkg.name;
			})
			.filter(Boolean)
			.sort();

		const expected = discoverNonPrivatePackageNames();
		expect(publishedNames).toEqual(expected);
	});
});
