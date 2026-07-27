/**
 * Proto builders for the modern Cursor CLI exec frames (`ExecServerMessage`
 * 27-31, 36-38, 40-55).
 *
 * Split out of `cursor.ts` because these are pure `create(...)` shapes with no
 * transport, stream, or block-state coupling: the dispatcher decides *which*
 * answer a frame gets, this module knows *what* that answer looks like on the
 * wire. Every builder returns a result whose oneof case is set — an
 * `ExecClientMessage` carrying a result with an unset oneof is a fake success
 * the server reads as "the tool ran and produced nothing".
 */

import * as path from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	AfterAgentResponseRequestResponseSchema,
	AfterAgentThoughtRequestResponseSchema,
	BeforeSubmitPromptRequestResponseSchema,
	type ExecuteHookRequest,
	type ExecuteHookResponse,
	ExecuteHookResponseSchema,
	type ExecuteHookResult,
	ExecuteHookResultSchema,
	type McpStateExecResult,
	McpStateExecResultSchema,
	McpStateServerSchema,
	McpStateSuccessSchema,
	type McpToolDefinition,
	PiBashExecErrorSchema,
	type PiBashExecResult,
	PiBashExecResultSchema,
	PiBashExecSuccessSchema,
	PiEditExecErrorSchema,
	type PiEditExecResult,
	PiEditExecResultSchema,
	PiEditExecSuccessSchema,
	PiFindExecErrorSchema,
	type PiFindExecResult,
	PiFindExecResultSchema,
	PiFindExecSuccessSchema,
	PiGrepExecErrorSchema,
	type PiGrepExecResult,
	PiGrepExecResultSchema,
	PiGrepExecSuccessSchema,
	PiLsExecErrorSchema,
	type PiLsExecResult,
	PiLsExecResultSchema,
	PiLsExecSuccessSchema,
	PiReadExecErrorSchema,
	type PiReadExecResult,
	PiReadExecResultSchema,
	PiReadExecSuccessSchema,
	type PiTruncation,
	PiTruncationSchema,
	PiWriteExecErrorSchema,
	type PiWriteExecResult,
	PiWriteExecResultSchema,
	PiWriteExecSuccessSchema,
	PostToolUseFailureRequestResponseSchema,
	PostToolUseRequestResponseSchema,
	PreCompactRequestResponseSchema,
	PreToolUseRequestResponseSchema,
	StopRequestResponseSchema,
	SubagentStartRequestResponseSchema,
	SubagentStopRequestResponseSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import type { ToolResultMessage } from "../../types";

/**
 * Translate a Pi frame's args into the local tool kwargs that run it.
 *
 * Shared deliberately: the provider synthesizes a display block from these and
 * the coding-agent bridge executes with them. Two hand-rolled translations of
 * one frame drift, and the drift is invisible — the transcript shows one
 * operation while a different one runs.
 *
 * Every `optional int32` here is presence-sensitive: `0` is a supplied value,
 * not "unset", so it must never be folded into a default.
 */

/**
 * A `pi_read` range composed onto the path as `read`'s inline `:N+K` selector.
 *
 * `read` exposes no range kwargs, so an uncomposed range reads the whole file.
 * `offset` is a 1-indexed start clamped like the reference's
 * `Math.max(0, offset - 1)` over 0-indexed lines; `limit` is a line count.
 * `null` marks a present `limit: 0` — zero lines, which no selector expresses
 * and which must not degrade into a whole-file read.
 */
export function piReadPath(path: string, offset?: number, limit?: number): string | null {
	if (limit !== undefined && Math.floor(limit) <= 0) return null;
	const start = offset !== undefined ? Math.max(1, Math.floor(offset)) : undefined;
	const count = limit !== undefined ? Math.floor(limit) : undefined;
	if (start === undefined && count === undefined) return path;
	if (start === undefined) return `${path}:1+${count}`;
	return count === undefined ? `${path}:${start}-` : `${path}:${start}+${count}`;
}

/**
 * Join a Pi frame's optional `path` with the `glob`/`pattern` it scopes.
 *
 * The local `grep`/`glob` tools take one combined path spec. An absolute
 * pattern ignores the path, and an absent or `.` path leaves the pattern
 * standing alone rather than building a `./`- or `//`-prefixed spec.
 *
 * Uses `node:path` rather than string surgery so Windows absolutes (`C:\…`,
 * UNC) are recognised and separators stay normalized — the same treatment
 * `joinLegacyGlob` gives the legacy pi shim's identical path/glob pair.
 */
export function piJoinPath(basePath: string | undefined, pattern: string): string {
	if (path.isAbsolute(pattern)) return pattern;
	if (!basePath || basePath === ".") return pattern;
	return path.join(basePath, pattern);
}

/**
 * The path a `pi_ls` frame lists.
 *
 * The frame's `limit` is deliberately NOT mapped. It caps directory *entries*
 * (the reference does a flat `readdir` and slices the entry array), while the
 * local `read` tool renders a depth-2 tree with per-directory caps and elision
 * summaries and applies a selector as a *rendered line* slice. Nested rows,
 * headers and "N more" lines all count toward that slice, so `:1+K` would cap
 * a different unit while looking honored — worse than leaving it unset, which
 * at least reports the local listing's own truncation faithfully.
 */
export function piLsPath(basePath: string | undefined): string {
	return basePath || ".";
}

/** Escape a literal string so the regex-only local `grep` tool matches it verbatim. */
export function piEscapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Clamp a present `optional int32` result cap the way the reference does; `undefined` stays unset. */
export function piLimit(limit: number | undefined): number | undefined {
	return limit === undefined ? undefined : Math.max(1, Math.floor(limit));
}

/** Flatten a tool result's content into the single `output` string the Pi frames carry. */
export function piOutputText(toolResult: ToolResultMessage): string {
	return toolResult.content.map(item => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

/**
 * Read one field off a tool result's `details` bag, or off a nested object
 * inside it.
 *
 * `details` is `unknown` by design — every tool ships its own shape — so each
 * read is narrowed rather than asserted, and the caller decides what a value of
 * the wrong type means.
 */
function bagValue(bag: unknown, key: string): unknown {
	if (!bag || typeof bag !== "object" || !(key in bag)) return undefined;
	return Reflect.get(bag, key);
}

/**
 * A positive integer count from `details`, or `undefined`.
 *
 * The Pi frames model their limit counters as `optional uint32`: zero means
 * "the limit was reached at zero results", so a missing, non-numeric, or
 * non-positive value must stay unset rather than be sent as 0.
 */
function detailCount(toolResult: ToolResultMessage, key: string): number | undefined {
	const value = bagValue(toolResult.details, key);
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Translate a local tool's truncation summary
 * (`coding-agent/src/session/streaming-output.ts:TruncationResult`) into
 * `PiTruncation`.
 *
 * Returns `undefined` when nothing was truncated: the field is `optional` on
 * every Pi success message, and emitting a zeroed `PiTruncation` would tell the
 * server the output was trimmed to nothing.
 */
export function piTruncation(toolResult: ToolResultMessage): PiTruncation | undefined {
	const truncation = bagValue(toolResult.details, "truncation");
	if (bagValue(truncation, "truncated") !== true) return undefined;
	const truncatedBy = bagValue(truncation, "truncatedBy");
	const totalLines = bagValue(truncation, "totalLines");
	const outputLines = bagValue(truncation, "outputLines");
	const outputBytes = bagValue(truncation, "outputBytes");
	return create(PiTruncationSchema, {
		truncated: true,
		truncatedBy: typeof truncatedBy === "string" ? truncatedBy : "",
		totalLines: typeof totalLines === "number" ? totalLines : 0,
		outputLines: typeof outputLines === "number" ? outputLines : 0,
		outputBytes: typeof outputBytes === "number" ? outputBytes : 0,
		firstLineExceedsLimit: bagValue(truncation, "firstLineExceedsLimit") === true,
		lastLinePartial: bagValue(truncation, "lastLinePartial") === true,
	});
}

export function buildPiReadResult(toolResult: ToolResultMessage): PiReadExecResult {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildPiReadError(text || "Read failed");
	return create(PiReadExecResultSchema, {
		result: {
			case: "success",
			value: create(PiReadExecSuccessSchema, { output: text, truncation: piTruncation(toolResult) }),
		},
	});
}

export function buildPiReadError(error: string): PiReadExecResult {
	return create(PiReadExecResultSchema, {
		result: { case: "error", value: create(PiReadExecErrorSchema, { error }) },
	});
}

export function buildPiBashResult(toolResult: ToolResultMessage): PiBashExecResult {
	const text = piOutputText(toolResult);
	const truncation = piTruncation(toolResult);
	if (toolResult.isError) {
		return create(PiBashExecResultSchema, {
			result: {
				case: "error",
				value: create(PiBashExecErrorSchema, { error: text || "Command failed", truncation }),
			},
		});
	}
	return create(PiBashExecResultSchema, {
		result: {
			case: "success",
			value: create(PiBashExecSuccessSchema, { output: text, truncation }),
		},
	});
}

export function buildPiBashError(error: string): PiBashExecResult {
	return create(PiBashExecResultSchema, {
		result: { case: "error", value: create(PiBashExecErrorSchema, { error }) },
	});
}

/**
 * `PiEditExecSuccess` requires `diff` and `patch` alongside `output`. The local
 * `edit` tool reports them under `details`; when it does not, the strings stay
 * empty rather than being faked from the output text.
 */
export function buildPiEditResult(toolResult: ToolResultMessage): PiEditExecResult {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildPiEditError(text || "Edit failed");
	const diff = bagValue(toolResult.details, "diff");
	const patch = bagValue(toolResult.details, "patch");
	return create(PiEditExecResultSchema, {
		result: {
			case: "success",
			value: create(PiEditExecSuccessSchema, {
				output: text,
				diff: typeof diff === "string" ? diff : "",
				patch: typeof patch === "string" ? patch : "",
				firstChangedLine: detailCount(toolResult, "firstChangedLine"),
			}),
		},
	});
}

export function buildPiEditError(error: string): PiEditExecResult {
	return create(PiEditExecResultSchema, {
		result: { case: "error", value: create(PiEditExecErrorSchema, { error }) },
	});
}

export function buildPiWriteResult(toolResult: ToolResultMessage): PiWriteExecResult {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildPiWriteError(text || "Write failed");
	return create(PiWriteExecResultSchema, {
		result: { case: "success", value: create(PiWriteExecSuccessSchema, { output: text }) },
	});
}

export function buildPiWriteError(error: string): PiWriteExecResult {
	return create(PiWriteExecResultSchema, {
		result: { case: "error", value: create(PiWriteExecErrorSchema, { error }) },
	});
}

export function buildPiGrepResult(toolResult: ToolResultMessage): PiGrepExecResult {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildPiGrepError(text || "Grep failed");
	return create(PiGrepExecResultSchema, {
		result: {
			case: "success",
			value: create(PiGrepExecSuccessSchema, {
				output: text,
				truncation: piTruncation(toolResult),
				matchLimitReached: detailCount(toolResult, "perFileLimitReached"),
				linesTruncated: bagValue(toolResult.details, "linesTruncated") === true,
			}),
		},
	});
}

export function buildPiGrepError(error: string): PiGrepExecResult {
	return create(PiGrepExecResultSchema, {
		result: { case: "error", value: create(PiGrepExecErrorSchema, { error }) },
	});
}

export function buildPiFindResult(toolResult: ToolResultMessage): PiFindExecResult {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildPiFindError(text || "Find failed");
	return create(PiFindExecResultSchema, {
		result: {
			case: "success",
			value: create(PiFindExecSuccessSchema, {
				output: text,
				truncation: piTruncation(toolResult),
				resultLimitReached: detailCount(toolResult, "resultLimitReached"),
			}),
		},
	});
}

export function buildPiFindError(error: string): PiFindExecResult {
	return create(PiFindExecResultSchema, {
		result: { case: "error", value: create(PiFindExecErrorSchema, { error }) },
	});
}

export function buildPiLsResult(toolResult: ToolResultMessage): PiLsExecResult {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildPiLsError(text || "Ls failed");
	return create(PiLsExecResultSchema, {
		result: {
			case: "success",
			value: create(PiLsExecSuccessSchema, {
				output: text,
				truncation: piTruncation(toolResult),
				entryLimitReached: detailCount(toolResult, "resultLimitReached"),
			}),
		},
	});
}

export function buildPiLsError(error: string): PiLsExecResult {
	return create(PiLsExecResultSchema, {
		result: { case: "error", value: create(PiLsExecErrorSchema, { error }) },
	});
}

/**
 * Answer `mcpStateExecArgs` (frame 36) from the catalog already advertised in
 * `RequestContext.tools`.
 *
 * This client hosts no MCP servers of its own: every forwarded tool is a local
 * pi-agent tool published under a synthetic `providerIdentifier`. Regrouping
 * the same list keeps the server's view of "which servers exist and what do
 * they expose" consistent with what it was told at context time, instead of
 * claiming zero servers while tool calls for them keep arriving.
 *
 * `serverIdentifiers` filters the answer when the server asks about specific
 * servers. `kickOnly` is a restart request — there is nothing to restart, so it
 * is answered with the same state rather than an error.
 */
export function buildMcpStateResult(
	tools: McpToolDefinition[],
	serverIdentifiers: readonly string[],
): McpStateExecResult {
	const byProvider = new Map<string, McpToolDefinition[]>();
	for (const tool of tools) {
		const identifier = tool.providerIdentifier;
		const existing = byProvider.get(identifier);
		if (existing) existing.push(tool);
		else byProvider.set(identifier, [tool]);
	}

	const wanted = serverIdentifiers.length > 0 ? new Set(serverIdentifiers) : undefined;
	const servers = [];
	for (const [identifier, serverTools] of byProvider) {
		if (wanted && !wanted.has(identifier)) continue;
		servers.push(
			create(McpStateServerSchema, {
				serverName: identifier,
				serverIdentifier: identifier,
				tools: serverTools,
				status: "connected",
			}),
		);
	}

	return create(McpStateExecResultSchema, {
		result: { case: "success", value: create(McpStateSuccessSchema, { servers }) },
	});
}

/**
 * Build the neutral response for a hook query: the matching response case with
 * every field unset.
 *
 * This client runs no Cursor hooks, and every field of every response variant
 * is `optional` — so an empty response of the right case means "no hook had
 * anything to say", which is exactly true. It is NOT the unset-oneof fake
 * success: the case itself is set, only the payload is empty.
 *
 * `ExecuteHookRequest` and `ExecuteHookResponse` are parallel oneofs whose case
 * names line up, but the two unions are unrelated to the compiler: a `switch`
 * is what makes each pairing individually type-checked, and it forces a
 * deliberate branch when a future regen adds a request case.
 *
 * Returns `null` for a request case this build does not model, which the
 * dispatcher answers with `ExecClientThrow` rather than guessing a case.
 */
export function buildNeutralHookResult(request: ExecuteHookRequest | undefined): ExecuteHookResult | null {
	let response: ExecuteHookResponse;
	switch (request?.request.case) {
		case "preCompact":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "preCompact", value: create(PreCompactRequestResponseSchema, {}) },
			});
			break;
		case "subagentStart":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "subagentStart", value: create(SubagentStartRequestResponseSchema, {}) },
			});
			break;
		case "subagentStop":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "subagentStop", value: create(SubagentStopRequestResponseSchema, {}) },
			});
			break;
		case "preToolUse":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "preToolUse", value: create(PreToolUseRequestResponseSchema, {}) },
			});
			break;
		case "postToolUse":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "postToolUse", value: create(PostToolUseRequestResponseSchema, {}) },
			});
			break;
		case "postToolUseFailure":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "postToolUseFailure", value: create(PostToolUseFailureRequestResponseSchema, {}) },
			});
			break;
		case "beforeSubmitPrompt":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "beforeSubmitPrompt", value: create(BeforeSubmitPromptRequestResponseSchema, {}) },
			});
			break;
		case "afterAgentResponse":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "afterAgentResponse", value: create(AfterAgentResponseRequestResponseSchema, {}) },
			});
			break;
		case "afterAgentThought":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "afterAgentThought", value: create(AfterAgentThoughtRequestResponseSchema, {}) },
			});
			break;
		case "stop":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "stop", value: create(StopRequestResponseSchema, {}) },
			});
			break;
		default:
			return null;
	}
	return create(ExecuteHookResultSchema, { response });
}
