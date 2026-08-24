import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("extension compatibility dispatch", () => {
	let tempDir: TempDir | undefined;

	afterEach(() => {
		tempDir?.removeSync();
		tempDir = undefined;
	});

	test("loads modern-esm extensions without legacy graph preparation", async () => {
		tempDir = TempDir.createSync("@omp-modern-esm-");
		fs.writeFileSync(
			path.join(tempDir.path(), "package.json"),
			JSON.stringify({ type: "module", omp: { compatibility: "modern-esm" } }),
		);
		fs.writeFileSync(path.join(tempDir.path(), "extension.ts"), 'export default pi => pi.setLabel("modern");\n');
		const result = await loadExtensions([path.join(tempDir.path(), "extension.ts")], tempDir.path());
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
	});

	test("keeps extensions without modern metadata on the legacy path", async () => {
		tempDir = TempDir.createSync("@omp-legacy-esm-");
		fs.writeFileSync(path.join(tempDir.path(), "extension.ts"), 'export default pi => pi.setLabel("legacy");\n');
		const result = await loadExtensions([path.join(tempDir.path(), "extension.ts")], tempDir.path());
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
	});
});
