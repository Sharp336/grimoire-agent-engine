import type { Cursor, ServerFrame } from "@oh-my-pi/app-wire";
import type { SessionProjection } from "./projection";
import type { SubagentProjection } from "./subagent-projection";
import type { PreparedAttachOutput } from "./types";

export function prepareAttachOutput(projection: SessionProjection, cursor?: Cursor): PreparedAttachOutput {
	const initialFrames = cursor === undefined ? [projection.snapshot()] : projection.replay(cursor);
	return { initialFrames, baseline: { ...projection.value.cursor } };
}

export function completeAttachOutput(
	prepared: PreparedAttachOutput,
	projection: SessionProjection,
	subagents?: SubagentProjection,
): ServerFrame[] {
	return [...prepared.initialFrames, ...projection.replay(prepared.baseline), ...(subagents?.frames() ?? [])];
}
