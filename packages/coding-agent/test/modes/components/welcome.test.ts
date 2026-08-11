import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	pickWeightedTip,
	renderWelcomeTip,
	WelcomeComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { appendContributionReminder, CONTRIBUTION_REMINDER } from "@oh-my-pi/pi-coding-agent/utils/contribution";
import { visibleWidth } from "@oh-my-pi/pi-tui";

describe("WelcomeComponent tips", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("selects standard tip when preset is not unicode", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("nerd");

		const welcome = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcome.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcome.tip).toBeDefined();
	});

	it("selects nerdfont tip with 10% probability under unicode preset", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("unicode");

		// 9% chance => selects special tip
		vi.spyOn(Math, "random").mockReturnValue(0.09);
		const welcomeSpecial = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcomeSpecial.tip).toBe("Please use nerdfont 😭.");

		// 10% chance => selects regular tip
		vi.spyOn(Math, "random").mockReturnValue(0.1);
		const welcomeRegular = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcomeRegular.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcomeRegular.tip).toBeDefined();
	});

	it("keeps the complete contribution reminder directly after the rotating tip at boundary widths", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("nerd");
		const random = vi.spyOn(Math, "random");

		for (const termWidth of [16, 22, 23, 80]) {
			for (const sample of [0, 0.25, 0.5, 0.75, 0.999_999]) {
				random.mockReturnValue(sample);
				const welcome = new WelcomeComponent("1.0.0", "model", "provider");
				const lines = welcome.render(termWidth);
				const plain = lines.map(line => Bun.stripANSI(line));
				const tipStart = plain.findIndex(line => /^\s*Tip: /.test(line));
				const contributionStart = plain.findIndex(line => line.includes("Contribute:"));

				expect(tipStart).toBeGreaterThanOrEqual(0);
				expect(contributionStart).toBeGreaterThan(tipStart);

				const expectedTip = renderWelcomeTip(welcome.tip ?? "", termWidth - 2).map(line => Bun.stripANSI(line));
				expect(plain.slice(tipStart, contributionStart)).toEqual(expectedTip);
				expect(
					plain
						.slice(contributionStart)
						.map(line => line.trim())
						.join(" "),
				).toBe(`Contribute: ${CONTRIBUTION_REMINDER}`);
				if (termWidth === 80) {
					expect(plain[contributionStart]).toMatch(/^\s*Contribute: Something broken\?/);
				}
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(termWidth);
				}
			}
		}
	});

	it("weights [NEW] tips above ordinary tips in selection", () => {
		// Data-independent: tips.txt may legitimately carry zero "[NEW]" tips, so
		// exercise the weighting contract on a synthetic list.
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;

		const counts = new Map<string, number>();
		const samples = 10_000;
		for (let i = 0; i < samples; i++) {
			const tip = pickWeightedTip(tips, (i + 0.5) / samples); // sweep the selection domain uniformly
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}

		let newMax = 0;
		let ordinaryMax = 0;
		for (const [tip, count] of counts) {
			if (/\[NEW\]\s*$/.test(tip)) newMax = Math.max(newMax, count);
			else ordinaryMax = Math.max(ordinaryMax, count);
		}

		// A "[NEW]" tip carries a >1 weight, so it covers strictly more of the
		// uniform selection domain than any single ordinary tip.
		expect(newMax).toBeGreaterThan(0);
		expect(newMax).toBeGreaterThan(ordinaryMax);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});
});

describe("contribution reminder", () => {
	it("trims leading and trailing whitespace before appending a blank line and the reminder", () => {
		expect(appendContributionReminder("  Startup changes.  \n\t")).toBe(
			`Startup changes.\n\n${CONTRIBUTION_REMINDER}`,
		);
	});
});
