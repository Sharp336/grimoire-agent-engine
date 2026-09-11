import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CursorCliSession } from "../../src/engine/cursor-cli";

describe.skipIf(process.platform !== "win32")("Cursor headless permission boundary", () => {
	it("only admits an exact once-only owner-session tool and bounds cancellation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "artel-cursor-contract-"));
		let permissions = 0;
		let text = "";
		const session = new CursorCliSession({
			cwd: root,
			sessionId: "12345678-1234-1234-1234-123456789012",
			modelId: "fixture",
			command: [process.execPath, path.resolve(import.meta.dir, "../fixtures/cursor-cli-peer.ts")],
			pluginDirectory: path.join(root, "plugin"),
			hookNode: process.execPath,
			requestTimeoutMs: 2000,
			onSession: async () => {},
			onPermission: async () => {
				permissions++;
				return { outcome: { outcome: "selected", optionId: "allow" } };
			},
			onUpdate: event => {
				if (event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text")
					text += event.update.content.text;
			},
		});
		try {
			await session.initialize();
			expect((await session.prompt([{ type: "text", text: "ok" }])).stopReason).toBe("end_turn");
			expect(text).toBe("forbidden,deny,deny,deny,allow,deny");
			expect(permissions).toBe(1);
			await expect(session.prompt([{ type: "text", text: "missing-result" }])).rejects.toThrow(
				"without a completed turn",
			);
			const abort = new AbortController();
			const pending = session.prompt([{ type: "text", text: "cancel" }], abort.signal);
			setTimeout(() => abort.abort(), 30);
			expect((await pending).stopReason).toBe("cancelled");
		} finally {
			session.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 10000);
});
