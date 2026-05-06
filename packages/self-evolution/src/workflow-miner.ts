/**
 * WorkflowMiner: extracts deduplicated tool sequences as workflow patterns.
 */
import type { SessionTrace, WorkflowPattern } from "./types";

export class WorkflowMiner {
	/**
	 * Extract a workflow pattern from a session trace.
	 * Returns undefined if no tool calls exist.
	 */
	mine(trace: SessionTrace, intent: string): WorkflowPattern | undefined {
		const toolCalls = trace.entries.filter(e => e.type === "tool_call" && e.toolName);
		if (toolCalls.length === 0) return undefined;

		// Deduplicate consecutive identical tools
		const sequence: string[] = [];
		for (const entry of toolCalls) {
			const tool = entry.toolName!;
			if (sequence.length === 0 || sequence[sequence.length - 1] !== tool) {
				sequence.push(tool);
			}
		}

		const id = this.#hashSequence(sequence);

		return {
			id,
			intent: intent as WorkflowPattern["intent"],
			toolSequence: sequence,
			occurrenceCount: 1,
			avgQualityScore: 0,
			lastSeenAt: Date.now(),
		};
	}

	#hashSequence(sequence: string[]): string {
		return sequence.join("→");
	}
}
