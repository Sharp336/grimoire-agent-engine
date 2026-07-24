import {
	CONTEXT_DREAM_TASK_NAMES,
	CONTEXT_DREAM_TASKS,
	type ContextDreamTaskName,
	isContextDreamTaskName,
} from "../../context-manager/dreamer-registry";
import {
	formatContextDreamResult as formatDreamResult,
	formatContextEmbeddingStatus as formatEmbedding,
	formatContextHistorianResult as formatHistorian,
	formatManagedContextStatus,
	sanitizeContextStatusText as safe,
} from "../../context-manager/report";
import type { ContextEmbeddingStatus } from "../../context-manager/types";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, usage } from "./parse";

function manager(runtime: SlashCommandRuntime) {
	return runtime.session.contextManager;
}

export async function handleContextStatus(
	_command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const contextManager = manager(runtime);
	if (!contextManager) return usage("Managed context is unavailable for this session.", runtime);
	await runtime.output(formatManagedContextStatus(await contextManager.diagnostics()));
	return commandConsumed();
}

export async function handleContextFlush(
	_command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const contextManager = manager(runtime);
	if (!contextManager) return usage("Managed context is unavailable for this session.", runtime);
	const result = await contextManager.flush(runtime.session.model);
	if (result.status === "ok") runtime.session.freshSession();
	const error = result.error ? `; ${safe(result.error)}` : "";
	await runtime.output(
		`Context flush: ${result.status}; ${result.activatedDrops} drops activated; ${result.activeDrops} active; ${result.queuedDrops} queued; ${result.compartments} compartments; ${result.facts} facts${error}`,
	);
	return commandConsumed();
}

function parseRecompRange(
	args: string,
): { readonly range?: { readonly startTag: number; readonly endTag: number } } | { readonly error: string } {
	const trimmed = args.trim().toLowerCase();
	if (!trimmed || trimmed === "full") return {};
	const match = /^(\d+)\s*(?:-|\.\.|:)\s*(\d+)$/.exec(trimmed);
	if (!match) return { error: "Usage: /ctx-recomp [full|<start>-<end>]" };
	const startTag = Number(match[1]);
	const endTag = Number(match[2]);
	if (!Number.isSafeInteger(startTag) || !Number.isSafeInteger(endTag) || startTag < 1 || endTag < startTag) {
		return { error: "Recomp range must use positive ascending tag ordinals." };
	}
	return { range: { startTag, endTag } };
}

export async function handleContextRecomp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const contextManager = manager(runtime);
	if (!contextManager) return usage("Managed context is unavailable for this session.", runtime);
	const parsed = parseRecompRange(command.args);
	if ("error" in parsed) return usage(parsed.error, runtime);
	void contextManager.recomp(parsed.range).then(result => {
		const level = result.status === "published" || result.status === "noop" ? "info" : "warning";
		runtime.session.emitNotice(level, formatHistorian("Context recomp", result), "context-manager");
	});
	await runtime.output("Context recomp started in the background; completion will arrive as a session notice.");
	return commandConsumed();
}

export async function handleContextWrapup(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const contextManager = manager(runtime);
	if (!contextManager) return usage("Managed context is unavailable for this session.", runtime);
	const trimmed = command.args.trim();
	const messagesToKeep = trimmed ? Number(trimmed) : 20;
	if (!Number.isSafeInteger(messagesToKeep) || messagesToKeep < 1 || messagesToKeep > 10_000) {
		return usage("Usage: /ctx-wrapup [messages-to-keep]", runtime);
	}
	const result = await contextManager.wrapup(messagesToKeep);
	await runtime.output(formatHistorian("Context wrapup", result));
	return commandConsumed();
}

export async function handleContextAugment(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const userPrompt = command.args.trim();
	if (!userPrompt) return usage("Usage: /ctx-aug <prompt>", runtime);
	const contextManager = manager(runtime);
	if (!contextManager) return usage("Managed context is unavailable for this session.", runtime);
	const result = await contextManager.augmentPrompt(userPrompt);
	if (result.status === "augmented") await runtime.output("Sidekick context attached.");
	else if (result.warning) await runtime.output(`Sidekick failed open: ${safe(result.warning)}`);
	else
		await runtime.output(
			result.status === "disabled" ? "Sidekick is disabled." : "Sidekick found no relevant context.",
		);
	return { prompt: result.prompt };
}

export async function handleContextEmbed(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const contextManager = manager(runtime);
	if (!contextManager) return usage("Managed context is unavailable for this session.", runtime);
	const action = command.args.trim().toLowerCase() || "status";
	let status: ContextEmbeddingStatus;
	if (action === "start") status = await contextManager.startEmbedding();
	else if (action === "pause") status = contextManager.pauseEmbedding();
	else if (action === "status") status = contextManager.embeddingStatus();
	else return usage("Usage: /ctx-embed [start|pause|status]", runtime);
	await runtime.output(formatEmbedding(status));
	return commandConsumed();
}

function parseDreamArgs(
	args: string,
):
	| { readonly tasks: readonly ContextDreamTaskName[]; readonly force: boolean; readonly all: boolean }
	| { readonly error: string } {
	const words = args.split(/\s+/).filter(Boolean);
	const force = words.includes("--force");
	const positional = words.filter(word => word !== "--force");
	if (positional.length > 1) return { error: "Usage: /ctx-dream [task|all] [--force]" };
	const requested = positional[0] ?? "all";
	if (requested === "all") return { tasks: CONTEXT_DREAM_TASK_NAMES, force, all: true };
	if (!isContextDreamTaskName(requested)) {
		return { error: `Unknown dream task '${safe(requested)}'. Available: ${CONTEXT_DREAM_TASK_NAMES.join(", ")}` };
	}
	return { tasks: [requested], force: true, all: false };
}

export async function handleContextDream(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const contextManager = manager(runtime);
	if (!contextManager) return usage("Managed context is unavailable for this session.", runtime);
	const parsed = parseDreamArgs(command.args);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const tasks =
		parsed.all && !parsed.force
			? parsed.tasks.filter(task => String(runtime.settings.get(CONTEXT_DREAM_TASKS[task].schedulePath)).trim())
			: parsed.tasks;
	if (tasks.length === 0) return usage("No dream tasks are enabled.", runtime);
	const results = await contextManager.runDreamTasks(tasks, { force: parsed.force });
	await runtime.output(results.map(formatDreamResult).join("\n"));
	return commandConsumed();
}

export async function handleContextSessionUpgrade(
	_command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const contextManager = manager(runtime);
	if (!contextManager) return usage("Managed context is unavailable for this session.", runtime);
	await contextManager.rebind();
	const recomp = await contextManager.recomp();
	const classifications = await contextManager.runDreamTasks(["classify-memories"], { force: true });
	await runtime.output(
		[formatHistorian("Session upgrade", recomp), ...classifications.map(formatDreamResult)].join("\n"),
	);
	return commandConsumed();
}
