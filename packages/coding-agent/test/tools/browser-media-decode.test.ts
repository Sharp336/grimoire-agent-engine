import { describe, expect, it } from "bun:test";
import { decodeBoundedMediaChunks } from "@oh-my-pi/pi-coding-agent/tools/browser/media-decode";

describe("bounded browser media decoding", () => {
	it("decodes canonical chunks and reports their exact byte length", () => {
		const result = decodeBoundedMediaChunks([
			Buffer.from("first").toString("base64"),
			Buffer.from("second").toString("base64"),
		]);

		expect(result.byteLength).toBe(11);
		expect(Buffer.concat(result.chunks, result.byteLength).toString()).toBe("firstsecond");
	});

	it("rejects non-canonical base64 before decoding", () => {
		expect(() => decodeBoundedMediaChunks(["dGVzdA"])).toThrow(
			"downloadMedia page transfer returned invalid base64 data",
		);
	});

	it("rejects decoded payloads above 32 MiB", () => {
		const chunk = Buffer.alloc(1024).toString("base64");
		const oversized = Array.from({ length: 32 * 1024 + 1 }, () => chunk);

		expect(() => decodeBoundedMediaChunks(oversized)).toThrow("downloadMedia response exceeds the 32 MiB limit");
	});
});
