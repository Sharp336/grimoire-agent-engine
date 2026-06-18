import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("stats dashboard assets in distributed CLI builds", () => {
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	const bundleScriptPath = path.join(repoRoot, "packages/coding-agent/scripts/bundle-dist.ts");
	const cliPath = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
	const statsServerPath = path.join(repoRoot, "packages/stats/src/server.ts");

	it("embeds the stats client archive while building the npm CLI bundle", async () => {
		const bundleScript = await Bun.file(bundleScriptPath).text();
		expect(bundleScript).toContain(`"scripts/generate-client-bundle.ts", "--generate"`);
		expect(bundleScript).toContain(`"scripts/generate-client-bundle.ts", "--reset"`);
		expect(bundleScript).toContain(`process.env.PI_BUNDLED="true"`);
	});

	it("uses embedded stats assets for prebuilt CLI distributions", async () => {
		const statsServer = await Bun.file(statsServerPath).text();
		expect(statsServer).toContain("process.env.PI_BUNDLED");
		expect(statsServer).toContain("USE_EMBEDDED_CLIENT");
		expect(statsServer).toContain("Embedded stats client bundle missing");
	});

	it("probes dashboard static assets in the install smoke test path", async () => {
		const cliSource = await Bun.file(cliPath).text();
		expect(cliSource).toContain("startServer(0)");
		expect(cliSource).toContain("127.0.0.1");
		expect(cliSource).toContain("dashboard HTML was not served");
	});

	it("keeps npm bundle sources parseable by Bun 1.3.8", async () => {
		const bundledSourceRoots = [
			path.join(repoRoot, "packages/agent/src"),
			path.join(repoRoot, "packages/coding-agent/src"),
			path.join(repoRoot, "packages/utils/src"),
		];
		const sourceFiles = (await Promise.all(bundledSourceRoots.map(root => collectTypeScriptFiles(root)))).flat();
		const offenders: string[] = [];
		for (const file of sourceFiles) {
			const source = await Bun.file(file).text();
			if (explicitResourceManagementDeclaration.test(source)) {
				offenders.push(path.relative(repoRoot, file));
			}
		}
		expect(offenders).toEqual([]);
	});
});

const explicitResourceManagementDeclaration = /^\s*(?:await\s+)?using\s+[$A-Z_a-z][$\w]*\s*=/m;

async function collectTypeScriptFiles(dir: string, files: string[] = []): Promise<string[]> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		if (entry.name === "__tests__") continue;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectTypeScriptFiles(fullPath, files);
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push(fullPath);
		}
	}
	return files;
}
