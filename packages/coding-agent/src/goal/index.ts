/**
 * Built-in /goal extension — persistent autonomous goals.
 *
 * Adds a /goal command and goal tools so the agent keeps working toward a
 * long-running objective until the goal is complete, paused, cleared, or
 * token-budget-limited.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Box, Spacer, Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";

import type { ExtensionContext, ExtensionFactory, ExtensionUIContext } from "../extensibility/extensions/types";
import type { CustomMessage } from "../session/messages";
import type { SessionEntry } from "../session/session-manager";

import budgetLimitTemplate from "./budget-limit.md" with { type: "text" };
import continuationTemplate from "./continuation.md" with { type: "text" };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const CUSTOM_TYPE = "pi-goal";
const EVENT_TYPE = "pi-goal-event";
const GOAL_TOOL_NAMES = ["get_goal", "update_goal"];

type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

interface GoalState {
	version: 1;
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

type GoalEventKind = "active" | "continuation" | "paused" | "resumed" | "cleared" | "budget_limited" | "complete";

interface GoalEventDetails {
	kind: GoalEventKind;
	goal: GoalState | null;
	timestamp: number;
}

// ---------------------------------------------------------------------------
// Formatting helpers (zero-alloc where practical)
// ---------------------------------------------------------------------------

function parseTokenBudget(input: string): { objective: string; tokenBudget: number | null; error?: string } {
	const match = input.match(/(?:^|\s)--tokens(?:=|\s+)([0-9]+(?:\.[0-9]+)?\s*[kKmM]?)(?:\s|$)/);
	if (!match) return { objective: input.trim(), tokenBudget: null };

	const raw = match[1].replace(/\s+/g, "");
	const suffix = raw.slice(-1).toLowerCase();
	const numeric = suffix === "k" || suffix === "m" ? raw.slice(0, -1) : raw;
	const value = Number(numeric);
	if (!Number.isFinite(value) || value <= 0) {
		return { objective: input.trim(), tokenBudget: null, error: "Token budget must be positive." };
	}
	const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
	const tokenBudget = Math.round(value * multiplier);
	const objective = `${input.slice(0, match.index)} ${input.slice((match.index ?? 0) + match[0].length)}`.trim();
	return { objective, tokenBudget };
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
	if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
	return String(value);
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function goalUsage(state: GoalState): string {
	if (state.tokenBudget != null)
		return `${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)} tokens`;
	return formatElapsed(state.timeUsedSeconds);
}

function statusLine(state: GoalState | null): string | undefined {
	if (!state) return undefined;
	const budget = state.tokenBudget
		? ` (${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)})`
		: ` (${formatElapsed(state.timeUsedSeconds)})`;
	if (state.status === "active") return `Pursuing goal${budget}`;
	if (state.status === "paused") return "Goal paused (/goal resume)";
	if (state.status === "budget_limited") return state.tokenBudget ? `Goal unmet${budget}` : "Goal abandoned";
	return `Goal achieved${budget}`;
}

function truncateObjective(objective: string, max = 96): string {
	const singleLine = objective.replace(/\s+/g, " ").trim();
	return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

const EVENT_LABELS: Record<GoalEventKind, string> = {
	active: "active",
	continuation: "continuing",
	paused: "paused",
	resumed: "resumed",
	cleared: "cleared",
	budget_limited: "budget reached",
	complete: "achieved",
};

// ---------------------------------------------------------------------------
// Token accounting
// ---------------------------------------------------------------------------

function tokenDeltaFromMessage(message: AgentMessage): number {
	if (message.role !== "assistant") return 0;
	const usage = (message as AssistantMessage).usage;
	if (!usage) return 0;
	if (typeof usage.totalTokens === "number") return Math.max(0, usage.totalTokens);
	return Math.max(0, (Number(usage.input) || 0) + (Number(usage.output) || 0));
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function continuationPrompt(state: GoalState): string {
	return prompt.render(continuationTemplate, {
		objective: state.objective,
		timeUsedSeconds: String(state.timeUsedSeconds),
		tokensUsed: String(state.tokensUsed),
		tokenBudget: state.tokenBudget == null ? "none" : String(state.tokenBudget),
		remainingTokens: state.tokenBudget == null ? "n/a" : String(Math.max(0, state.tokenBudget - state.tokensUsed)),
	});
}

function budgetLimitPrompt(state: GoalState): string {
	return prompt.render(budgetLimitTemplate, {
		objective: state.objective,
		timeUsedSeconds: String(state.timeUsedSeconds),
		tokensUsed: String(state.tokensUsed),
		tokenBudget: state.tokenBudget == null ? "none" : String(state.tokenBudget),
	});
}

function goalContentForLLM(kind: GoalEventKind, state: GoalState): string {
	switch (kind) {
		case "active":
		case "continuation":
		case "resumed":
			return continuationPrompt(state);
		case "budget_limited":
			return budgetLimitPrompt(state);
		case "paused":
			return `The active goal has been paused by the user. Stop pursuing it for now and wait for further instructions.\n\nObjective: ${state.objective}`;
		case "cleared":
			return `The active goal has been cleared by the user. Stop pursuing it.\n\nObjective was: ${state.objective}`;
		case "complete":
			return `The goal has been marked complete.\n\nObjective: ${state.objective}\nUsage: ${goalUsage(state)}`;
	}
}

// ---------------------------------------------------------------------------
// Session state reconstruction
// ---------------------------------------------------------------------------

function latestStateFromSession(entries: SessionEntry[]): { goal: GoalState | null; statusBarEnabled: boolean } {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			const data = entry.data as { goal?: GoalState | null; statusBarEnabled?: boolean } | undefined;
			return {
				goal: data?.goal ?? null,
				statusBarEnabled: data?.statusBarEnabled ?? true,
			};
		}
	}
	return { goal: null, statusBarEnabled: true };
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export const createGoalExtension: ExtensionFactory = api => {
	let goal: GoalState | null = null;
	let statusBarEnabled = true;
	let activeTurnStartedAt: number | null = null;
	let continuationQueued = false;

	// -- helpers bound to the running extension --------------------------------

	function updateStatusBar(ui: ExtensionUIContext) {
		ui.setStatus(CUSTOM_TYPE, statusBarEnabled ? (statusLine(goal) ?? "") : "");
	}

	function syncGoalTools() {
		const want = goal?.status === "active";
		const active = new Set(api.getActiveTools());
		let changed = false;
		for (const name of GOAL_TOOL_NAMES) {
			if (want) {
				if (!active.has(name)) {
					active.add(name);
					changed = true;
				}
			} else {
				if (active.has(name)) {
					active.delete(name);
					changed = true;
				}
			}
		}
		if (changed) void api.setActiveTools(Array.from(active));
	}

	function persist(ctx: ExtensionContext, next: GoalState | null) {
		goal = next;
		api.appendEntry(CUSTOM_TYPE, { goal: next, statusBarEnabled });
		updateStatusBar(ctx.ui);
		syncGoalTools();
	}

	function persistSettings(ctx: ExtensionContext) {
		api.appendEntry(CUSTOM_TYPE, { goal, statusBarEnabled });
		updateStatusBar(ctx.ui);
	}

	function emitGoalEvent(
		kind: GoalEventKind,
		state: GoalState,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	) {
		api.sendMessage(
			{
				customType: EVENT_TYPE,
				content: goalContentForLLM(kind, state),
				display: true,
				details: { kind, goal: state, timestamp: Date.now() } satisfies GoalEventDetails,
			},
			options,
		);
	}

	function queueContinuation(state: GoalState) {
		if (continuationQueued || state.status !== "active") return;
		continuationQueued = true;
		queueMicrotask(() => {
			continuationQueued = false;
			if (!goal || goal.id !== state.id || goal.status !== "active") return;
			emitGoalEvent("continuation", goal, { triggerTurn: true, deliverAs: "followUp" });
		});
	}

	// -- message renderer -------------------------------------------------------

	api.registerMessageRenderer<GoalEventDetails>(EVENT_TYPE, (message, { expanded }, theme) => {
		const details = (message as CustomMessage<GoalEventDetails>).details;
		const kind = details?.kind ?? "continuation";
		const state = details?.goal ?? null;
		const box = new Box(1, 1, value => theme.bg("customMessageBg", value));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("Goal")), 0, 0));
		box.addChild(new Spacer(1));
		if (!expanded) {
			box.addChild(
				new Text(
					`${theme.fg("customMessageText", EVENT_LABELS[kind])} ${theme.fg("dim", "(ctrl+o to expand)")}`,
					0,
					0,
				),
			);
			return box;
		}
		const lines = [`${theme.fg("dim", "Status: ")}${theme.fg("customMessageText", EVENT_LABELS[kind])}`];
		if (state) {
			lines.push(`${theme.fg("dim", "Goal: ")}${theme.fg("customMessageText", state.objective)}`);
			lines.push(`${theme.fg("dim", "Usage: ")}${theme.fg("customMessageText", goalUsage(state))}`);
		}
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});

	// -- tools ------------------------------------------------------------------

	api.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Read the current active thread goal, if one exists.",
		defaultInactive: true,
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		} as any,
		async execute() {
			return { content: [{ type: "text", text: JSON.stringify({ goal }, null, 2) }], details: { goal } };
		},
	});

	api.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Mark the current thread goal complete. This tool only accepts status=complete.",
		defaultInactive: true,
		parameters: {
			type: "object",
			properties: {
				status: {
					type: "string",
					enum: ["complete"],
					description: "Only complete is accepted.",
				},
			},
			required: ["status"],
			additionalProperties: false,
		} as any,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if ((params as { status: string }).status !== "complete") {
				return { content: [{ type: "text", text: "update_goal only accepts status=complete." }], isError: true };
			}
			if (!goal) {
				return { content: [{ type: "text", text: "No goal is set." }], isError: true };
			}
			const now = Date.now();
			const next: GoalState = { ...goal, status: "complete", updatedAt: now };
			persist(ctx, next);
			emitGoalEvent("complete", next);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								goal: next,
								remainingTokens:
									next.tokenBudget == null ? null : Math.max(0, next.tokenBudget - next.tokensUsed),
							},
							null,
							2,
						),
					},
				],
				details: { goal: next },
			};
		},
	});

	// -- /goal command ----------------------------------------------------------

	api.registerCommand("goal", {
		description: "Set, view, pause, resume, clear, or configure a long-running goal",
		getArgumentCompletions: prefix => {
			const values = ["pause", "resume", "clear", "status", "statusbar", "statusbar on", "statusbar off"];
			const filtered = values.filter(v => v.startsWith(prefix));
			return filtered.length ? filtered.map(value => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const now = Date.now();

			if (!trimmed || trimmed === "status") {
				if (!goal) ctx.ui.notify("Usage: /goal [--tokens 50k] <objective>", "info");
				else
					ctx.ui.notify(
						`${statusLine(goal)}\nObjective: ${goal.objective}\nStatus bar: ${statusBarEnabled ? "on" : "off"}`,
						"info",
					);
				return;
			}

			if (
				trimmed === "statusbar" ||
				trimmed === "statusbar toggle" ||
				trimmed === "statusbar on" ||
				trimmed === "statusbar off"
			) {
				const [, value] = trimmed.split(/\s+/, 2);
				statusBarEnabled = value === "on" ? true : value === "off" ? false : !statusBarEnabled;
				persistSettings(ctx);
				ctx.ui.notify(`Goal status bar ${statusBarEnabled ? "enabled" : "disabled"}.`, "info");
				return;
			}

			if (trimmed === "clear") {
				if (!goal) {
					ctx.ui.notify("No goal is set.", "info");
					return;
				}
				const previous = goal;
				persist(ctx, null);
				emitGoalEvent("cleared", previous);
				return;
			}

			if (trimmed === "pause" || trimmed === "resume") {
				if (!goal) {
					ctx.ui.notify("No goal is set.", "warning");
					return;
				}
				const status: GoalStatus = trimmed === "pause" ? "paused" : "active";
				const next: GoalState = { ...goal, status, updatedAt: now };
				persist(ctx, next);
				emitGoalEvent(status === "active" ? "resumed" : "paused", next);
				if (status === "active" && ctx.isIdle()) queueContinuation(next);
				return;
			}

			const parsed = parseTokenBudget(trimmed);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			if (!parsed.objective) {
				ctx.ui.notify("Usage: /goal [--tokens 50k] <objective>", "warning");
				return;
			}
			if (goal && goal.status !== "complete") {
				const ok = await ctx.ui.confirm("Replace goal?", `Current: ${goal.objective}\n\nNew: ${parsed.objective}`);
				if (!ok) return;
			}
			const next: GoalState = {
				version: 1,
				id: `${now}-${Math.random().toString(16).slice(2)}`,
				objective: parsed.objective,
				status: "active",
				tokenBudget: parsed.tokenBudget,
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			};
			persist(ctx, next);
			emitGoalEvent("active", next, { triggerTurn: ctx.isIdle() });
		},
	});

	// -- lifecycle events -------------------------------------------------------

	api.on("session_start", (_event, ctx) => {
		const restored = latestStateFromSession(ctx.sessionManager.getBranch());
		goal = restored.goal;
		statusBarEnabled = restored.statusBarEnabled;
		continuationQueued = false;
		activeTurnStartedAt = null;
		syncGoalTools();

		if (goal?.status === "active") {
			// Reload pauses an active goal so it does not silently resume.
			goal = { ...goal, status: "paused", updatedAt: Date.now() };
			persist(ctx, goal);
			ctx.ui.notify(
				`Goal paused after reload: ${truncateObjective(goal.objective)}\nUse /goal resume to continue, or /goal clear to stop.`,
				"info",
			);
			return;
		}
		updateStatusBar(ctx.ui);
	});

	api.on("turn_start", () => {
		activeTurnStartedAt = Date.now();
	});

	api.on("turn_end", (event, ctx) => {
		if (!goal || goal.status !== "active") return;
		const elapsed = activeTurnStartedAt ? Math.max(0, Math.round((Date.now() - activeTurnStartedAt) / 1000)) : 0;
		activeTurnStartedAt = null;
		const tokenDelta = tokenDeltaFromMessage(event.message);
		let next: GoalState = {
			...goal,
			tokensUsed: goal.tokensUsed + tokenDelta,
			timeUsedSeconds: goal.timeUsedSeconds + elapsed,
			updatedAt: Date.now(),
		};
		if (next.tokenBudget != null && next.tokensUsed >= next.tokenBudget) {
			next = { ...next, status: "budget_limited" };
		}
		persist(ctx, next);
		if (next.status === "budget_limited") {
			emitGoalEvent("budget_limited", next, { triggerTurn: true, deliverAs: "followUp" });
		}
	});

	api.on("agent_end", (_event, ctx) => {
		if (!goal || goal.status !== "active" || ctx.hasPendingMessages()) return;
		queueContinuation(goal);
	});
};
