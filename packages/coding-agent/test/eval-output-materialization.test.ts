import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { ArtifactManager, MAX_ARTIFACT_RANGE_BYTES } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import {
	DEFAULT_EVAL_INLINE_PREVIEW_BYTES,
	materializeEvalOutput,
} from "@oh-my-pi/pi-coding-agent/session/eval-output";
import { truncateTailBytes } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("eval output materialization", () => {
	let tempDir: TempDir | undefined;

	afterEach(() => tempDir?.removeSync());

	function createManager(): ArtifactManager {
		tempDir = TempDir.createSync("omp-eval-output-");
		return new ArtifactManager(path.join(tempDir.path(), "artifacts"));
	}

	test("retains complete multibyte output behind bounded tail preview", async () => {
		const manager = createManager();
		const output = Buffer.from(`prefix-${"αβ界".repeat(80_000)}-suffix`, "utf8");
		const previewBytes = 17;

		const result = await materializeEvalOutput(manager, output, { previewBytes });

		expect(result.artifactRef).toBe(`artifact://${result.artifact.id}`);
		expect(result.artifact.byteLength).toBe(output.byteLength);
		expect(result.preview.truncated).toBe(true);
		expect(result.preview.direction).toBe("tail");
		expect(result.preview.byteLength).toBeLessThanOrEqual(previewBytes);
		expect(Buffer.from(result.preview.text, "utf8").byteLength).toBe(result.preview.byteLength);
		expect(result.preview.text).toBe(truncateTailBytes(output, previewBytes).text);
		const chunks: Buffer[] = [];
		let offset = 0;
		while (true) {
			const range = await manager.readRange(result.artifact.id, {
				offset,
				length: MAX_ARTIFACT_RANGE_BYTES,
			});
			chunks.push(Buffer.from(range.data, "base64"));
			offset += range.byteLength;
			if (range.eof) break;
		}
		expect(Buffer.concat(chunks)).toEqual(output);
	});

	test("starts each preview from a fresh rolling tail", async () => {
		const manager = createManager();
		const first = await materializeEvalOutput(manager, "old-output-".repeat(100), { previewBytes: 8 });
		const second = await materializeEvalOutput(manager, "new", { previewBytes: 8 });

		expect(first.preview.truncated).toBe(true);
		expect(second.preview).toEqual({
			text: "new",
			byteLength: 3,
			totalBytes: 3,
			truncated: false,
			direction: "none",
		});
	});

	test("references a backend artifact without overwriting it from a truncated preview", async () => {
		const manager = createManager();
		const complete = "complete-output-".repeat(100);
		const artifactId = await manager.save(complete, "eval");

		const result = await materializeEvalOutput(manager, "output-", { artifactId, previewBytes: 7 });

		expect(result.artifact.id).toBe(artifactId);
		expect(result.artifact.byteLength).toBe(Buffer.byteLength(complete));
		expect(result.preview).toEqual({
			text: "output-",
			byteLength: 7,
			totalBytes: Buffer.byteLength(complete),
			truncated: true,
			direction: "tail",
		});
		const range = await manager.readRange(artifactId, { offset: 0, length: MAX_ARTIFACT_RANGE_BYTES });
		expect(Buffer.from(range.data, "base64").toString("utf8")).toBe(complete);
	});

	test("uses the documented default inline budget", async () => {
		const manager = createManager();
		const output = "x".repeat(DEFAULT_EVAL_INLINE_PREVIEW_BYTES + 1);
		const result = await materializeEvalOutput(manager, output);

		expect(result.preview.byteLength).toBe(DEFAULT_EVAL_INLINE_PREVIEW_BYTES);
		expect(result.preview.truncated).toBe(true);
	});
});
