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

	test("loads modern-esm extensions with native module caching", async () => {
		tempDir = TempDir.createSync("@omp-modern-esm-");
		fs.writeFileSync(
			path.join(tempDir.path(), "package.json"),
			JSON.stringify({ type: "module", omp: { compatibility: "modern-esm" } }),
		);
		fs.writeFileSync(path.join(tempDir.path(), "state.ts"), "export const value = { count: 0 };\n");
		fs.writeFileSync(
			path.join(tempDir.path(), "extension.ts"),
			' import { value } from "./state.ts"; export default pi => { value.count += 1; pi.setLabel(String(value.count)); };\n',
		);
		const first = await loadExtensions([path.join(tempDir.path(), "extension.ts")], tempDir.path());
		const second = await loadExtensions([path.join(tempDir.path(), "extension.ts")], tempDir.path());
		expect(first.extensions[0]?.label).toBe("1");
		expect(second.extensions[0]?.label).toBe("2");
	});

	test("keeps extensions without modern metadata on the legacy path", async () => {
		tempDir = TempDir.createSync("@omp-legacy-esm-");
		fs.writeFileSync(path.join(tempDir.path(), "extension.ts"), 'export default pi => pi.setLabel("legacy");\n');
		const result = await loadExtensions([path.join(tempDir.path(), "extension.ts")], tempDir.path());
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
	});
});
