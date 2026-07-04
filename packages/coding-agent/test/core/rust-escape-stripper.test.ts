import { describe, expect, it } from "bun:test";
import { TerminalEscapeStripper } from "../../src/eval/rs/kernel";

describe("TerminalEscapeStripper", () => {
	// ---------------------------------------------------------------------------
	// Regression: an unterminated OSC/DCS/APC/PM string from user output must not
	// swallow the Evcxr C1 completion markers (U+0091 success / U+0092 failure)
	// or the ">> " prompt.  CAN (0x18), SUB (0x1a), and C1 controls (0x80-0x9f)
	// abort the current escape state back to normal so the marker passes through.
	// ---------------------------------------------------------------------------

	it("preserves C1 success marker and prompt after an unterminated OSC split across chunks", () => {
		const stripper = new TerminalEscapeStripper();
		// Unterminated OSC — swallowed entirely, state left in `osc`.
		expect(stripper.write("\u001b]0;unterminated")).toBe("");
		// U+0091 aborts the escape state, then the marker and prompt pass through.
		const out = stripper.write("\u0091>> ");
		expect(out).toContain("\u0091");
		expect(out).toContain(">> ");
	});

	it("preserves C1 success marker and prompt after an unterminated OSC in a single chunk", () => {
		const stripper = new TerminalEscapeStripper();
		const out = stripper.write("\u001b]0;unterminated\u0091>> ");
		expect(out).toContain("\u0091");
		expect(out).toContain(">> ");
	});

	it("preserves C1 failure marker and prompt after an unterminated APC string sequence", () => {
		const stripper = new TerminalEscapeStripper();
		// ESC _ starts an APC string sequence; left unterminated.
		expect(stripper.write("\u001b_Pnope")).toBe("");
		// U+0092 aborts the string state, then the marker and prompt pass through.
		const out = stripper.write("\u0092>> ");
		expect(out).toContain("\u0092");
		expect(out).toContain(">> ");
	});

	// ---------------------------------------------------------------------------
	// Guard: the C1/CAN/SUB abort must not over-broaden and break legitimate
	// escape-sequence stripping.  Complete sequences must still be consumed.
	// ---------------------------------------------------------------------------

	it("strips a complete CSI color sequence", () => {
		const stripper = new TerminalEscapeStripper();
		expect(stripper.write("\u001b[31mred\u001b[0m")).toBe("red");
	});

	it("strips a complete OSC terminated by BEL", () => {
		const stripper = new TerminalEscapeStripper();
		expect(stripper.write("\u001b]0;title\u0007after")).toBe("after");
	});

	it("strips a complete OSC terminated by ST (ESC backslash) without treating ESC as an abort", () => {
		const stripper = new TerminalEscapeStripper();
		// ESC (0x1b) is NOT a CAN/SUB/C1 abort, so the ST terminator must still
		// close the OSC cleanly and let the trailing text pass through.
		expect(stripper.write("\u001b]0;title\u001b\\after")).toBe("after");
	});

	// ---------------------------------------------------------------------------
	// 8-bit C1 sequence handling: introducers are stripped like their ESC-pair
	// equivalents, and the C1 ST terminator closes a sequence without leaking.
	// ---------------------------------------------------------------------------

	it("strips a complete C1 CSI color sequence", () => {
		const stripper = new TerminalEscapeStripper();
		expect(stripper.write("\u009b31mred\u009b0m")).toBe("red");
	});

	it("strips a complete C1 OSC terminated by BEL", () => {
		const stripper = new TerminalEscapeStripper();
		expect(stripper.write("\u009d0;title\u0007after")).toBe("after");
	});

	it("strips a complete C1 DCS string terminated by C1 ST without leaking ST", () => {
		const stripper = new TerminalEscapeStripper();
		expect(stripper.write("\u0090content\u009c")).toBe("");
	});

	it("strips a complete C1 APC string terminated by C1 ST without leaking ST", () => {
		const stripper = new TerminalEscapeStripper();
		expect(stripper.write("\u009fcontent\u009c")).toBe("");
	});

	it("preserves C1 success marker and prompt after an unterminated C1-introduced sequence", () => {
		const stripper = new TerminalEscapeStripper();
		expect(stripper.write("\u009d0;unterminated")).toBe("");
		const out = stripper.write("\u0091>> ");
		expect(out).toContain("\u0091");
		expect(out).toContain(">> ");
	});

	it("preserves C1 markers and prompt in normal flow", () => {
		const stripper = new TerminalEscapeStripper();
		const out = stripper.write("\u0091\u0092>> ");
		expect(out).toBe("\u0091\u0092>> ");
	});

	// ---------------------------------------------------------------------------
	// Plain passthrough — no escape sequences at all.
	// ---------------------------------------------------------------------------

	it("passes through plain text unchanged", () => {
		const stripper = new TerminalEscapeStripper();
		expect(stripper.write("hello world")).toBe("hello world");
	});
});
