import { describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import type { EvalCellResult, EvalToolDetails } from "../../eval/types";
import { getThemeByName } from "../../modes/theme/theme";
import { evalToolRenderer } from "../eval-render";

type RemoteTarget = { kind: "ssh"; host: string };
type RenderCallArgs = Parameters<typeof evalToolRenderer.renderCall>[0];
type RemoteRenderCallArgs = RenderCallArgs & { host: string; cwd: string; target: RemoteTarget };
type RemoteEvalCellResult = EvalCellResult & { host: string; cwd: string; target: RemoteTarget };
type RemoteEvalToolDetails = EvalToolDetails & {
	host: string;
	cwd: string;
	target: RemoteTarget;
	cells: RemoteEvalCellResult[];
};

function stripRendered(component: Component, width = 100): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

async function theme() {
	const uiTheme = await getThemeByName("dark");
	if (!uiTheme) throw new Error("theme unavailable");
	return uiTheme;
}

describe("eval renderer remote target", () => {
	it("preserves the SSH host and remote cwd in pending render output", async () => {
		const args: RemoteRenderCallArgs = {
			language: "py",
			code: "print('hello')",
			host: "icaro",
			cwd: "/srv/remote-app",
			target: { kind: "ssh", host: "icaro" },
		};

		const component = evalToolRenderer.renderCall(args, { expanded: false, isPartial: false }, await theme());
		const text = stripRendered(component);

		expect(text).toContain("ssh:icaro");
		expect(text).toContain("/srv/remote-app");
	});

	it("preserves the SSH host and remote cwd in result render output", async () => {
		const details: RemoteEvalToolDetails = {
			language: "python",
			languages: ["python"],
			host: "icaro",
			cwd: "/srv/remote-app",
			target: { kind: "ssh", host: "icaro" },
			cells: [
				{
					index: 0,
					language: "python",
					code: "print('hello')",
					output: "hello",
					status: "complete",
					durationMs: 12,
					exitCode: 0,
					host: "icaro",
					cwd: "/srv/remote-app",
					target: { kind: "ssh", host: "icaro" },
				},
			],
		};

		const component = evalToolRenderer.renderResult(
			{ content: [{ type: "text", text: "hello" }], details },
			{ expanded: false, isPartial: false },
			await theme(),
		);
		const text = stripRendered(component);

		expect(text).toContain("ssh:icaro");
		expect(text).toContain("/srv/remote-app");
		expect(text).toContain("hello");
	});
});
