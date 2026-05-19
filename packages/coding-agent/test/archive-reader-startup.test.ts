import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const archiveReaderPath = path.join(import.meta.dir, "../src/tools/archive-reader.ts");

test("archive-reader keeps fflate off parse-only imports", () => {
	const source = fs.readFileSync(archiveReaderPath, "utf-8");
	expect(source).not.toContain('from "fflate"');
	expect(source).not.toContain("from './zip-inflate'");
	expect(source).not.toContain('from "./zip-inflate"');
});
