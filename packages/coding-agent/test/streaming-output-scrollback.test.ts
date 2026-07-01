import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { theme as activeTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval-render";
import { previewWindowRows } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// Long, path-like output that wraps at the box's inner width — the case that
// made a fixed 10-line preview overflow the viewport once committed.
function longLines(count: number): string {
	return Array.from(
		{ length: count },
		(_, i) => `out-line-${i} ${"=".repeat(60)} https://example.com/very/long/path/segment/${i}`,
	).join("\n");
}

type DrainableScheduler = {
	now(): number;
	scheduleImmediate(cb: () => void): void;
	scheduleRender(cb: () => void, delayMs: number): { cancel(): void };
	flush(): void;
};
function makeDrainableScheduler(): DrainableScheduler {
	let clock = 0;
	const queue: Array<{ run: () => void; cancelled: boolean }> = [];
	const enqueue = (cb: () => void) => {
		const item = { run: cb, cancelled: false };
		queue.push(item);
		return item;
	};
	return {
		now: () => clock,
		scheduleImmediate(cb) {
			enqueue(cb);
		},
		scheduleRender(cb) {
			const item = enqueue(cb);
			return {
				cancel() {
					item.cancelled = true;
				},
			};
		},
		flush() {
			let guard = 0;
			while (queue.length > 0) {
				if (++guard > 100_000) throw new Error("scheduler did not settle");
				const item = queue.shift()!;
				clock += 1;
				if (!item.cancelled) item.run();
			}
		},
	};
}

// Plain Component → finalized by default: a settled block above the live region.
class StaticBlock implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.#lines;
	}
}

// A still-live predecessor (e.g. a parallel tool that is still running): being
// non-finalized closes the transcript's commit-safe run, so the streaming tool
// below it commits as forced-overflow — the path that sprayed.
class LiveBarrier extends StaticBlock {
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	isTranscriptBlockCommitStable(): boolean {
		return true;
	}
}

class MutableLiveBarrier extends LiveBarrier {
	#lines: string[];

	constructor(lines: string[]) {
		super(lines);
		this.#lines = lines;
	}

	set(lines: string[]): void {
		this.#lines = lines;
	}

	override render(_width: number): string[] {
		return this.#lines;
	}
}

// Stand-in for the input editor + status drawn below the transcript.
class Footer implements Component {
	#rows: number;
	constructor(rows: number) {
		this.#rows = rows;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.#rows }, (_, i) => `editor-${i}`);
	}
}

const ORIGINAL_ROWS = Object.getOwnPropertyDescriptor(process.stdout, "rows");
function stubStdoutRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

function contiguousAt(buffer: string[], needle: string[]): number[] {
	const hits: number[] = [];
	outer: for (let start = 0; start <= buffer.length - needle.length; start++) {
		for (let i = 0; i < needle.length; i++) {
			if ((buffer[start + i] ?? "") !== needle[i]) continue outer;
		}
		hits.push(start);
	}
	return hits;
}

function expectNoLoss(term: VirtualTerminal, frame: string[]): string[] {
	const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
	const hits = contiguousAt(buffer, frame);
	expect(hits.length).toBeGreaterThan(0);
	const tailStart = hits.at(-1)! + frame.length;
	for (let i = tailStart; i < buffer.length; i++) expect(buffer[i]).toBe("");
	return buffer;
}

describe("streaming tool output never sprays duplicate scrollback banners", () => {
	beforeAll(async () => {
		await initTheme();
	});
	afterEach(() => {
		if (ORIGINAL_ROWS) Object.defineProperty(process.stdout, "rows", ORIGINAL_ROWS);
		else Reflect.deleteProperty(process.stdout, "rows");
	});

	test("bash: growing partial output under a live predecessor does not duplicate banners", async () => {
		if (process.platform === "win32") return;
		const rows = 14;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(80, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new TranscriptContainer();
		transcript.addChild(new StaticBlock(["user: run the build"]));
		transcript.addChild(new LiveBarrier(["assistant: still working in a parallel tool…"]));
		const bash = new ToolExecutionComponent("bash", { command: "build.sh" }, {}, undefined, tui, process.cwd());
		transcript.addChild(bash);
		tui.addChild(transcript);
		tui.addChild(new Footer(6));

		try {
			tui.start();
			scheduler.flush();
			await term.flush();
			for (let n = 1; n <= 40; n++) {
				bash.updateResult({ content: [{ type: "text", text: longLines(n) }], isError: false }, true);
				term.scrollLines(1000);
				tui.requestRender();
				scheduler.flush();
				await term.flush();
			}
			const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			const banners = buffer.filter(row => row.includes("ctrl+o")).length;
			// Pre-fix this re-committed a fresh snapshot per streamed frame (~30+).
			expect(banners).toBeLessThanOrEqual(1);
		} finally {
			bash.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("ssh: settled native scrollback does not keep a stale pending host header above the final frame", async () => {
		if (process.platform === "win32") return;
		const rows = 14;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(60, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new TranscriptContainer();
		const command = [
			"python3 - <<'PY'",
			"import time",
			'BLOB = """',
			"alpha",
			"beta",
			"gamma",
			"delta",
			"epsilon",
			"zeta",
			"eta",
			"theta",
			"iota",
			"kappa",
			"lambda",
			"mu",
			"nu",
			"xi",
			"omicron",
			"pi",
			"rho",
			"sigma",
			"tau",
			"upsilon",
			"phi",
			"chi",
			"psi",
			"omega",
			'"""',
			"",
			"def chunk(label):",
			"    print(label)",
			"    print(BLOB[:40])",
			"",
			'print("REMOTE_PY_BEGIN")',
			'chunk("REMOTE_PY_BLOB")',
			"time.sleep(1)",
			'print("REMOTE_PY_TICK_1")',
			"time.sleep(1)",
			'print("REMOTE_PY_TICK_2")',
			"time.sleep(1)",
			'print("REMOTE_PY_TICK_3")',
			'print("REMOTE_PY_END")',
			"PY",
		].join("\n");
		const settle = async () => {
			scheduler.flush();
			await term.flush();
		};

		transcript.addChild(
			new StaticBlock([
				"Use only the ssh tool on build-host.",
				"Do not pass cwd and do not use tilde.",
				"Set command to: python3 - <<'PY'",
				...command.split("\n"),
			]),
		);
		transcript.addChild(new LiveBarrier(["assistant: still working in a parallel tool…"]));
		const ssh = new ToolExecutionComponent("ssh", { host: "build-host", command }, {}, undefined, tui, process.cwd());
		transcript.addChild(ssh);
		tui.addChild(transcript);
		tui.addChild(new Footer(4));

		try {
			tui.start();
			await settle();

			ssh.setArgsComplete();
			tui.requestRender();
			await settle();

			ssh.updateResult(
				{
					content: [
						{
							type: "text",
							text: [
								"REMOTE_PY_BEGIN",
								"REMOTE_PY_BLOB",
								"",
								"alpha",
								"beta",
								"gamma",
								"delta",
								"epsilon",
								"zeta",
								"eta",
								"REMOTE_PY_TICK_1",
								"REMOTE_PY_TICK_2",
								"REMOTE_PY_TICK_3",
								"REMOTE_PY_END",
							].join("\n"),
						},
					],
					isError: false,
				},
				false,
			);
			tui.requestRender();
			await settle();

			term.scrollLines(1_000);
			await term.flush();

			const bufferRows = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			const viewportText = term
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");

			// Final-state contract: once the SSH block settles, neither the viewport nor
			// native scrollback should retain a stale pending host header. Use a generic
			// host label so the oracle is repo-local, not machine-local.
			expect(viewportText).not.toContain("⏳ SSH: [build-host]");
			expect(bufferRows.filter(row => row.includes("⇄ SSH: [build-host]")).length).toBe(1);
			expect(bufferRows.filter(row => row.includes("⏳ SSH: [build-host]")).length).toBe(0);
		} finally {
			ssh.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("ssh regression: settled output must not leave a stale pending host header in native scrollback", async () => {
		if (process.platform === "win32") return;
		const rows = 14;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(60, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new TranscriptContainer();
		const command = ["python3 - <<'PY'", ...Array.from({ length: 50 }, (_unused, i) => `line_${i}`), "PY"].join("\n");
		const settle = async () => {
			scheduler.flush();
			await term.flush();
		};

		transcript.addChild(new StaticBlock(["lead-0", "lead-1"]));
		transcript.addChild(new LiveBarrier(["assistant: still working in a parallel tool…"]));
		const ssh = new ToolExecutionComponent("ssh", { host: "build-host", command }, {}, undefined, tui, process.cwd());
		transcript.addChild(ssh);
		tui.addChild(transcript);
		tui.addChild(new Footer(4));

		try {
			tui.start();
			await settle();

			ssh.setExpanded(true);
			ssh.setArgsComplete();
			for (let i = 0; i < 60; i++) {
				term.scrollLines(1_000);
				tui.requestRender();
				await settle();
			}

			ssh.updateResult({ content: [{ type: "text", text: "REMOTE_PY_BEGIN" }], isError: false }, true);
			for (let i = 0; i < 60; i++) {
				term.scrollLines(1_000);
				tui.requestRender();
				await settle();
			}

			ssh.updateResult(
				{
					content: [{ type: "text", text: ["REMOTE_PY_BEGIN", "REMOTE_PY_END"].join("\n") }],
					isError: false,
				},
				false,
			);
			tui.requestRender();
			await settle();
			term.scrollLines(1_000);
			await term.flush();

			const bufferText = term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			const viewportText = term
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");

			// Replay-like regression: the current engine leaves a stale pending host
			// header in native scrollback even though the settled viewport is clean.
			// Desired contract: once fixed, the settled state retains only the final
			// output/content, never the old pending host header.
			expect(viewportText).not.toContain("⏳ SSH: [build-host]");
			expect(bufferText).not.toContain("⏳ SSH: [build-host]");
			expect(bufferText).toContain("Output");
			expect(bufferText).toContain("REMOTE_PY_BEGIN");
			expect(bufferText).toContain("REMOTE_PY_END");
		} finally {
			ssh.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("ssh regression: settling a provisional result repaints away the pending header in viewport", async () => {
		if (process.platform === "win32") return;
		const rows = 14;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(60, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new TranscriptContainer();
		const command = ["python3 - <<'PY'", "print('hi')", "PY"].join("\n");
		const settle = async () => {
			scheduler.flush();
			await term.flush();
		};

		transcript.addChild(new StaticBlock(["lead-0", "lead-1"]));
		transcript.addChild(new LiveBarrier(["assistant: still working in a parallel tool…"]));
		const ssh = new ToolExecutionComponent("ssh", { host: "build-host", command }, {}, undefined, tui, process.cwd());
		transcript.addChild(ssh);
		tui.addChild(transcript);
		tui.addChild(new Footer(4));

		try {
			tui.start();
			await settle();

			ssh.setExpanded(true);
			ssh.setArgsComplete();
			tui.requestRender();
			await settle();

			ssh.updateResult({ content: [{ type: "text", text: "REMOTE_PY_BEGIN" }], isError: false }, true);
			tui.requestRender();
			await settle();

			const pendingViewportRows = term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			expect(pendingViewportRows.join("\n")).toContain("REMOTE_PY_BEGIN");
			expect(pendingViewportRows.join("\n")).toContain("⏳ SSH: [build-host]");
			expect(pendingViewportRows.join("\n")).toContain("Output");

			ssh.updateResult(
				{
					content: [{ type: "text", text: ["REMOTE_PY_BEGIN", "REMOTE_PY_END"].join("\n") }],
					isError: false,
				},
				false,
			);
			tui.requestRender();
			await settle();

			const viewportRows = term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			const viewportText = viewportRows.join("\n");
			expect(viewportRows.filter(row => row.includes("⏳ SSH: [build-host]"))).toHaveLength(0);
			expect(viewportText).toContain("⇄ SSH: [build-host]");
			expect(viewportText).toContain("REMOTE_PY_END");
			expect(viewportText).toContain("Output");
		} finally {
			ssh.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("ssh regression: settling after an ellipsis placeholder repaints away the stale placeholder rows", async () => {
		if (process.platform === "win32") return;
		const rows = 14;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(60, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new TranscriptContainer();
		const command = ["python3 - <<'PY'", ...Array.from({ length: 50 }, (_unused, i) => `line_${i}`), "PY"].join("\n");
		const settle = async () => {
			scheduler.flush();
			await term.flush();
		};

		transcript.addChild(new StaticBlock(["lead-0", "lead-1"]));
		transcript.addChild(new LiveBarrier(["assistant: still working in a parallel tool…"]));
		const ssh = new ToolExecutionComponent("ssh", { __partialJson: '{"host":"build-host"' }, {}, undefined, tui, process.cwd());
		transcript.addChild(ssh);
		tui.addChild(transcript);
		tui.addChild(new Footer(4));

		try {
			tui.start();
			await settle();

			const initialViewportText = term.getViewport().map(row => Bun.stripANSI(row).trimEnd()).join("\n");
			expect(initialViewportText).toContain("⏳ SSH: […]");
			expect(initialViewportText).toContain("$ …");

			for (let i = 0; i < 60; i++) {
				term.scrollLines(1_000);
				tui.requestRender();
				await settle();
			}

			ssh.updateArgs({ host: "build-host", command });
			ssh.setExpanded(true);
			ssh.setArgsComplete();
			tui.requestRender();
			await settle();

			ssh.updateResult({ content: [{ type: "text", text: "REMOTE_PY_BEGIN" }], isError: false }, true);
			for (let i = 0; i < 60; i++) {
				term.scrollLines(1_000);
				tui.requestRender();
				await settle();
			}

			ssh.updateResult(
				{
					content: [{ type: "text", text: ["REMOTE_PY_BEGIN", "REMOTE_PY_END"].join("\n") }],
					isError: false,
				},
				false,
			);
			tui.requestRender();
			await settle();
			term.scrollLines(1_000);
			await term.flush();

			const bufferText = term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			const viewportText = term
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");

			expect(viewportText).not.toContain("⏳ SSH: […]");
			expect(bufferText).not.toContain("⏳ SSH: […]");
			expect(bufferText).toContain("⇄ SSH: [build-host]");
			expect(bufferText).toContain("REMOTE_PY_BEGIN");
			expect(bufferText).toContain("REMOTE_PY_END");
		} finally {
			ssh.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("transcript regression: a stable live block growing above finalized lower content does not lose rows", async () => {
		if (process.platform === "win32") return;
		const rows = 4;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(40, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new TranscriptContainer();
		const live = new MutableLiveBarrier(["live-0"]);
		const finalFrame1 = ["head-0", "head-1", "", "live-0", "", "tail-0", "tail-1", "tail-2"];
		const finalFrame2 = ["head-0", "head-1", "", "live-0", "live-1", "", "tail-0", "tail-1", "tail-2"];
		const settle = async () => {
			scheduler.flush();
			await term.flush();
		};

		transcript.addChild(new StaticBlock(["head-0", "head-1"]));
		transcript.addChild(live);
		transcript.addChild(new StaticBlock(["tail-0", "tail-1", "tail-2"]));
		tui.addChild(transcript);

		try {
			tui.start();
			await settle();

			for (let i = 0; i < 40; i++) {
				tui.requestRender();
				await settle();
			}

			expect(transcript.getNativeScrollbackSnapshotSafeEnd()).toBe(4);
			expect(transcript.getNativeScrollbackOfferEnd()).toBe(8);
			expectNoLoss(term, finalFrame1);

			live.set(["live-0", "live-1"]);
			tui.requestRender();
			await settle();

			const buffer = expectNoLoss(term, finalFrame2);
			expect(buffer).toContain("live-1");
			expect(buffer).toContain("tail-2");
		} finally {
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("eval: collapsed cell output stays within the viewport budget", () => {
		const rows = 18;
		stubStdoutRows(rows);
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				cells: [
					{ index: 0, code: "run()", language: "js" as const, output: longLines(60), status: "running" as const },
				],
			},
			isError: false,
		};
		const component = evalToolRenderer.renderResult(result, { expanded: false, isPartial: true }, activeTheme);
		const lines = component.render(80);
		// The collapsed cell box fits the viewport budget: code + output tails are
		// each capped at previewWindowRows() VISUAL rows. Pre-fix the long output
		// wrapped into ~2x its line count and blew past this.
		expect(lines.length).toBeLessThanOrEqual(previewWindowRows() + 10);
		expect(lines.map(line => Bun.stripANSI(line)).join("\n")).toContain("ctrl+o");
	});
});
