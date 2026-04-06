import { afterEach, describe, expect, it } from "bun:test";
import { convertBufferWithMarkit, convertFileWithMarkit } from "@oh-my-pi/pi-coding-agent/utils/markit";

describe("markit compiled fallback", () => {
	const originalPiCompiled = process.env.PI_COMPILED;

	afterEach(() => {
		if (originalPiCompiled === undefined) {
			delete process.env.PI_COMPILED;
		} else {
			process.env.PI_COMPILED = originalPiCompiled;
		}
	});

	it("returns an unavailable error for file conversion in compiled mode", async () => {
		process.env.PI_COMPILED = "true";

		const result = await convertFileWithMarkit("/tmp/example.pdf");

		expect(result).toEqual({
			ok: false,
			content: "",
			error: "markit unavailable in compiled builds",
		});
	});

	it("returns an unavailable error for buffer conversion in compiled mode", async () => {
		process.env.PI_COMPILED = "true";

		const result = await convertBufferWithMarkit(new Uint8Array([1, 2, 3]), ".pdf");

		expect(result).toEqual({
			ok: false,
			content: "",
			error: "markit unavailable in compiled builds",
		});
	});
});
