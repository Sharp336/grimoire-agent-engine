import { describe, expect, test } from "bun:test";
import {
	buildLineSnappedPreview,
	buildProgressPreview,
	PROGRESS_PREVIEW_MAX_BYTES,
	ProgressPreviewAccumulator,
} from "@oh-my-pi/pi-coding-agent/session/progress-preview";

describe("progress preview line snapping", () => {
	test("truncated head ends and tail begins on complete lines", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `chatty line ${i + 1}`);
		const preview = buildLineSnappedPreview(lines.join("\n"));
		expect(preview.truncated).toBe(true);
		expect(lines).toContain(preview.head!.split("\n").at(-1)!);
		expect(lines).toContain(preview.tail!.split("\n")[0]!);
	});

	test("single oversized line keeps the byte split", () => {
		const preview = buildLineSnappedPreview("x".repeat(PROGRESS_PREVIEW_MAX_BYTES + 100));
		expect(preview.truncated).toBe(true);
		expect(preview.head!.length).toBeGreaterThan(0);
		expect(preview.tail!.length).toBeGreaterThan(0);
	});

	test("source-truncated window that fits the budget splits between complete lines", () => {
		const preview = buildLineSnappedPreview("line 1\nline 2\nline 98\nline 99", true);
		expect(preview.truncated).toBe(true);
		expect(preview.head).toBe("line 1\nline 2");
		expect(preview.tail).toBe("line 98\nline 99");
	});

	test("byte-split preview rejoins to the retained text for wire fidelity", () => {
		const text = `partial\n${"H".repeat(250)}${"T".repeat(250)}\nfinal`;
		const preview = buildProgressPreview(text, true);
		expect(preview.truncated).toBe(true);
		expect(`${preview.head}${preview.tail}`).toBe(text);
	});

	test("accumulator keeps raw window edges for transport fidelity", () => {
		const accumulator = new ProgressPreviewAccumulator();
		for (let i = 1; i <= 400; i++) accumulator.append(`accumulated line ${i}`);
		const preview = accumulator.take()!;
		expect(preview.truncated).toBe(true);
		expect(preview.head!.startsWith("accumulated line 1\n")).toBe(true);
		expect(preview.tail!.endsWith("accumulated line 400")).toBe(true);
	});
});
