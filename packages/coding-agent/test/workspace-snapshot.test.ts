import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HiddenWorkspaceSnapshotService } from "../src/workspace-snapshot/service";

async function run(cwd: string, ...args: string[]): Promise<string> {
	const proc = await Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	if ((proc.exitCode ?? 0) !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${err || out}`);
	}
	return out;
}

describe("HiddenWorkspaceSnapshotService", () => {
	let tmpDir: string;
	let projectDir: string;
	let agentDir: string;
	let svc: HiddenWorkspaceSnapshotService;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-snapshot-test-"));
		projectDir = path.join(tmpDir, "project");
		agentDir = path.join(tmpDir, "agent-data");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await run(projectDir, "init");
		await run(projectDir, "config", "user.email", "test@example.com");
		await run(projectDir, "config", "user.name", "Test");
		await fs.writeFile(path.join(projectDir, "tracked.txt"), "tracked v1");
		await run(projectDir, "add", "tracked.txt");
		await run(projectDir, "commit", "-m", "initial");
		svc = new HiddenWorkspaceSnapshotService({ projectRoot: projectDir, agentDataDir: agentDir });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("reports supported for git projects", async () => {
		expect(await svc.isSupported()).toBe(true);
	});

	it("captures a snapshot and computes changed files", async () => {
		const before = await svc.capture();
		expect(before).toBeTruthy();
		await fs.writeFile(path.join(projectDir, "tracked.txt"), "tracked v2");
		await fs.writeFile(path.join(projectDir, "new.txt"), "new file");
		const after = await svc.capture();
		expect(after).toBeTruthy();
		const changed = await svc.listChangedFiles(before!, after!);
		expect(changed.sort()).toEqual(["new.txt", "tracked.txt"]);
	});

	it("restores selected files to an earlier snapshot", async () => {
		const before = await svc.capture();
		await fs.writeFile(path.join(projectDir, "tracked.txt"), "tracked v2");
		await fs.writeFile(path.join(projectDir, "new.txt"), "new file");
		await svc.capture();
		await svc.restore(before!, ["tracked.txt"]);
		expect(await fs.readFile(path.join(projectDir, "tracked.txt"), "utf8")).toBe("tracked v1");
		expect(await fileExists(path.join(projectDir, "new.txt"))).toBe(true);
	});

	it("deletes files that did not exist in the snapshot", async () => {
		const before = await svc.capture();
		await fs.writeFile(path.join(projectDir, "new.txt"), "new file");
		await svc.capture();
		await svc.restore(before!, ["new.txt"]);
		expect(await fileExists(path.join(projectDir, "new.txt"))).toBe(false);
	});

	it("returns undefined when the project directory does not exist", async () => {
		const bad = new HiddenWorkspaceSnapshotService({
			projectRoot: path.join(tmpDir, "missing"),
			agentDataDir: agentDir,
		});
		expect(await bad.capture()).toBeUndefined();
	});
});

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
