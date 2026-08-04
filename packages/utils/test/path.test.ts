import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { expandTilde, stripWindowsExtendedLengthPathPrefix } from "../src/path";

describe("stripWindowsExtendedLengthPathPrefix", () => {
	it("removes drive and UNC extended-length prefixes on Windows", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\Users\\Shi Xin\\omp.exe", "win32")).toBe(
			"C:\\Users\\Shi Xin\\omp.exe",
		);
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\UNC\\server\\share\\omp.exe", "win32")).toBe(
			"\\\\server\\share\\omp.exe",
		);
	});

	it("leaves non-Windows paths unchanged", () => {
		const path = "\\\\?\\C:\\Users\\Shi Xin\\omp.exe";
		expect(stripWindowsExtendedLengthPathPrefix(path, "linux")).toBe(path);
	});
});

describe("expandTilde", () => {
	it("passes an empty string through unchanged", () => {
		expect(expandTilde("")).toBe("");
	});

	it("expands a bare tilde to the home directory", () => {
		expect(expandTilde("~")).toBe(os.homedir());
	});

	it("splices the home prefix for ~/ paths", () => {
		expect(expandTilde("~/x")).toBe(`${os.homedir()}/x`);
	});

	it("splices the home prefix for ~\\ paths", () => {
		expect(expandTilde("~\\x")).toBe(`${os.homedir()}\\x`);
	});

	it("leaves ~foo untouched", () => {
		expect(expandTilde("~foo")).toBe("~foo");
	});

	it("honors a custom home", () => {
		expect(expandTilde("~", "/custom/home")).toBe("/custom/home");
		expect(expandTilde("~/x", "/custom/home")).toBe("/custom/home/x");
		expect(expandTilde("~\\x", "/custom/home")).toBe("/custom/home\\x");
		expect(expandTilde("~foo", "/custom/home")).toBe("~foo");
	});

	it("leaves non-tilde paths unchanged", () => {
		expect(expandTilde("plain/path")).toBe("plain/path");
		expect(expandTilde("/abs/path")).toBe("/abs/path");
	});
});
