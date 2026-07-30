import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("parseArgs — --agents-file flag", () => {
	it("parses spaced and equals values without leaking them into messages", () => {
		const spaced = parseArgs(["--agents-file", "strict.md", "hello"]);
		const equals = parseArgs(["--agents-file=minimal.md", "hello"]);

		expect(spaced.agentsFile).toBe("strict.md");
		expect(spaced.messages).toEqual(["hello"]);
		expect(equals.agentsFile).toBe("minimal.md");
		expect(equals.messages).toEqual(["hello"]);
	});

	it("keeps an @-prefixed path as the flag value", () => {
		const parsed = parseArgs(["--agents-file", "@fixtures/strict.md", "hello"]);

		expect(parsed.agentsFile).toBe("@fixtures/strict.md");
		expect(parsed.fileArgs).toEqual([]);
		expect(parsed.messages).toEqual(["hello"]);
	});

	it("preserves an explicit empty equals value for strict resolution", () => {
		const parsed = parseArgs(["--agents-file=", "hello"]);

		expect(parsed.agentsFile).toBe("");
		expect(parsed.messages).toEqual(["hello"]);
	});

	it("rejects the bare flag as a missing required value", () => {
		expect(() => parseArgs(["--agents-file"])).toThrow("--agents-file requires a value");
	});

	it("forwards the exact value into session creation", async () => {
		using tempDir = TempDir.createSync("@omp-agents-file-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		let observedOptions: CreateAgentSessionOptions | undefined;
		const exactValue = "./fixtures/strict.md";
		const parsed = parseArgs(["--agents-file", exactValue, "--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		try {
			await runRootCommand(parsed, ["--agents-file", exactValue, "--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") throw error;
		} finally {
			authStorage.close();
		}

		expect(observedOptions?.userAgentsFile).toBe(exactValue);
	});

	it("rejects an explicit empty path during strict discovery", async () => {
		using tempDir = TempDir.createSync("@omp-agents-file-empty-");
		const { loadProjectContextFiles } = await import("@oh-my-pi/pi-coding-agent/system-prompt");

		await expect(loadProjectContextFiles({ cwd: tempDir.path(), userAgentsFile: "" })).rejects.toThrow(
			"--agents-file requires a non-empty path",
		);
	});
});
