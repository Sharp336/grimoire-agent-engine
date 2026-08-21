import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cursorProjectFolder } from "../src/providers/cursor/workspace";
import { persistGenerateImageResult } from "../src/providers/cursor-generate-image";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x0a]);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-imagine-persist-"));
	tempDirs.push(dir);
	return dir;
}

function successCall(filePath: string, imageData = Buffer.from(PNG).toString("base64")) {
	return {
		args: { filePath, description: "a dog" },
		result: {
			result: {
				case: "success" as const,
				value: { filePath, imageData },
			},
		},
	};
}

describe("persistGenerateImageResult", () => {
	it("writes image_data into the workspace", () => {
		const dir = tempDir();
		const target = path.join(dir, "assets", "dog.png");
		const persisted = persistGenerateImageResult(successCall(target), [dir]);
		expect(persisted.isError).toBe(false);
		expect(persisted.filePath).toBe(target);
		expect(new Uint8Array(fs.readFileSync(target))).toEqual(PNG);
	});

	it("relocates ~/.cursor/projects paths into the workspace", () => {
		const dir = tempDir();
		const artifact = path.join(cursorProjectFolder(dir), "assets", "cat.png");
		const relocated = path.join(dir, "assets", "cat.png");
		const persisted = persistGenerateImageResult(successCall(artifact), [dir]);
		expect(persisted.isError).toBe(false);
		expect(persisted.filePath).toBe(relocated);
		expect(new Uint8Array(fs.readFileSync(relocated))).toEqual(PNG);
		expect(fs.existsSync(artifact)).toBe(false);
	});

	it("resolves a relative file_path against the session workspace", () => {
		const dir = tempDir();
		const persisted = persistGenerateImageResult(successCall("assets/relative.png"), [dir]);
		const target = path.join(dir, "assets", "relative.png");
		expect(persisted.isError).toBe(false);
		expect(persisted.filePath).toBe(target);
		expect(new Uint8Array(fs.readFileSync(target))).toEqual(PNG);
	});

	it("refuses empty image_data", () => {
		const dir = tempDir();
		const target = path.join(dir, "empty.png");
		const persisted = persistGenerateImageResult(successCall(target, ""), [dir]);
		expect(persisted.isError).toBe(true);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("refuses a path outside the workspace", () => {
		const dir = tempDir();
		const outside = path.join(os.tmpdir(), `omp-imagine-outside-${process.pid}.png`);
		try {
			const persisted = persistGenerateImageResult(successCall(outside), [dir]);
			expect(persisted.isError).toBe(true);
			expect(fs.existsSync(outside)).toBe(false);
		} finally {
			fs.rmSync(outside, { force: true });
		}
	});

	it("returns the GenerateImage error text without writing", () => {
		const dir = tempDir();
		const target = path.join(dir, "nope.png");
		const persisted = persistGenerateImageResult(
			{
				args: { filePath: target },
				result: { result: { case: "error", value: { error: "safety filter" } } },
			},
			[dir],
		);
		expect(persisted).toEqual({ text: "safety filter", isError: true });
		expect(fs.existsSync(target)).toBe(false);
	});

	it("overwrites an existing PNG without leaving a sibling tmp", () => {
		const dir = tempDir();
		const target = path.join(dir, "assets", "dog.png");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, new Uint8Array([1, 2, 3]));
		const persisted = persistGenerateImageResult(successCall(target), [dir]);
		expect(persisted.isError).toBe(false);
		expect(new Uint8Array(fs.readFileSync(target))).toEqual(PNG);
		expect(fs.readdirSync(path.dirname(target)).filter(name => name.includes(".tmp."))).toEqual([]);
	});

	it("refuses oversized image_data without creating the dest", () => {
		const dir = tempDir();
		const target = path.join(dir, "huge.png");
		const persisted = persistGenerateImageResult(successCall(target, "A".repeat(50 * 1024 * 1024)), [dir]);
		expect(persisted.isError).toBe(true);
		expect(persisted.text).toContain("exceeds");
		expect(fs.existsSync(target)).toBe(false);
	});
});
