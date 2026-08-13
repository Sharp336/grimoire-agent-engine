import { beforeAll, describe, expect, it } from "bun:test";
import { createCouncilTranscriptHeaderCard } from "@oh-my-pi/pi-coding-agent/modes/components/council-transcript-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const WIDTHS = [10, 40, 72, 120];

/** Hostile fragment: a tab, a NUL, a BEL and a raw SGR sequence. */
const HOSTILE = "one\ttwo\u0000three\u0007four\u001b[31mfive";

function plain(lines: readonly string[]): string {
	return lines.map(line => Bun.stripANSI(line)).join("\n");
}

beforeAll(async () => {
	await initTheme();
});

describe("council transcript mirror header card", () => {
	it("never emits a line wider than the requested width", () => {
		const component = createCouncilTranscriptHeaderCard({
			label: "security",
			model: "anthropic/claude-sonnet-4-5",
			phase: "review round 2",
			agentId: "01998c-child-2",
		});

		for (const width of WIDTHS) {
			const lines = component.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("strips control characters and escape sequences from every field", () => {
		const text = plain(
			createCouncilTranscriptHeaderCard({
				label: HOSTILE,
				model: HOSTILE,
				phase: HOSTILE,
				agentId: HOSTILE,
			}).render(120),
		);

		expect(text).not.toContain("\t");
		expect(text).not.toContain("\u0000");
		expect(text).not.toContain("\u0007");
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("31m");
		expect(text).toContain("one two");
	});

	it("names the child, its model, its phase, and the durable history pointer", () => {
		const text = plain(
			createCouncilTranscriptHeaderCard({
				label: "Planner",
				model: "openai/gpt-5",
				phase: "planning",
				agentId: "01998c-planner",
			}).render(120),
		);

		expect(text).toContain("[Planner]");
		expect(text).toContain("openai/gpt-5");
		expect(text).toContain("planning");
		expect(text).toContain("history://01998c-planner");
	});

	it("wraps the history pointer onto its own line when the head fills the width", () => {
		const lines = createCouncilTranscriptHeaderCard({
			label: "Planner",
			model: "anthropic/claude-opus-4-5-with-a-long-routing-suffix",
			phase: "planning",
			agentId: "019fe0cb-c90d-7000-8e37-77lbf268814",
		}).render(60);

		expect(lines.length).toBe(2);
		expect(plain([lines[1]])).toContain("history://019fe0cb-c90d-7000-8e37-77lbf268814");
	});
});
