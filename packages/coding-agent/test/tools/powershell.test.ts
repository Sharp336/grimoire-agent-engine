import { afterAll, describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { $which } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { getThemeByName } from "../../src/modes/theme/theme";
import type { ToolSession } from "../../src/tools";
import { loadPowerShellTool, type PowerShellToolDetails, powershellToolRenderer } from "../../src/tools/powershell";
import { acquirePsHost, disposeAllPsHosts } from "../../src/tools/pshost-manager";

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
		const nativeFail = process.platform === "win32" ? "cmd /c exit 5" : "/bin/sh -c 'exit 5'";
		const failed = await tool.execute("c4", { command: nativeFail });
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

	test("host modes: ephemeral is isolated and disposed; new-session replaces the runspace", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-host-modes"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Ephemeral calls are independent processes -> shared concurrency; the
		// session host stays exclusive.
		expect(tool.concurrency({ host: "ephemeral" })).toBe("shared");
		expect(tool.concurrency({})).toBe("exclusive");
		expect(tool.concurrency({ host: "new-session" })).toBe("exclusive");

		const seed = await tool.execute("m1", { command: "$y = 7; $y" });
		expect(textOf(seed).trim()).toBe("7");
		expect(seed.details?.host).toBe("session");
		const sessionPid = seed.details?.pid;

		// Ephemeral: fresh runspace, session state invisible, own process.
		const eph = await tool.execute("m2", { command: "Test-Path variable:y", host: "ephemeral" });
		expect(textOf(eph).trim()).toBe("False");
		expect(eph.details?.host).toBe("ephemeral");
		expect(eph.details?.pid).not.toBe(sessionPid);

		// Awaited teardown: the ephemeral process is dead before the result returns.
		expect(() => process.kill(eph.details?.pid as number, 0)).toThrow();

		// The session host is untouched by the ephemeral call.
		const still = await tool.execute("m3", { command: "$y" });
		expect(textOf(still).trim()).toBe("7");
		expect(still.details?.pid).toBe(sessionPid);

		// new-session: old runspace state is gone and a new host takes over.
		const fresh = await tool.execute("m4", { command: "Test-Path variable:y", host: "new-session" });
		expect(textOf(fresh).trim()).toBe("False");
		expect(fresh.details?.host).toBe("new-session");
		const freshPid = fresh.details?.pid;
		expect(freshPid).not.toBe(sessionPid);

		// The replacement is the warm session host now: it persists.
		const persisted = await tool.execute("m5", { command: "$z = 1; $z" });
		expect(textOf(persisted).trim()).toBe("1");
		expect(persisted.details?.pid).toBe(freshPid);
	});

	test("a session host that dies mid-run is dropped and respawned", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-death-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		const before = await tool.execute("d1", { command: "$PID" });
		const beforePid = Number(textOf(before).trim());
		expect(beforePid).toBeGreaterThan(0);

		// Kill the sidecar from inside the command: the run must reject…
		await expect(tool.execute("d2", { command: "[Environment]::Exit(5)" })).rejects.toThrow();

		// …and the next default call gets a fresh host, not the pooled corpse.
		const after = await tool.execute("d3", { command: "$PID" });
		expect(after.isError ?? false).toBe(false);
		const afterPid = Number(textOf(after).trim());
		expect(afterPid).toBeGreaterThan(0);
		expect(afterPid).not.toBe(beforePid);
	});

	test("concurrent acquires for one session converge on a single host", async () => {
		const opts = { sessionId: "ps-race-test", cwd: process.cwd(), historyDepth: 5, idleTtlMs: 0 };
		// Without single-flight spawning, both acquires would see an empty pool
		// slot and spawn their own sidecar, silently leaking one.
		const [a, b] = await Promise.all([acquirePsHost(opts), acquirePsHost(opts)]);
		try {
			expect(a.host.pid).toBeGreaterThan(0);
			expect(a.host.pid).toBe(b.host.pid);
		} finally {
			a.release();
			b.release();
		}
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

	test("a spawned native reading stdin gets EOF instead of hanging on the protocol pipe", async () => {
		// The reported repro: git.exe inherited the host's stdin — the JSON
		// protocol pipe — and blocked on every subcommand until the tool timed
		// out. git-gated so the suite still runs where git is absent.
		const gitPath = await $which("git");
		if (!gitPath) return;
		const tool = await loadPowerShellTool(fakeSession("ps-native-stdin"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// A short timeout makes a regression fail fast rather than stalling the
		// whole suite for the full default window.
		const result = await tool.execute("g1", { command: "git --version", timeout: 15 });
		expect(result.isError ?? false).toBe(false);
		expect(textOf(result)).toContain("git version");
		expect(textOf(result)).not.toMatch(/timed out/i);
	});

	test("a lookup-only command after a failed native does not inherit its exit code", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-lookup-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		const nativeFail = process.platform === "win32" ? "cmd /c exit 7" : "/bin/sh -c 'exit 7'";
		const failed = await tool.execute("l1", { command: nativeFail });
		expect(failed.isError).toBe(true);

		// Get-Command resolves an Application without running it; PowerShell's
		// PostCommandLookupAction is NOT triggered by Get-Command discovery
		// (verified on 7.6.2), so the stale $LASTEXITCODE must not be
		// attributed to this lookup-only invocation. Guards against a pwsh
		// behavior change silently re-introducing stale-exit attribution.
		const lookup = await tool.execute("l2", {
			command: "[bool](Get-Command pwsh -ErrorAction SilentlyContinue)",
		});
		expect(lookup.isError ?? false).toBe(false);
		expect(textOf(lookup)).toContain("True");

		// A real native re-run exiting with the SAME code is still attributed
		// (the invocation-time lookup flag, not a value change, catches it).
		const failedAgain = await tool.execute("l3", { command: nativeFail });
		expect(failedAgain.isError).toBe(true);
		expect(textOf(failedAgain)).toContain("code 7");
	});

	test("a direct [Console]::Error write surfaces as error output instead of vanishing", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-console-error-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Only PS.Streams.Error and HadErrors previously fed hadErrors/output; a
		// .NET library (or user code) writing straight to [Console]::Error
		// silently vanished — Rust only retains the sidecar's OS stderr as a
		// startup-failure diagnostic tail, never routed to a running exec.
		const result = await tool.execute("ce1", { command: "[Console]::Error.WriteLine('boom-from-console-error')" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("boom-from-console-error");
	});

	test("a timed-out command with truncated output still surfaces the truncation notice", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-timeout-truncation-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Warm the host so its ~1s spawn doesn't eat into the tight timeout below.
		await tool.execute("t0", { command: "'warm'" });

		// Emit output well over the sink's 50KB in-memory window, then block past
		// the deadline so the command times out with a truncated tail retained.
		// Uses Write-Warning (not success-stream output): success output only
		// reaches the sink via the wrapped script's trailing Out-String line,
		// which never runs on a Stop mid-Start-Sleep — only data-stream output
		// (Write-Warning/-Host/-Verbose/-Debug) is live-streamed via
		// Publish-Streams before the pipeline completes (see pshost_bootstrap.ps1).
		// Pre-fix, the thrown timeout message carried only the retained tail with
		// no indication earlier output was elided.
		const command = "1..2000 | ForEach-Object { Write-Warning ('x' * 100) }; Start-Sleep -Seconds 30";
		// OutputSink retained head+tail here, so the notice is middle-elision
		// shaped ("Showing lines A-B and C-D of N; … elided") rather than a pure
		// tail range — match on the distinctive "Showing … of <total>" contract
		// shared by every truncation shape instead of one specific wording.
		await expect(tool.execute("t1", { command, timeout: 1 })).rejects.toThrow(/Showing .+ of \d+/);
	});
});

// Ungated: these need neither pwsh nor a live host.

test("loadPowerShellTool returns null when no shell resolves", async () => {
	// The stub returns a bogus shellPath for every settings key the loader
	// reads, so $which cannot resolve it and the tool must stay unregistered.
	const stubSettings = { get: () => "omp-no-such-shell-zzz-12345" };
	const session = { cwd: process.cwd(), settings: stubSettings } as unknown as ToolSession;
	expect(await loadPowerShellTool(session)).toBeNull();
});

test("renderer tags non-default host modes and renders the output", async () => {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	if (!theme) return;

	const component = powershellToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "boom" }],
			isError: true,
			details: { host: "ephemeral" } as PowerShellToolDetails,
		},
		{ expanded: false } as Parameters<typeof powershellToolRenderer.renderResult>[1],
		theme,
		{ command: "cmd /c exit 5", host: "ephemeral" },
	);
	const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
	const plain = stripAnsi(component.render(80).join("\n"));
	expect(plain).toContain("PowerShell · ephemeral");
	expect(plain).toContain("boom");

	// Default session mode carries no tag.
	const sessionComponent = powershellToolRenderer.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { host: "session" } as PowerShellToolDetails },
		{ expanded: false } as Parameters<typeof powershellToolRenderer.renderResult>[1],
		theme,
		{ command: "'ok'" },
	);
	const sessionPlain = stripAnsi(sessionComponent.render(80).join("\n"));
	expect(sessionPlain).toContain("PowerShell");
	expect(sessionPlain).not.toContain("PowerShell ·");
});

test("collapsed preview shows the output TAIL, not the first lines", async () => {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	if (!theme) return;

	// 30 lines, collapsed: the preview must window the END of the output (a
	// long-running command's current progress), with a skipped-lines banner —
	// not pin the first N lines forever.
	const lines = Array.from({ length: 30 }, (_, i) => `row-${String(i + 1).padStart(2, "0")}`);
	const component = powershellToolRenderer.renderResult(
		{ content: [{ type: "text", text: lines.join("\n") }], details: { host: "session" } as PowerShellToolDetails },
		{ expanded: false } as Parameters<typeof powershellToolRenderer.renderResult>[1],
		theme,
		{ command: '1..30 | ForEach-Object { "row-$_" }' },
	);
	const plain = component
		.render(80)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
	expect(plain).toContain("row-30");
	expect(plain).not.toContain("row-05");
	expect(plain).toMatch(/earlier lines/);
});
