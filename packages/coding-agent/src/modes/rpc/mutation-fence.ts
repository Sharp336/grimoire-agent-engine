import type { RpcCommand, RpcCommandType } from "./rpc-types";

const READ_ONLY_COMMANDS: ReadonlySet<RpcCommandType> = new Set([
	"negotiate_protocol",
	"get_state",
	"get_available_commands",
	"get_subagents",
	"get_subagent_messages",
	"get_available_models",
	"get_session_stats",
	"get_branch_messages",
	"get_last_assistant_text",
	"get_messages",
	"get_messages_page",
	"get_login_providers",
	"set_subagent_subscription",
]);

export function rpcCommandMutatesSession(command: RpcCommand): boolean {
	return !READ_ONLY_COMMANDS.has(command.type);
}
