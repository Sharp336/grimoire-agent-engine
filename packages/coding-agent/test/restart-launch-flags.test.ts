import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { buildRestartCommand, consumeRestartLiteralPrompts } from "@oh-my-pi/pi-coding-agent/cli/restart";
import {
	applyLiveThinkingToRestartLaunchArgs,
	buildRestartLaunchFlags,
	resolveStartupPromptInputs,
} from "@oh-my-pi/pi-coding-agent/main";
import { resolvePromptInput, resolvePromptInputWithSource } from "@oh-my-pi/pi-coding-agent/system-prompt";
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
				providerPromptCacheKey: "cache-shard-1",
				provider: "openai",
				model: "gpt-5",
				noPty: true,
				noTitle: true,
				prewalk: true,
				prewalkInto: "@smol",
				planYolo: true,
				planYoloInto: "@slow",
			},
			"/repo/original",
			undefined,
			undefined,
			undefined,
			"/repo/resumed",
			undefined,
			undefined,
			["env-overlay.yml", "/tmp/env-overlay.yml"].join(path.delimiter),
		);

		expect(flags.configFiles).toEqual(["/repo/original/omp.yml", "/tmp/global.yml"]);
		expect(flags.configEnvFiles).toEqual(["/repo/original/env-overlay.yml", "/tmp/env-overlay.yml"]);
		expect(flags.extensionPaths).toEqual(["/repo/resumed/ext", "/repo/resumed/pkg-extension", "/repo/shared/ext"]);
		expect(flags.extensionPackageRoots).toEqual([
			"/repo/original/ext",
			"/repo/original/pkg-extension",
			"/repo/shared/ext",
			"/repo/original/hooks/restart.ts",
			"/repo/original/@scope/pkg",
		]);
		expect(flags.hookPaths).toEqual(["/repo/resumed/hooks/restart.ts", "/repo/resumed/@scope/pkg"]);
		expect(flags.pluginDirs).toEqual(["/repo/original/plugins", "/opt/plugins"]);
		expect(flags.providerSessionId).toBe("provider-session-1");
		expect(flags.providerPromptCacheKey).toBe("cache-shard-1");
		expect(flags.provider).toBe("openai");
		expect(flags.model).toBe("gpt-5");
		expect(flags.noPty).toBe(true);
		expect(flags.noTitle).toBe(true);
		expect(flags.prewalk).toBe(true);
		expect(flags.prewalkInto).toBe("@smol");
		expect(flags.planYolo).toBe(true);
		expect(flags.planYoloInto).toBe("@slow");
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

	test("preserves empty extension flag snapshots as restart markers", () => {
		const flags = buildRestartLaunchFlags({}, "/repo/original", []);

		expect(flags.extensionFlagValues).toEqual([]);
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

	test("preserves autoApprove flag in launch flags snapshot", () => {
		const flags = buildRestartLaunchFlags({ autoApprove: true }, "/repo/original");

		expect(flags.autoApprove).toBe(true);

		const defaultFlags = buildRestartLaunchFlags({}, "/repo/original");

		expect(defaultFlags.autoApprove).toBe(false);
	});
	test("resolves extension and hook path flags with tilde forms and relative paths", () => {
		const home = os.homedir();
		const flags = buildRestartLaunchFlags(
			{
				extensions: ["~/my-ext", "~\\windows-ext", "~name/named-ext", "./relative-ext"],
				hooks: ["~/my-hook.ts", "~\\windows-hook.ts", "~name/named-hook.ts", "./relative-hook.ts"],
			},
			"/repo/original",
			undefined,
			undefined,
			undefined,
			"/repo/resumed",
		);

		expect(flags.extensionPaths).toEqual([
			path.join(home, "my-ext"),
			`${home}\\windows-ext`,
			path.join(home, "name/named-ext"),
			"/repo/resumed/relative-ext",
		]);

		expect(flags.hookPaths).toEqual([
			path.join(home, "my-hook.ts"),
			`${home}\\windows-hook.ts`,
			path.join(home, "name/named-hook.ts"),
			"/repo/resumed/relative-hook.ts",
		]);
	});

	test("preserves initial prompt source classification across restart", async () => {
		const tempDir = TempDir.createSync("restart-prompt-flags");
		const sessionCwd = path.resolve(tempDir.path());
		const fileBackedPrompt = path.join(sessionCwd, "prompts", "system.md");
		const literalSystemPrompt = path.join(sessionCwd, "literal-system-prompt");
		const literalAppendPrompt = path.join(sessionCwd, "literal-append-prompt");
		const prefixCollision = "omp-restart-literal-prompt:bm90LWludGVybmFs";
		try {
			await Bun.write(fileBackedPrompt, "file-backed prompt");
			const fileBackedSource = await resolvePromptInputWithSource(fileBackedPrompt, "system prompt");
			const literalSystemSource = await resolvePromptInputWithSource(literalSystemPrompt, "system prompt");
			const literalAppendSource = await resolvePromptInputWithSource(literalAppendPrompt, "append system prompt");

			expect(fileBackedSource?.source).toBe("file");
			expect(literalSystemSource?.source).toBe("literal");
			expect(literalAppendSource?.source).toBe("literal");
			expect(await resolvePromptInput(prefixCollision, "system prompt")).toBe(prefixCollision);

			await Bun.write(literalSystemPrompt, "new system file");
			await Bun.write(literalAppendPrompt, "new append file");
			const flags = buildRestartLaunchFlags(
				{ systemPrompt: literalSystemPrompt, appendSystemPrompt: literalAppendPrompt },
				sessionCwd,
				undefined,
				undefined,
				undefined,
				sessionCwd,
				undefined,
				undefined,
				undefined,
				{ systemPrompt: literalSystemSource, appendSystemPrompt: literalAppendSource },
			);
			const fileFlags = buildRestartLaunchFlags(
				{ systemPrompt: fileBackedPrompt },
				sessionCwd,
				undefined,
				undefined,
				undefined,
				sessionCwd,
				undefined,
				undefined,
				undefined,
				{ systemPrompt: fileBackedSource },
			);
			const command = buildRestartCommand({
				sessionId: "session-1",
				cwd: sessionCwd,
				sessionDir: tempDir.join("sessions"),
				approvalMode: "write",
				...flags,
			});
			const restartLiterals = consumeRestartLiteralPrompts(command.env);
			const childInputs = await resolveStartupPromptInputs({
				restartLiteralPrompts: restartLiterals,
			});

			expect(fileFlags.systemPrompt).toBe(fileBackedPrompt);
			expect(command.cmd).not.toContain("--system-prompt");
			expect(command.cmd).not.toContain("--append-system-prompt");
			expect(childInputs.systemPrompt?.value).toBe(literalSystemPrompt);
			expect(childInputs.appendSystemPrompt?.value).toBe(literalAppendPrompt);
		} finally {
			await tempDir.remove();
		}
	});
});
