import type { AppKeybinding } from "../../config/keybindings";
import type { RpcUiActionDescriptor } from "./rpc-types";

export type RpcUiActionRoute = Omit<RpcUiActionDescriptor, "id">;

/**
 * Exhaustive semantic routes for application keybindings.
 *
 * rpc-ui clients own physical key matching. A matched action either invokes a
 * typed RPC operation, remains terminal-local, or is forwarded to the active
 * semantic presentation for server-side component behavior.
 */
export const RPC_UI_ACTION_ROUTES = {
	"app.interrupt": { owner: "rpc", operations: ["abort", "ui_cancel", "ui_presentation_action"] },
	"app.clear": { owner: "client", operations: ["ui_editor_update"] },
	"app.exit": { owner: "rpc", operations: ["session_shutdown"] },
	"app.suspend": { owner: "client", operations: [] },
	"app.display.reset": { owner: "client", operations: [] },
	"app.thinking.cycle": { owner: "rpc", operations: ["cycle_thinking_level"] },
	"app.thinking.toggle": { owner: "client", operations: [] },
	"app.model.cycleForward": { owner: "rpc", operations: ["cycle_model"] },
	"app.model.cycleBackward": { owner: "rpc", operations: ["get_available_models", "set_model"] },
	"app.model.select": { owner: "rpc", operations: ["get_available_models", "set_model_role"] },
	"app.model.selectTemporary": { owner: "rpc", operations: ["get_available_models", "set_model"] },
	"app.tools.expand": { owner: "rpc", operations: ["ui_tools_expanded_set"] },
	"app.tools.toggleVisibility": { owner: "client", operations: [] },
	"app.editor.external": { owner: "client", operations: ["ui_editor_update"] },
	"app.message.followUp": { owner: "rpc", operations: ["follow_up"] },
	"app.retry": { owner: "rpc", operations: ["retry"] },
	"app.message.dequeue": {
		owner: "client",
		operations: ["get_queue", "remove_queued_message", "ui_editor_update"],
	},
	"app.clipboard.pasteImage": { owner: "client", operations: ["prompt", "steer", "follow_up"] },
	"app.clipboard.pasteTextRaw": { owner: "client", operations: ["ui_editor_paste"] },
	"app.clipboard.copyLine": { owner: "client", operations: ["ui_autocomplete_apply"] },
	"app.clipboard.copyPrompt": { owner: "client", operations: ["ui_autocomplete_apply"] },
	"app.agents.hub": { owner: "rpc", operations: ["list_agents", "get_agent"] },
	"app.session.new": { owner: "rpc", operations: ["new_session"] },
	"app.session.tree": { owner: "rpc", operations: ["get_session_tree", "select_session_leaf"] },
	"app.session.fork": { owner: "rpc", operations: ["fork_session"] },
	"app.session.resume": { owner: "rpc", operations: ["list_sessions", "switch_session"] },
	"app.session.observe": { owner: "rpc", operations: ["session_open"] },
	"app.session.togglePath": { owner: "presentation", operations: ["ui_presentation_input"] },
	"app.session.toggleSort": { owner: "presentation", operations: ["ui_presentation_input"] },
	"app.session.rename": { owner: "rpc", operations: ["rename_session"] },
	"app.session.delete": { owner: "rpc", operations: ["delete_session"] },
	"app.session.deleteNoninvasive": { owner: "rpc", operations: ["delete_session"] },
	"app.tree.foldOrUp": { owner: "presentation", operations: ["ui_presentation_input"] },
	"app.tree.unfoldOrDown": { owner: "presentation", operations: ["ui_presentation_input"] },
	"app.plan.toggle": { owner: "rpc", operations: ["get_state", "set_mode"] },
	"app.history.search": { owner: "client", operations: ["get_messages_page", "ui_editor_update"] },
	"app.stt.toggle": { owner: "client", operations: ["ui_editor_update"] },
	"app.live.toggle": { owner: "client", operations: ["prompt", "abort"] },
} satisfies Record<AppKeybinding, RpcUiActionRoute>;

export function projectRpcUiActionRoutes(): RpcUiActionDescriptor[] {
	return (Object.keys(RPC_UI_ACTION_ROUTES) as AppKeybinding[]).map(id => ({
		id,
		...RPC_UI_ACTION_ROUTES[id],
		operations: [...RPC_UI_ACTION_ROUTES[id].operations],
	}));
}
