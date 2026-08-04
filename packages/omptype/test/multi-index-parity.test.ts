import { describe, expect, it } from "bun:test";
import { OmpErrors, type Type, type } from "../src";

/** Call count that guarantees the JIT has kicked in (threshold is 3). */
const JIT = 5;

/**
 * Assert `T(value)` and `T.allows(value)` agree on every call from 1 through
 * JIT — covering the interpreter (calls 1-2) and the JIT (calls 3+). A fresh
 * schema is built so the call counter resets for each value.
 */
function assertStageParity(build: () => Type, value: unknown, shouldAccept: boolean): void {
	const schema = build();
	for (let i = 0; i < JIT; i++) {
		const out = schema(structuredClone(value));
		const allows = schema.allows(structuredClone(value));
		const accepted = !(out instanceof OmpErrors);
		expect(accepted).toBe(allows);
		expect(accepted).toBe(shouldAccept);
	}
}

describe("multi-index union fast-path parity", () => {
	it("applies every matching pattern index across all stages (two pattern indexes)", () => {
		// /^f/ → number, /oo$/ → string.  "foo" matches BOTH patterns, so the
		// value must satisfy number AND string — impossible for any single value.
		const build = () => type([{ "[/^f/]": "number", "[/oo$/]": "string" }, "|", "null"]);
		// "fox" matches only /^f/ → number; 1 is a number → accepted.
		assertStageParity(build, { fox: 1 }, true);
		// null is accepted by the null union member.
		assertStageParity(build, null, true);
		// "foo" matches both patterns; 1 is a number but not a string → rejected.
		assertStageParity(build, { foo: 1 }, false);
	});

	it("applies the general index plus every matching pattern index across all stages", () => {
		// [string] → unknown (general index), /^a/ → number (pattern index).
		// "a" matches BOTH, so the value must satisfy unknown AND number.
		const build = () => type({ "[string]": "unknown", "[/^a/]": "number" }).or("null");
		// "a" matches both; 1 is unknown and a number → accepted.
		assertStageParity(build, { a: 1 }, true);
		// null is accepted by the null union member.
		assertStageParity(build, null, true);
		// "a" matches both; "bad" is unknown but not a number → rejected.
		assertStageParity(build, { a: "bad" }, false);
	});
});
