import { afterEach, describe, expect, test, vi } from "bun:test";
import { MCP_TEST_ESC_GRACE_MS, McpTestEscapeState } from "@oh-my-pi/pi-coding-agent/modes/mcp-test-escape";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("McpTestEscapeState", () => {
	test('pending test: Esc aborts it and returns "abort"', () => {
		const state = new McpTestEscapeState();
		const controller = new AbortController();
		state.begin(controller, "fast");

		expect(state.hasActive()).toBe(true);
		expect(state.handleEscape()).toBe("abort");
		expect(controller.signal.aborted).toBe(true);
	});

	test("settled test: Esc is consumed within the grace window, falls through after it", () => {
		// Freeze the clock so the grace boundary is measured from one stable
		// settlement timestamp instead of two wall-clock reads.
		const now = 1_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const state = new McpTestEscapeState();
		const controller = new AbortController();
		state.begin(controller, "fast");
		state.settle(controller);

		expect(state.handleEscape(now + 1000)).toBe("consume");
		expect(state.handleEscape(now + MCP_TEST_ESC_GRACE_MS - 1)).toBe("consume");
		// Past the grace window: Esc is released back to normal semantics.
		expect(state.handleEscape(now + MCP_TEST_ESC_GRACE_MS + 1)).toBe("fallthrough");
		expect(state.hasActive()).toBe(false);
	});

	test("no active test: Esc falls through without touching anything", () => {
		const state = new McpTestEscapeState();
		expect(state.handleEscape()).toBe("fallthrough");
		expect(state.hasActive()).toBe(false);
	});

	test("clear releases Esc ownership immediately, without the grace window", () => {
		const state = new McpTestEscapeState();
		const controller = new AbortController();
		state.begin(controller, "missing");
		state.clear(controller);

		expect(state.hasActive()).toBe(false);
		expect(state.handleEscape()).toBe("fallthrough");
	});

	test("clear is identity-guarded: a stale controller cannot release the active test", () => {
		const state = new McpTestEscapeState();
		const stale = new AbortController();
		const active = new AbortController();
		state.begin(stale, "old");
		state.begin(active, "new");
		state.clear(stale); // superseded controller must be ignored

		expect(state.hasActive()).toBe(true);
		expect(state.handleEscape()).toBe("abort");
		expect(active.signal.aborted).toBe(true);
	});

	test("settle records cancellation when the signal was already aborted", () => {
		const state = new McpTestEscapeState();
		const controller = new AbortController();
		state.begin(controller, "slow");
		controller.abort();
		state.settle(controller);

		expect(state.cancelled).toBe(true);
		expect(state.name).toBe("slow");
		expect(state.handleEscape(Date.now() + 1000)).toBe("consume");
	});

	test("settle records completion when the signal was not aborted", () => {
		const state = new McpTestEscapeState();
		const controller = new AbortController();
		state.begin(controller, "fast");
		state.settle(controller);

		expect(state.cancelled).toBe(false);
	});

	test("begin supersedes a pending test by aborting its predecessor", () => {
		const state = new McpTestEscapeState();
		const first = new AbortController();
		const second = new AbortController();
		state.begin(first, "old");
		state.begin(second, "new");

		// The orphaned predecessor's connection attempt must not survive the
		// Esc-ownership handover.
		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(false);
		expect(state.handleEscape()).toBe("abort");
		expect(second.signal.aborted).toBe(true);
	});

	test("a superseded test cannot settle or cancel the newer one", () => {
		const state = new McpTestEscapeState();
		const first = new AbortController();
		const second = new AbortController();
		state.begin(first, "old");
		state.begin(second, "new");
		state.settle(first); // stale settle must be ignored

		expect(state.hasActive()).toBe(true);
		expect(state.handleEscape()).toBe("abort");
		expect(second.signal.aborted).toBe(true);
		// The superseded test was aborted by begin, not by this Esc.
		expect(first.signal.aborted).toBe(true);
	});
});
