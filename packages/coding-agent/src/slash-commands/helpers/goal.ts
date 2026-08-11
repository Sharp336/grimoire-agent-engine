import { prompt } from "@oh-my-pi/pi-utils";
import type { GoalControllerResult } from "../../goals/goal-mode-controller";
import guidedGoalInterviewPrompt from "../../prompts/goals/guided-goal-interview.md" with { type: "text" };
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, parseSubcommand, usage } from "./parse";

const GOAL_SET_USAGE = "Usage: /goal set <objective>";
const GOAL_BUDGET_USAGE = "Usage: /goal budget <N|off>";
const GOAL_UNKNOWN_VERB_USAGE = "Unknown /goal subcommand. Use set|show|pause|resume|drop|budget";

async function mapGoalResult(result: GoalControllerResult, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!result.ok) return usage(result.error, runtime);
	if (result.prompt !== undefined) return { prompt: result.prompt };
	return commandConsumed();
}

/** ACP/text-mode `/goal` handler. Shared by both dispatchers via the spec. */
export async function handleGoalAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	const controller = runtime.session.goalModeController;
	const hasActiveGoal = runtime.session.getGoalModeState()?.goal !== undefined;

	switch (verb) {
		case "set": {
			const objective = rest.trim();
			if (!objective) return usage(GOAL_SET_USAGE, runtime);
			const result = hasActiveGoal
				? await controller.replaceObjective(objective)
				: await controller.enter(objective);
			return await mapGoalResult(result, runtime);
		}
		case "show": {
			await runtime.output(controller.show());
			return commandConsumed();
		}
		case "pause":
			return await mapGoalResult(await controller.pause(), runtime);
		case "resume":
			return await mapGoalResult(await controller.resume(), runtime);
		case "drop":
			return await mapGoalResult(await controller.drop(), runtime);
		case "budget": {
			const raw = rest.trim();
			if (!raw) return usage(GOAL_BUDGET_USAGE, runtime);
			let budget: number | undefined;
			if (raw === "off") {
				budget = undefined;
			} else {
				const parsed = Number(raw);
				if (!Number.isFinite(parsed)) return usage(GOAL_BUDGET_USAGE, runtime);
				budget = parsed;
			}
			return await mapGoalResult(await controller.setBudget(budget), runtime);
		}
		case "": {
			// Bare /goal = status query.
			await runtime.output(controller.show());
			return commandConsumed();
		}
		default: {
			// `/goal <objective>` with an unrecognized verb sets a goal when none
			// is active (TUI parity); with an active goal it's a typo.
			if (!hasActiveGoal) {
				const result = await controller.enter(command.args.trim());
				return await mapGoalResult(result, runtime);
			}
			return usage(GOAL_UNKNOWN_VERB_USAGE, runtime);
		}
	}
}

/** ACP/text-mode `/guided-goal` handler: expose the goal tool and run the interview kickoff. */
export async function handleGuidedGoalAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const controller = runtime.session.goalModeController;
	// Reuse the controller's entry guard (goal.enabled + plan active OR paused)
	// so a persisted plan_paused session can't start a guided goal whose interview
	// would then call `goal create` — the goal tool itself has no plan guard.
	const guard = controller.entryGuard();
	if (guard && !guard.ok) return usage(guard.error, runtime);
	const existing = runtime.session.getGoalModeState();
	if (existing?.goal && existing.goal.status !== "dropped" && existing.goal.status !== "complete") {
		return usage(
			existing.goal.status === "paused"
				? "Resume the current goal first, or drop it before starting a guided goal."
				: "Goal mode is already active. Use /goal to manage it, or /goal drop to start over.",
			runtime,
		);
	}
	await controller.exposeGoalTool();
	const interviewPrompt = prompt.render(guidedGoalInterviewPrompt, { initial: command.args?.trim() || undefined });
	// Return the interview kickoff as a residual prompt so the slash dispatcher
	// feeds it as model input WITHIN the current client request — calling
	// session.prompt() directly would nest an agent-initiated turn and break the
	// ACP lifecycle (mirrors how /goal set returns {prompt} for its first turn).
	// Mark it synthetic (mirroring the TUI kickoff) so the dispatcher delivers
	// it as a hidden developer message instead of recording the internal
	// interview instructions as user-authored chat content.
	return { prompt: interviewPrompt, synthetic: true };
}
