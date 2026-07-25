import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, readJsonl, removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Drives `get_settings` through the real RPC server.
 *
 * The other tests stop short of the server: `rpc-get-settings.test.ts` calls
 * `handleGetSettings()` directly and the client test talks to a mock agent that
 * accepts the command through its own implementation. Deleting the dispatcher's
 * `case "get_settings"` leaves both of those green, so only a round trip over
 * real stdio protects the public wiring.
 */
describe("get_settings over the RPC server", () => {
	test("answers a real frame with disclosed appearance settings and redacts the rest", async () => {
		// A private agent directory: this command reads configured values, so an
		// inherited config would make the assertions depend on whoever runs them
		// and would print their settings into test output.
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-settings-${Snowflake.next()}-`));
		const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
		const child = Bun.spawn(
			["bun", cliPath, "--mode", "rpc", "--provider", "anthropic", "--model", "claude-sonnet-4-5"],
			{
				cwd: path.join(import.meta.dir, ".."),
				env: { ...Bun.env, PI_NO_TITLE: "1", PI_CODING_AGENT_DIR: agentDir },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		let unscoped: Record<string, unknown> | undefined;
		let scoped: Record<string, unknown> | undefined;
		// A parse error or a timeout inside the read loop must not leave the child
		// or its directory behind for the rest of the run.
		try {
			child.stdin.write(`${JSON.stringify({ type: "get_settings", id: "settings-probe" })}\n`);
			child.stdin.write(`${JSON.stringify({ type: "get_settings", id: "tab-probe", tab: "appearance" })}\n`);
			await child.stdin.flush();

			for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
				if (!isRecord(frame) || frame.type !== "response") continue;
				if (frame.id === "settings-probe") unscoped = frame;
				if (frame.id === "tab-probe") scoped = frame;
				if (unscoped && scoped) break;
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited.catch(() => {});
			await removeWithRetries(agentDir).catch(() => {});
		}

		expect(unscoped).toMatchObject({ success: true, command: "get_settings" });
		interface Entry {
			path: string;
			type: string;
			value?: unknown;
			redacted?: true;
			description?: string;
			ui?: { tab?: string; options?: unknown; ordered?: boolean };
		}
		if (!unscoped) throw new Error("the server never answered the unscoped get_settings frame");
		const settings = (unscoped.data as { settings: Entry[] }).settings;
		expect(settings.length).toBeGreaterThan(0);

		const byPath = new Map(settings.map(entry => [entry.path, entry]));
		// An allowlisted setting arrives with its value.
		expect(byPath.get("tui.tight")).not.toHaveProperty("redacted");
		expect(byPath.get("tui.tight")).toHaveProperty("value");
		// Everything outside the allowlist is withheld, with no value at all.
		expect(byPath.get("auth.broker.token")).toMatchObject({ redacted: true });
		expect(byPath.get("auth.broker.token")).not.toHaveProperty("value");
		// Rendering metadata survives the wire, which is the reason to call this
		// command instead of duplicating the schema.
		expect(byPath.get("theme.dark")?.ui?.options).toBe("runtime");
		expect(byPath.get("providers.webSearchOrder")?.ui?.ordered).toBe(true);
		expect(byPath.get("tui.maxInlineImageColumns")?.description).toContain("inline images");

		// The tab argument reaches the server rather than being dropped.
		expect(scoped).toMatchObject({ success: true });
		if (!scoped) throw new Error("the server never answered the tab-scoped get_settings frame");
		const scopedSettings = (scoped.data as { settings: Entry[] }).settings;
		expect(scopedSettings.length).toBeGreaterThan(0);
		expect(scopedSettings.length).toBeLessThan(settings.length);
		for (const entry of scopedSettings) expect(entry.ui?.tab).toBe("appearance");
	}, 60000);
});
