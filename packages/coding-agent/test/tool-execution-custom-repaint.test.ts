import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { toolRenderers } from "@oh-my-pi/pi-coding-agent/tools/renderers";
import { type Component, Text, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// Viewport-repaint seams of ToolExecutionComponent, driven through the public
// ToolRenderer flags (`forceFirstResultViewportRepaint`,
// `forceResultViewportRepaintOnSettle`). The removed ssh tool was the last
// built-in exercising them; custom/extension tool renderers remain consumers
// of the contract, so a synthetic tool stands in.

function toolResult(text: string) {
	return { content: [{ type: "text", text }] };
}

// The repaint flag stays armed for any streamed-args shape (raw JSON buffer
// present), while the visible label upgrades to parsed chrome as soon as a
// concrete field lands — mirroring how the removed ssh renderer behaved.
function hasStreamedArgs(args: unknown): boolean {
	return !!args && typeof args === "object" && "__partialJson" in args;
}

function isPlaceholderArgs(args: unknown): boolean {
	return hasStreamedArgs(args) && !(args && typeof args === "object" && "host" in args);
}

/** Synthetic renderer-bearing tool; cast is the test seam for the renderer contract. */
function makeFakeTool(): AgentTool {
	const tool = {
		name: "fake_device",
		label: "Fake",
		renderCall: (args: unknown) => new Text(isPlaceholderArgs(args) ? "FAKE: […]" : "FAKE: [router]", 0, 0),
		renderResult: (result: { content: Array<{ type: string; text?: string }> }, options: { isPartial: boolean }) => {
			const text = result.content[0]?.text ?? "";
			return new Text(options.isPartial ? `provisional ${text}` : `Output ${text}`, 0, 0);
		},
		forceFirstResultViewportRepaint: (args: unknown) => hasStreamedArgs(args),
		forceResultViewportRepaintOnSettle: true,
	};
	return tool as unknown as AgentTool;
}

/**
 * Fake tool with an overridden settlement flag. Aliases the fake tool through a
 * view whose only member is the optional ad-hoc flag the component reads by
 * shape, so no cast is needed and the mutation lands on the shared object.
 */
function makeFakeToolWithSettleFlag(flag: boolean | undefined): AgentTool {
	const tool = makeFakeTool();
	Object.assign(tool, { forceResultViewportRepaintOnSettle: flag });
	return tool;
}

/**
 * A result whose text is `rowCount` distinctly-prefixed lines. The fake tool's
 * renderResult renders it as one row per line (`provisional <prefix>-0` … and
 * `Output <prefix>-0` …), so a partial can overflow the viewport while its
 * final settles to a shorter, distinctly-marked block.
 */
function multilineResult(prefix: string, rowCount: number) {
	return {
		content: [{ type: "text", text: Array.from({ length: rowCount }, (_unused, i) => `${prefix}-${i}`).join("\n") }],
	};
}

class Footer implements Component {
	constructor(readonly rows: number) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.rows }, (_, i) => `editor-${i}`);
	}
}

function plainBuffer(term: VirtualTerminal): string[] {
	return term
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(Boolean);
}

async function drain(scheduler: StressRenderScheduler, term: VirtualTerminal): Promise<void> {
	await scheduler.drain(term);
}

function plainViewport(term: VirtualTerminal): string[] {
	return term
		.getViewport()
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(Boolean);
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

function ed3Count(writes: string[]): number {
	return (writes.join("").match(/\x1b\[3J/g) ?? []).length;
}

// Every multiplexer marker `isInsideTerminalMultiplexer` honours, plus TERM
// (which it inspects as a fallback). Snapshot/clear/restore all seven so a
// direct-terminal case is host-independent even under an inherited mux/TERM,
// and a mux case sets only its own marker.
const MULTIPLEXER_ENV_KEYS = [
	"TERM",
	"TMUX",
	"STY",
	"ZELLIJ",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_REMOTE_TRANSPORT",
];

async function withSettlementEnv(
	overrides: Record<string, string | undefined>,
	run: () => Promise<void>,
): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const key of MULTIPLEXER_ENV_KEYS) {
		saved[key] = Bun.env[key];
		delete Bun.env[key];
	}
	for (const key in overrides) {
		const value = overrides[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	try {
		await run();
	} finally {
		for (const key of MULTIPLEXER_ENV_KEYS) {
			const value = saved[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}
}

describe("ToolExecutionComponent custom-renderer repaint seams", () => {
	const components: ToolExecutionComponent[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		for (const component of components) component.stopAnimation();
		components.length = 0;
		vi.restoreAllMocks();
	});

	function makeComponent(args: unknown, tool: AgentTool | undefined = makeFakeTool()) {
		const resetDisplay = vi.fn();
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay } as unknown as TUI;
		const component = new ToolExecutionComponent("fake_device", args, {}, tool, ui);
		components.push(component);
		resetDisplay.mockClear();
		return { component, resetDisplay };
	}

	it("forces a viewport repaint when a painted streamed placeholder receives its first result", () => {
		const { component, resetDisplay } = makeComponent({ __partialJson: '{"host"' });
		// A paint has to land for the placeholder to actually reach the terminal.
		component.render(80);

		component.updateResult(toolResult("partial output"), true);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the streamed placeholder never reaches the terminal", () => {
		const { component, resetDisplay } = makeComponent({ __partialJson: '{"host"' });
		// The placeholder shape was built in memory but never painted — a
		// resetDisplay here would wipe scrollback for a shape the user never saw.

		component.updateResult(toolResult("partial output"), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not repaint complete args on the first result", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.render(80);

		component.updateResult(toolResult("partial output"), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("forces a viewport repaint when a painted provisional partial result settles to a different height", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(multilineResult("prov", 20), true);
		component.render(80);
		resetDisplay.mockClear();

		component.updateResult(multilineResult("fin", 4), false);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not resetDisplay when a painted partial settles at the same rendered height", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(toolResult("partial output"), true);
		component.render(80);
		resetDisplay.mockClear();

		// Same single-line result chrome height as the provisional frame — settle
		// must keep the ordinary in-place repaint path (no ED3 scrollback wipe).
		component.updateResult(toolResult("final output"), false);

		expect(resetDisplay).not.toHaveBeenCalled();
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Output final output");
	});

	it("does not repaint when the provisional partial result never reaches the terminal", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(toolResult("partial output"), true);
		// No render() between the partial and the final update — the provisional
		// frame never reached the terminal, so no reset should fire.

		component.updateResult(toolResult("final output"), false);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("removes streamed placeholder rows from the terminal buffer when the first result arrives", async () => {
		const term = new VirtualTerminal(90, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = new ToolExecutionComponent(
			"fake_device",
			{ __partialJson: '{"host"' },
			{},
			makeFakeTool(),
			tui,
		);
		components.push(component);
		tui.addChild(component);
		tui.addChild(new Footer(5));

		try {
			tui.start();
			await drain(scheduler, term);
			expect(plainBuffer(term).some(row => row.includes("FAKE: […]"))).toBe(true);

			component.updateArgs({
				host: "router",
				command: "uptime",
				__partialJson: '{"host":"router","command":"uptime"}',
			});
			component.setArgsComplete();
			tui.requestRender();
			await drain(scheduler, term);

			component.updateResult(toolResult("partial output"), true);
			tui.requestRender();
			await drain(scheduler, term);

			const rows = plainBuffer(term);
			expect(rows.some(row => row.includes("FAKE: […]"))).toBe(false);
			expect(rows.some(row => row.includes("FAKE: [router]"))).toBe(true);
			expect(rows.some(row => row.includes("provisional partial output"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("removes provisional partial chrome from the terminal buffer when the result settles", async () => {
		const term = new VirtualTerminal(90, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = new ToolExecutionComponent(
			"fake_device",
			{ host: "router", command: "uptime" },
			{},
			makeFakeTool(),
			tui,
		);
		components.push(component);
		tui.addChild(component);
		tui.addChild(new Footer(5));

		try {
			tui.start();
			await drain(scheduler, term);
			component.updateResult(toolResult("partial output"), true);
			tui.requestRender();
			await drain(scheduler, term);
			const partialRows = plainBuffer(term);
			expect(partialRows.some(row => row.includes("FAKE: [router]"))).toBe(true);
			expect(partialRows.some(row => row.includes("provisional partial output"))).toBe(true);

			component.updateResult(toolResult("final output"), false);
			tui.requestRender();
			await drain(scheduler, term);

			const rows = plainBuffer(term);
			expect(rows.some(row => row.includes("provisional partial output"))).toBe(false);
			expect(rows.filter(row => row.includes("FAKE: [router]"))).toHaveLength(1);
			expect(rows.some(row => row.includes("Output final output"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("settles exactly once when a painted partial coalesces with a newer partial before the final", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(multilineResult("prov", 20), true);
		// Partial 1 reaches the terminal → live-painted.
		component.render(80);
		resetDisplay.mockClear();
		// A newer partial coalesces in without its own render; the paint evidence
		// from partial 1 must survive so the final still settles once.
		component.updateResult(multilineResult("prov", 20), true);
		component.updateResult(multilineResult("fin", 4), false);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not settle when no partial ever reaches the terminal before the final", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(toolResult("partial 1"), true);
		component.updateResult(toolResult("partial 2"), true);
		// No render between any partial and the final: no paint evidence armed.
		component.updateResult(toolResult("final output"), false);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("keeps the settlement reset count at one across a duplicate success final", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(multilineResult("prov", 20), true);
		component.render(80);
		resetDisplay.mockClear();

		component.updateResult(multilineResult("fin", 4), false);
		component.updateResult(multilineResult("fin", 4), false);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("keeps the settlement reset count at one across a duplicate error final", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(multilineResult("prov", 20), true);
		component.render(80);
		resetDisplay.mockClear();

		const errorFinal = { content: [{ type: "text", text: "boom" }], isError: true };
		component.updateResult(errorFinal, false);
		component.updateResult(errorFinal, false);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not settle a painted partial for a stable (unflagged) renderer", () => {
		const stable = makeFakeToolWithSettleFlag(undefined);
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" }, stable);
		component.updateResult(toolResult("partial output"), true);
		component.render(80);
		resetDisplay.mockClear();

		component.updateResult(toolResult("final output"), false);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not settle a painted partial when the tool sets forceResultViewportRepaintOnSettle false", () => {
		const disabled = makeFakeToolWithSettleFlag(false);
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" }, disabled);
		component.updateResult(toolResult("partial output"), true);
		component.render(80);
		resetDisplay.mockClear();

		component.updateResult(toolResult("final output"), false);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not settle a painted partial after seal and keeps the late final renderable", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(toolResult("partial output"), true);
		component.render(80);
		resetDisplay.mockClear();

		// seal() enters the absorbing history state; a render after seal cannot
		// revive paint evidence into a late destructive reset.
		component.seal();
		component.render(80);
		component.updateResult(toolResult("final output"), false);

		expect(resetDisplay).not.toHaveBeenCalled();
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Output final output");
	});

	it("opts exactly the topology-changing built-in renderers into settlement repaint", () => {
		const flagged = Object.keys(toolRenderers)
			.filter(name => toolRenderers[name]?.forceResultViewportRepaintOnSettle === true)
			.sort();
		expect(flagged).toEqual([
			"apply_patch",
			"bash",
			"edit",
			"eval",
			"github",
			"glob",
			"hub",
			"task",
			"vibe_wait",
			"write",
		]);
		// edit and apply_patch share one renderer object.
		expect(toolRenderers.edit).toBe(toolRenderers.apply_patch);
		// Non-wait vibe ops and search/read-like tools stay opted out.
		for (const name of [
			"vibe_spawn",
			"vibe_send",
			"vibe_list",
			"vibe_kill",
			"read",
			"grep",
			"todo",
			"browser",
			"debug",
		]) {
			expect(toolRenderers[name]?.forceResultViewportRepaintOnSettle ?? false).toBe(false);
		}
	});

	it("emits exactly one ED3 and leaves one final block on a direct terminal when a long partial settles", async () => {
		await withSettlementEnv({ TERM: "xterm-256color" }, async () => {
			const term = new VirtualTerminal(48, 10, 2_000);
			const scheduler = new StressRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const resetSpy = vi.spyOn(tui, "resetDisplay");
			const writes = captureWrites(term);
			const component = new ToolExecutionComponent(
				"fake_device",
				{ host: "router", command: "uptime" },
				{},
				makeFakeTool(),
				tui,
			);
			components.push(component);
			tui.addChild(component);
			tui.addChild(new Footer(2));

			try {
				tui.start();
				await drain(scheduler, term);

				// A long partial overflows the 10-row viewport → rows commit to
				// native scrollback.
				component.updateResult(multilineResult("prov", 20), true);
				tui.requestRender();
				await drain(scheduler, term);
				expect(plainBuffer(term).some(row => row.includes("prov-0"))).toBe(true);
				resetSpy.mockClear();

				// The coalesced newer partial and the shorter final drain together.
				component.updateResult(multilineResult("prov", 20), true);
				component.updateResult(multilineResult("fin", 4), false);
				tui.requestRender();
				await drain(scheduler, term);

				expect(resetSpy).toHaveBeenCalledTimes(1);
				expect(ed3Count(writes)).toBe(1);
				const tape = plainBuffer(term);
				expect(tape.some(row => row.includes("prov-"))).toBe(false);
				expect(tape.filter(row => row.includes("fin-0"))).toHaveLength(1);
				expect(tape.some(row => row.includes("fin-3"))).toBe(true);
			} finally {
				tui.stop();
				await term.flush();
			}
		});
	});

	for (const [label, muxEnv] of [
		["tmux", { TMUX: "1" }],
		["screen", { STY: "1234.pts-0" }],
		["zellij", { ZELLIJ: "0" }],
	] as const) {
		it(`settles once without ED3 and shows one final block under ${label}`, async () => {
			await withSettlementEnv(muxEnv, async () => {
				const term = new VirtualTerminal(48, 10, 2_000);
				const scheduler = new StressRenderScheduler();
				const tui = new TUI(term, undefined, { renderScheduler: scheduler });
				const resetSpy = vi.spyOn(tui, "resetDisplay");
				const writes = captureWrites(term);
				const component = new ToolExecutionComponent(
					"fake_device",
					{ host: "router", command: "uptime" },
					{},
					makeFakeTool(),
					tui,
				);
				components.push(component);
				tui.addChild(component);
				tui.addChild(new Footer(2));

				try {
					tui.start();
					await drain(scheduler, term);

					component.updateResult(multilineResult("prov", 20), true);
					tui.requestRender();
					await drain(scheduler, term);
					resetSpy.mockClear();

					component.updateResult(multilineResult("prov", 20), true);
					component.updateResult(multilineResult("fin", 4), false);
					tui.requestRender();
					await drain(scheduler, term);

					// The component still requests exactly one reset, but the mux
					// path never emits ED3 (native pane history is not destroyed).
					expect(resetSpy).toHaveBeenCalledTimes(1);
					expect(ed3Count(writes)).toBe(0);
					const view = plainViewport(term);
					expect(view.some(row => row.includes("prov-"))).toBe(false);
					expect(view.some(row => row.includes("fin-0"))).toBe(true);
				} finally {
					tui.stop();
					await term.flush();
				}
			});
		});
	}
});
