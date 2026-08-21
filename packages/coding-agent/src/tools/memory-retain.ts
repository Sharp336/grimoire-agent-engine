import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type MemoryBackendSaveResult, memoryBackendSupports } from "../memory-backend";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRetainSchema = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

export type MemoryRetainParams = typeof memoryRetainSchema.infer;
export class MemoryRetainTool implements AgentTool<typeof memoryRetainSchema> {
	readonly name = "retain";
	readonly approval = "read" as const;
	readonly label = "Retain";
	readonly description = retainDescription;
	readonly parameters = memoryRetainSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Store important facts in long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRetainTool | null {
		if (!memoryBackendSupports(session.settings.get("memory.backend"), "retain")) return null;
		return new MemoryRetainTool(session);
	}

	async execute(_id: string, params: MemoryRetainParams): Promise<AgentToolResult> {
		const memory = this.session.memory;
		if (!memory) throw new Error("Memory backend is not initialised for this session.");
		const results: MemoryBackendSaveResult[] = [];
		for (const item of params.items) {
			const result = await memory.save({
				content: item.content,
				context: item.context,
				source: "coding-agent-retain",
				importance: 0.75,
			});
			if (result.message) throw new Error(result.message);
			results.push(result);
		}
		const count = params.items.length;
		const noun = count === 1 ? "memory" : "memories";
		const queued = results.some(result => result.queued);
		return {
			content: [{ type: "text", text: `${count} ${noun} ${queued ? "queued" : "stored"}.` }],
			details: { count },
		};
	}
}
