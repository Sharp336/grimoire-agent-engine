import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getAgentDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const DARK_THEME_PATH = path.join(import.meta.dir, "..", "src", "modes", "theme", "dark.json");
const TITANIUM_DRACULA_THEME_PATH = path.join(
	import.meta.dir,
	"..",
	"src",
	"modes",
	"theme",
	"defaults",
	"titanium-dracula.json",
);

let tempAgentDir: string | undefined;
let originalAgentDir = "";
let originalAgentDirEnv: string | undefined;

afterEach(async () => {
	if (tempAgentDir === undefined) return;
	setAgentDir(originalAgentDir);
	if (originalAgentDirEnv === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
	}
	await removeWithRetries(tempAgentDir);
	tempAgentDir = undefined;
});

it("uses the Nerd Fonts v3 Material Design session icon", async () => {
	originalAgentDir = getAgentDir();
	originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-nerd-symbols-"));
	setAgentDir(tempAgentDir);

	const dark = await Bun.file(DARK_THEME_PATH).json();
	const customThemeName = "nerd-symbols";
	await Bun.write(
		path.join(getCustomThemesDir(), `${customThemeName}.json`),
		JSON.stringify({ ...dark, name: customThemeName, symbols: { ...dark.symbols, preset: "nerd" } }),
	);

	const theme = await getThemeByName(customThemeName);
	expect(theme?.symbol("icon.session")).toBe("\u{f0051}");
});

const PERSISTENT_ICONS = {
	model: "",
	pi: "",
	folder: "",
	branch: "",
	git: "",
	context: "",
	input: "",
	output: "",
	tokens: "",
	throughput: "",
	cache: "",
	cacheMiss: "",
	session: "",
	host: "",
	time: "",
	cost: "",
	agents: "",
	job: "",
} as const;

const TEXT_THINKING = {
	minimal: "\u001b[38;2;133;147;194m\u00a0min\u001b[39m",
	low: "\u001b[38;2;133;147;194m\u00a0low\u001b[39m",
	medium: "\u001b[38;2;133;147;194m\u00a0med\u001b[39m",
	high: "\u001b[38;2;133;147;194m\u00a0high\u001b[39m",
	xhigh: "\u001b[38;2;133;147;194m\u00a0xhigh\u001b[39m",
	max: "\u001b[38;2;133;147;194m\u00a0max\u001b[39m",
	autoPending: "",
} as const;

const CONDITIONAL_ICON_CASES = [
	{
		preset: "unicode",
		icons: {
			plan: "🗺",
			prewalk: "🏃",
			vibe: "👥",
			loop: "↻",
			pause: "⏸",
			goal: "🎯",
			ghost: "👻",
			scratchFolder: "🗑",
			worktree: "🌳",
			pr: "⤴",
		},
	},
	{
		preset: "nerd",
		icons: {
			plan: "\uf2d2",
			prewalk: "\uf29d",
			vibe: "\uf0c0",
			loop: "\uf021",
			pause: "\uf04c",
			goal: "\uf140",
			ghost: "\u{f02a0}",
			scratchFolder: "\uf014",
			worktree: "\uf0e8",
			pr: "\uea64",
		},
	},
	{
		preset: "ascii",
		icons: {
			plan: "plan",
			prewalk: "prewalk",
			vibe: "AG",
			loop: "loop",
			pause: "||",
			goal: "goal",
			ghost: "@",
			scratchFolder: "[T]",
			worktree: "[wt]",
			pr: "PR",
		},
	},
] as const;

it("keeps conditional Titanium Dracula indicators preset-specific", async () => {
	originalAgentDir = getAgentDir();
	originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-titanium-dracula-symbols-"));
	setAgentDir(tempAgentDir);

	const titaniumDracula = await Bun.file(TITANIUM_DRACULA_THEME_PATH).json();

	for (const { preset, icons } of CONDITIONAL_ICON_CASES) {
		const customThemeName = `titanium-dracula-${preset}`;
		await Bun.write(
			path.join(getCustomThemesDir(), `${customThemeName}.json`),
			JSON.stringify({
				...titaniumDracula,
				name: customThemeName,
				symbols: { ...titaniumDracula.symbols, preset },
			}),
		);

		const theme = await getThemeByName(customThemeName);
		expect(theme?.icon).toMatchObject({
			...PERSISTENT_ICONS,
			...icons,
			fast: "\u001b[38;2;241;250;140m\u{f140b}\u001b[39m",
			auto: "",
		});
		expect(theme?.sep.pipe).toBe(" │ ");
		expect(theme?.sep.dot).toBe("");
		expect(theme?.thinking).toEqual(TEXT_THINKING);
	}
});
