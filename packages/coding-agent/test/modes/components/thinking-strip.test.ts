import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { ThinkingStripComponent } from "@oh-my-pi/pi-coding-agent/modes/components/thinking-strip";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

describe("ThinkingStripComponent", () => {
	it("renders the horizontal hub-style strip with the selected level", () => {
		const strip = new ThinkingStripComponent(
			"anthropic/claude-opus-5",
			[ThinkingLevel.Off, "auto", Effort.Medium, Effort.High],
			Effort.Medium,
			() => {},
			() => {},
		);
		const rendered = strip.render(120).join("\n");
		expect(rendered).toContain("anthropic/claude-opus-5");
		expect(rendered).toContain("medium");
		expect(rendered).toContain("←/→ thinking level");
	});
	it("keeps the selected effort visible beside a long model label", () => {
		const strip = new ThinkingStripComponent(
			"provider/very-long-custom-model-identifier",
			[Effort.Low, Effort.Medium, Effort.High],
			Effort.High,
			() => {},
			() => {},
		);

		expect(strip.render(32)[1]).toContain("high");
	});

	it("moves right and applies the highlighted level", () => {
		let selected: string | undefined;
		const strip = new ThinkingStripComponent(
			"model",
			[Effort.Low, Effort.Medium, Effort.High],
			Effort.Medium,
			level => {
				selected = level;
			},
			() => {},
		);
		strip.handleInput("\x1b[C");
		strip.handleInput("\r");
		expect(selected).toBe(Effort.High);
	});

	it("cancels without applying a level", () => {
		let selected: string | undefined;
		let cancelled = false;
		const strip = new ThinkingStripComponent(
			"model",
			[Effort.Low, Effort.Medium],
			Effort.Low,
			level => {
				selected = level;
			},
			() => {
				cancelled = true;
			},
		);
		strip.handleInput("\x1b");
		expect(cancelled).toBe(true);
		expect(selected).toBeUndefined();
	});
});
