import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processFileArguments } from "@oh-my-pi/pi-coding-agent/cli/file-processor";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

// 1x1 red PNG image as base64 (smallest valid PNG)
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function createTestToolSession(cwd: string, settings: Settings = Settings.isolated()): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

describe("blockImages setting", () => {
	describe("Read tool", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = path.join(os.tmpdir(), `block-images-test-${Date.now()}-${Math.random()}`);
			fs.mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			fs.rmSync(testDir, { recursive: true, force: true });
		});

		it("returns metadata without image blocks when reading images", async () => {
			const imagePath = path.join(testDir, "test.png");
			fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const tool = new ReadTool(
				createTestToolSession(testDir, Settings.isolated({ "inspect_image.enabled": false })),
			);
			const result = await tool.execute("test-1", { path: imagePath });

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			expect(result.content.some(c => c.type === "image")).toBe(false);
			const textContent = result.content[0] as { type: "text"; text: string };
			expect(textContent.text).toContain("Image metadata:");
			expect(textContent.text).toContain("- MIME: image/png");
			expect(textContent.text).toContain("If you want to analyze the image, call inspect_image");
		});

		it("should read text files normally", async () => {
			// Create test text file
			const textPath = path.join(testDir, "test.txt");
			fs.writeFileSync(textPath, "Hello, world!");

			const tool = new ReadTool(createTestToolSession(testDir));
			const result = await tool.execute("test-2", { path: textPath });

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			const textContent = result.content[0] as { type: "text"; text: string };
			expect(textContent.text).toContain("Hello, world!");
		});
	});

	describe("processFileArguments", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = path.join(os.tmpdir(), `block-images-process-test-${Date.now()}-${Math.random()}`);
			fs.mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			fs.rmSync(testDir, { recursive: true, force: true });
		});

		it("should always process images (filtering happens at convertToLlm layer)", async () => {
			// Create test image
			const imagePath = path.join(testDir, "test.png");
			fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const result = await processFileArguments([imagePath]);

			expect(result.images).toHaveLength(1);
			expect(result.images[0].type).toBe("image");
		});

		it("should process text files normally", async () => {
			// Create test text file
			const textPath = path.join(testDir, "test.txt");
			fs.writeFileSync(textPath, "Hello, world!");

			const result = await processFileArguments([textPath]);

			expect(result.images).toHaveLength(0);
			expect(result.text).toContain("Hello, world!");
		});
	});
});
