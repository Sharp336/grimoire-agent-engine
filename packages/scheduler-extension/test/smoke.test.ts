import { expect, test } from "bun:test";
// Static side-effect import: evaluating `./smoke` runs the whole behavioral
// scenario suite (top-level `node:assert` checks). Any failure throws here and
// fails this file to load; on success it exports `smokeCompleted`. This wrapper
// exists so `bun test` — and therefore repo CI (ci-test-ts fast bucket) — gates
// the suite, which is otherwise a standalone `bun test/smoke.ts` script.
import { smokeCompleted } from "./smoke";

test("scheduler-extension behavioral smoke", () => {
	expect(smokeCompleted).toBe(true);
});
