import { describe, expect, it } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { convertMessageToLlm } from "@oh-my-pi/pi-agent-core/compaction";
import { resolveExecHandler } from "@oh-my-pi/pi-ai/providers/cursor";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import {
	type ReadResult,
	ReadResultSchema,
	ReadSuccessSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

describe("Cursor native exec replay conversion", () => {
	it("preserves the exact native result through LLM message conversion", async () => {
		const pairing = { toolCallId: "cursor-read-1", toolName: "read" };
		const nativeResult = create(ReadResultSchema, {
			result: {
				case: "success",
				value: create(ReadSuccessSchema, {
					path: "/tmp/foo",
					output: { case: "content", value: "native file bytes" },
				}),
			},
		});
		const first = await resolveExecHandler<{ path: string }, ReadResult>(
			{ path: "/tmp/foo" },
			async () => nativeResult,
			undefined,
			() => {
				throw new Error("first execution must use the native handler result");
			},
			() => create(ReadResultSchema),
			() => create(ReadResultSchema),
			pairing,
		);
		if (!first.toolResult) throw new Error("expected a paired transcript result");

		const converted = convertMessageToLlm(first.toolResult);
		if (converted?.role !== "toolResult") throw new Error("expected a converted tool result");

		let repeatedExecutions = 0;
		const replay = await resolveExecHandler<{ path: string }, ReadResult>(
			{ path: "/tmp/foo" },
			async () => {
				repeatedExecutions++;
				return create(ReadResultSchema);
			},
			undefined,
			() =>
				create(ReadResultSchema, {
					result: {
						case: "success",
						value: create(ReadSuccessSchema, {
							path: "/tmp/foo",
							output: { case: "content", value: "lossy transcript reconstruction" },
						}),
					},
				}),
			() => create(ReadResultSchema),
			() => create(ReadResultSchema),
			{ ...pairing, previousResult: converted as ToolResultMessage },
		);

		expect(repeatedExecutions).toBe(0);
		expect(replay.execResult).toBe(nativeResult);
		expect(JSON.stringify(converted)).not.toContain("native file bytes");
	});
});
