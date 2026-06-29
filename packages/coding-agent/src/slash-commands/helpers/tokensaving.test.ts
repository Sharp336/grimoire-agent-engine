import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyTokenSaving,
	collectTokenSavingWarnings,
	disableTokenSaving,
	enableTokenSaving,
	formatTokenSavingStatus,
	runTokenSavingCommand,
	type TokenSavingSettingPath,
	type TokenSavingSettingsLike,
	type TokenSavingSettingValue,
} from "./tokensaving";

class FakeSettings implements TokenSavingSettingsLike {
	values: Record<
		Exclude<TokenSavingSettingPath, "modelRoles">,
		TokenSavingSettingValue<Exclude<TokenSavingSettingPath, "modelRoles">>
	>;
	modelRoles: Record<string, string>;

	agentDir?: string;
	constructor(
		options: {
			values?: Partial<
				Record<
					Exclude<TokenSavingSettingPath, "modelRoles">,
					TokenSavingSettingValue<Exclude<TokenSavingSettingPath, "modelRoles">>
				>
			>;
			modelRoles?: Record<string, string>;
			agentDir?: string;
		} = {},
	) {
		this.values = {
			"task.eager": "default",
			"advisor.subagents": true,
			"advisor.syncBacklog": "5",
			"advisor.immuneTurns": 3,
			"advisor.compactionThresholdTokens": 0,
			enabledModels: [],
			...options.values,
		} as Record<
			Exclude<TokenSavingSettingPath, "modelRoles">,
			TokenSavingSettingValue<Exclude<TokenSavingSettingPath, "modelRoles">>
		>;
		this.modelRoles = { ...options.modelRoles };
		this.agentDir = options.agentDir;
	}

	get<P extends TokenSavingSettingPath>(path: P): TokenSavingSettingValue<P> {
		if (path === "modelRoles") return this.modelRoles as TokenSavingSettingValue<P>;
		return this.values[path as Exclude<TokenSavingSettingPath, "modelRoles">] as TokenSavingSettingValue<P>;
	}

	set<P extends TokenSavingSettingPath>(path: P, value: TokenSavingSettingValue<P>): void {
		if (path === "modelRoles") this.modelRoles = { ...(value as Record<string, string>) };
		else {
			this.values[path as Exclude<TokenSavingSettingPath, "modelRoles">] = value as TokenSavingSettingValue<
				Exclude<TokenSavingSettingPath, "modelRoles">
			>;
		}
	}

	getModelRole(role: string): string | undefined {
		return this.modelRoles[role];
	}

	setModelRole(role: string, modelId: string): void {
		this.modelRoles[role] = modelId;
	}

	getModelRoles(): Readonly<Record<string, string>> {
		return { ...this.modelRoles };
	}

	getAgentDir(): string {
		return this.agentDir ?? "";
	}
}

describe("tokensaving helper", () => {
	it("warns when task role equals the default model", async () => {
		const settings = new FakeSettings({
			values: {
				"task.eager": "always",
				"advisor.subagents": false,
				"advisor.syncBacklog": "off",
				"advisor.immuneTurns": 10,
			},
			modelRoles: {
				default: "gpt-expensive",
				task: "gpt-expensive",
				advisor: "opencode-go/deepseek-v4-flash:low",
			},
		});

		expect(collectTokenSavingWarnings(settings)).toContain(
			"modelRoles.task equals modelRoles.default; task subagents are not shifted to a cheap model.",
		);
		expect(await formatTokenSavingStatus(settings)).toContain("Token saving: off");
	});

	it("warns when task role is non-default and not cheap", async () => {
		const settings = new FakeSettings({
			values: {
				"task.eager": "always",
				"advisor.subagents": false,
				"advisor.syncBacklog": "off",
				"advisor.immuneTurns": 10,
			},
			modelRoles: {
				default: "gpt-expensive",
				task: "claude-opus",
				advisor: "opencode-go/deepseek-v4-flash:low",
			},
		});

		expect(collectTokenSavingWarnings(settings)).toContain(
			"modelRoles.task is not a cheap model; task subagents may still use an expensive model.",
		);
		expect(await formatTokenSavingStatus(settings)).toContain("Token saving: off");
	});

	it("warns when task role points at a protected expensive orchestration role model", async () => {
		const settings = new FakeSettings({
			values: {
				"task.eager": "always",
				"advisor.subagents": false,
				"advisor.syncBacklog": "off",
				"advisor.immuneTurns": 10,
			},
			modelRoles: {
				default: "gpt-expensive",
				task: "gpt-slow",
				slow: "gpt-slow",
				advisor: "opencode-go/deepseek-v4-flash:low",
			},
		});

		const warnings = collectTokenSavingWarnings(settings);
		expect(warnings).toContain(
			"modelRoles.task points at an expensive orchestration role model; task subagents are additive model spend.",
		);
		expect(warnings).toContain(
			"modelRoles.task is not a cheap model; task subagents may still use an expensive model.",
		);
		expect(await formatTokenSavingStatus(settings)).toContain("Token saving: off");
	});

	it("applies task routing and advisor economy levers", () => {
		const settings = new FakeSettings({
			values: { enabledModels: ["opencode-go/deepseek-v4-flash"] },
			modelRoles: { default: "gpt-expensive", task: "gpt-expensive", advisor: "gpt-expensive" },
		});

		const result = applyTokenSaving(settings);

		expect(settings.get("task.eager")).toBe("always");
		expect(settings.get("advisor.subagents")).toBe(false);
		expect(settings.get("advisor.syncBacklog")).toBe("off");
		expect(settings.get("advisor.immuneTurns")).toBe(10);
		expect(settings.get("advisor.compactionEnabled")).toBe(true);
		expect(settings.get("advisor.compactionThresholdPercent")).toBe(25);
		expect(settings.get("advisor.compactionStrategy")).toBe("snapcompact");
		expect(settings.getModelRole("task")).toBe("opencode-go/deepseek-v4-flash");
		expect(settings.getModelRole("advisor")).toBe("opencode-go/deepseek-v4-flash");
		expect(result.changes.map(change => change.key)).toContain("modelRoles.task");
	});

	it("preserves an existing cheap task role", () => {
		const settings = new FakeSettings({
			values: { enabledModels: ["other-cheap-model"] },
			modelRoles: {
				default: "gpt-expensive",
				task: "opencode-go/deepseek-v4-flash:xhigh",
				advisor: "gpt-expensive",
			},
		});

		applyTokenSaving(settings);

		expect(settings.getModelRole("task")).toBe("opencode-go/deepseek-v4-flash:xhigh");
	});

	it("replaces a non-default expensive task role with the candidate", () => {
		const settings = new FakeSettings({
			values: { enabledModels: ["vendor/flash-small"] },
			modelRoles: {
				default: "gpt-expensive",
				task: "claude-opus",
				advisor: "gpt-expensive",
			},
		});

		applyTokenSaving(settings);

		expect(settings.getModelRole("task")).toBe("vendor/flash-small");
	});

	it("replaces a task role that points at a protected expensive orchestration role model", () => {
		const settings = new FakeSettings({
			values: { enabledModels: ["vendor/flash-small"] },
			modelRoles: {
				default: "gpt-expensive",
				task: "gpt-slow",
				slow: "gpt-slow",
				advisor: "gpt-expensive",
			},
		});

		const result = applyTokenSaving(settings);

		expect(settings.getModelRole("task")).toBe("vendor/flash-small");
		expect(result.changes.map(change => change.key)).toContain("modelRoles.task");
	});

	it("leaves warnings when no cheap candidate exists and task is non-default expensive", () => {
		const settings = new FakeSettings({
			values: { enabledModels: [] },
			modelRoles: {
				default: "gpt-expensive",
				task: "claude-opus",
				advisor: "gpt-expensive",
			},
		});

		applyTokenSaving(settings);

		expect(settings.getModelRole("task")).toBe("claude-opus");
		const warnings = collectTokenSavingWarnings(settings);
		expect(warnings).toContain(
			"modelRoles.task is not a cheap model; task subagents may still use an expensive model.",
		);
	});

	it("does not rewrite task/advisor when role models are non-cheap and no cheap enabled model exists", () => {
		const settings = new FakeSettings({
			values: { enabledModels: [] },
			modelRoles: {
				default: "gpt-expensive",
				task: "claude-opus",
				smol: "claude-haiku",
				advisor: "gpt-expensive",
			},
		});

		applyTokenSaving(settings);

		// No cheap candidate — task stays unchanged
		expect(settings.getModelRole("task")).toBe("claude-opus");
		// Advisor also stays unchanged (not rewritten to "claude-haiku" or any fallback)
		expect(settings.getModelRole("advisor")).toBe("gpt-expensive");
		// Warnings still present for non-cheap task
		const warnings = collectTokenSavingWarnings(settings);
		expect(warnings).toContain(
			"modelRoles.task is not a cheap model; task subagents may still use an expensive model.",
		);
	});

	it("selects cheap models from smol, tiny, advisor, then enabledModels", () => {
		const fromSmol = new FakeSettings({
			modelRoles: { default: "gpt-expensive", task: "gpt-expensive", smol: "opencode-go/deepseek-v4-flash:xhigh" },
		});
		applyTokenSaving(fromSmol);
		expect(fromSmol.getModelRole("task")).toBe("opencode-go/deepseek-v4-flash:xhigh");

		const fromEnabled = new FakeSettings({
			values: { enabledModels: ["plain-model", "vendor/flash-small"] },
			modelRoles: { default: "gpt-expensive", task: "gpt-expensive" },
		});
		applyTokenSaving(fromEnabled);
		expect(fromEnabled.getModelRole("task")).toBe("vendor/flash-small");
	});

	it("does not clobber unrelated model roles when changing one role", () => {
		const settings = new FakeSettings({
			values: { enabledModels: ["vendor/flash-small"] },
			modelRoles: {
				default: "gpt-expensive",
				slow: "gpt-slow",
				vision: "gpt-vision",
				task: "gpt-expensive",
			},
		});

		applyTokenSaving(settings);

		expect(settings.getModelRole("slow")).toBe("gpt-slow");
		expect(settings.getModelRole("vision")).toBe("gpt-vision");
		expect(settings.getModelRole("task")).toBe("vendor/flash-small");
	});

	it("warns when advisor compaction is disabled", () => {
		const settings = new FakeSettings({
			values: {
				"task.eager": "always",
				"advisor.subagents": false,
				"advisor.syncBacklog": "off",
				"advisor.immuneTurns": 10,
				"advisor.compactionEnabled": false,
			},
			modelRoles: {
				default: "gpt-expensive",
				task: "opencode-go/deepseek-v4-flash:xhigh",
			},
		});

		const warnings = collectTokenSavingWarnings(settings);
		expect(warnings).toContain("advisor.compactionEnabled is false; advisor compaction is disabled.");
	});

	it("warns when advisor compaction threshold is above 50", () => {
		const settings = new FakeSettings({
			values: {
				"task.eager": "always",
				"advisor.subagents": false,
				"advisor.syncBacklog": "off",
				"advisor.immuneTurns": 10,
				"advisor.compactionEnabled": true,
				"advisor.compactionThresholdPercent": 75,
			},
			modelRoles: {
				default: "gpt-expensive",
				task: "opencode-go/deepseek-v4-flash:xhigh",
			},
		});

		const warnings = collectTokenSavingWarnings(settings);
		expect(warnings).toContain("advisor.compactionThresholdPercent is above 50; compaction may not trigger effectively.");
	});

	it("sets advisor.compactionThresholdTokens to -1 when enabling token saving", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tokensaving-"));
		const settings = new FakeSettings({
			agentDir,
			values: { enabledModels: ["vendor/flash-small"] },
			modelRoles: { default: "gpt-expensive", task: "gpt-expensive" },
		});

		await enableTokenSaving(settings);

		expect(settings.get("advisor.compactionThresholdTokens")).toBe(-1);
	});

	it("off restores settings from the snapshot created by on", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tokensaving-"));
		const settings = new FakeSettings({
			agentDir,
			values: { enabledModels: ["vendor/flash-small"] },
			modelRoles: { default: "gpt-expensive", task: "gpt-expensive", slow: "gpt-slow" },
		});

		const enabled = await enableTokenSaving(settings);
		expect(enabled.snapshotCreated).toBe(true);
		expect(settings.get("task.eager")).toBe("always");
		expect(settings.getModelRole("task")).toBe("vendor/flash-small");

		settings.set("task.eager", "preferred");
		settings.setModelRole("task", "temporary-model");
		expect(await disableTokenSaving(settings)).toContain("restored");

		expect(settings.get("task.eager")).toBe("default");
		expect(settings.get("advisor.subagents")).toBe(true);
		expect(settings.get("advisor.syncBacklog")).toBe("5");
		expect(settings.get("advisor.immuneTurns")).toBe(3);
		expect(settings.getModelRole("task")).toBe("gpt-expensive");
		expect(settings.getModelRole("slow")).toBe("gpt-slow");
		expect(fs.existsSync(path.join(agentDir, "tokensaving-snapshot.json"))).toBe(false);
	});

	it("off does not mutate settings when no snapshot exists", async () => {
		const settings = new FakeSettings({
			agentDir: fs.mkdtempSync(path.join(os.tmpdir(), "omp-tokensaving-")),
			modelRoles: { default: "gpt-expensive", task: "opencode-go/deepseek-v4-flash:xhigh" },
		});
		const before = JSON.stringify({ values: settings.values, roles: settings.modelRoles });

		expect(await runTokenSavingCommand("off", settings)).toContain("no token-saving snapshot");
		expect(JSON.stringify({ values: settings.values, roles: settings.modelRoles })).toBe(before);
	});
});
