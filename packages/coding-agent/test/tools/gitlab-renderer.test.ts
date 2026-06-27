import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { gitlabToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/gitlab-renderer";

describe("gitlabToolRenderer", () => {
	it("sanitizes tabs in status header metadata", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const rendered = gitlabToolRenderer
			.renderCall(
				{
					op: "mr_create",
					repo: "group\tproject",
					branch: "feature\tbranch",
					mr: "56\t78",
					status: "run\tning",
					title: "title\ttext",
				},
				{ expanded: false, isPartial: true },
				theme!,
			)
			.render(240)
			.join("\n");

		const plain = Bun.stripANSI(rendered);
		expect(plain).not.toContain("\t");
		expect(plain).toContain("group");
		expect(plain).toContain("project");
		expect(plain).toContain("title");
		expect(plain).toContain("text");
	});
});
