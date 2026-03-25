import { describe, expect, it } from "bun:test";
import { getCargoTarget, isCargoCrossCompile, parseRustHostTarget } from "../scripts/build-target";

describe("build-native target resolution", () => {
	it("maps darwin arm64 to the matching Rust target triple", () => {
		expect(getCargoTarget({ targetPlatform: "darwin", targetArch: "arm64" })).toBe("aarch64-apple-darwin");
	});

	it("prefers an explicit cross target override", () => {
		expect(
			getCargoTarget({
				targetPlatform: "darwin",
				targetArch: "arm64",
				crossTarget: "aarch64-apple-darwin",
			}),
		).toBe("aarch64-apple-darwin");
	});

	it("reuses the Rust host triple when it already matches the requested Linux ABI", () => {
		expect(
			getCargoTarget({
				targetPlatform: "linux",
				targetArch: "x64",
				rustHostTarget: "x86_64-unknown-linux-musl",
			}),
		).toBe("x86_64-unknown-linux-musl");
	});

	it("treats a different Rust host triple as cross compilation", () => {
		expect(isCargoCrossCompile("aarch64-apple-darwin", "x86_64-apple-darwin")).toBe(true);
		expect(isCargoCrossCompile("aarch64-apple-darwin", "aarch64-apple-darwin")).toBe(false);
	});

	it("parses the Rust host triple from rustc -vV output", () => {
		expect(parseRustHostTarget("release: 1.94.0\nhost: x86_64-apple-darwin\nLLVM version: 21.1.8")).toBe(
			"x86_64-apple-darwin",
		);
		expect(parseRustHostTarget("release: 1.94.0")).toBeNull();
	});
});
