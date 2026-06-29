import { afterEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getCachedGpu } from "../system-prompt";

describe("getCachedGpu", () => {
	let tmpPath = "";

	afterEach(async () => {
		if (tmpPath) await fsp.rm(tmpPath, { force: true });
		tmpPath = "";
	});

	function freshPath(): string {
		tmpPath = path.join(os.tmpdir(), `omp-gpu-cache-${crypto.randomUUID()}.json`);
		return tmpPath;
	}

	it("returns the cached GPU without probing on a cache hit", async () => {
		const p = freshPath();
		await Bun.write(p, JSON.stringify({ gpu: "Cached GPU 1" }));
		let probed = false;
		const got = await getCachedGpu(async () => {
			probed = true;
			return "Should Not Run";
		}, p);
		expect(got).toBe("Cached GPU 1");
		expect(probed).toBe(false);
	});

	it("caches a positive probe result on a cache miss", async () => {
		const p = freshPath();
		const got = await getCachedGpu(async () => "Probed GPU 2", p);
		expect(got).toBe("Probed GPU 2");
		const written: unknown = await Bun.file(p).json();
		expect(written).toEqual({ gpu: "Probed GPU 2" });
	});

	it("caches a null probe result so it is not re-probed every boot (the bug)", async () => {
		const p = freshPath();
		const got = await getCachedGpu(async () => null, p);
		expect(got).toBeUndefined();
		// Regression guard: absence is persisted, not dropped.
		const written: unknown = await Bun.file(p).json();
		expect(written).toEqual({ gpu: null });
		// A second call honors the cached null without re-running the probe.
		let probed = false;
		const again = await getCachedGpu(async () => {
			probed = true;
			return "Late GPU";
		}, p);
		expect(again).toBeUndefined();
		expect(probed).toBe(false);
	});
});
