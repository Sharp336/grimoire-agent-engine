import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installPrimeSkill } from "../src/cli";

const temporaryDirectories: string[] = [];

async function makeFixture(): Promise<{ homeDir: string; sourceDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "prime-skill-install-"));
	temporaryDirectories.push(root);
	const sourceDir = path.join(root, "bundled-skill");
	await fs.mkdir(path.join(sourceDir, "src"), { recursive: true });
	await fs.writeFile(path.join(sourceDir, "SKILL.md"), "bundled skill\n");
	await fs.writeFile(path.join(sourceDir, "src", "__init__.py"), "# bundled\n");
	return { homeDir: path.join(root, "home"), sourceDir };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("Prime skill installation", () => {
	it("installs the complete skill tree with restrictive modes", async () => {
		const { homeDir, sourceDir } = await makeFixture();
		const targetDir = await installPrimeSkill({ homeDir, sourceDir });
		const targetStat = await fs.stat(targetDir);
		const agentsStat = await fs.stat(path.join(homeDir, ".agents"));
		const skillsStat = await fs.stat(path.join(homeDir, ".agents", "skills"));
		expect(targetStat.mode & 0o777).toBe(0o700);
		expect(agentsStat.mode & 0o777).toBe(0o700);
		expect(skillsStat.mode & 0o777).toBe(0o700);
		expect(await fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).toBe("bundled skill\n");
		expect(await fs.readFile(path.join(targetDir, "src", "__init__.py"), "utf8")).toBe("# bundled\n");
		expect(await fs.readFile(path.join(targetDir, ".omp-managed"), "utf8")).toBe("omp-prime-bridge-skill-v1\n");
	});

	it("does not overwrite an unmanaged user skill", async () => {
		const { homeDir, sourceDir } = await makeFixture();
		const targetDir = path.join(homeDir, ".agents", "skills", "omp-message");
		await fs.mkdir(targetDir, { recursive: true });
		await fs.writeFile(path.join(targetDir, "SKILL.md"), "user skill\n");
		await installPrimeSkill({ homeDir, sourceDir });
		expect(await fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).toBe("user skill\n");
		expect(await fs.lstat(path.join(targetDir, ".omp-managed")).catch(() => undefined)).toBeUndefined();
	});

	it("atomically replaces a previously managed skill", async () => {
		const { homeDir, sourceDir } = await makeFixture();
		const targetDir = await installPrimeSkill({ homeDir, sourceDir });
		await fs.writeFile(path.join(targetDir, "old.txt"), "stale\n");
		await fs.writeFile(path.join(sourceDir, "SKILL.md"), "updated skill\n");
		await installPrimeSkill({ homeDir, sourceDir });
		expect(await fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).toBe("updated skill\n");
		expect(await fs.lstat(path.join(targetDir, "old.txt")).catch(() => undefined)).toBeUndefined();
	});

	it("rejects symlinked destination paths", async () => {
		const { homeDir, sourceDir } = await makeFixture();
		const skillsDir = path.join(homeDir, ".agents", "skills");
		await fs.mkdir(skillsDir, { recursive: true });
		const targetDir = path.join(skillsDir, "omp-message");
		const elsewhere = path.join(homeDir, "elsewhere");
		await fs.mkdir(elsewhere);
		await fs.symlink(elsewhere, targetDir);
		await expect(installPrimeSkill({ homeDir, sourceDir })).rejects.toThrow("symlinked Prime skill path");
	});
});
