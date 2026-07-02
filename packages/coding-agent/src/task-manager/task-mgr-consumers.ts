/**
 * Task Manager LLM consumers — `overview` and `create --ai`.
 *
 * Both use the `taskMgr` model role, falling back to `default` when unset.
 * The LLM call uses `completeSimple` from `@oh-my-pi/pi-ai`.
 */

import { type Api, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import acGenerationPrompt from "../prompts/task-ac-generation.md" with { type: "text" };
import overviewPrompt from "../prompts/task-overview.md" with { type: "text" };
import type { Core } from "./core";
import { computeStatistics, type TaskStatistics } from "./statistics";

/** Resolve the taskMgr model, falling back to default. */
function resolveTaskMgrModel(registry: ModelRegistry, settings: Settings): Model<Api> | undefined {
	const available = registry.getAvailable();
	if (available.length === 0) return undefined;

	const roleValue = settings.getModelRole("taskMgr") ?? settings.getModelRole("default");
	const resolved = resolveModelRoleValue(roleValue, available, { settings });
	return resolved.model ?? available[0];
}

/** Extract plain text from an AssistantMessage content array. */
function extractText(content: { type: string; text?: string }[]): string {
	return content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("");
}

/** Generate a natural-language project overview via the taskMgr model. */
export async function generateOverview(core: Core, registry: ModelRegistry, settings: Settings): Promise<string> {
	await core.ensureConfigLoaded();
	const tasks = await core.listTasks();
	const milestones = await core.listMilestones();
	const stats = computeStatistics(tasks, milestones);

	const model = resolveTaskMgrModel(registry, settings);
	if (!model) {
		return formatOverviewText(core, stats);
	}

	const userMessage = JSON.stringify(
		{
			projectName: core.config.projectName,
			totalTasks: stats.total,
			drafts: stats.drafts,
			archived: stats.archived,
			byStatus: stats.byStatus,
			blocked: stats.blocked.map(t => ({ id: t.id, title: t.title })),
			milestoneProgress: stats.milestoneProgress.map(m => ({
				name: m.milestone.name,
				done: m.done,
				total: m.total,
				percentage: m.percentage,
			})),
		},
		null,
		2,
	);

	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: [overviewPrompt],
				messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
			},
			{
				apiKey: registry.resolver(model),
				maxTokens: 1024,
				disableReasoning: true,
			},
		);

		if (response.stopReason === "error") {
			logger.warn("task-manager: overview LLM error", { errorMessage: response.errorMessage });
			return formatOverviewText(core, stats);
		}

		const text = extractText(response.content);
		return text || formatOverviewText(core, stats);
	} catch (err) {
		logger.warn("task-manager: overview failed, using text fallback", { error: String(err) });
		return formatOverviewText(core, stats);
	}
}

/** Generate acceptance criteria and plan via the taskMgr model (--ai flag). */
export async function generateAcceptanceCriteria(
	_core: Core,
	registry: ModelRegistry,
	settings: Settings,
	title: string,
	description: string,
): Promise<{ acceptanceCriteria: string[]; taskPlan: string } | null> {
	const model = resolveTaskMgrModel(registry, settings);
	if (!model) return null;

	const userMessage = `Title: ${title}\nDescription: ${description}\n\nGenerate acceptance criteria (one per line) and an implementation plan.`;

	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: [acGenerationPrompt],
				messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
			},
			{
				apiKey: registry.resolver(model),
				maxTokens: 1024,
				disableReasoning: true,
			},
		);

		if (response.stopReason === "error") return null;

		const content = extractText(response.content);
		if (!content) return null;
		const acMatch = content.match(/^(.*?)(?:##\s*Plan|$)/s);
		const planMatch = content.match(/##\s*Plan\s*\n([\s\S]*?)$/);

		const acceptanceCriteria = (acMatch?.[1] ?? "")
			.split("\n")
			.map(line => line.replace(/^\s*-\s*/, "").trim())
			.filter(Boolean);

		const taskPlan = planMatch?.[1]?.trim() ?? "";

		return { acceptanceCriteria, taskPlan };
	} catch (err) {
		logger.warn("task-manager: --ai generation failed", { error: String(err) });
		return null;
	}
}

/** Text fallback for overview when no model is available. */
function formatOverviewText(core: Core, stats: TaskStatistics): string {
	const lines: string[] = [];
	lines.push(`Project: ${core.config.projectName}`);
	lines.push(`Total tasks: ${stats.total} (${stats.drafts} drafts, ${stats.archived} archived)`);
	lines.push("");
	lines.push("By status:");
	for (const [status, count] of Object.entries(stats.byStatus)) {
		lines.push(`  ${status}: ${count}`);
	}
	if (stats.blocked.length > 0) {
		lines.push("");
		lines.push("Blocked tasks:");
		for (const task of stats.blocked) {
			lines.push(`  ${task.id}: ${task.title}`);
		}
	}
	if (stats.milestoneProgress.length > 0) {
		lines.push("");
		lines.push("Milestone progress:");
		for (const m of stats.milestoneProgress) {
			lines.push(`  ${m.milestone.name}: ${m.done}/${m.total} done (${m.percentage}%)`);
		}
	}
	return lines.join("\n");
}
