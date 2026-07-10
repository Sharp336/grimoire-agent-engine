import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	applyLiveThinkingToRestartLaunchArgs,
	buildRestartLaunchFlags,
	resolveRestartPromptLaunchValue,
} from "@oh-my-pi/pi-coding-agent/main";
import { resolvePromptInput } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("restart launch flags", () => {
	test("resolves launch and session path flags against their live startup cwd", () => {
		const flags = buildRestartLaunchFlags(
			{
				config: ["./omp.yml", "/tmp/global.yml"],
				extensions: ["./ext", "pkg-extension", "../shared/ext"],
				hooks: ["./hooks/restart.ts", "@scope/pkg"],
				pluginDirs: ["plugins", "/opt/plugins"],
				providerSessionId: "provider-session-1",
				provider: "openai",
				model: "gpt-5",
				noPty: true,
				noTitle: true,
			},
			"/repo/original",
			undefined,
			undefined,
			undefined,
			"/repo/resumed",
		);

		expect(flags.configFiles).toEqual(["/repo/original/omp.yml", "/tmp/global.yml"]);
		expect(flags.extensionPaths).toEqual(["/repo/resumed/ext", "/repo/resumed/pkg-extension", "/repo/shared/ext"]);
		expect(flags.hookPaths).toEqual(["/repo/resumed/hooks/restart.ts", "/repo/resumed/@scope/pkg"]);
		expect(flags.pluginDirs).toEqual(["/repo/original/plugins", "/opt/plugins"]);
		expect(flags.providerSessionId).toBe("provider-session-1");
		expect(flags.provider).toBe("openai");
		expect(flags.model).toBe("gpt-5");
		expect(flags.noPty).toBe(true);
		expect(flags.noTitle).toBe(true);
	});

	test("carries env-injected API keys through extension-aware restart snapshots", () => {
		const flags = buildRestartLaunchFlags(
			{},
			"/repo/original",
			undefined,
			undefined,
			"openai",
			"/repo/resumed",
			"sk-runtime",
		);

		expect(flags.apiKey).toBe("sk-runtime");
		expect(flags.apiKeyProvider).toBe("openai");

		const cliFlags = buildRestartLaunchFlags(
			{ apiKey: "sk-cli" },
			"/repo/original",
			undefined,
			undefined,
			"openai",
			"/repo/resumed",
			"sk-runtime",
		);

		expect(cliFlags.apiKey).toBe("sk-cli");
	});

	test("uses the live thinking selector instead of the stale launch selector", () => {
		const restartArgs = applyLiveThinkingToRestartLaunchArgs({ thinking: ThinkingLevel.High }, ThinkingLevel.Low);
		const flags = buildRestartLaunchFlags(
			restartArgs,
			"/repo/original",
			undefined,
			undefined,
			undefined,
			"/repo/resumed",
		);

		expect(flags.thinking).toBe(ThinkingLevel.Low);
		expect(applyLiveThinkingToRestartLaunchArgs({ thinking: ThinkingLevel.High }, undefined).thinking).toBe(
			ThinkingLevel.High,
		);
	});

	test("absolutizes file-backed prompt flags from the session-start cwd only", async () => {
		using tempDir = TempDir.createSync("@omp-restart-prompts-");
		const launchPromptPath = path.join(tempDir.path(), "launch", "prompts", "system.md");
		const sessionCwd = path.join(tempDir.path(), "session");
		const sessionPromptPath = path.join(sessionCwd, "prompts", "system.md");
		await Bun.write(launchPromptPath, "launch prompt");
		await Bun.write(sessionPromptPath, "session prompt");

		expect(await resolveRestartPromptLaunchValue("prompts/system.md", sessionCwd)).toBe(sessionPromptPath);
		expect(await resolveRestartPromptLaunchValue("prompts/system.md", sessionCwd)).not.toBe(launchPromptPath);
		expect(await resolveRestartPromptLaunchValue(undefined, sessionCwd, launchPromptPath)).toBe(launchPromptPath);
		const literalRestartValue = await resolveRestartPromptLaunchValue("literal prompt", sessionCwd);
		expect(literalRestartValue).not.toBe("literal prompt");
		await Bun.write(path.join(sessionCwd, "literal prompt"), "session literal file");
		expect(await resolvePromptInput(literalRestartValue, "system prompt")).toBe("literal prompt");
		const secondRestartValue = await resolveRestartPromptLaunchValue(literalRestartValue, sessionCwd);
		expect(secondRestartValue).toBe(literalRestartValue);
		expect(await resolvePromptInput(secondRestartValue, "system prompt")).toBe("literal prompt");
		expect(await resolveRestartPromptLaunchValue("literal\nprompt", sessionCwd)).toBe("literal\nprompt");
	});
});
