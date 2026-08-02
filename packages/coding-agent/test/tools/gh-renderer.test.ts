import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "../../src/modes/theme/theme";
import { githubToolRenderer } from "../../src/tools/gh-renderer";

describe("githubToolRenderer", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	it("renders an aborted run-watch neutrally instead of as an error", () => {
		const component = githubToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					aborted: true,
					watch: {
						mode: "run",
						state: "watching",
						repo: "owner/repo",
						run: { id: 1, workflowName: "test", status: "queued", jobs: [] },
						runs: [],
					},
				},
				isError: true,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			{ op: "run_watch" },
		);
		const rendered = component.render(100).join("\n");
		const errorAnsi = uiTheme.fg("error", "").replace("\x1b[39m", "");

		expect(rendered).not.toContain(errorAnsi);
		expect(rendered).toContain("GitHub Run Watch");
	});
});
