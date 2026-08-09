import { describe, expect, it } from "bun:test";
import { parsePrimeSessions } from "../src/import/prime/session-parser";
import type { PrimeImportSourceDiscovery, PrimeSourceExcludedEntry, PrimeSourceFile } from "../src/import/prime/types";

function sessionFile(
	sourceRef: string,
	lines: readonly string[],
	domain: PrimeSourceFile["domain"] = "sessions",
): PrimeSourceFile {
	const content = lines.join("\n");
	return {
		kind: "file",
		domain,
		sourceRef,
		canonicalPath: `/prime/${sourceRef}`,
		mode: 0o600,
		mtimeMs: 1,
		size: Buffer.byteLength(content),
		sha256: "b".repeat(64),
		contentBase64: Buffer.from(content).toString("base64"),
	};
}

function discovery(
	files: readonly PrimeSourceFile[],
	excluded: readonly PrimeSourceExcludedEntry[] = [],
): PrimeImportSourceDiscovery {
	return {
		snapshot: {
			schemaVersion: 1,
			snapshotId: "session-snapshot",
			sourceRoot: "/prime",
			cwd: "/project",
			sessionRoot: "/prime/sessions",
			maxFileBytes: 1_000_000,
			maxTotalBytes: 1_000_000,
			maxEntries: 100,
			files: files.map(({ contentBase64: _contentBase64, ...metadata }) => metadata),
		},
		inventory: { records: files, files, excluded },
		losses: [],
	};
}

const header = (id = "root", parentSession?: string) =>
	JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/project",
		...(parentSession ? { parentSession } : {}),
	});
const entry = (value: Record<string, unknown>) => JSON.stringify(value);
const base = (id: string, parentId: string | null, type: string, timestamp = "2026-01-01T00:00:01.000Z") => ({
	type,
	id,
	parentId,
	timestamp,
});

function parse(files: readonly PrimeSourceFile[]) {
	return parsePrimeSessions(discovery(files));
}

describe("parsePrimeSessions", () => {
	it("parses v3 branches, settings transitions, compaction, summaries, and paired messages in physical order", () => {
		const lines = [
			header(),
			entry({ ...base("u", null, "message"), message: { role: "user", content: "hello", timestamp: 1 } }),
			entry({ ...base("m", "u", "model_change"), provider: "anthropic", modelId: "claude" }),
			entry({ ...base("t", "m", "thinking_level_change"), thinkingLevel: "high" }),
			entry({ ...base("s", "t", "service_tier_change"), serviceTier: "priority" }),
			entry({
				...base("a", "s", "message"),
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "calling" },
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					usage: {
						input: 1,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 3,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
			}),
			entry({
				...base("r", "a", "message"),
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
			}),
			entry({
				...base("c", "r", "compaction"),
				summary: "summary",
				firstKeptEntryId: "a",
				tokensBefore: 42,
				customInstructions: "focus",
			}),
			entry({ ...base("b", "c", "branch_summary"), fromId: "u", summary: "explored branch" }),
			entry({
				...base("u2", "b", "message"),
				message: { role: "user", content: [{ type: "text", text: "next" }], timestamp: 4 },
			}),
			entry({ ...base("label", "u2", "label"), targetId: "u2", label: "valid" }),
		];
		const result = parse([sessionFile("sessions/current/root.jsonl", lines)]);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]?.entries.map(entry => entry.id)).toEqual([
			"u",
			"m",
			"t",
			"s",
			"a",
			"r",
			"c",
			"b",
			"u2",
			"label",
		]);
		expect(result.sessions[0]?.entries.find(entry => entry.type === "model_change")).toMatchObject({
			model: "anthropic/claude",
		});
		expect(result.sessions[0]?.entries.find(entry => entry.type === "compaction")).toMatchObject({
			summary: "summary",
			tokensBefore: 42,
		});
		expect(
			result.sessions[0]?.entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"),
		).toMatchObject({
			message: { toolCallId: "call-1", toolName: "read" },
		});
	});

	it("preserves sibling branch parents and maps branch-local model settings and summaries", () => {
		const lines = [
			header("branches"),
			entry({ ...base("root", null, "message"), message: { role: "user", content: "root", timestamp: 1 } }),
			entry({ ...base("ga", "root", "model_change"), provider: "google", modelId: "gemini" }),
			entry({ ...base("gt", "ga", "thinking_level_change"), thinkingLevel: "low" }),
			entry({ ...base("gs", "gt", "service_tier_change"), serviceTier: "flex" }),
			entry({
				...base("gc", "gs", "compaction"),
				summary: "google",
				firstKeptEntryId: "ga",
				tokensBefore: 7,
				details: { source: "google" },
				customInstructions: "focus",
			}),
			entry({
				...base("gb", "gc", "branch_summary"),
				fromId: "root",
				summary: "branch",
				details: { branch: "google" },
				fromHook: true,
			}),
			entry({ ...base("aa", "root", "model_change"), provider: "anthropic", modelId: "claude" }),
			entry({ ...base("at", "aa", "thinking_level_change"), thinkingLevel: "high" }),
			entry({ ...base("as", "at", "service_tier_change"), serviceTier: "priority" }),
		];
		const result = parse([sessionFile("sessions/current/branches.jsonl", lines)]);
		const entries = result.sessions[0]?.entries ?? [];
		expect(entries.map(entry => entry.id)).toEqual(["root", "ga", "gt", "gs", "gc", "gb", "aa", "at", "as"]);
		expect(entries.find(entry => entry.id === "gs")).toMatchObject({ serviceTier: { google: "flex" } });
		expect(entries.find(entry => entry.id === "as")).toMatchObject({ serviceTier: { anthropic: "priority" } });
		expect(entries.find(entry => entry.id === "gc")).toMatchObject({
			details: { details: { source: "google" }, customInstructions: "focus" },
			firstKeptEntryId: "ga",
		});
		expect(entries.find(entry => entry.id === "gb")).toMatchObject({
			details: { branch: "google" },
			fromExtension: true,
		});
	});

	it("migrates v1 and v2 in memory, retaining physical order and assigning deterministic tree ids", () => {
		const raw = [
			JSON.stringify({ type: "session", id: "legacy", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/project" }),
			JSON.stringify({
				type: "message",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "one", timestamp: 1 },
			}),
			JSON.stringify({
				type: "message",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: { role: "hookMessage", customType: "x", content: "two", display: true, timestamp: 2 },
			}),
		];
		const result = parse([sessionFile("sessions/current/legacy.jsonl", raw)]);
		expect(result.sessions[0]?.header.version).toBe(3);
		expect(result.sessions[0]?.entries).toHaveLength(2);
		expect(result.sessions[0]?.entries[0]?.parentId).toBe(null);
		expect(result.sessions[0]?.entries[1]?.parentId).toBe(result.sessions[0]?.entries[0]?.id);
		expect(result.sessions[0]?.entries[1]).toMatchObject({ type: "message", message: { role: "custom" } });
	});
	it("migrates explicit v2 ids, parents, and hook custom-message details", () => {
		const lines = [
			JSON.stringify({
				type: "session",
				version: 2,
				id: "v2",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/project",
			}),
			entry({
				...base("u", null, "message"),
				message: { role: "user", content: "u", timestamp: 1 },
			}),
			entry({
				...base("h", "u", "message"),
				message: {
					role: "hookMessage",
					customType: "hook",
					content: "h",
					display: true,
					details: { ok: true },
					timestamp: 2,
				},
			}),
		];
		const result = parse([sessionFile("sessions/current/v2.jsonl", lines)]);
		expect(result.sessions[0]?.entries).toMatchObject([
			{ id: "u", parentId: null },
			{ id: "h", parentId: "u", type: "message", message: { role: "custom", details: { ok: true } } },
		]);
	});

	it("ledgers opaque records, duplicate ids, broken parents, and unmatched tool calls/results", () => {
		const lines = [
			header("bad"),
			entry({
				...base("a", null, "message"),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "missing-result", name: "x", arguments: {} }],
					api: "x",
					provider: "x",
					model: "x",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			}),
			entry({ ...base("dup", null, "label"), targetId: "a", label: "duplicate-one" }),
			entry({ ...base("dup", null, "label"), targetId: "a", label: "duplicate-two" }),
			entry({ ...base("c", null, "custom"), customType: "opaque", data: { secret: "must not appear" } }),
			entry({ ...base("state1", "a", "session_state") }),
			entry({ ...base("state2", "state1", "agent_status") }),
			entry({ ...base("state3", "state2", "git_state") }),
			entry({ ...base("state4", "state3", "child_usage_attributed") }),
			entry({ ...base("d", "does-not-exist", "label"), targetId: "x", label: "broken" }),
			entry({
				...base("r", null, "message"),
				message: {
					role: "toolResult",
					toolCallId: "unknown-call",
					toolName: "x",
					content: [],
					isError: false,
					timestamp: 2,
				},
			}),
		];
		const result = parse([sessionFile("sessions/current/bad.jsonl", lines)]);
		expect(result.sessions[0]?.entries.map(entry => entry.id)).toEqual(["a"]);
		expect(result.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "sessions-duplicate-id" }),
				expect.objectContaining({ code: "sessions-excluded-state" }),
				expect.objectContaining({ code: "sessions-unmatched-tool-call" }),
				expect.objectContaining({ code: "sessions-unmatched-tool-result" }),
				expect.objectContaining({ code: "sessions-opaque-record" }),
			]),
		);
		expect(JSON.stringify(result)).not.toContain("must not appear");
	});
	it("pairs distinct calls, disambiguates reused branch ids, and rejects duplicate results", () => {
		const assistant = (id: string, parentId: string | null, calls: readonly Record<string, unknown>[]) =>
			entry({
				...base(id, parentId, "message"),
				message: {
					role: "assistant",
					content: calls,
					api: "x",
					provider: "x",
					model: "x",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
			});
		const resultEntry = (id: string, parentId: string, callId: string) =>
			entry({
				...base(id, parentId, "message"),
				message: {
					role: "toolResult",
					toolCallId: callId,
					toolName: "x",
					content: [],
					isError: false,
					timestamp: 2,
				},
			});
		const lines = [
			header("pairing"),
			assistant("a", null, [
				{ type: "toolCall", id: "one", name: "one", arguments: {} },
				{ type: "toolCall", id: "two", name: "two", arguments: {} },
			]),
			resultEntry("r1", "a", "one"),
			resultEntry("r2", "a", "two"),
			assistant("b", "a", [{ type: "toolCall", id: "reused", name: "x", arguments: {} }]),
			assistant("c", "a", [{ type: "toolCall", id: "reused", name: "x", arguments: {} }]),
			resultEntry("r3", "b", "reused"),
			resultEntry("r4", "b", "reused"),
			assistant("d", "a", [{ type: "toolCall", id: "nested", name: "nested", arguments: {} }]),
			resultEntry("rx", "d", "unknown"),
			resultEntry("ry", "rx", "nested"),
		];
		const result = parse([sessionFile("sessions/current/pairing.jsonl", lines)]);
		expect(result.sessions[0]?.entries.map(entry => entry.id)).toEqual(["a", "r1", "r2", "b", "c", "r3", "d"]);
		expect(result.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "sessions-unmatched-tool-call" }),
				expect.objectContaining({ code: "sessions-unmatched-tool-result" }),
			]),
		);
	});

	it("does not mark a valid call unmatched when only a duplicate result is discarded", () => {
		const assistant = entry({
			...base("a", null, "message"),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "one", name: "one", arguments: {} }],
				api: "x",
				provider: "x",
				model: "x",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
		});
		const resultLine = (id: string) =>
			entry({
				...base(id, "a", "message"),
				message: {
					role: "toolResult",
					toolCallId: "one",
					toolName: "one",
					content: [],
					isError: false,
					timestamp: 2,
				},
			});
		const result = parse([
			sessionFile("sessions/current/duplicate-result.jsonl", [
				header("duplicate-result"),
				assistant,
				resultLine("r1"),
				resultLine("r2"),
			]),
		]);
		expect(result.sessions[0]?.entries.map(entry => entry.id)).toEqual(["a", "r1"]);
		expect(result.losses).toContainEqual(expect.objectContaining({ code: "sessions-unmatched-tool-result" }));
		expect(result.losses).not.toContainEqual(expect.objectContaining({ code: "sessions-unmatched-tool-call" }));
	});

	it("reports malformed middle lines and truncated tails with exact LF byte diagnostics", () => {
		const content = [
			header("diagnostics"),
			"{not-json}",
			entry({ ...base("u", null, "message"), message: { role: "user", content: "ok", timestamp: 1 } }),
			'{"type":"message"',
		].join("\n");
		const result = parse([sessionFile("sessions/current/diagnostics.jsonl", [content])]);
		expect(result.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "sessions-malformed",
					line: 2,
					byteOffset: Buffer.byteLength(header("diagnostics")) + 1,
				}),
				expect.objectContaining({ code: "sessions-truncated-tail", line: 4 }),
			]),
		);
	});

	it("accepts CRLF without splitting Unicode line separators and excludes runtime child state", () => {
		const crlf = `${header("crlf")}\r\n${entry({ ...base("u", null, "message"), message: { role: "user", content: "ok", timestamp: 1 } })}\r\n`;
		const unicode = `${header("unicode")}\u2028${entry({ ...base("u", null, "message"), message: { role: "user", content: "ok", timestamp: 1 } })}`;
		const result = parse([
			sessionFile("sessions/current/crlf.jsonl", [crlf]),
			sessionFile("sessions/current/unicode.jsonl", [unicode]),
			sessionFile(
				"artifacts/child.jsonl",
				[
					header("child", "/prime/root.jsonl"),
					entry({ ...base("u", null, "message"), message: { role: "user", content: "child", timestamp: 1 } }),
				],
				"artifacts",
			),
		]);
		expect(result.sessions.map(session => session.header.id)).toEqual(["crlf", "child"]);
		expect(result.losses).toContainEqual(
			expect.objectContaining({ code: "sessions-malformed", sourceRef: "sessions/current/unicode.jsonl" }),
		);
	});
	it("records child lineage, rejects orphan artifacts, and ledgers excluded runtime artifacts", () => {
		const child = sessionFile(
			"artifacts/child.jsonl",
			[
				header("child", "/prime/root.jsonl"),
				entry({ ...base("u", null, "message"), message: { role: "user", content: "child", timestamp: 1 } }),
			],
			"artifacts",
		);
		const orphan = sessionFile(
			"artifacts/orphan.jsonl",
			[
				header("orphan"),
				entry({ ...base("u", null, "message"), message: { role: "user", content: "orphan", timestamp: 1 } }),
			],
			"artifacts",
		);
		const baseDiscovery = discovery([child, orphan]);
		const result = parsePrimeSessions({
			...baseDiscovery,
			inventory: {
				...baseDiscovery.inventory,
				excluded: [
					{
						domain: "excluded-state",
						sourceRef: "runtime/heartbeat",
						canonicalPath: "/prime/runtime/heartbeat",
						kind: "file",
						reason: "heartbeat",
					},
				],
			},
		});
		expect(result.sessions[0]?.header.lineage).toMatchObject({ child: true, parentSession: "/prime/root.jsonl" });
		expect(result.sessions.some(session => session.header.id === "orphan")).toBe(false);
		expect(result.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "sessions-excluded-state", sourceRef: "artifacts/orphan.jsonl" }),

				expect.objectContaining({ code: "sessions-excluded-state", sourceRef: "runtime/heartbeat" }),
			]),
		);
	});

	it("hydrates only owned truncated bash output and keeps source provenance", () => {
		const source = sessionFile("sessions/current/hydrate.jsonl", [
			header("hydrate"),
			entry({
				...base("t", null, "message"),
				message: {
					role: "bashExecution",
					command: "run",
					output: "short",
					exitCode: 0,
					cancelled: false,
					truncated: true,
					fullOutputPath: "out.txt",
					timestamp: 1,
				},
			}),
			entry({
				...base("n", "t", "message"),
				message: {
					role: "bashExecution",
					command: "run",
					output: "complete",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					fullOutputPath: "out.txt",
					timestamp: 2,
				},
			}),
		]);
		const owned = {
			...sessionFile("artifacts/hydrate/out.txt", ["full output"], "artifacts"),
			canonicalPath: "/prime/sessions/current/out.txt",
			sha256: "c".repeat(64),
		};
		const wrongDomain = {
			...sessionFile("artifacts/hydrate/wrong.txt", ["wrong"], "sessions"),
			canonicalPath: "/prime/sessions/current/out.txt",
		};
		const result = parse([source, owned, wrongDomain]);
		const messages = result.sessions[0]?.entries.filter(
			entry => entry.type === "message" && entry.message.role === "bashExecution",
		);
		expect(messages?.[0]).toMatchObject({
			message: {
				output: "full output",
				fullOutputSourceRef: "artifacts/hydrate/out.txt",
				fullOutputSha256: "c".repeat(64),
			},
		});
		expect(messages?.[1]).toMatchObject({ message: { output: "complete" } });
		expect(messages?.[1]).not.toHaveProperty("message.fullOutputSourceRef");
	});
	it("ledgers truncated bash output when the owned full-output snapshot is missing", () => {
		const result = parse([
			sessionFile("sessions/current/missing-output.jsonl", [
				header("missing-output"),
				entry({
					...base("bash", null, "message"),
					message: {
						role: "bashExecution",
						command: "run",
						output: "inline",
						exitCode: 1,
						cancelled: false,
						truncated: true,
						fullOutputPath: "missing.txt",
						timestamp: 1,
					},
				}),
			]),
		]);
		expect(result.sessions[0]?.entries[0]).toMatchObject({ message: { output: "inline", truncated: true } });
		expect(result.losses).toContainEqual(
			expect.objectContaining({
				code: "sessions-missing-full-output",
				sourceRef: "sessions/current/missing-output.jsonl",
			}),
		);
	});

	it("rejects repeated tool-call ids and removes labels targeting an unmatched result", () => {
		const lines = [
			header("repeated-call"),
			entry({
				...base("a", null, "message"),
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "same-call", name: "first", arguments: {} },
						{ type: "toolCall", id: "same-call", name: "second", arguments: {} },
					],
					api: "x",
					provider: "x",
					model: "x",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			}),
			entry({
				...base("r", null, "message"),
				message: {
					role: "toolResult",
					toolCallId: "same-call",
					toolName: "first",
					content: [],
					isError: false,
					timestamp: 2,
				},
			}),
			entry({ ...base("l1", null, "label"), targetId: "r", label: "result" }),
			entry({ ...base("l2", null, "label"), targetId: "l1", label: "chain" }),
		];
		const result = parse([sessionFile("sessions/current/repeated-call.jsonl", lines)]);
		expect(result.sessions[0]?.entries.map(entry => entry.id)).toEqual(["a"]);
		expect(result.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "sessions-unmatched-tool-call",
					sourceRef: "sessions/current/repeated-call.jsonl",
				}),
				expect.objectContaining({
					code: "sessions-unmatched-tool-result",
					sourceRef: "sessions/current/repeated-call.jsonl",
				}),
				expect.objectContaining({
					code: "sessions-invalid-entry",
					sourceRef: "sessions/current/repeated-call.jsonl",
				}),
			]),
		);
	});
});
