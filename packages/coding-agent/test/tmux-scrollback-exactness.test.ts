import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

const PANE_COLUMNS = 164;
const PANE_ROWS = 19;
const PANE_EXIT_POLL_ATTEMPTS = 100;
const PANE_EXIT_POLL_MS = 50;
const MARKER_COUNT = 36;
const SESSION_NAME = "exactness";
const PANE_TARGET = `${SESSION_NAME}:0.0`;
const DRIVER_EXIT_MARKER = "TMUX-DRIVER-EXIT-0";
const tmuxPath = $which("tmux") ?? "";
const socketName = `omp-scrollback-${process.pid}-${crypto.randomUUID()}`;
const driverPath = path.join(import.meta.dir, "fixtures", "tmux-scrollback-driver.ts");
const childEnv = { ...process.env };
delete childEnv.TMUX;

type TmuxResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

async function runTmux(args: readonly string[], allowFailure = false): Promise<TmuxResult> {
	const command = [tmuxPath, "-L", socketName, "-f", "/dev/null", ...args];
	const proc = Bun.spawn(command, {
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0 && !allowFailure) {
		throw new Error(`tmux command failed (${exitCode}): ${command.map(shellQuote).join(" ")}\nstderr:\n${stderr}`);
	}
	return { exitCode, stdout, stderr };
}

describe.skipIf(process.platform === "win32" || !tmuxPath)("tmux scrollback exactness", () => {
	it("records one exact final assistant answer without erasing prior pane history", async () => {
		let paneState = "";
		let capture = "";
		try {
			await runTmux(["new-session", "-d", "-x", String(PANE_COLUMNS), "-y", String(PANE_ROWS), "-s", SESSION_NAME]);
			await runTmux(["set-option", "-w", "-t", `${SESSION_NAME}:0`, "remain-on-exit", "on"]);
			const paneCommand = `${shellQuote(process.execPath)} ${shellQuote(driverPath)} && echo ${shellQuote(DRIVER_EXIT_MARKER)}`;
			await runTmux(["respawn-pane", "-k", "-t", PANE_TARGET, paneCommand]);

			for (let attempt = 0; attempt < PANE_EXIT_POLL_ATTEMPTS; attempt++) {
				const status = await runTmux(["display-message", "-p", "-t", PANE_TARGET, "#{pane_dead}"]);
				paneState = status.stdout.trim();
				if (paneState === "1") break;
				// tmux is an external integration, so fake timers cannot advance pane lifecycle.
				await Bun.sleep(PANE_EXIT_POLL_MS);
			}

			capture = (await runTmux(["capture-pane", "-p", "-S", "-", "-t", PANE_TARGET])).stdout;
			expect(paneState, `pane did not exit; captured pane:\n${capture}`).toBe("1");
			expect(countOccurrences(capture, DRIVER_EXIT_MARKER), capture).toBe(1);
			expect(countOccurrences(capture, "PREEXISTING-HISTORY"), capture).toBe(1);
			expect(countOccurrences(capture, "STABLE-PREFACE"), capture).toBe(1);
			for (let index = 0; index < MARKER_COUNT; index++) {
				const marker = `MARK-${String(index).padStart(3, "0")}`;
				expect(countOccurrences(capture, marker), `${marker} count was not exact; captured pane:\n${capture}`).toBe(
					1,
				);
			}
		} finally {
			try {
				await runTmux(["kill-server"], true);
			} catch {
				// Best-effort cleanup: primary assertion failures must remain visible.
			}
		}
	}, 15_000);
});
