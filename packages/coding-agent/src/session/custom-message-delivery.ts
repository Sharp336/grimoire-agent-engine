import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { CustomMessage } from "./messages";

/**
 * Persist custom messages via message_start/end so session listeners render
 * (TUI/ACP) and SessionManager appends CustomMessageEntry on message_end.
 */
export function emitPersistedCustomMessages(agent: Agent, records: CustomMessage[]): void {
	for (const record of records) {
		agent.emitExternalEvent({ type: "message_start", message: record });
		agent.emitExternalEvent({ type: "message_end", message: record });
	}
}
