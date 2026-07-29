import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractArchive } from "@oh-my-pi/pi-coding-agent/utils/zip";

let root: string;

beforeEach(async () => {
	root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-zip-test-"));
});

afterEach(async () => {
	await fs.promises.rm(root, { recursive: true, force: true });
});

describe("archive extraction", () => {
	test("streams tar Blob/File members to Bun.write without materializing them", async () => {
		const archive = path.join(root, "input.tar");
		await Bun.Archive.write(archive, { "member.txt": "streamed payload" });
		const arrayBufferSpy = spyOn(Blob.prototype, "arrayBuffer").mockImplementation(() => {
			throw new Error("eager Blob.arrayBuffer read");
		});
		try {
			expect(await extractArchive(archive, root)).toBe(1);
		} finally {
			arrayBufferSpy.mockRestore();
		}
		expect(await Bun.file(path.join(root, "member.txt")).text()).toBe("streamed payload");
	});
});
