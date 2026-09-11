// Explicit manual real-provider probe. Does not create an Artel task or claim UI acceptance.
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { CursorCliSession } from "../../src/engine/cursor-cli";
import { cursorTurn } from "../../src/engine/cursor-turn";
import { SessionManager } from "../../src/session/session-manager";

if (process.env.ARTEL_CURSOR_LIVE !== "1") throw new Error("Explicit live probe opt-in required");
const executable = process.env.ARTEL_CURSOR_NODE;
const entrypoint = process.env.ARTEL_CURSOR_ENTRYPOINT;
const cwd = process.env.ARTEL_CURSOR_TEST_CWD;
const pluginDirectory = process.env.ARTEL_CURSOR_PLUGIN_DIR;
if (!executable || !entrypoint || !cwd || !pluginDirectory) throw new Error("Exact owned test paths required");
const model: Model = {
	id: "composer-2.5",
	provider: "cursor",
	api: "cursor-agent",
	baseUrl: "cursor://local",
	compat: undefined,
	name: "Composer 2.5",
	reasoning: true,
	input: ["text"],
	contextWindow: 200000,
	maxTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const sessionManager = SessionManager.inMemory(cwd);
let turn = 0;
const loop = cursorTurn({
	model,
	sessionManager,
	beforePrompt: async () => {},
	open: options =>
		new CursorCliSession({
			...options,
			command: [executable, entrypoint],
			modelId: model.id,
			pluginDirectory: path.join(pluginDirectory, String(++turn)),
			hookNode: executable,
		}),
	toolExecutionHook: {
		before: async call => {
			process.stdout.write(
				`${JSON.stringify({ permission: "requested", tool: call.toolName, id: call.toolCallId })}\n`,
			);
			if (process.env.ARTEL_CURSOR_ALLOW_READ !== "1" || call.toolName !== "read")
				throw new Error("Probe denies this tool");
			return { invocationId: call.toolCallId };
		},
		after: async () => {},
	},
});
const agent = new Agent({ initialState: { model }, externalLoop: loop });
let cancelled = false;
agent.subscribe(event => {
	if (process.env.ARTEL_CURSOR_CANCEL === "1" && event.type === "message_update" && !cancelled) {
		cancelled = true;
		agent.abort();
	}
	if (
		event.type === "message_end" &&
		(event.message.role === "user" || event.message.role === "assistant" || event.message.role === "toolResult")
	) {
		sessionManager.appendMessage(event.message);
		process.stdout.write(`${JSON.stringify({ role: event.message.role, content: event.message.content })}\n`);
	}
});
await agent.prompt(
	"Use Read exactly once on ./acceptance.txt. If denied, report that and stop. Do not try another tool.",
);
if (process.env.ARTEL_CURSOR_CONTINUE === "1" && !agent.state.error) {
	await agent.prompt("Without calling tools, repeat the exact sentinel string returned by the previous Read.");
}
process.stdout.write(
	`${JSON.stringify({ finished: !agent.state.isStreaming, cancelled, error: agent.state.error })}\n`,
);
