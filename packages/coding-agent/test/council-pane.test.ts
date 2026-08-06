import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import {
	CouncilPaneComponent,
	type CouncilPaneRowSnapshot,
	type CouncilPaneSnapshot,
	SUBAGENT_HUD_VISIBLE_LIMIT,
} from "@oh-my-pi/pi-coding-agent/modes/components/council-pane";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

function row(overrides: Partial<CouncilPaneRowSnapshot> = {}): CouncilPaneRowSnapshot {
	return {
		key: "planner",
		label: "Planner",
		model: "anthropic/claude-sonnet-4-5",
		effort: "high",
		status: "running",
		attempts: 1,
		...overrides,
	};
}

function snapshot(overrides: Partial<CouncilPaneSnapshot> = {}): CouncilPaneSnapshot {
	return {
		runId: "run-1",
		state: "reviewing",
		round: 1,
		totalRounds: 2,
		startedAt: "2026-08-05T12:00:00.000Z",
		outputPath: "/home/test/project/plans/council-run-1.md",
		degraded: false,
		usage: { requests: 4, tokens: 12_345, cost: 0.0123 },
		rows: [
			row(),
			row({ key: "main", label: "Main", status: "queued", attempts: 0 }),
			row({ key: "member:0", label: "security", status: "succeeded" }),
			row({ key: "member:1", label: "testing", status: "failed", error: "provider failed" }),
			row({ key: "member:2", label: "ux", status: "retry", attempts: 2 }),
		],
		terminal: false,
		...overrides,
	};
}

function harness(terminalRows = 24, editorMaxHeight = 12) {
	let rows = terminalRows;
	const requestRender = vi.fn();
	const requestComponentRender = vi.fn();
	const pane = new CouncilPaneComponent({
		tui: { requestRender, requestComponentRender },
		getTerminalRows: () => rows,
		getEditorMaxHeight: () => editorMaxHeight,
		now: () => Date.parse("2026-08-05T12:00:12.000Z"),
	});
	return {
		pane,
		requestRender,
		requestComponentRender,
		setTerminalRows(next: number) {
			rows = next;
		},
	};
}

function plain(lines: readonly string[]): string {
	return Bun.stripANSI(lines.join("\n"));
}

describe("CouncilPaneComponent", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("has no inactive rows or live-region footprint", () => {
		const { pane } = harness();
		expect(pane.render(100)).toEqual([]);
		expect(pane.getNativeScrollbackLiveRegionStart()).toBeUndefined();
		expect(pane.isNativeScrollbackLiveRegionPinned()).toBeFalse();
		expect(pane.isNativeScrollableLiveRegionPinned()).toBeFalse();
	});

	it("bounds compact and expanded bodies at 24 and 12 terminal rows", () => {
		const roomy = harness(24, 12);
		roomy.pane.update(snapshot());
		const compact = roomy.pane.render(100);
		expect(compact.length).toBeLessThanOrEqual(Math.min(SUBAGENT_HUD_VISIBLE_LIMIT + 1, 24 - 12 - 4));
		expect(plain(compact)).toContain("Council");
		expect(plain(compact)).toContain("round 1/2");
		expect(plain(compact)).toContain("council-r");
		expect(plain(compact)).toContain("4 req/12K tok/$0.012");

		roomy.pane.setExpanded(true);
		const expanded = roomy.pane.render(100);
		expect(expanded.length).toBeLessThanOrEqual(9);
		expect(roomy.pane.handleInput("\x1b[6~")).toBeTrue();
		expect(roomy.requestComponentRender).toHaveBeenCalledWith(roomy.pane);

		const short = harness(12, 6);
		short.pane.update(snapshot());
		expect(short.pane.render(100).length).toBeLessThanOrEqual(Math.min(SUBAGENT_HUD_VISIBLE_LIMIT + 1, 12 - 6 - 4));
		short.pane.setExpanded(true);
		expect(short.pane.render(100).length).toBeLessThanOrEqual(Math.min(SUBAGENT_HUD_VISIBLE_LIMIT + 1, 12 - 6 - 4));
	});

	it("keeps every status readable without relying on color", () => {
		const statuses = ["queued", "running", "retry", "succeeded", "failed", "interrupted"] as const;

		const { pane } = harness(40, 12);
		pane.update(
			snapshot({
				rows: statuses.map((status, index) =>
					row({ key: String(index), label: `slot-${index}`, status, attempts: index }),
				),
			}),
		);
		const output = plain(pane.render(140));
		for (const status of statuses) expect(output).toContain(status);
	});
	it("shows a compact degraded/warning marker alongside aggregate usage", () => {
		const { pane } = harness(24, 12);
		pane.update(snapshot({ degraded: true, warnings: ["fallback", "partial result"] }));
		const output = plain(pane.render(140));
		expect(output).toContain("degraded+2w");
		expect(output).toContain("4 req/12K tok/$0.012");
	});

	it("identifies reviewer confinement as a sanitized width-bounded prompt contract", () => {
		const { pane } = harness(24, 12);
		pane.update(snapshot({ state: "reviewing\t\u001b[31munsafe\u001b[0m" }));
		const narrowLines = pane.render(72);
		const narrowOutput = plain(narrowLines);
		expect(narrowOutput).toContain("read-only/root: prompt");
		expect(narrowOutput).not.toContain("\t");
		expect(narrowOutput).not.toContain("[31m");
		for (const line of narrowLines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(72);
		expect(plain(pane.render(140))).toContain("read-only/root: prompt contract");
	});

	it("sanitizes and width-bounds long, CJK, ANSI, tab, control, tool-arg, output, and error text", () => {
		const malicious = `\u001b[31m模型\t${"界".repeat(200)}\u001b[0m\u0000`;
		const hugeArgs = `${"arg\t".repeat(2_500)}ARGUMENT_TAIL_MUST_NOT_LEAK`;
		const homePath = `${os.homedir()}/private/council-secret.log`;
		const { pane } = harness(40, 12);
		pane.update(
			snapshot({
				state: "reviewing\t\u001b[32munsafe\u001b[0m",
				outputPath: `/tmp/${"p".repeat(400)}/plan.md`,
				rows: [
					row({
						label: malicious,
						model: "provider/MODEL_BADGE",
						effort: "max",
						currentTool: `bash\t\u001b[34mtool\u001b[0m`,
						currentToolArgs: `{"path":"${homePath}"} ${hugeArgs}`,
						lastIntent: `${malicious}\nsecond physical line`,
						recentOutput: [`\u001b[35moutput\t${"終".repeat(400)}\u001b[0m\u0007`],
						error: `at ${homePath}\t\u001b[31merror\u001b[0m\n${"x".repeat(400)}`,
					}),
				],
			}),
		);
		pane.setExpanded(true);
		const lines = pane.render(72);
		const output = plain(lines);
		expect(output).not.toContain("\t");
		expect(output).not.toContain("\u0000");
		expect(output).toContain("MODEL_BADGE");
		expect(output).toContain("max");
		expect(output).toContain("running");
		expect(output).not.toContain("\u0007");
		expect(output).not.toContain("[31m");
		expect(output).not.toContain("ARGUMENT_TAIL_MUST_NOT_LEAK");
		expect(output).toContain("模型");
		expect(output).toContain("error:");
		expect(output).toContain("~/private/council-secret.log");
		expect(output).not.toContain(os.homedir());
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(72);
	});

	it("uses component repaints for ticks and same-topology snapshots", () => {
		const h = harness();
		const initial = snapshot();
		h.pane.update(initial);
		expect(h.requestRender).toHaveBeenCalledTimes(1);
		h.requestRender.mockClear();
		h.requestComponentRender.mockClear();

		h.pane.tick(Date.parse("2026-08-05T12:00:13.000Z"));
		expect(h.requestComponentRender).toHaveBeenCalledTimes(1);
		expect(h.requestRender).not.toHaveBeenCalled();
		h.requestComponentRender.mockClear();

		h.pane.update({
			...initial,
			usage: { requests: 5, tokens: 13_000, cost: 0.013 },
			rows: initial.rows.map(item => ({ ...item, attempts: item.attempts + 1 })),
		});
		expect(h.requestComponentRender).toHaveBeenCalledTimes(1);
		expect(h.requestRender).not.toHaveBeenCalled();

		h.pane.update({ ...initial, rows: [...initial.rows, row({ key: "new", label: "new" })] });
		expect(h.requestRender).toHaveBeenCalledTimes(1);
	});

	it("pins only a nonterminal snapshot and clears on terminal transition", () => {
		const h = harness();
		const active = snapshot();
		h.pane.update(active);
		expect(h.pane.getNativeScrollbackLiveRegionStart()).toBe(0);
		expect(h.pane.isNativeScrollbackLiveRegionPinned()).toBeTrue();
		expect(h.pane.render(100).length).toBeGreaterThan(0);

		h.pane.update({ ...active, state: "completed", terminal: true });
		expect(h.pane.render(100)).toEqual([]);
		expect(h.pane.getNativeScrollbackLiveRegionStart()).toBeUndefined();
		expect(h.pane.isNativeScrollbackLiveRegionPinned()).toBeFalse();
	});

	it("recomputes a single bounded frame on resize without retaining old rows", () => {
		const h = harness(24, 12);
		h.pane.update(
			snapshot({
				rows: [row({ recentOutput: Array.from({ length: 8 }, (_, index) => `old-detail-${index}`) })],
			}),
		);
		h.pane.setExpanded(true);
		const before = plain(h.pane.render(100));
		expect(before).toContain("old-detail");

		h.setTerminalRows(12);
		const afterLines = h.pane.render(100);
		const after = plain(afterLines);
		expect(afterLines.length).toBeLessThanOrEqual(1);
		expect(after.match(/Council/g)).toHaveLength(1);
		expect(after).not.toContain("old-detail");
	});
});
