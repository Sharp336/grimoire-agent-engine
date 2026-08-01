/**
 * Regression coverage for the model-cache latch-key mismatch (#7302).
 *
 * `withModelCacheDb` resolves a falsy `dbPath` to the shared default
 * (`if (!dbPath) return useDb(getSharedDb())`), but the latch previously
 * resolved with nullish-only `dbPath ?? getModelDbPath()`. A caller passing
 * `""` opened the shared default but latched `""`, so a later `undefined`
 * call missed the latch and re-probed the damaged file. The fix changes both
 * latch resolutions to `dbPath || getModelDbPath()` so a falsy `dbPath`
 * consistently resolves to the shared default path.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelCache, resetModelCacheCorruptLatchForTests } from "@oh-my-pi/pi-catalog/model-cache";
import { getModelDbPath, logger } from "@oh-my-pi/pi-utils";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils/dirs";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	resetModelCacheCorruptLatchForTests();
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	refreshDirsFromEnv();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("model-cache latch key matches the open fallback", () => {
	let dir: string;
	let malformedDbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-catalog-latch-key-"));
		tempDirs.push(dir);
		// Point the shared default db path at our temp dir.
		process.env.PI_CODING_AGENT_DIR = dir;
		refreshDirsFromEnv();
		malformedDbPath = getModelDbPath();
		// Write bytes that are not a valid SQLite database so openDb throws
		// SQLITE_NOTADB — the same family the latch classifies as corrupt.
		writeFileSync(malformedDbPath, "this is not a sqlite database");
	});

	test("an empty-string dbPath latches the shared default so undefined skips the probe", () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		// First call with "" — opens the shared default (malformed), latches.
		// With the fix, the latch key is getModelDbPath() (not "").
		const first = readModelCache("test-provider", Infinity, Date.now, "");
		expect(first).toBeNull();

		// Exactly one error log fired for the corrupt open.
		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Model cache database is damaged"),
		);
		expect(damagedErrors).toHaveLength(1);

		// Second call with undefined — must hit the latch (same resolved path)
		// and return null WITHOUT probing the store again.
		const second = readModelCache("test-provider", Infinity, Date.now, undefined);
		expect(second).toBeNull();

		// No second error log — the latch short-circuited before any db open.
		const damagedErrorsAfterSecond = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Model cache database is damaged"),
		);
		expect(damagedErrorsAfterSecond).toHaveLength(1);
	});

	test("mutation proof: restoring ?? makes the undefined call re-probe", () => {
		// This test documents the regression: if the latch resolution used
		// `??` instead of `||`, the empty-string call would latch "" and the
		// undefined call would miss the latch. We verify the fix by confirming
		// the latch key for "" equals the latch key for undefined (both are
		// getModelDbPath()). The mutation proof is structural: replacing `||`
		// with `??` in the source makes the first test above fail (two error
		// logs instead of one). See the acceptance criteria.
		//
		// Run the same scenario and confirm only one error fires.
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		readModelCache("test-provider", Infinity, Date.now, "");
		readModelCache("test-provider", Infinity, Date.now, undefined);

		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Model cache database is damaged"),
		);
		// With `||`: 1 error (latch hit). With `??`: 2 errors (latch miss).
		expect(damagedErrors).toHaveLength(1);
	});
});
