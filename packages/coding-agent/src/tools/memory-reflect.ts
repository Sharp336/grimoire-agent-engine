import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { memoryBackendSupports } from "../memory-backend";
import reflectDescription from "../prompts/tools/reflect.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryReflectSchema = type({
	query: type("string").describe("question to answer"),
	"context?": type("string").describe("optional context"),
});

export type MemoryReflectParams = typeof memoryReflectSchema.infer;

export class MemoryReflectTool implements AgentTool<typeof memoryReflectSchema> {
	readonly name = "reflect";
	readonly approval = "read" as const;
	readonly label = "Reflect";
	readonly description = reflectDescription;
	readonly parameters = memoryReflectSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Synthesize an answer from long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryReflectTool | null {
		if (!memoryBackendSupports(session.settings.get("memory.backend"), "reflect")) return null;
		return new MemoryReflectTool(session);
	}

	async execute(_id: string, params: MemoryReflectParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const memory = this.session.memory;
			if (!memory) throw new Error("Memory backend is not initialised for this session.");
			try {
				const result = await memory.reflect(params.query, { context: params.context, signal });
				return {
					content: [{ type: "text", text: result.text }],
					details: {},
				};
			} catch (err) {
				logger.warn("reflect failed", {
					backend: this.session.settings.get("memory.backend"),
					error: String(err),
				});
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}
