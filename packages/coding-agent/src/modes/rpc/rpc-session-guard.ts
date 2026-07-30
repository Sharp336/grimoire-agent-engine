import type { AgentSession } from "../../session/agent-session";
import * as rpcCollab from "./rpc-collab";
import type { RpcCommand } from "./rpc-types";

export interface RpcSessionTransitionGuestBlock {
	message: string;
	code: "operation_failed";
}

const GUEST_SESSION_TRANSITION_MESSAGE =
	"Session changes are unavailable while joined as a collaboration guest. Run leave_collab_session first.";

const RPC_SESSION_TRANSITION_COMMANDS: Partial<Record<RpcCommand["type"], true>> = {
	join_collab_session: true,
	new_session: true,
	switch_session: true,
	branch: true,
	fork: true,
	branch_btw: true,
	navigate_tree: true,
	delete_session: true,
	handoff: true,
};

/** Whether a command changes the active session and must reach the transition coordinator. */
export function isRpcSessionTransitionCommand(command: RpcCommand, deletesActiveSession = false): boolean {
	if (command.type === "approve_plan_proposal") return command.strategy === "execute";
	return (
		RPC_SESSION_TRANSITION_COMMANDS[command.type] === true &&
		(command.type !== "delete_session" || deletesActiveSession)
	);
}

/** Returns the protocol error for a session transition attempted by a collaboration guest. */
export function getRpcSessionTransitionGuestBlock(session: AgentSession): RpcSessionTransitionGuestBlock | undefined {
	if (!rpcCollab.isRpcCollabGuest(session)) return undefined;
	return { message: GUEST_SESSION_TRANSITION_MESSAGE, code: "operation_failed" };
}

/** Rejects indirect RPC paths before they mutate a collaboration guest replica. */
export function assertRpcSessionTransitionAllowed(session: AgentSession): void {
	const block = getRpcSessionTransitionGuestBlock(session);
	if (block) throw new Error(block.message);
}
