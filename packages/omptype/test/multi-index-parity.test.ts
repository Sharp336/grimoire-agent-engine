import { describe, expect, it } from "bun:test";
import { OmpErrors, scope, type Type, type } from "../src";

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

describe("index-key predicate single evaluation", () => {
	/**
	 * Build a schema whose pattern-index key is a custom scoped string
	 * refinement, so the key predicate runs through `objectIndexValidators`.
	 * The predicate counts its own invocations to prove single evaluation.
	 */
	function buildCountedSchema(count: { value: number }, acceptFirst: boolean): Type {
		const $ = scope({
			countedKey: [
				"string",
				":",
				(s: string) => {
					count.value++;
					return acceptFirst ? count.value === 1 : s.startsWith("f");
				},
			],
		});
		return $.type({ "[countedKey]": "number", "+": "reject" });
	}

	it("evaluates a pattern-index key predicate exactly once per key", () => {
		const count = { value: 0 };
		const T = buildCountedSchema(count, false);
		count.value = 0;
		const out = T({ foo: 1 });
		expect(out).not.toBeInstanceOf(OmpErrors);
		// "foo" is the only enumerable own key; the predicate should run once.
		expect(count.value).toBe(1);
	});

	it("does not reject a validated property when the predicate is non-idempotent", () => {
		// The predicate returns true on the first call and false on every
		// subsequent call.  Double evaluation would cause `isObjectExtra` to
		// see false on the second call, classify the key as undeclared, and
		// reject it as extra — even though it was already index-validated.
		const count = { value: 0 };
		const T = buildCountedSchema(count, true);
		count.value = 0;
		const out = T({ foo: 1 });
		expect(out).not.toBeInstanceOf(OmpErrors);
		expect(count.value).toBe(1);
	});

	it("evaluates the key predicate exactly once per key across JIT stages", () => {
		const count = { value: 0 };
		const T = buildCountedSchema(count, false);
		for (let i = 0; i < JIT; i++) {
			count.value = 0;
			const out = T(structuredClone({ foo: 1 }));
			expect(out).not.toBeInstanceOf(OmpErrors);
			expect(count.value).toBe(1);
		}
	});

	it("T(value) and T.allows(value) agree for a stateful pattern-key predicate", () => {
		// The predicate returns true only on its first invocation (count === 1)
		// and false on every subsequent call. The walker evaluates it once per
		// key, so T(value) accepts. The compiled allows path must also evaluate
		// it once — not twice (once for pattern-index validation, again for
		// extras-reject classification) — or T.allows would see false on the
		// second call, classify the key as undeclared, and reject it.
		const count = { value: 0 };
		const T = buildCountedSchema(count, true);
		for (let i = 0; i < JIT; i++) {
			count.value = 0;
			const out = T(structuredClone({ foo: 1 }));
			expect(out).not.toBeInstanceOf(OmpErrors);
			expect(count.value).toBe(1);

			count.value = 0;
			const allows = T.allows(structuredClone({ foo: 1 }));
			expect(allows).toBe(true);
			expect(count.value).toBe(1);
		}
	});
});
