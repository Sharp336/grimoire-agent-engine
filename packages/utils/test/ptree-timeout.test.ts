import { describe, expect, it } from "bun:test";
import { spawn, TimeoutError } from "@oh-my-pi/pi-utils/ptree";

describe("ptree.ChildProcess.attachTimeout()", () => {
	it("contains the watchdog rejection without hiding TimeoutError from callers", async () => {
		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			const child = spawn(["bun", "-e", "setInterval(() => {}, 1_000)"], { timeout: 10 });

			// Let the watchdog reject before the caller observes a derived promise.
			await Bun.sleep(100);
			await expect(child.exitedCleanly).rejects.toBeInstanceOf(TimeoutError);
			await Bun.sleep(0);

			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});
});
