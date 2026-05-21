import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	detectDevTreeForTest,
	replaceBinaryForUpdate,
	resolveUpdateMethodForTest,
} from "../src/cli/update-cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
describe("update-cli install target detection", () => {
	it("uses bun update when prioritized omp is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses binary update when prioritized omp is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/omp", undefined);

		expect(method).toBe("binary");
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous omp binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});

describe("update-cli dev-tree detection", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "omp-devtree-"));
	});

	afterEach(() => {
		try {
			fsSync.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	function makeBunBinDir(): string {
		const bunBin = path.join(tmpDir, ".bun", "bin");
		fsSync.mkdirSync(bunBin, { recursive: true });
		return bunBin;
	}

	function makeRegistryInstall(bunBin: string): { ompShim: string; cli: string } {
		// Layout mimics `bun install -g @oh-my-pi/pi-coding-agent`:
		//   <tmp>/.bun/bin/omp -> ../install/global/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts
		//   <tmp>/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts (real file)
		const pkgDir = path.join(
			tmpDir,
			".bun",
			"install",
			"global",
			"node_modules",
			"@oh-my-pi",
			"pi-coding-agent",
		);
		fsSync.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
		const cli = path.join(pkgDir, "src", "cli.ts");
		fsSync.writeFileSync(cli, "// cli\n");
		const ompShim = path.join(bunBin, "omp");
		fsSync.symlinkSync(path.relative(bunBin, cli), ompShim);
		return { ompShim, cli };
	}

	function makeDevTreeRelink(bunBin: string): { ompShim: string; devCli: string } {
		// Layout mimics `omp-relink`:
		//   <tmp>/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent -> <tmp>/dev/packages/coding-agent (symlink)
		//   <tmp>/.bun/bin/omp -> ../install/global/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts
		const scope = path.join(tmpDir, ".bun", "install", "global", "node_modules", "@oh-my-pi");
		const devPkg = path.join(tmpDir, "dev", "packages", "coding-agent");
		fsSync.mkdirSync(scope, { recursive: true });
		fsSync.mkdirSync(path.join(devPkg, "src"), { recursive: true });
		const devCli = path.join(devPkg, "src", "cli.ts");
		fsSync.writeFileSync(devCli, "// dev cli\n");
		fsSync.symlinkSync(devPkg, path.join(scope, "pi-coding-agent"));
		const ompShim = path.join(bunBin, "omp");
		fsSync.symlinkSync(
			path.relative(bunBin, path.join(scope, "pi-coding-agent", "src", "cli.ts")),
			ompShim,
		);
		return { ompShim, devCli };
	}

	it("returns undefined when bun bin dir is unknown", () => {
		const fakeOmp = path.join(tmpDir, "omp");
		fsSync.writeFileSync(fakeOmp, "");
		expect(detectDevTreeForTest(fakeOmp, undefined)).toBeUndefined();
	});

	it("returns undefined when omp resolves inside the bun install tree", () => {
		const bunBin = makeBunBinDir();
		const { ompShim } = makeRegistryInstall(bunBin);
		expect(detectDevTreeForTest(ompShim, bunBin)).toBeUndefined();
	});

	it("returns the dev-tree realpath when the package directory is symlinked outside the bun install tree", () => {
		const bunBin = makeBunBinDir();
		const { ompShim, devCli } = makeDevTreeRelink(bunBin);
		const result = detectDevTreeForTest(ompShim, bunBin);
		expect(result).toBeDefined();
		expect(fsSync.realpathSync.native(result!.realPath)).toBe(fsSync.realpathSync.native(devCli));
	});

	it("returns undefined when the omp shim cannot be realpathed", () => {
		const bunBin = makeBunBinDir();
		expect(detectDevTreeForTest(path.join(bunBin, "omp-missing"), bunBin)).toBeUndefined();
	});
});
