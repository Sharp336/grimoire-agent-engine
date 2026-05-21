import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeUpdateNotice,
	readLastSeenVersion,
	writeLastSeenVersion,
} from "../src/cli/last-seen-version";

describe("computeUpdateNotice", () => {
	it("returns undefined on first run (lastSeen is undefined)", () => {
		expect(computeUpdateNotice(undefined, "15.0.0")).toBeUndefined();
	});

	it("returns undefined on first run (lastSeen is null)", () => {
		expect(computeUpdateNotice(null, "15.0.0")).toBeUndefined();
	});

	it("returns undefined when lastSeen is an empty string", () => {
		expect(computeUpdateNotice("", "15.0.0")).toBeUndefined();
	});

	it("returns undefined when lastSeen is whitespace only", () => {
		expect(computeUpdateNotice("   \n  ", "15.0.0")).toBeUndefined();
	});

	it("returns undefined when versions match exactly", () => {
		expect(computeUpdateNotice("15.0.0", "15.0.0")).toBeUndefined();
	});

	it("tolerates surrounding whitespace in lastSeen", () => {
		expect(computeUpdateNotice("  15.0.0\n", "15.0.0")).toBeUndefined();
	});

	it("returns a notice when versions differ", () => {
		expect(computeUpdateNotice("15.0.0", "15.1.8")).toBe("omp updated: 15.0.0 → 15.1.8");
	});

	it("returns a notice on a downgrade too (defensive — surface any change)", () => {
		expect(computeUpdateNotice("15.1.8", "15.0.0")).toBe("omp updated: 15.1.8 → 15.0.0");
	});
});

describe("read/write last-seen-version round trip", () => {
	let tmpFile: string;

	beforeEach(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lastseen-"));
		tmpFile = path.join(dir, "last-seen-version");
	});

	afterEach(() => {
		try {
			fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("returns undefined when the file does not exist", () => {
		expect(readLastSeenVersion(tmpFile)).toBeUndefined();
	});

	it("returns undefined when the file is empty", () => {
		fs.writeFileSync(tmpFile, "");
		expect(readLastSeenVersion(tmpFile)).toBeUndefined();
	});

	it("returns undefined when the file is whitespace only", () => {
		fs.writeFileSync(tmpFile, "\n\n  \n");
		expect(readLastSeenVersion(tmpFile)).toBeUndefined();
	});

	it("round-trips a version through write then read", () => {
		writeLastSeenVersion("15.1.8", tmpFile);
		expect(readLastSeenVersion(tmpFile)).toBe("15.1.8");
	});

	it("overwrites the previous value", () => {
		writeLastSeenVersion("15.0.0", tmpFile);
		writeLastSeenVersion("15.1.8", tmpFile);
		expect(readLastSeenVersion(tmpFile)).toBe("15.1.8");
	});

	it("creates parent directory if missing", () => {
		const nested = path.join(path.dirname(tmpFile), "deep", "deeper", "last-seen-version");
		writeLastSeenVersion("15.2.0", nested);
		expect(fs.existsSync(nested)).toBe(true);
		expect(readLastSeenVersion(nested)).toBe("15.2.0");
	});

	it("uses atomic write (no half-written file under concurrent reads)", () => {
		// We can't really test atomicity without races, but we can at least
		// confirm the implementation doesn't leave a `.tmp` file behind on
		// successful write.
		writeLastSeenVersion("15.1.8", tmpFile);
		expect(fs.existsSync(`${tmpFile}.tmp`)).toBe(false);
	});
});

describe("integration: doctor's expected notice flow", () => {
	let tmpFile: string;

	beforeEach(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lastseen-int-"));
		tmpFile = path.join(dir, "last-seen-version");
	});

	afterEach(() => {
		fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
	});

	it("first launch: no notice, but writes current version", () => {
		const current = "15.0.0";
		const notice = computeUpdateNotice(readLastSeenVersion(tmpFile), current);
		expect(notice).toBeUndefined();
		writeLastSeenVersion(current, tmpFile);
		expect(readLastSeenVersion(tmpFile)).toBe(current);
	});

	it("second launch with same version: no notice, no state change", () => {
		writeLastSeenVersion("15.0.0", tmpFile);
		const notice = computeUpdateNotice(readLastSeenVersion(tmpFile), "15.0.0");
		expect(notice).toBeUndefined();
		writeLastSeenVersion("15.0.0", tmpFile);
		expect(readLastSeenVersion(tmpFile)).toBe("15.0.0");
	});

	it("post-auto-update launch: notice fires once then is muted", () => {
		writeLastSeenVersion("15.0.0", tmpFile);
		// First session after update lands
		const notice1 = computeUpdateNotice(readLastSeenVersion(tmpFile), "15.1.8");
		expect(notice1).toBe("omp updated: 15.0.0 → 15.1.8");
		writeLastSeenVersion("15.1.8", tmpFile);
		// Next session sees the same version
		const notice2 = computeUpdateNotice(readLastSeenVersion(tmpFile), "15.1.8");
		expect(notice2).toBeUndefined();
	});
});
