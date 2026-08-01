import { describe, expect, it } from "bun:test";
import { shellQuote } from "../src/shell";

describe("shellQuote", () => {
	it("wraps a plain path in single quotes", () => {
		expect(shellQuote("/tmp/omp-agent.db")).toBe("'/tmp/omp-agent.db'");
	});

	it("balances quoting for a path containing a single quote", () => {
		const path = "/tmp/omp's agent.db";
		const quoted = shellQuote(path);
		// The POSIX form: close the quote, insert an escaped literal quote,
		// reopen the quote — '/tmp/omp'\''s agent.db'
		expect(quoted).toBe("'/tmp/omp'\\''s agent.db'");
		// The emitted string must be shell-balanced: every unescaped single
		// quote (one not preceded by a backslash) toggles the open/close state,
		// so a balanced string ends in the closed state.
		let open = false;
		for (let i = 0; i < quoted.length; i++) {
			if (quoted[i] === "'" && quoted[i - 1] !== "\\") open = !open;
		}
		expect(open).toBe(false);
	});

	it("produces an empty single-quoted pair for the empty string", () => {
		expect(shellQuote("")).toBe("''");
	});
});
