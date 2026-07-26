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
});
