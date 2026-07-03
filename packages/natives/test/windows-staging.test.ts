/**
 * Remaining regression tests for the native addon loader: stale version
 * directory cleanup (used by compiled-binary mode) and the version sentinel
 * pairing between Rust and the package.json.
 *
 * NOTE: The Windows `bun install -g` staging mechanism
 * (`shouldStageNodeModulesAddon` / `maybeStageNodeModulesAddon`) has been
 * removed. On Windows, `omp update` warns the user to close other omp
 * processes before installing, avoiding the file-lock problem at update time
 * rather than at load time.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanupStaleNativeVersions,
} from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

describe("native addon cache cleanup", () => {
	it("removes stale version directories after the current native version loads", async () => {
		const nativesDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-cache-"));
		try {
			await fs.mkdir(path.join(nativesDir, "15.10.11"));
			await fs.mkdir(path.join(nativesDir, packageJson.version));
			await Bun.write(path.join(nativesDir, "README.txt"), "not a version directory");

			const removed = cleanupStaleNativeVersions({ nativesDir, currentVersion: packageJson.version });

			expect(removed.map(filePath => path.basename(filePath))).toEqual(["15.10.11"]);
			expect((await fs.readdir(nativesDir)).sort()).toEqual(["README.txt", packageJson.version].sort());
		} finally {
			await fs.rm(nativesDir, { recursive: true, force: true });
		}
	});
});

describe("pi-natives version sentinel", () => {
	it("Rust `js_name` matches the package version", async () => {
		// The JS loader (`packages/natives/native/index.js`) computes its expected
		// sentinel from `package.json#version`; if the Rust source falls out of
		// sync we ship a `.node` that the loader will refuse to use. Pinning the
		// pairing here catches release-script regressions before they reach CI.
		const libRs = await Bun.file(path.join(import.meta.dir, "../../../crates/pi-natives/src/lib.rs")).text();
		const sentinelMatch = libRs.match(/js_name = "(__piNativesV[A-Za-z0-9_]+)"/);
		expect(sentinelMatch, 'Rust sentinel `js_name = "__piNativesV…"` not found in lib.rs').not.toBeNull();
		const expected = `__piNativesV${packageJson.version.replace(/[^A-Za-z0-9]/g, "_")}`;
		expect(sentinelMatch?.[1]).toBe(expected);
	});
});
