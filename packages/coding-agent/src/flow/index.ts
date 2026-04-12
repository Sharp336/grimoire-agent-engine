/**
 * Flow agent — data-driven orchestrator packaged as an ExecutionStrategy.
 *
 * Opt-in via OMP_FLOW=1 env var. See the flow-agent skill under
 * .claude/skills/flow-agent/ for the design brief, implementation plan,
 * and architecture references.
 *
 * The strategy is installed on `session.agent` at startup and then every
 * `session.prompt()` call — interactive, print, rpc, acp, nested — runs
 * through flow semantics without a parallel code path.
 */

export {
	createFlowStateMessage,
	extractLatestFlowState,
	isFlowStateMessage,
} from "./flow-state-codec";
export type { FlowExecutionStrategyOptions } from "./flow-strategy";
export { FlowExecutionStrategy } from "./flow-strategy";
export type { RunSubAgentOptions } from "./flow-subagent";
export { runSubAgent } from "./flow-subagent";

export type { FlowEditOp, FlowEditResult, FlowTraceEvent, FlowTraceListener } from "./flow-runtime";
export { FlowRuntime } from "./flow-runtime";
export type { FlowInspectDetails, FlowV2EditOp } from "./flow-tools";
export {
	applyV2EditOps,
	createFlowEditTool,
	createFlowInspectTool,
	FLOW_EDIT_TOOL_NAME,
	FLOW_INSPECT_TOOL_NAME,
	isFlowOwnedToolName,
} from "./flow-tools";
export { BUNDLED_BASE_FLOW, FlowStore } from "./flow-store";
export { FlowInterpreter } from "./flow-interpreter";
export type {
	Flow,
	FlowEdge,
	FlowNode,
	FlowTrigger,
	HookCall,
	NodeId,
} from "./flow-types";
export type { CallFrame, FlowState } from "./types";
export { FLOW_STATE_CUSTOM_TYPE } from "./types";
