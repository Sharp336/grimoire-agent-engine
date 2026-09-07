import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager, writeArtifact } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager write integrity", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifact-integrity-${crypto.randomUUID()}`);
		dirs.push(dir);
		return dir;
	}

	function simulateShortWrite(bytes: number): void {
		const open = fs.open.bind(fs);
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const file = await open(...args);
			const write = file.write.bind(file);
			vi.spyOn(file, "write").mockImplementation((content: string) => write(content.slice(0, bytes)));
			return file;
		});
	}

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
	});

	it("publishes a complete large child report through long Windows artifact paths", async () => {
		const destination = path.join(freshDir(), "long-output-".repeat(17), "Worker.md");
		const content = "child output with unicode \u2603\n".repeat(65_536);
		expect(destination.length).toBeGreaterThan(260);

		expect(await writeArtifact(destination, content)).toBe(Buffer.byteLength(content));
		expect(await Bun.file(destination).text()).toBe(content);
		expect(await fs.readdir(path.dirname(destination))).toEqual(["Worker.md"]);
	});

	it("rejects a short write instead of publishing an unreadable artifact id", async () => {
		const manager = new ArtifactManager(freshDir());
		simulateShortWrite(1);

		await expect(manager.save("complete report", "task")).rejects.toThrow(
			"Artifact write incomplete: wrote 1 of 15 bytes",
		);
	});

	it("leaves no discoverable file when the staged write falls short", async () => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		// Partial bytes really land on the staging file before publication is rejected.
		simulateShortWrite(3);

		await expect(writeArtifact(destination, "full report body")).rejects.toThrow("Artifact write incomplete");

		// Neither the destination nor a leftover staging file survives, so
		// agent:// / artifact:// scans cannot resolve a truncated artifact.
		expect(await fs.readdir(dir)).toEqual([]);
	});

	it("preserves the prior artifact when a follow-up write fails", async () => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "original valid report");

		simulateShortWrite(2);

		await expect(writeArtifact(destination, "replacement report")).rejects.toThrow("Artifact write incomplete");

		expect(await Bun.file(destination).text()).toBe("original valid report");
		expect(await fs.readdir(dir)).toEqual(["Worker.md"]);
	});

	it("replaces an existing artifact when Windows rejects rename-over-target", async () => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "original report");

		const rename = fs.rename.bind(fs);
		let injected = false;
		vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
			if (!injected && String(source).includes(".tmp-") && String(target) === destination) {
				injected = true;
				throw Object.assign(new Error("injected Windows replacement failure"), { code: "EEXIST" });
			}
			await rename(source, target);
		});

		await writeArtifact(destination, "replacement report");

		expect(injected).toBe(true);
		expect(await Bun.file(destination).text()).toBe("replacement report");
		expect(await fs.readdir(dir)).toEqual(["Worker.md"]);
	});
});
