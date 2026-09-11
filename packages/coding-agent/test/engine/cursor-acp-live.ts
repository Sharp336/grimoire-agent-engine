// Manual real-provider acceptance. Never part of unattended fixture tests.
import { CursorAcpSession } from "../../src/engine/cursor-acp";

if (process.env.ARTEL_CURSOR_LIVE !== "1") throw new Error("Explicit live Cursor probe opt-in required");
const executable = process.env.ARTEL_CURSOR_NODE;
const entrypoint = process.env.ARTEL_CURSOR_ENTRYPOINT;
const cwd = process.env.ARTEL_CURSOR_TEST_CWD;
if (!executable || !entrypoint || !cwd) throw new Error("Exact owner-local CLI and test workspace required");
const updates: string[] = [];
const abort = new AbortController();
const plugin = process.env.ARTEL_CURSOR_TEST_PLUGIN;
const session = CursorAcpSession.spawn(
	[
		executable,
		entrypoint,
		"--model",
		process.env.ARTEL_CURSOR_MODEL ?? "auto",
		...(plugin ? ["--plugin-dir", plugin] : []),
		...(process.env.ARTEL_CURSOR_TRUST_TEST_WORKSPACE === "1" ? ["--trust"] : []),
		"acp",
	],
	{
		cwd,
		mode: process.env.ARTEL_CURSOR_AGENT_MODE === "1" ? "agent" : "ask",
		sessionId: process.env.ARTEL_CURSOR_SESSION_ID,
		onSession: async sessionId => {
			process.stdout.write(`${JSON.stringify({ sessionId })}\n`);
		},
		onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		onUpdate: (notification, replay) => {
			const update = notification.update;
			if (!replay && process.env.ARTEL_CURSOR_CANCEL === "1" && update.sessionUpdate === "agent_thought_chunk") {
				abort.abort();
			}
			if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && !replay) {
				updates.push(update.content.text);
			}
			process.stdout.write(`${JSON.stringify({ type: update.sessionUpdate, replay })}\n`);
		},
	},
);
try {
	await session.initialize();
	process.stdout.write(`${JSON.stringify({ initialized: true, capabilities: session.capabilities })}\n`);
	if (process.env.ARTEL_CURSOR_PROMPT) {
		const result = await session.prompt([{ type: "text", text: process.env.ARTEL_CURSOR_PROMPT }], abort.signal);
		process.stdout.write(`${JSON.stringify({ result, text: updates.join("") })}\n`);
	}
} finally {
	session.dispose();
}
