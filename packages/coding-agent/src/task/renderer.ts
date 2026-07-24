/**
 * Task tool renderer export.
 *
 * Separated from render.ts to avoid circular dependency issues with
 * tools/renderers.ts. This module has no side effects and can be safely
 * imported without triggering the subprocessToolRegistry registration.
 */
import { renderCall, renderResult } from "./render";

export const taskToolRenderer = {
	renderCall,
	renderResult,
	mergeCallAndResult: true,
	// Foreground task progress settles to a different final topology; force one
	// viewport repaint at settlement. Detached tasks are excluded by the
	// component's history retirement, not by removing this opt-in.
	forceResultViewportRepaintOnSettle: true,
} as const;
