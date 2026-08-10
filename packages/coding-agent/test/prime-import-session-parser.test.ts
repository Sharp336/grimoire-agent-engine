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
	maxEntries = 100,
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
			maxEntries,
			files: files.map(({ contentBase64: _contentBase64, ...metadata }) => metadata),
			treeEntries: [],
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
function parse(files: readonly PrimeSourceFile[], maxEntries = 100) {
	return parsePrimeSessions(discovery(files, [], maxEntries));
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
	it("removes compaction and branch summaries whose referenced entries were rejected", () => {
		const lines = [
			header("dangling-references"),
			entry({ ...base("kept", null, "message"), message: { role: "user", content: "kept", timestamp: 1 } }),
			entry({ ...base("duplicate", "kept", "label"), targetId: "kept", label: "first" }),
			entry({ ...base("duplicate", "kept", "label"), targetId: "kept", label: "second" }),
			entry({
				...base("compaction", "kept", "compaction"),
				summary: "would truncate the transcript",
				firstKeptEntryId: "duplicate",
				tokensBefore: 1,
			}),
			entry({
				...base("chained-compaction", "kept", "compaction"),
				summary: "depends on a removed compaction",
				firstKeptEntryId: "compaction",
				tokensBefore: 2,
			}),
			entry({
				...base("child", "chained-compaction", "message"),
				message: { role: "user", content: "orphaned child", timestamp: 2 },
			}),
			entry({
				...base("root-summary", "kept", "branch_summary"),
				fromId: "root",
				summary: "valid root sentinel",
			}),
			entry({
				...base("summary", "kept", "branch_summary"),
				fromId: "duplicate",
				summary: "dangling branch",
			}),
			entry({ ...base("label", "kept", "label"), targetId: "child", label: "dangling label" }),
		];
		const result = parse([sessionFile("sessions/current/dangling-references.jsonl", lines)]);
		expect(result.sessions[0]?.entries.map(entry => entry.id)).toEqual(["kept", "root-summary"]);
		expect(result.losses.filter(item => item.code === "sessions-invalid-entry")).toHaveLength(5);
	});
	it("rejects invalid inline image base64 before apply while preserving valid image payloads", () => {
		const validData = Buffer.from("valid-image").toString("base64");
		const result = parse([
			sessionFile("sessions/current/images.jsonl", [
				header("images"),
				entry({
					...base("invalid", null, "message"),
					message: {
						role: "user",
						content: [{ type: "image", data: "not-base64", mimeType: "image/png" }],
						timestamp: 1,
					},
				}),
				entry({
					...base("valid", null, "message"),
					message: {
						role: "user",
						content: [{ type: "image", data: validData, mimeType: "image/png" }],
						timestamp: 2,
					},
				}),
			]),
		]);
		expect(result.sessions[0]?.entries.map(value => value.id)).toEqual(["valid"]);
		expect(result.sessions[0]?.entries[0]).toMatchObject({
			message: { content: [{ type: "image", data: validData, mimeType: "image/png" }] },
		});
		expect(result.losses).toContainEqual(
			expect.objectContaining({
				code: "sessions-invalid-entry",
				sourceRef: "sessions/current/images.jsonl",
				line: 2,
			}),
		);
	});
	it("hydrates full output from Windows-native paths while preserving POSIX source refs", () => {
		const source = {
			...sessionFile("sessions/current/windows-paths.jsonl", [
				header("windows-paths"),
				entry({
					...base("bash", null, "message"),
					message: {
						role: "bashExecution",
						command: "run",
						output: "truncated",
						exitCode: 0,
						cancelled: false,
						truncated: true,
						fullOutputPath: "C:\\Prime\\sessions\\current\\full-output.txt",
						timestamp: 1,
					},
				}),
			]),
			canonicalPath: "C:\\Prime\\sessions\\current\\windows-paths.jsonl",
		} satisfies PrimeSourceFile;
		const artifact = {
			...sessionFile("artifacts/windows-paths/full-output.txt", ["hydrated full output"], "artifacts"),
			canonicalPath: "C:\\Prime\\sessions\\current\\full-output.txt",
			sha256: "c".repeat(64),
		} satisfies PrimeSourceFile;

		const result = parse([source, artifact]);
		expect(result.sessions[0]?.sourceRef).toBe("sessions/current/windows-paths.jsonl");
		expect(result.sessions[0]?.entries[0]).toMatchObject({
			message: {
				output: "hydrated full output",
				fullOutputSourceRef: "artifacts/windows-paths/full-output.txt",
				fullOutputSha256: "c".repeat(64),
			},
		});
		expect(result.losses).not.toContainEqual(
			expect.objectContaining({
				code: "sessions-missing-full-output",
				sourceRef: "sessions/current/windows-paths.jsonl",
			}),
		);
	});
	it("matches Windows full-output paths case-insensitively while preserving POSIX provenance", () => {
		const source = {
			...sessionFile("sessions/current/windows-case.jsonl", [
				header("windows-case"),
				entry({
					...base("bash", null, "message"),
					message: {
						role: "bashExecution",
						command: "run",
						output: "truncated",
						exitCode: 0,
						cancelled: false,
						truncated: true,
						fullOutputPath: "C:\\PRIME\\SESSIONS\\CURRENT\\Full-Output.TXT",
						timestamp: 1,
					},
				}),
			]),
			canonicalPath: "c:\\Prime\\Sessions\\Current\\windows-case.jsonl",
		} satisfies PrimeSourceFile;
		const artifact = {
			...sessionFile("artifacts/windows-case/full-output.txt", ["hydrated case-insensitive output"], "artifacts"),
			canonicalPath: "C:\\prime\\sessions\\current\\full-output.txt",
			sha256: "c".repeat(64),
		} satisfies PrimeSourceFile;

		const result = parse([source, artifact]);
		expect(result.sessions[0]?.sourceRef).toBe("sessions/current/windows-case.jsonl");
		expect(result.sessions[0]?.entries[0]).toMatchObject({
			message: {
				output: "hydrated case-insensitive output",
				fullOutputSourceRef: "artifacts/windows-case/full-output.txt",
				fullOutputSha256: "c".repeat(64),
			},
		});
		expect(result.losses).not.toContainEqual(
			expect.objectContaining({
				code: "sessions-missing-full-output",
				sourceRef: "sessions/current/windows-case.jsonl",
			}),
		);
	});

	it("rejects inherited session and entry fields supplied through __proto__", () => {
		const inheritedHeader = JSON.stringify({
			["__proto__"]: {
				type: "session",
				version: 3,
				id: "inherited-header",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/attacker",
			},
		});
		const headerResult = parse([sessionFile("sessions/current/inherited-header.jsonl", [inheritedHeader])]);
		expect(headerResult.sessions).toEqual([]);
		expect(headerResult.losses).toContainEqual(
			expect.objectContaining({
				code: "sessions-invalid-entry",
				sourceRef: "sessions/current/inherited-header.jsonl",
				line: 1,
			}),
		);

		const inheritedEntry = JSON.stringify({
			["__proto__"]: {
				type: "message",
				id: "inherited-entry",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "user",
					content: "attacker-inherited",
					timestamp: 1,
				},
			},
		});
		const entryResult = parse([
			sessionFile("sessions/current/inherited-entry.jsonl", [header("safe"), inheritedEntry]),
		]);
		expect(entryResult.sessions).toHaveLength(1);
		expect(entryResult.sessions[0]?.entries).toEqual([]);
		expect(entryResult.sessions[0]?.fatalLossCodes).toEqual(["sessions-invalid-entry"]);
		expect(entryResult.losses).toContainEqual(
			expect.objectContaining({
				code: "sessions-invalid-entry",
				sourceRef: "sessions/current/inherited-entry.jsonl",
				line: 2,
			}),
		);
	});

	it("keeps genuinely header-only sessions importable while marking all-lost rows fatal", () => {
		const empty = parse([sessionFile("sessions/current/empty.jsonl", [header("empty")])]);
		expect(empty.sessions[0]?.entries).toEqual([]);
		expect(empty.sessions[0]?.fatalLossCodes).toBeUndefined();

		const allLost = parse([
			sessionFile("sessions/current/all-lost.jsonl", [
				header("all-lost"),
				entry({ ...base("unsupported", null, "custom"), customType: "opaque" }),
			]),
		]);
		expect(allLost.sessions[0]?.entries).toEqual([]);
		expect(allLost.sessions[0]?.fatalLossCodes).toEqual(["sessions-invalid-entry"]);
	});

	it("bounds rows and keeps deep linear ancestry near-linear", () => {
		const lines = [header("chain")];
		let parent: string | null = null;
		for (let index = 0; index < 90; index += 1) {
			const id = `label-${index}`;
			lines.push(entry({ ...base(id, parent, "label"), targetId: id }));
			parent = id;
		}
		const chain = parse([sessionFile("sessions/current/chain.jsonl", lines)]);
		expect(chain.sessions[0]?.entries).toHaveLength(90);
		expect(chain.losses).not.toContainEqual(expect.objectContaining({ code: "source-budget-exceeded" }));

		const bounded = parse(
			[
				sessionFile("sessions/current/bounded.jsonl", [
					header("bounded"),
					entry({ ...base("one", null, "label"), targetId: "one" }),
					entry({ ...base("two", "one", "label"), targetId: "two" }),
					entry({ ...base("three", "two", "label"), targetId: "three" }),
				]),
			],
			3,
		);
		expect(bounded.sessions[0]?.fatalLossCodes).toEqual(["source-budget-exceeded"]);
		expect(bounded.losses).toContainEqual(
			expect.objectContaining({ code: "source-budget-exceeded", line: 4, byteOffset: expect.any(Number) }),
		);
	});
	it("accounts for deeply nested details without throwing or importing the affected session", () => {
		let details: Record<string, unknown> = { leaf: "value" };
		for (let depth = 0; depth < 300; depth += 1) details = { next: details };
		const result = parse([
			sessionFile("sessions/current/deep-details.jsonl", [
				header("deep-details"),
				entry({ ...base("deep", null, "branch_summary"), fromId: "deep", summary: "deep", details }),
			]),
		]);

		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]?.entries).toEqual([]);
		expect(result.sessions[0]?.fatalLossCodes).toEqual(["source-budget-exceeded"]);
		expect(result.losses).toEqual([
			{
				code: "source-budget-exceeded",
				domain: "sessions",
				sourceRef: "sessions/current/deep-details.jsonl",
				line: 2,
				byteOffset: expect.any(Number),
				byteLength: expect.any(Number),
			},
		]);
	});
});
