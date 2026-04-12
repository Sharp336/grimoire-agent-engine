/**
 * FlowState codec — serializes flow runtime state into the conversation
 * history as a CustomMessage with customType "flow-state".
 *
 * Why CustomMessage:
 * - Already exists in coding-agent (session/messages.ts). Zero touch required.
 * - Gets persisted/loaded with session history for free.
 * - Branching/undo/export/rollback all work because the state rides along
 *   with the conversation.
 *
 * Why filter in convertToLlm:
 * - The existing convertToLlm turns `custom` messages into user messages —
 *   we don't want raw flow state as user text. The strategy strips
 *   flow-state messages before delegating to the base converter.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CustomMessage } from "../session/messages";
import { FLOW_STATE_CUSTOM_TYPE, type FlowState } from "./types";

export type FlowStateMessage = CustomMessage<FlowState>;

export function createFlowStateMessage(state: FlowState): FlowStateMessage {
	return {
		role: "custom",
		customType: FLOW_STATE_CUSTOM_TYPE,
		content: "",
		display: false,
		details: state,
		timestamp: Date.now(),
	};
}

export function isFlowStateMessage(message: AgentMessage): message is FlowStateMessage {
	return message.role === "custom" && (message as CustomMessage).customType === FLOW_STATE_CUSTOM_TYPE;
}

/**
 * Scan history backwards for the most recent flow-state message. Returns
 * undefined if the conversation has no flow state yet.
 */
export function extractLatestFlowState(messages: readonly AgentMessage[]): FlowState | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (isFlowStateMessage(msg)) {
			return msg.details;
		}
	}
	return undefined;
}
