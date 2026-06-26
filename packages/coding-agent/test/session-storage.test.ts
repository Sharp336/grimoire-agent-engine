import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

describe("FileSessionStorage.deleteSessionWithArtifacts", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-storage-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	async function createSessionFile(name: string): Promise<string> {
		const sessionPath = path.join(tempDir, `${name}.jsonl`);
		await Bun.write(
			sessionPath,
			`${JSON.stringify({ type: "session", id: "session-id", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n`,
		);
		return sessionPath;
	}

	it("succeeds when the artifact directory is already absent", async () => {
		const sessionPath = await createSessionFile("missing-artifacts");
		const artifactsDir = sessionPath.slice(0, -6);

		expect(fs.existsSync(sessionPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(false);

		await expect(storage.deleteSessionWithArtifacts(sessionPath)).resolves.toBeUndefined();
		expect(fs.existsSync(sessionPath)).toBe(false);
		expect(fs.existsSync(artifactsDir)).toBe(false);
	});

	it("throws when artifact cleanup fails after the session file is deleted", async () => {
		const sessionPath = await createSessionFile("cleanup-failure");
		const artifactsDir = sessionPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "artifact payload");

		const rmError = new Error("permission denied");
		const rmSpy = vi.spyOn(fsp, "rm").mockRejectedValueOnce(rmError);

		await expect(storage.deleteSessionWithArtifacts(sessionPath)).rejects.toThrow(
			`Session file deleted but failed to remove artifacts directory ${artifactsDir}: permission denied`,
		);
		expect(rmSpy).toHaveBeenCalledWith(artifactsDir, { recursive: true, force: true });
		expect(fs.existsSync(sessionPath)).toBe(false);
		expect(fs.existsSync(artifactsDir)).toBe(true);
	});
});

describe("FileSessionStorage.writeTextSync", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-storage-"));
	});

	afterEach(async () => {
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("replaces the file identity so transcript tailers detect rewrites", async () => {
		const storage = new FileSessionStorage();
		const sessionPath = path.join(tempDir, "session.jsonl");

		storage.writeTextSync(sessionPath, "first\n");
		const first = fs.statSync(sessionPath);
		storage.writeTextSync(sessionPath, "second\n");
		const second = fs.statSync(sessionPath);

		expect(second.ino).not.toBe(first.ino);
		expect(await Bun.file(sessionPath).text()).toBe("second\n");
	});
});

describe("FileSessionStorage.renameIfAbsent", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-storage-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("throws ENOENT when destination exists but source is missing", async () => {
		const sourcePath = path.join(tempDir, "missing.jsonl");
		const targetPath = path.join(tempDir, "target.jsonl");

		await fsp.writeFile(targetPath, "target\n");

		await expect(storage.renameIfAbsent(sourcePath, targetPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await Bun.file(targetPath).text()).toBe("target\n");
	});

	it("rolls back the destination when source cleanup reports ENOENT", async () => {
		const sourcePath = path.join(tempDir, "source.jsonl");
		const targetPath = path.join(tempDir, "target.jsonl");
		const realUnlink = fs.promises.unlink.bind(fs.promises);

		await fsp.writeFile(sourcePath, "source\n");
		vi.spyOn(fs.promises, "unlink").mockImplementation(async (target: fs.PathLike) => {
			if (String(target) === sourcePath) {
				await realUnlink(sourcePath);
				const err = Object.assign(new Error("mock unlink missing"), { code: "ENOENT" });
				throw err;
			}
			await realUnlink(target);
		});

		await expect(storage.renameIfAbsent(sourcePath, targetPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(fs.existsSync(sourcePath)).toBe(false);
		expect(fs.existsSync(targetPath)).toBe(false);
	});

	it("rolls back the destination when source cleanup fails", async () => {
		const sourcePath = path.join(tempDir, "source.jsonl");
		const targetPath = path.join(tempDir, "target.jsonl");
		const realUnlink = fs.promises.unlink.bind(fs.promises);

		await fsp.writeFile(sourcePath, "source\n");
		vi.spyOn(fs.promises, "unlink").mockImplementation(async (target: fs.PathLike) => {
			if (String(target) === sourcePath) {
				const err = Object.assign(new Error("mock unlink failure"), { code: "EACCES" });
				throw err;
			}
			await realUnlink(target);
		});

		await expect(storage.renameIfAbsent(sourcePath, targetPath)).rejects.toMatchObject({ code: "EACCES" });
		expect(await Bun.file(sourcePath).text()).toBe("source\n");
		expect(fs.existsSync(targetPath)).toBe(false);
	});
});
