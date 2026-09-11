import * as path from "node:path";

// Synthetic CLI peer: exercises the real local hook endpoint, never a provider.
const args = process.argv.slice(2);
const sessionId = args[args.indexOf("--resume") + 1];
const plugin = args[args.indexOf("--plugin-dir") + 1];
const config = await Bun.file(path.join(plugin, "connection.json")).json();
const mode = args.at(-1);
if (mode === "cancel") {
	setInterval(() => {}, 1000);
} else {
	const decisions = [];
	for (const [tool, sid, id, token] of [
		["Read", sessionId, "wrong-auth", "wrong"],
		["Read", "foreign", "foreign-session", config.token],
		["Task", sessionId, "child", config.token],
		["mcp_custom_read", sessionId, "unknown", config.token],
		["Read", sessionId, "read-1", config.token],
		["Read", sessionId, "read-1", config.token],
	]) {
		const response = await fetch(config.url, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: JSON.stringify({
				hook_event_name: "preToolUse",
				conversation_id: sid,
				tool_use_id: id,
				tool_name: tool,
				tool_input: { path: "acceptance.txt" },
			}),
		});
		const result = response.ok ? ((await response.json()) as { permission: string }) : { permission: "forbidden" };
		decisions.push(result.permission);
	}
	process.stdout.write(
		`${JSON.stringify({ type: "assistant", session_id: sessionId, timestamp_ms: 1, message: { content: [{ type: "text", text: decisions.join(",") }] } })}\n`,
	);
	if (mode !== "missing-result")
		process.stdout.write(
			`${JSON.stringify({ type: "result", session_id: sessionId, subtype: "success", is_error: false })}\n`,
		);
}
