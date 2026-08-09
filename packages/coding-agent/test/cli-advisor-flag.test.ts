import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyExtensionFlags } from "@oh-my-pi/pi-coding-agent/cli/extension-flags";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { applyAdvisorCliOverride, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("parseArgs — --advisor flag", () => {
	it("parses --advisor as a boolean flag", () => {
		const result = parseArgs(["--advisor"]);
		expect(result.advisor).toBe(true);
	});

	it("defaults advisor to undefined when flag is not provided", () => {
		const result = parseArgs([]);
		expect(result.advisor).toBeUndefined();
	});

	it("parses --advisor with other flags", () => {
		const result = parseArgs(["--advisor", "--model", "opus", "hello"]);
		expect(result.advisor).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toContain("hello");
	});

	it("parses --advisor in any position", () => {
		const result1 = parseArgs(["--advisor", "prompt"]);
		const result2 = parseArgs(["prompt", "--advisor"]);
		const result3 = parseArgs(["--model", "opus", "--advisor", "prompt"]);

		expect(result1.advisor).toBe(true);
		expect(result2.advisor).toBe(true);
		expect(result3.advisor).toBe(true);
	});

	it("does not consume a value after --advisor", () => {
		const result = parseArgs(["--advisor", "--model", "opus"]);
		expect(result.advisor).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual([]);
	});

	it("accepts explicit on and off values without consuming the prompt", () => {
		const enabled = parseArgs(["--advisor", "on", "review this"]);
		const disabled = parseArgs(["--advisor", "off", "review this"]);

		expect(enabled.advisor).toBe(true);
		expect(enabled.messages).toEqual(["review this"]);
		expect(disabled.advisor).toBe(false);
		expect(disabled.messages).toEqual(["review this"]);
	});

	it("accepts provider/model selectors with thinking suffixes through equals syntax", () => {
		const result = parseArgs(["--advisor=oai/gpt-5:med", "review this"]);

		expect(result.advisor).toBe("oai/gpt-5:med");
		expect(result.messages).toEqual(["review this"]);
	});

	it("does not consume a path-shaped prompt", () => {
		const result = parseArgs(["--advisor", "src/foo.ts"]);

		expect(result.advisor).toBe(true);
		expect(result.messages).toEqual(["src/foo.ts"]);
	});

	it("accepts unqualified model selectors through equals syntax", () => {
		const result = parseArgs(["--advisor=opus", "review this"]);

		expect(result.advisor).toBe("opus");
		expect(result.messages).toEqual(["review this"]);
	});

	it("supports the explicit off form with equals syntax", () => {
		const result = parseArgs(["--advisor=off", "review this"]);

		expect(result.advisor).toBe(false);
		expect(result.messages).toEqual(["review this"]);
	});

	it("does not apply a same-named extension flag as the built-in advisor override", () => {
		const values = new Map<string, boolean | string>();
		const parsed = applyExtensionFlags(
			{
				getFlags: () => new Map([["advisor", { type: "string" as const }]]),
				setFlagValue: (name, value) => values.set(name, value),
			},
			["--advisor=openai/gpt-5"],
		);
		const settings = Settings.isolated({
			"advisor.enabled": false,
			modelRoles: { advisor: "persisted/model" },
		});

		expect(parsed?.advisor).toBeUndefined();
		expect(values.get("advisor")).toBe("openai/gpt-5");
		applyAdvisorCliOverride(settings, parsed?.advisor);
		expect(settings.get("advisor.enabled")).toBe(false);
		expect(settings.getModelRole("advisor")).toBe("persisted/model");
	});

	it("resolves an ACP extension-owned advisor flag before session creation", async () => {
		using tempDir = TempDir.createSync("@omp-advisor-acp-extension-");
		const extensionPath = path.join(tempDir.path(), "advisor-flag.ts");
		await Bun.write(
			extensionPath,
			`export default function (api) {
				api.registerFlag("advisor", { type: "string" });
			}`,
		);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({
			"advisor.enabled": false,
			modelRoles: { advisor: "persisted/model" },
			"marketplace.autoUpdate": "off",
		});
		const rawArgs = ["--advisor=extension-value"];
		const parsed = {
			...parseArgs(rawArgs),
			mode: "acp" as const,
			trustedExtensions: [extensionPath],
			sessionDir: tempDir.path(),
			noSkills: true,
			noRules: true,
			noTools: true,
			noLsp: true,
		};
		const stopMessage = "stop after ACP advisor extension collision check";

		try {
			await runRootCommand(parsed, rawArgs, {
				discoverAuthStorage: async () => authStorage,
				settings,
				runAcpMode: async createSession => {
					await createSession(tempDir.path());
					throw new Error("ACP session factory returned unexpectedly");
				},
				createAgentSession: async options => {
					if (!options) throw new Error("Missing ACP session options");
					expect(options.settings?.get("advisor.enabled")).toBe(false);
					expect(options.settings?.getModelRole("advisor")).toBe("persisted/model");
					expect(options.preloadedExtensions?.runtime.flagValues.get("advisor")).toBe("extension-value");
					throw new Error(stopMessage);
				},
			});
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(stopMessage);
		} finally {
			authStorage.close();
		}
	});

	it("applies CLI enablement and model overrides without persistence", async () => {
		const cases = [
			{ advisorArgs: ["--advisor", "off"], enabled: false, model: "persisted/model" },
			{ advisorArgs: ["--advisor=oai/gpt-5:med"], enabled: true, model: "oai/gpt-5:med" },
		] as const;

		for (const testCase of cases) {
			using tempDir = TempDir.createSync("@omp-advisor-cli-");
			const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			const settings = Settings.isolated({
				"advisor.enabled": true,
				modelRoles: { advisor: "persisted/model" },
				"marketplace.autoUpdate": "off",
			});
			const rawArgs = [
				...testCase.advisorArgs,
				"--print",
				"review this",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--no-tools",
				"--no-lsp",
				"--session-dir",
				tempDir.path(),
			];
			const parsed = parseArgs(rawArgs);

			let observedError: unknown;
			try {
				await runRootCommand(parsed, rawArgs, {
					discoverAuthStorage: async () => authStorage,
					settings,
					createAgentSession: async () => {
						throw new Error("stop after advisor CLI override");
					},
				});
			} catch (error) {
				observedError = error;
			} finally {
				authStorage.close();
			}

			if (!(observedError instanceof Error)) {
				throw new Error("runRootCommand did not reach createAgentSession");
			}
			expect(observedError.message).toBe("stop after advisor CLI override");
			expect(settings.get("advisor.enabled")).toBe(testCase.enabled);
			expect(settings.getModelRole("advisor")).toBe(testCase.model);
		}
	});
});
