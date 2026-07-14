import { describe, expect, it } from "bun:test";
import { Process, ProcessStatus } from "../native/index.js";

describe("native process identity", () => {
	it("exposes a stable full-precision start marker", () => {
		const first = Process.fromPid(process.pid);
		const second = Process.fromPid(process.pid);
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		if (!first || !second) throw new Error("unable to open current process");
		expect(first.status()).toBe(ProcessStatus.Running);
		expect(first.startMarker).toBe(second.startMarker);
		expect(first.startMarker).toMatch(/^(linux|darwin|win32):[0-9]+(?::[0-9]+)?$/);
	});
});
