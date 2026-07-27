import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ToolCallLoopGuard } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("ToolCallLoopGuard", () => {
	test("detects the fifth consecutive identical tool call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: ["job", "irc"] });
		let detection = null;
		for (let index = 0; index < 5; index++) {
			const toolCallId = `call-${index}`;
			detection = guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pytest -q", timeout: 120 } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId,
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			});
		}

		expect(detection).toEqual({
			kind: "repeated_tool_call",
			toolName: "bash",
			count: 5,
			resultSummary: "1263 passed, 4 skipped",
			argumentsSummary: '{"command":"pytest -q","timeout":120}',
		});
	});

	test("canonicalizes argument key order and ignores harness intent fields", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "first", name: "read", arguments: { path: "a.ts", [INTENT_FIELD]: "first" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "second",
							name: "read",
							arguments: { [INTENT_FIELD]: "second", path: "a.ts" },
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toMatchObject({ toolName: "read", count: 2 });
	});

	test("resets the consecutive count on a different call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "first", name: "bash", arguments: { command: "pytest -q" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "second", name: "read", arguments: { path: "src/index.ts" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "third", name: "bash", arguments: { command: "pytest -q" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "third",
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});

	test("ignores exempt polling tools", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["job"] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "first", name: "job", arguments: { poll: ["abc"] } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "job",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "second", name: "job", arguments: { poll: ["abc"] } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "job",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});

	test("check() vetoes a no-progress streak at the threshold (pre-call veto)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99, // high — we test no-progress, not args-only repeat
			exemptTools: [],
			noProgressThreshold: 3,
			wanderingThreshold: 0,
		});
		// Simulate 3 identical calls (same args + same result) via the live path.
		for (let i = 0; i < 3; i++) {
			expect(guard.check({ toolName: "bash", args: { command: "pytest" } })).toEqual({ kind: "allow" });
			guard.recordCall("bash", { command: "pytest" });
			guard.recordOutcome(
				"bash",
				{ command: "pytest" },
				{
					result: { content: [{ type: "text", text: "all passed" }], details: {}, isError: false },
				},
			);
		}
		// 4th call with same args+result should be vetoed (streak >= 3).
		const verdict = guard.check({ toolName: "bash", args: { command: "pytest" } });
		expect(verdict.kind).toBe("critical");
	});

	test("check() does NOT veto when the result changed (streak broken)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 3,
			wanderingThreshold: 0,
		});
		// 2 identical calls build the streak.
		for (let i = 0; i < 2; i++) {
			guard.check({ toolName: "bash", args: { command: "ls" } });
			guard.recordCall("bash", { command: "ls" });
			guard.recordOutcome(
				"bash",
				{ command: "ls" },
				{
					result: { content: [{ type: "text", text: "file.txt" }], details: {}, isError: false },
				},
			);
		}
		// 3rd call has the same args but a DIFFERENT result — streak resets.
		guard.check({ toolName: "bash", args: { command: "ls" } });
		guard.recordCall("bash", { command: "ls" });
		guard.recordOutcome(
			"bash",
			{ command: "ls" },
			{
				result: { content: [{ type: "text", text: "file2.txt" }], details: {}, isError: false },
			},
		);
		// 4th call should still be allowed (streak was broken at call 3).
		expect(guard.check({ toolName: "bash", args: { command: "ls" } })).toEqual({ kind: "allow" });
	});

	test("check() fires breaker after consecutive vetoes hit breakerVetoStreak", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 0,
			breakerVetoStreak: 3,
		});
		// Build the no-progress streak to 2.
		for (let i = 0; i < 2; i++) {
			guard.check({ toolName: "fetch", args: { url: "http://dead.example" } });
			guard.recordCall("fetch", { url: "http://dead.example" });
			guard.recordOutcome(
				"fetch",
				{ url: "http://dead.example" },
				{
					result: { content: [{ type: "text", text: "timeout" }], details: {}, isError: true },
				},
			);
		}
		// 3rd call: critical veto (streak >= 2), consecutiveVetoes = 1.
		expect(guard.check({ toolName: "fetch", args: { url: "http://dead.example" } }).kind).toBe("critical");
		guard.recordCall("fetch", { url: "http://dead.example" });
		guard.recordOutcome("fetch", { url: "http://dead.example" }, { vetoed: true });
		// 4th call: still critical, consecutiveVetoes = 2.
		expect(guard.check({ toolName: "fetch", args: { url: "http://dead.example" } }).kind).toBe("critical");
		guard.recordCall("fetch", { url: "http://dead.example" });
		guard.recordOutcome("fetch", { url: "http://dead.example" }, { vetoed: true });
		// 5th call: consecutiveVetoes = 3 >= breakerVetoStreak → breaker.
		expect(guard.check({ toolName: "fetch", args: { url: "http://dead.example" } }).kind).toBe("breaker");
	});

	test("volatile-field stripping: timestamps in details do not defeat the no-progress hash", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 0,
		});
		// Two calls with identical text but different volatile details.
		for (let i = 0; i < 2; i++) {
			guard.check({ toolName: "http.request", args: { url: "http://api.example" } });
			guard.recordCall("http.request", { url: "http://api.example" });
			guard.recordOutcome(
				"http.request",
				{ url: "http://api.example" },
				{
					result: {
						content: [{ type: "text", text: "ok" }],
						details: { status: 200, timestamp: `2026-07-26T12:00:0${i}Z`, requestId: `req-${i}` },
						isError: false,
					},
				},
			);
		}
		// 3rd call should be vetoed — the volatile fields were stripped so the
		// result hashes as identical despite different timestamp/requestId.
		expect(guard.check({ toolName: "http.request", args: { url: "http://api.example" } }).kind).toBe("critical");
	});

	test("wandering detector warns at wanderingThreshold for prone tools", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 0,
			wanderingThreshold: 3,
			wanderingEscalation: 99, // high — we test warn, not escalation
			proneTools: ["web.fetch"],
		});
		// 2 distinct URLs — below threshold.
		for (const url of ["http://a.example", "http://b.example"]) {
			guard.check({ toolName: "web.fetch", args: { url } });
			guard.recordCall("web.fetch", { url });
			guard.recordOutcome(
				"web.fetch",
				{ url },
				{
					result: { content: [{ type: "text", text: "page" }], details: {}, isError: false },
				},
			);
		}
		// 3rd distinct URL — should warn.
		const verdict = guard.check({ toolName: "web.fetch", args: { url: "http://c.example" } });
		expect(verdict.kind).toBe("wandering");
		if (verdict.kind === "wandering") expect(verdict.spread).toBe(3);
	});

	test("wandering detector does NOT fire for non-prone tools (bulk reads)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 0,
			wanderingThreshold: 3,
			wanderingEscalation: 99,
			proneTools: ["web.fetch"],
		});
		// read is NOT prone — scanning many files is legitimate.
		for (const file of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
			const verdict = guard.check({ toolName: "read", args: { path: file } });
			expect(verdict.kind).toBe("allow");
			guard.recordCall("read", { path: file });
			guard.recordOutcome(
				"read",
				{ path: file },
				{
					result: { content: [{ type: "text", text: "contents" }], details: {}, isError: false },
				},
			);
		}
	});

	test("recordTurn does not double-count when live path is active", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 3,
			exemptTools: [],
			noProgressThreshold: 0,
			wanderingThreshold: 0,
		});
		// Live path: 2 calls via check+recordCall+recordOutcome.
		for (let i = 0; i < 2; i++) {
			guard.check({ toolName: "bash", args: { command: "echo hi" } });
			guard.recordCall("bash", { command: "echo hi" });
			guard.recordOutcome(
				"bash",
				{ command: "echo hi" },
				{
					result: { content: [{ type: "text", text: "hi" }], details: {}, isError: false },
				},
			);
		}
		// recordTurn should NOT re-increment #repeatCount (live path already did).
		const detection = guard.recordTurn({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "echo hi" } }],
				api: "openai-responses" as const,
				provider: "openai",
				model: "test",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			} as AssistantMessage,
			toolResults: [
				{
					role: "toolResult" as const,
					toolCallId: "tc-1",
					toolName: "bash",
					content: [{ type: "text" as const, text: "hi" }],
					details: {},
					isError: false,
					timestamp: Date.now(),
				},
			],
		});
		// After 2 live-path calls, repeatCount should be 2 — NOT 3 (which would fire).
		expect(detection).toBeNull();
		// 3rd live call should fire.
		guard.check({ toolName: "bash", args: { command: "echo hi" } });
		guard.recordCall("bash", { command: "echo hi" });
		guard.recordOutcome(
			"bash",
			{ command: "echo hi" },
			{
				result: { content: [{ type: "text", text: "hi" }], details: {}, isError: false },
			},
		);
		const detection2 = guard.recordTurn({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-2", name: "bash", arguments: { command: "echo hi" } }],
				api: "openai-responses" as const,
				provider: "openai",
				model: "test",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			} as AssistantMessage,
			toolResults: [
				{
					role: "toolResult" as const,
					toolCallId: "tc-2",
					toolName: "bash",
					content: [{ type: "text" as const, text: "hi" }],
					details: {},
					isError: false,
					timestamp: Date.now(),
				},
			],
		});
		expect(detection2).not.toBeNull();
		expect(detection2?.kind).toBe("repeated_tool_call");
	});

	test("image content is included in the no-progress hash (different screenshots break the streak)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 0,
		});
		// Two calls with same args but DIFFERENT image data — should NOT veto.
		for (let i = 0; i < 2; i++) {
			guard.check({ toolName: "computer", args: { action: "screenshot" } });
			guard.recordCall("computer", { action: "screenshot" });
			guard.recordOutcome(
				"computer",
				{ action: "screenshot" },
				{
					result: {
						content: [{ type: "image" as const, data: `base64-different-${i}`, mimeType: "image/png" }],
						details: {},
						isError: false,
					},
				},
			);
		}
		// 3rd call should be allowed — different image data broke the streak.
		expect(guard.check({ toolName: "computer", args: { action: "screenshot" } })).toEqual({ kind: "allow" });
	});

	test("image content with identical data DOES trigger no-progress veto", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 0,
		});
		// Two calls with IDENTICAL image data — should build the streak.
		for (let i = 0; i < 2; i++) {
			guard.check({ toolName: "computer", args: { action: "screenshot" } });
			guard.recordCall("computer", { action: "screenshot" });
			guard.recordOutcome(
				"computer",
				{ action: "screenshot" },
				{
					result: {
						content: [{ type: "image" as const, data: "base64-identical", mimeType: "image/png" }],
						details: {},
						isError: false,
					},
				},
			);
		}
		// 3rd call should be vetoed — identical image data = no progress.
		expect(guard.check({ toolName: "computer", args: { action: "screenshot" } }).kind).toBe("critical");
	});

	test("wandering detector accumulates spread across turns (resetForTurn does not clear it)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 0,
			wanderingThreshold: 3,
			wanderingEscalation: 99,
			proneTools: ["web.fetch"],
		});
		// Turn 1: fetch URL A
		guard.check({ toolName: "web.fetch", args: { url: "http://a.example" } });
		guard.recordCall("web.fetch", { url: "http://a.example" });
		guard.recordOutcome(
			"web.fetch",
			{ url: "http://a.example" },
			{
				result: { content: [{ type: "text" as const, text: "page a" }], details: {}, isError: false },
			},
		);
		guard.resetForTurn();
		// Turn 2: fetch URL B (different args)
		guard.check({ toolName: "web.fetch", args: { url: "http://b.example" } });
		guard.recordCall("web.fetch", { url: "http://b.example" });
		guard.recordOutcome(
			"web.fetch",
			{ url: "http://b.example" },
			{
				result: { content: [{ type: "text" as const, text: "page b" }], details: {}, isError: false },
			},
		);
		guard.resetForTurn();
		// Turn 3: fetch URL C — spread should be 3 (accumulated across turns).
		const verdict = guard.check({ toolName: "web.fetch", args: { url: "http://c.example" } });
		expect(verdict.kind).toBe("wandering");
		if (verdict.kind === "wandering") expect(verdict.spread).toBe(3);
	});

	test("P1: per-tool wandering set is bounded (cap evicts oldest entries)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 0,
			wanderingThreshold: 1,
			wanderingEscalation: 2, // cap = max(2*2, 1*2, 24) = 24
			breakerVetoStreak: 99, // high — don't trip the breaker, test the cap
			proneTools: ["web.fetch"],
		});
		// Insert 30 distinct URLs — exceeds the cap of 24.
		for (let i = 0; i < 30; i++) {
			const url = `http://example-${i}.com`;
			guard.check({ toolName: "web.fetch", args: { url } });
			guard.recordCall("web.fetch", { url });
			guard.recordOutcome(
				"web.fetch",
				{ url },
				{
					result: { content: [{ type: "text" as const, text: "page" }], details: {}, isError: false },
				},
			);
		}
		// With an unbounded set, a new URL would have spread = 31.
		// With cap=24 (6 evicted), a new URL has spread = 25 (set.size + 1).
		// The verdict is critical (spread >= escalation), but the count field
		// reveals the actual spread — proving the set is bounded at 24, not 31.
		const fresh = guard.check({
			toolName: "web.fetch",
			args: { url: "http://brand-new.com" },
		});
		expect(fresh.kind).toBe("critical");
		if (fresh.kind === "critical") expect(fresh.count).toBe(25);

		// A URL still in the set (example-29, last inserted) has spread = 24.
		const retained = guard.check({
			toolName: "web.fetch",
			args: { url: "http://example-29.com" },
		});
		expect(retained.kind).toBe("critical");
		if (retained.kind === "critical") expect(retained.count).toBe(24);
	});

	test("P2a: recordOutcome matches by toolCallId (survives pre/post-transform args mismatch)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 0,
		});
		// Simulate: beforeToolCall records with pre-transform args + toolCallId,
		// afterToolCall records outcome with DIFFERENT (post-transform) args but
		// same toolCallId. The outcome should still be recorded.
		const toolCallId = "tc-1";
		guard.check({ toolName: "bash", args: { command: "secret-placeholder" } });
		guard.recordCall("bash", { command: "secret-placeholder" }, toolCallId);
		// afterToolCall sees post-transform args (deobfuscated secret)
		guard.recordOutcome(
			"bash",
			{ command: "real-secret-value" },
			{
				result: { content: [{ type: "text" as const, text: "ok" }], details: {}, isError: false },
				toolCallId,
			},
		);
		// Second call with same pre-transform args — streak should have built
		// because the outcome was recorded via toolCallId matching.
		guard.check({ toolName: "bash", args: { command: "secret-placeholder" } });
		guard.recordCall("bash", { command: "secret-placeholder" }, "tc-2");
		guard.recordOutcome(
			"bash",
			{ command: "real-secret-value" },
			{
				result: { content: [{ type: "text" as const, text: "ok" }], details: {}, isError: false },
				toolCallId: "tc-2",
			},
		);
		// Third call should be vetoed — streak built despite args mismatch.
		expect(guard.check({ toolName: "bash", args: { command: "secret-placeholder" } }).kind).toBe("critical");
	});

	test("P2b: intervening prose turn breaks the no-progress streak", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 3,
			wanderingThreshold: 0,
		});
		// Build a streak of 3 via the standalone recordTurn path.
		for (let i = 0; i < 3; i++) {
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: `tc-${i}`, name: "bash", arguments: { command: "echo hi" } }],
					api: "openai-responses" as const,
					provider: "openai",
					model: "test",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				} as AssistantMessage,
				toolResults: [
					{
						role: "toolResult" as const,
						toolCallId: `tc-${i}`,
						toolName: "bash",
						content: [{ type: "text" as const, text: "hi" }],
						details: {},
						isError: false,
						timestamp: Date.now(),
					},
				],
			});
		}
		// Intervening prose turn (no tool calls) — should break the streak.
		guard.recordTurn({
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Let me think about this." }],
				api: "openai-responses" as const,
				provider: "openai",
				model: "test",
				usage: zeroUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			} as AssistantMessage,
			toolResults: [],
		});
		// Next call with same args should NOT be vetoed — streak was broken.
		const detection = guard.recordTurn({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-after", name: "bash", arguments: { command: "echo hi" } }],
				api: "openai-responses" as const,
				provider: "openai",
				model: "test",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			} as AssistantMessage,
			toolResults: [
				{
					role: "toolResult" as const,
					toolCallId: "tc-after",
					toolName: "bash",
					content: [{ type: "text" as const, text: "hi" }],
					details: {},
					isError: false,
					timestamp: Date.now(),
				},
			],
		});
		expect(detection).toBeNull();
	});

	test("wandering breaker clears the tool's wandering set (fresh start after graceful end)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 0,
			wanderingThreshold: 3,
			wanderingEscalation: 4,
			breakerVetoStreak: 2,
			proneTools: ["web.fetch"],
		});
		// Build spread: calls 1-3 are below escalation (spread 1,2,3).
		// Call 4 hits escalation (spread=4, wanderingVetoes=1, critical).
		for (let i = 0; i < 4; i++) {
			const url = `http://example-${i}.com`;
			guard.check({ toolName: "web.fetch", args: { url } });
			guard.recordCall("web.fetch", { url });
			guard.recordOutcome(
				"web.fetch",
				{ url },
				{
					result: { content: [{ type: "text" as const, text: "page" }], details: {}, isError: false },
				},
			);
		}
		// 5th distinct URL: spread=5 >= escalation(4), wanderingVetoes=2 >= breakerVetoStreak(2) → breaker.
		const verdict = guard.check({ toolName: "web.fetch", args: { url: "http://e.com" } });
		expect(verdict.kind).toBe("breaker");
		guard.recordCall("web.fetch", { url: "http://e.com" });
		guard.recordOutcome("web.fetch", { url: "http://e.com" }, { vetoed: true });
		// After the breaker, the wandering set should be cleared — a new call
		// should be allowed (spread=1, not permanently stuck at escalation).
		expect(guard.check({ toolName: "web.fetch", args: { url: "http://fresh.com" } }).kind).toBe("allow");
	});

	test("interleaving a non-prone call does NOT reset the wandering veto counter", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 0,
			wanderingThreshold: 3,
			wanderingEscalation: 4,
			breakerVetoStreak: 3,
			proneTools: ["web.fetch"],
		});
		// Build spread: calls 1-3 below escalation, call 4 hits it (wanderingVetoes=1).
		for (let i = 0; i < 4; i++) {
			const url = `http://example-${i}.com`;
			guard.check({ toolName: "web.fetch", args: { url } });
			guard.recordCall("web.fetch", { url });
			guard.recordOutcome(
				"web.fetch",
				{ url },
				{
					result: { content: [{ type: "text" as const, text: "page" }], details: {}, isError: false },
				},
			);
		}
		// 5th distinct URL: spread=5 >= escalation(4), wanderingVetoes=2 → critical.
		let verdict = guard.check({ toolName: "web.fetch", args: { url: "http://e.com" } });
		expect(verdict.kind).toBe("critical");
		guard.recordCall("web.fetch", { url: "http://e.com" });
		guard.recordOutcome("web.fetch", { url: "http://e.com" }, { vetoed: true });

		// Model interleaves a `read` (non-prone) — should NOT reset wanderingVetoes.
		guard.check({ toolName: "read", args: { path: "foo.ts" } });
		guard.recordCall("read", { path: "foo.ts" });
		guard.recordOutcome(
			"read",
			{ path: "foo.ts" },
			{
				result: { content: [{ type: "text" as const, text: "contents" }], details: {}, isError: false },
			},
		);

		// 6th distinct URL: spread=6 >= escalation(4), wanderingVetoes=3 >= breakerVetoStreak(3) → breaker.
		verdict = guard.check({ toolName: "web.fetch", args: { url: "http://f.com" } });
		expect(verdict.kind).toBe("breaker");

		// After breaker, wandering set cleared — next call should be allowed.
		verdict = guard.check({ toolName: "web.fetch", args: { url: "http://fresh.com" } });
		expect(verdict.kind).toBe("allow");
	});

	test("volatile timestamps in error strings don't break the no-progress streak", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 0,
		});
		// Two calls with same args but error strings embedding different
		// timestamps and request IDs — should still build the no-progress
		// streak because the volatile patterns are stripped from text.
		const errors = [
			"Error: request req-abc123 failed at 2026-07-26T12:00:01Z",
			"Error: request req-def456 failed at 2026-07-26T12:00:02Z",
		];
		for (const text of errors) {
			guard.check({ toolName: "http.request", args: { url: "http://flaky.example" } });
			guard.recordCall("http.request", { url: "http://flaky.example" });
			guard.recordOutcome(
				"http.request",
				{ url: "http://flaky.example" },
				{
					result: { content: [{ type: "text" as const, text }], details: {}, isError: true },
				},
			);
		}
		// 3rd call should be vetoed — volatile patterns stripped, streak built.
		expect(guard.check({ toolName: "http.request", args: { url: "http://flaky.example" } }).kind).toBe("critical");
	});

	test("cyclic details don't crash hashOutcome", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 0,
		});
		// Create a cyclic object in details.
		const cyclic: Record<string, unknown> = { x: 1 };
		cyclic.self = cyclic;
		// Should not throw — falls back to "<unhashable>".
		guard.check({ toolName: "bash", args: { command: "test" } });
		guard.recordCall("bash", { command: "test" });
		guard.recordOutcome(
			"bash",
			{ command: "test" },
			{
				result: { content: [{ type: "text" as const, text: "ok" }], details: cyclic, isError: false },
			},
		);
		// Second call with same text but different (also cyclic) details — should
		// still build the streak because both fall back to "<unhashable>".
		const cyclic2: Record<string, unknown> = { x: 1 };
		cyclic2.self = cyclic2;
		guard.check({ toolName: "bash", args: { command: "test" } });
		guard.recordCall("bash", { command: "test" });
		guard.recordOutcome(
			"bash",
			{ command: "test" },
			{
				result: { content: [{ type: "text" as const, text: "ok" }], details: cyclic2, isError: false },
			},
		);
		// 3rd call should be vetoed — identical text, both details unhashable.
		expect(guard.check({ toolName: "bash", args: { command: "test" } }).kind).toBe("critical");
	});

	test("semantic IDs in details are NOT stripped (only volatile keys are)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 0,
		});
		// Two calls with same text but DIFFERENT semantic IDs in details.
		// These should NOT hash as identical — the `id` field is meaningful
		// (it's not requestId/traceId, which are the volatile ones).
		for (const itemId of ["a", "b"]) {
			guard.check({ toolName: "read", args: { path: "items.json" } });
			guard.recordCall("read", { path: "items.json" });
			guard.recordOutcome(
				"read",
				{ path: "items.json" },
				{
					result: {
						content: [{ type: "text" as const, text: "found item" }],
						details: { item: { id: itemId } },
						isError: false,
					},
				},
			);
		}
		// 3rd call should be allowed — different semantic IDs broke the streak.
		expect(guard.check({ toolName: "read", args: { path: "items.json" } })).toEqual({ kind: "allow" });
	});

	test("successful results with semantic timestamps are NOT stripped (only errors are)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 0,
		});
		// Two calls with same args but successful results containing different
		// timestamps — these should NOT hash as identical because the timestamp
		// is semantic data the model is polling for, not transport noise.
		const results = ["Build completed at 2026-07-26T12:00:01Z", "Build completed at 2026-07-26T12:05:02Z"];
		for (const text of results) {
			guard.check({ toolName: "bash", args: { command: "tail build.log" } });
			guard.recordCall("bash", { command: "tail build.log" });
			guard.recordOutcome(
				"bash",
				{ command: "tail build.log" },
				{
					result: { content: [{ type: "text" as const, text }], details: {}, isError: false },
				},
			);
		}
		// 3rd call should be allowed — different timestamps broke the streak.
		expect(guard.check({ toolName: "bash", args: { command: "tail build.log" } })).toEqual({
			kind: "allow",
		});
	});

	test("wandering escalation vetoes are tracked per-tool (don't cross-combine)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 0,
			wanderingThreshold: 1,
			wanderingEscalation: 2,
			breakerVetoStreak: 3,
			proneTools: ["web.fetch", "browser"],
		});
		// Fill web.fetch past escalation (spread >= 2) → 1st veto, counter=1.
		guard.check({ toolName: "web.fetch", args: { url: "http://a.com" } });
		guard.recordCall("web.fetch", { url: "http://a.com" });
		guard.check({ toolName: "web.fetch", args: { url: "http://b.com" } });
		guard.recordCall("web.fetch", { url: "http://b.com" });
		expect(guard.check({ toolName: "web.fetch", args: { url: "http://c.com" } }).kind).toBe("critical");
		guard.recordCall("web.fetch", { url: "http://c.com" });

		// Now fill browser past escalation → this is browser's 1st veto, NOT web.fetch's 2nd.
		guard.check({ toolName: "browser", args: { selector: "#a" } });
		guard.recordCall("browser", { selector: "#a" });
		guard.check({ toolName: "browser", args: { selector: "#b" } });
		guard.recordCall("browser", { selector: "#b" });
		// browser's 1st escalation veto → critical (not breaker), because
		// browser's counter is 1, not 2 (web.fetch's counter doesn't apply).
		expect(guard.check({ toolName: "browser", args: { selector: "#c" } }).kind).toBe("critical");
	});

	test("resetStreaks clears no-progress state without touching wandering hashes", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 3,
			wanderingEscalation: 4,
			proneTools: ["web.fetch"],
		});
		// Build a no-progress streak and some wandering spread.
		for (let i = 0; i < 2; i++) {
			guard.check({ toolName: "bash", args: { command: "test" } });
			guard.recordCall("bash", { command: "test" });
			guard.recordOutcome(
				"bash",
				{ command: "test" },
				{
					result: { content: [{ type: "text" as const, text: "ok" }], details: {}, isError: false },
				},
			);
		}
		guard.check({ toolName: "web.fetch", args: { url: "http://a.com" } });
		guard.recordCall("web.fetch", { url: "http://a.com" });

		// Simulate a terminal-yield abort: resetStreaks should clear the
		// no-progress streak but preserve wandering hashes.
		guard.resetStreaks();

		// No-progress streak is cleared — the next identical call should NOT
		// be vetoed (streak restarts at 1 after the next outcome).
		expect(guard.check({ toolName: "bash", args: { command: "test" } })).toEqual({ kind: "allow" });

		// Wandering hashes persist — web.fetch's set still has the entry.
		guard.check({ toolName: "web.fetch", args: { url: "http://b.com" } });
		guard.recordCall("web.fetch", { url: "http://b.com" });
		// A new URL should see spread=2 (set still has http://a.com from before).
		const verdict = guard.check({ toolName: "web.fetch", args: { url: "http://c.com" } });
		expect(verdict.kind).toBe("wandering");
		if (verdict.kind === "wandering") expect(verdict.spread).toBe(3);
	});

	test("distinct bigint details produce distinct hashes (not collapsed to unhashable)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 0,
		});
		// Two calls with same text but DIFFERENT bigint values in details.
		// JSON.stringify throws on bigint, but the replacer converts 1n → "1n"
		// and 2n → "2n", so they hash distinctly and don't build a streak.
		for (const value of [1n, 2n]) {
			guard.check({ toolName: "read", args: { path: "data.json" } });
			guard.recordCall("read", { path: "data.json" });
			guard.recordOutcome(
				"read",
				{ path: "data.json" },
				{
					result: {
						content: [{ type: "text" as const, text: "loaded" }],
						details: { value },
						isError: false,
					},
				},
			);
		}
		// 3rd call should be allowed — distinct bigints broke the streak.
		expect(guard.check({ toolName: "read", args: { path: "data.json" } })).toEqual({
			kind: "allow",
		});
	});

	test("genuinely unhashable outcomes are non-comparable (unique fallback)", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 0,
		});
		// Create objects with a getter that throws — bypasses the WeakSet
		// cycle guard and forces the catch branch.
		function makeThrowingDetails(): Record<string, unknown> {
			const obj: Record<string, unknown> = {};
			Object.defineProperty(obj, "boom", {
				get() {
					throw new Error("serialize fail");
				},
				enumerable: true,
			});
			return obj;
		}
		// Two calls with same text but unhashable details — each should get
		// a unique fallback hash so they never falsely match.
		for (let i = 0; i < 2; i++) {
			guard.check({ toolName: "bash", args: { command: "test" } });
			guard.recordCall("bash", { command: "test" });
			guard.recordOutcome(
				"bash",
				{ command: "test" },
				{
					result: {
						content: [{ type: "text" as const, text: "ok" }],
						details: makeThrowingDetails(),
						isError: false,
					},
				},
			);
		}
		// 3rd call should be allowed — unique fallbacks broke the streak.
		expect(guard.check({ toolName: "bash", args: { command: "test" } })).toEqual({
			kind: "allow",
		});
	});

	test("browser.* prefix matching: browser.scroll matches 'browser' prone entry", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 0,
			wanderingThreshold: 2,
			wanderingEscalation: 99,
			breakerVetoStreak: 99,
			proneTools: ["browser"], // only the prefix, not browser.scroll
		});
		// browser.scroll should be treated as prone via prefix matching.
		guard.check({ toolName: "browser.scroll", args: { x: 0, y: 0 } });
		guard.recordCall("browser.scroll", { x: 0, y: 0 });
		guard.check({ toolName: "browser.scroll", args: { x: 100, y: 200 } });
		guard.recordCall("browser.scroll", { x: 100, y: 200 });
		// spread=3 should trigger wandering (threshold=2).
		const verdict = guard.check({ toolName: "browser.scroll", args: { x: 50, y: 50 } });
		expect(verdict.kind).toBe("wandering");
		if (verdict.kind === "wandering") expect(verdict.spread).toBe(3);
	});

	test("non-prone tool name with a dot is NOT prefix-matched", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 0,
			wanderingThreshold: 2,
			proneTools: ["web.fetch"],
		});
		// "read.file" should NOT match "web.fetch" — different prefix.
		guard.check({ toolName: "read.file", args: { path: "a" } });
		guard.recordCall("read.file", { path: "a" });
		guard.check({ toolName: "read.file", args: { path: "b" } });
		guard.recordCall("read.file", { path: "b" });
		// read.file is not prone — should always be allow.
		expect(guard.check({ toolName: "read.file", args: { path: "c" } })).toEqual({ kind: "allow" });
	});

	test("Date/Map/Set in details are preserved by stripVolatile (not collapsed to {})", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 2,
			wanderingThreshold: 0,
		});
		// Two calls with same text but DIFFERENT Date values in details.
		// stripVolatile should pass Date through (not recurse into it as {}).
		// Note: the key name must NOT be a volatile key (timestamp, date, etc.
		// are stripped) — use a semantic key like "lastModified".
		// and JSON.stringify calls Date.toJSON() → distinct ISO strings.
		for (const date of [new Date("2026-01-01"), new Date("2026-06-01")]) {
			guard.check({ toolName: "read", args: { path: "log" } });
			guard.recordCall("read", { path: "log" });
			guard.recordOutcome(
				"read",
				{ path: "log" },
				{
					result: {
						content: [{ type: "text" as const, text: "ok" }],
						details: { lastModified: date },
						isError: false,
					},
				},
			);
		}
		// 3rd call should be allowed — distinct Date.toJSON() broke the streak.
		expect(guard.check({ toolName: "read", args: { path: "log" } })).toEqual({
			kind: "allow",
		});
	});

	test("breaker does not recreate the wandering set via recordCall", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 99,
			exemptTools: [],
			noProgressThreshold: 0,
			wanderingThreshold: 1,
			wanderingEscalation: 2,
			breakerVetoStreak: 2,
			proneTools: ["web.fetch"],
		});
		// Fill past escalation twice to trigger the breaker.
		// Call 1: spread=1 (below escalation)
		guard.check({ toolName: "web.fetch", args: { url: "http://a.com" } });
		guard.recordCall("web.fetch", { url: "http://a.com" });
		// Call 2: spread=2 (at escalation → critical, wanderingVetoes=1)
		guard.check({ toolName: "web.fetch", args: { url: "http://b.com" } });
		guard.recordCall("web.fetch", { url: "http://b.com" });
		// Call 3: spread=3 (at escalation → critical, wanderingVetoes=2 → breaker)
		const breaker = guard.check({ toolName: "web.fetch", args: { url: "http://c.com" } });
		expect(breaker.kind).toBe("breaker");
		// The breaker deleted the wandering set. Simulate the stream-guards
		// behavior: skip recordCall for breaker verdicts.
		// (In the real wiring, beforeToolCall skips recordCall for breakers.)
		// Now the next call should start fresh — spread=1, not 2.
		const fresh = guard.check({ toolName: "web.fetch", args: { url: "http://d.com" } });
		expect(fresh.kind).toBe("wandering"); // threshold=1, spread=1
		if (fresh.kind === "wandering") expect(fresh.spread).toBe(1);
	});
});
