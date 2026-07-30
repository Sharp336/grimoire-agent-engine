import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAvailableThemesWithPaths,
	getThemeByName,
	isLightTheme,
	setTheme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getConfigRootDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

let tmpAgentDir: string;

async function writeTheme(name: string, json: Record<string, unknown>): Promise<void> {
	const themesDir = getCustomThemesDir();
	await fs.mkdir(themesDir, { recursive: true });
	await Bun.write(path.join(themesDir, `${name}.json`), JSON.stringify(json, null, 2));
}

describe("theme extends", () => {
	beforeEach(async () => {
		tmpAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-theme-extends-"));
		setAgentDir(tmpAgentDir);
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(tmpAgentDir);
	});

	it("inherits colors from the base while overriding only the declared symbols", async () => {
		await writeTheme("sharp", {
			extends: "dark",
			symbols: { overrides: { "boxRound.topLeft": "+" } },
		});

		const base = await getThemeByName("dark");
		const child = await getThemeByName("sharp");
		expect(child).toBeDefined();
		expect(child!.symbol("boxRound.topLeft")).toBe("+");
		// Untouched sections come from the base.
		expect(child!.symbol("boxRound.topRight")).toBe(base!.symbol("boxRound.topRight"));
		expect(child!.getColorHex("accent")).toBe(base!.getColorHex("accent"));
	});

	it("resolves a multi-level chain, with the nearest declaration winning", async () => {
		await writeTheme("mid", {
			extends: "dark",
			symbols: { overrides: { "boxRound.topLeft": "+" } },
		});
		await writeTheme("leaf", { extends: "mid", colors: { accent: "#ff0000" } });

		const base = await getThemeByName("dark");
		const leaf = await getThemeByName("leaf");
		expect(leaf).toBeDefined();
		expect(leaf!.getColorHex("accent")).toBe("#ff0000");
		// Reached through two hops.
		expect(leaf!.symbol("boxRound.topLeft")).toBe("+");
		expect(leaf!.getColorHex("syntaxString")).toBe(base!.getColorHex("syntaxString"));
	});

	it("rejects a circular chain and names it", async () => {
		await writeTheme("loop-a", { extends: "loop-b" });
		await writeTheme("loop-b", { extends: "loop-a" });

		const result = await setTheme("loop-a");
		expect(result.success).toBe(false);
		expect(result.error).toContain("circular extends chain");
		expect(result.error).toContain("loop-a -> loop-b -> loop-a");
	});

	it("still requires every color token when no base supplies them", async () => {
		await writeTheme("orphan", { colors: { accent: "#ff0000" } });

		const result = await setTheme("orphan");
		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid theme");
	});

	it("layers a custom file over the built-in of the same name without `extends`", async () => {
		const builtin = await getThemeByName("dark");
		await writeTheme("dark", { symbols: { overrides: { "boxRound.topLeft": "+" } } });

		const shadowed = await getThemeByName("dark");
		expect(shadowed).toBeDefined();
		expect(shadowed!.symbol("boxRound.topLeft")).toBe("+");
		// Everything else still comes from the built-in it shadows.
		expect(shadowed!.getColorHex("accent")).toBe(builtin!.getColorHex("accent"));
		expect(shadowed!.symbol("boxRound.topRight")).toBe(builtin!.symbol("boxRound.topRight"));
	});

	it("prefers an explicit `extends` over the same-named built-in", async () => {
		const light = await getThemeByName("light");
		await writeTheme("dark", { extends: "light", colors: { accent: "#ff0000" } });

		const shadowed = await getThemeByName("dark");
		expect(shadowed).toBeDefined();
		expect(shadowed!.getColorHex("accent")).toBe("#ff0000");
		// Inherited from `light`, not from built-in `dark`.
		expect(shadowed!.getColorHex("syntaxString")).toBe(light!.getColorHex("syntaxString"));
	});

	it("resolves a chain whose base is a shadowed built-in", async () => {
		await writeTheme("dark", { symbols: { overrides: { "boxRound.topLeft": "S" } } });
		await writeTheme("leaf", { extends: "dark", colors: { accent: "#ff0000" } });

		const result = await setTheme("leaf");
		expect(result.success).toBe(true);
		const leaf = await getThemeByName("leaf");
		// Reaches the shadow's override, not a false cycle.
		expect(leaf!.symbol("boxRound.topLeft")).toBe("S");
		expect(leaf!.getColorHex("accent")).toBe("#ff0000");
	});

	it("classifies an inheriting theme by its resolved colors", async () => {
		await writeTheme("inherited-light", { extends: "light" });

		expect(isLightTheme("inherited-light")).toBe(true);
		expect(isLightTheme("dark")).toBe(false);
	});

	it("reports the custom file path for a name that shadows a built-in", async () => {
		await writeTheme("dark", { symbols: { overrides: { "boxRound.topLeft": "S" } } });

		const entries = await getAvailableThemesWithPaths();
		const shadowed = entries.filter(entry => entry.name === "dark");
		expect(shadowed).toHaveLength(1);
		expect(shadowed[0].path).toBe(path.join(getCustomThemesDir(), "dark.json"));
	});
});
