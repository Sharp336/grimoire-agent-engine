import { afterAll, describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { $which } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { loadPowerShellTool, type PowerShellToolDetails } from "../../src/tools/powershell";
import { disposeAllPsHosts } from "../../src/tools/pshost-manager";

const hasPwsh = Boolean(await $which("pwsh"));
const settings = await Settings.init();
const suite = hasPwsh ? describe : describe.skip;

function fakeSession(sessionId = "ps-tool-test"): ToolSession {
	return { cwd: process.cwd(), getSessionId: () => sessionId, settings } as unknown as ToolSession;
}

function textOf(result: AgentToolResult<PowerShellToolDetails>): string {
	const block = result.content?.find(part => part.type === "text");
	return block && block.type === "text" ? block.text : "";
}

suite("PowerShellTool (persistent host)", () => {
	afterAll(async () => {
		await disposeAllPsHosts();
	});

	test("retains runspace state across calls and maps exit codes", async () => {
		const tool = await loadPowerShellTool(fakeSession());
		expect(tool).not.toBeNull();
		if (!tool) return;

		const first = await tool.execute("c1", { command: "$x = 21; $x * 2" });
		expect(textOf(first).trim()).toBe("42");
		expect(first.isError ?? false).toBe(false);
		expect(first.details?.pid).toBeGreaterThan(0);

		// Same runspace: $x set above must survive into the next tool call.
		const second = await tool.execute("c2", { command: "$x + 1" });
		expect(textOf(second).trim()).toBe("22");

		// The previous result's live objects are inspectable without re-running.
		const third = await tool.execute("c3", { command: "$__omp.Last" });
		expect(textOf(third).trim()).toBe("22");

		// Non-zero native exit -> isError result (not thrown), output preserved.
		const failed = await tool.execute("c4", { command: "cmd /c exit 5" });
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain("code 5");

		// A PS-only command after a failed native must not inherit the stale
		// $LASTEXITCODE (regression: this was reported as exit 5 -> isError).
		const afterFail = await tool.execute("c5", { command: '"still ok"' });
		expect(textOf(afterFail).trim()).toBe("still ok");
		expect(afterFail.isError ?? false).toBe(false);

		// Invalid cwd fails fast: the command must not run in the previous dir.
		const badCwd = await tool.execute("c6", { command: '"should not run"', cwd: "omp-no-such-dir-zzz-12345" });
		expect(badCwd.isError).toBe(true);
		expect(textOf(badCwd)).toContain("Set-Location failed");
		expect(textOf(badCwd)).not.toContain("should not run");
	});

	test("captures non-success streams (Write-Host, Write-Warning)", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-streams-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Write-Host goes to the Information stream — previously dropped entirely.
		const host = await tool.execute("s1", { command: "Write-Host 'hello-host'" });
		expect(textOf(host)).toContain("hello-host");
		expect(host.isError ?? false).toBe(false);

		// Write-Warning is labeled and is not treated as a failure.
		const warn = await tool.execute("s2", { command: "Write-Warning 'heads-up'" });
		expect(textOf(warn)).toContain("WARNING: heads-up");
		expect(warn.isError ?? false).toBe(false);
	});
});
