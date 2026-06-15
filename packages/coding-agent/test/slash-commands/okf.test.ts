import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { writeConcept } from "../../src/okf/bundle";

const tempDirs: string[] = [];

async function makeTempCwd(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "okf-command-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createRuntimeHarness(cwd: string, overrides?: { setForcedToolChoice?: (toolName: string) => void }) {
	const setForcedToolChoice = vi.fn(overrides?.setForcedToolChoice ?? ((_toolName: string) => {}));
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const refreshSlashCommandState = vi.fn();
	const settings = {
		get: vi.fn((key: string) => (key === "okf.bundleDir" ? undefined : false)),
	};
	const sessionManager = { getCwd: () => cwd };
	const session = { setForcedToolChoice };

	const ctx = {
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		session: session as unknown as InteractiveModeContext["session"],
		sessionManager: sessionManager as unknown as InteractiveModeContext["sessionManager"],
		settings: settings as unknown as InteractiveModeContext["settings"],
		showStatus,
		showError,
		refreshSlashCommandState,
	} as unknown as InteractiveModeContext;

	return {
		runtime: { ctx },
		setForcedToolChoice,
		setText,
		showStatus,
		showError,
	};
}

describe("/okf slash command", () => {
	it("spawns one task subagent for enrichment", async () => {
		const cwd = await makeTempCwd();
		const harness = createRuntimeHarness(cwd);

		const result = await executeBuiltinSlashCommand("/okf enrich auth", harness.runtime);

		expect(typeof result).toBe("string");
		expect(result).toContain("Use the `task` tool to spawn exactly one codebase-walking OKF enrichment subagent.");
		expect(result).toContain("okf://");
		expect(result).toContain("Focus on: auth.");
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("task");
		expect(harness.showStatus).toHaveBeenCalledWith("OKF enrichment: spawning a codebase-walking task subagent…");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("rejects visualize output paths outside the working directory", async () => {
		const parent = await makeTempCwd();
		const cwd = path.join(parent, "project");
		await fs.mkdir(cwd, { recursive: true });
		await writeConcept(
			path.join(cwd, ".omp", "knowledge"),
			"architecture/auth",
			"---\ntype: Architecture\ndescription: auth\n---\nAuth flow.",
		);
		const outsidePath = path.join(parent, "escape.html");
		const harness = createRuntimeHarness(cwd);

		const result = await executeBuiltinSlashCommand("/okf visualize ../escape.html", harness.runtime);

		expect(result).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith(
			"OKF visualize: output path must be inside the working directory.",
		);
		expect(await Bun.file(outsidePath).exists()).toBe(false);
	});
});
