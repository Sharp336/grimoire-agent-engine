import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	formatRomanVersion,
	renderUpdateCrawl,
	runUpdateCrawl,
} from "@oh-my-pi/pi-coding-agent/modes/components/update-crawl";
import { getCurrentThemeName, initTheme, setTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, TERMINAL, visibleWidth } from "@oh-my-pi/pi-tui";

const stripAnsi = (text: string): string => Bun.stripANSI(text);
const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();
const TITLE_TOP = " ###  #   #    #   # #   #    ####  #####";
const sceneColor = (rgb: string): string => Bun.color(rgb, TERMINAL.trueColor ? "ansi-16m" : "ansi-256") ?? "";
const foregroundBefore = (line: string, needle: string): string | undefined => {
	const prefix = line.slice(0, line.indexOf(needle));
	return prefix.match(/\x1b\[[0-9;]*m/g)?.at(-1);
};

beforeAll(async () => {
	await initTheme(false);
});

describe("update crawl", () => {
	it("renders complete release notes beneath an ASCII title over twinkling stars", () => {
		const markdown = "## [2.4.0]\n\n### Added\n\n- A new feature with **bold** details.";
		const opening = renderUpdateCrawl(80, 24, 0, markdown, "2.4.0");
		const introText = renderUpdateCrawl(80, 24, 3_000, markdown, "2.4.0").map(stripAnsi).join("\n");
		const releaseText = renderUpdateCrawl(80, 24, 6_000, markdown, "2.4.0").map(stripAnsi).join("\n");
		const openingFrame = opening.join("\n");
		const openingText = opening.map(stripAnsi).join("\n");
		const finishedText = renderUpdateCrawl(80, 24, 100_000, markdown, "2.4.0").map(stripAnsi).join("\n");

		expect(opening).toHaveLength(24);
		expect(opening.map(line => Bun.stringWidth(line))).toEqual(Array(24).fill(80));
		expect(opening.every(line => line.startsWith("\x1b[40m") && line.endsWith("\x1b[49m"))).toBe(true);
		expect(openingFrame).toContain(`${sceneColor("rgb(208, 220, 235)")}✦`);
		expect(openingFrame).toContain(`${sceneColor("rgb(104, 108, 116)")}enter to skip`);
		expect(introText).toContain(TITLE_TOP);
		expect(introText).toContain("EPISODE II.IV.N");
		expect(introText).not.toContain("RELEASE 2.4.0");
		expect(openingText).toMatch(/[✦*·]/);
		expect(releaseText).toContain("ADDED");
		expect(normalizeWhitespace(releaseText)).toContain("• A new feature with bold details.");
		expect(releaseText).toContain("enter to skip");
		expect(finishedText).toContain("enter to continue");
	});

	it("keeps the cinematic palette identical across light and dark themes", async () => {
		const previousTheme = getCurrentThemeName() ?? "dark";
		try {
			await setTheme("light");
			const lightFrame = renderUpdateCrawl(80, 24, 3_000, "### Added\n\n- Theme proof.", "2.4.0");
			await setTheme("dark");
			const darkFrame = renderUpdateCrawl(80, 24, 3_000, "### Added\n\n- Theme proof.", "2.4.0");
			expect(lightFrame).toEqual(darkFrame);
		} finally {
			await setTheme(previousTheme);
		}
	});

	it("formats every numeric version component as a Roman numeral", () => {
		expect(formatRomanVersion("17.0.5")).toBe("XVII.N.V");
		expect(formatRomanVersion("2026.12.104-beta.3")).toBe("MMXXVI.XII.CIV-beta.III");
	});

	it("wraps complete lines without ellipses, preserves word spacing, and fades at the horizon", () => {
		const markdown =
			"### Added\n\n- BEGINNING a deliberately long release note whose complete wording must remain readable across conservatively wrapped crawl rows without losing its ENDING.";
		const frames = Array.from({ length: 81 }, (_, index) =>
			renderUpdateCrawl(80, 24, index * 250, markdown, "2.4.0"),
		);
		const allText = frames.flat().map(stripAnsi).join("\n");
		const readableFrame = renderUpdateCrawl(80, 24, 6_000, "### Added\n\n- A new feature.", "2.4.0");
		const readableText = readableFrame.map(stripAnsi).join("\n");
		const fencedText = renderUpdateCrawl(
			80,
			24,
			6_000,
			"````text\r\n# Before\r\n```\r\n- literal item\r\n````",
			"2.4.0",
		)
			.map(stripAnsi)
			.join("\n");
		const nearTitle = renderUpdateCrawl(80, 24, 0, markdown, "2.4.0").find(line =>
			stripAnsi(line).includes(TITLE_TOP),
		);
		const farTitle = renderUpdateCrawl(80, 24, 6_800, markdown, "2.4.0").find(line =>
			stripAnsi(line).includes(TITLE_TOP),
		);
		const fadedFrame = renderUpdateCrawl(80, 24, 8_000, markdown, "2.4.0").map(stripAnsi).join("\n");
		const headingOnlyFrame = renderUpdateCrawl(80, 24, 0, "## [2.4.0]", "2.4.0");
		const narrowFrames = [1, 8, 12].map(width => ({
			width,
			frame: renderUpdateCrawl(width, 24, 0, markdown, "2.4.0"),
		}));

		expect(normalizeWhitespace(allText)).toContain("BEGINNING");
		expect(normalizeWhitespace(allText)).toContain("ENDING");
		expect(allText).not.toContain("…");
		expect(allText).not.toContain("...");
		expect(readableText).toContain("• A new feature.");
		expect(fencedText).toContain("# Before");
		expect(fencedText).toContain("- literal item");
		expect(fencedText).toContain("```");
		expect(fencedText).not.toContain("\r");
		expect(nearTitle).toBeDefined();
		expect(farTitle).toBeDefined();
		expect(foregroundBefore(nearTitle!, TITLE_TOP)).not.toBe(foregroundBefore(farTitle!, TITLE_TOP));
		expect(fadedFrame).not.toContain(TITLE_TOP);
		expect(headingOnlyFrame).toHaveLength(24);
		for (const { width, frame } of narrowFrames) {
			expect(Math.max(...frame.map(visibleWidth))).toBeLessThanOrEqual(width);
		}
	});

	it("waits after the full crawl and dismisses on Enter, Escape, or Ctrl+C", async () => {
		const preCrawlFocus: Component = { render: () => [] };
		let focused: Component | undefined = preCrawlFocus;
		let overlayComponent: (Component & { handleInput(data: string): void }) | undefined;
		let hidden = false;
		const host = {
			ui: {
				terminal: { rows: 12, write: () => {} },
				showOverlay: (component: Component) => {
					overlayComponent = component as Component & { handleInput(data: string): void };
					const previousFocus = focused;
					focused = component;
					return {
						hide: () => {
							hidden = true;
							if (focused === component) focused = previousFocus;
						},
						setHidden: (nextHidden: boolean) => {
							hidden = nextHidden;
						},
						isHidden: () => hidden,
					};
				},
				setFocus: (component: Component) => {
					focused = component;
				},
				requestRender: () => {},
			},
		};

		for (const key of ["\r", "\x1b", "\x03"]) {
			hidden = false;
			const running = runUpdateCrawl(host, "### Fixed\n\n- A bug.", "2.4.0", {
				tickMs: 60_000,
				now: () => 0,
			});
			overlayComponent?.handleInput(" ");
			expect(hidden).toBe(false);

			overlayComponent?.handleInput(key);
			await running;
			expect(hidden).toBe(true);
			expect(focused).toBe(preCrawlFocus);
		}
	});

	it("registers crawl as an optional mode without changing the summary default", () => {
		expect(Settings.isolated().get("startup.changelogMode")).toBe("summary");
		expect(Settings.isolated({ "startup.changelogMode": "crawl" }).get("startup.changelogMode")).toBe("crawl");
	});
});
