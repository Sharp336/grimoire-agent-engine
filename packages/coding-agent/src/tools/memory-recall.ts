import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { formatCurrentTime } from "../hindsight/content";
import { memoryBackendSupports } from "../memory-backend";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRecallSchema = type({
	query: type("string").describe("natural language search query"),
});

export type MemoryRecallParams = typeof memoryRecallSchema.infer;

export class MemoryRecallTool implements AgentTool<typeof memoryRecallSchema> {
	readonly name = "recall";
	readonly approval = "read" as const;
	readonly label = "Recall";
	readonly description = recallDescription;
	readonly parameters = memoryRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search memory for relevant prior context";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRecallTool | null {
		if (!memoryBackendSupports(session.settings.get("memory.backend"), "recall")) return null;
		return new MemoryRecallTool(session);
	}

	async execute(_id: string, params: MemoryRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const memory = this.session.memory;
			if (!memory) throw new Error("Memory backend is not initialised for this session.");
			try {
				const result = await memory.search(params.query, { signal });
				if (result.message) throw new Error(result.message);
				if (result.count === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
						details: {},
						useless: true,
					};
				}
				const formatted = result.rendered ?? result.items.map(item => `- ${item.content}`).join("\n\n");
				return {
					content: [
						{
							type: "text",
							text: `Found ${result.count} relevant ${result.count === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
						},
					],
					details: {},
				};
			} catch (err) {
				logger.warn("recall failed", {
					backend: this.session.settings.get("memory.backend"),
					error: String(err),
				});
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}
