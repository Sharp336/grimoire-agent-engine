#!/usr/bin/env bun
/**
 * Test fixture: a stand-in for the coding-agent RPC mode.
 *
 * Emits the `ready` frame immediately, handles a small set of control frames,
 * echoes other inbound commands with success responses, and stays alive until
 * stdin closes or SIGTERM arrives.
 */
const write = (frame: Record<string, unknown>): void => {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};

write({ type: "ready" });

// Bun's `console` is an AsyncIterable over stdin lines.
for await (const raw of console) {
	if (!raw) continue;
	try {
		const frame = JSON.parse(raw) as Record<string, unknown>;
		if (!frame || typeof frame !== "object" || typeof frame.type !== "string") continue;
		const id = typeof frame.id === "string" ? frame.id : undefined;
		if (frame.type === "set_mode") {
			if (frame.mode === "plan") {
				write({
					type: "extension_ui_request",
					id: "plan-confirm",
					method: "confirm",
					title: "Approve plan?",
					message: "Approve the plan?",
				});
			}
			write({ type: "mode_changed", mode: frame.mode });
			write({ id, type: "response", command: frame.type, success: true, data: { mode: frame.mode } });
			continue;
		}
		if (frame.type === "set_approval_mode") {
			write({ type: "config_update", approvalMode: frame.mode });
			write({
				id,
				type: "response",
				command: frame.type,
				success: true,
				data: { approvalMode: frame.mode },
			});
			continue;
		}
		if (frame.type === "extension_ui_response") {
			write({
				type: "notice",
				level: "info",
				message: frame.confirmed === true ? "plan approved" : "plan rejected",
			});
			continue;
		}
		write({ id, type: "response", command: frame.type, success: true, data: {} });
	} catch {
		// Ignore parse errors — the test harness sends well-formed frames.
	}
}
process.exit(0);
