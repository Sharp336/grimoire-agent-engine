import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { truncateToWidth } from "@oh-my-pi/pi-tui";

class SidebarExample implements Component {
	#lines: readonly string[] = [];
	constructor(private readonly tui: TUI) {}
	setLines(lines: readonly string[]): void {
		this.#lines = lines;
		this.tui.requestComponentRender(this);
	}
	render(width: number): readonly string[] {
		return this.#lines.map(line => truncateToWidth(line, width));
	}
}

export default function rightSidebarExample(pi: ExtensionAPI): void {
	let sidebar: SidebarExample | undefined;
	let visible = true;

	function render(ctx: ExtensionContext): void {
		const usage = ctx.getContextUsage();
		sidebar?.setLines([
			"RIGHT SIDEBAR",
			`model  ${ctx.model?.provider ?? "none"}/${ctx.model?.id ?? "none"}`,
			`context ${usage ? `${usage.percent.toFixed(1)}%` : "unavailable"}`,
			`state   ${ctx.isIdle() ? "ready" : "running"}`,
		]);
	}

	function mount(ctx: ExtensionContext): void {
		ctx.ui.setWidget(
			"right-sidebar-example",
			tui => {
				sidebar = new SidebarExample(tui);
				render(ctx);
				return sidebar;
			},
			{
				placement: "rightSidebar",
				width: 44,
				minWidth: 28,
				minMainWidth: 64,
			},
		);
	}

	pi.registerCommand("right-sidebar", {
		description: "Toggle the reserved right-sidebar example",
		handler: async (_args, ctx) => {
			visible = !visible;
			if (visible) mount(ctx);
			else ctx.ui.setWidget("right-sidebar-example", undefined);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		mount(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => render(ctx));
	pi.on("agent_end", async (_event, ctx) => render(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget("right-sidebar-example", undefined);
		sidebar = undefined;
	});
}
