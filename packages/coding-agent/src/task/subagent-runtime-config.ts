import type { ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { buildServiceTierByFamily, resolveSubagentServiceTier } from "../config/service-tier";
import { Settings } from "../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings-schema";
import type { ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
import type { AgentDefinition } from "./types";

export function createSubagentSettings(
	baseSettings: Settings,
	overrides?: Partial<Record<SettingPath, unknown>>,
	inheritedServiceTier?: ServiceTierByFamily | null,
): Settings {
	const snapshot: Partial<Record<SettingPath, unknown>> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		snapshot[key] = baseSettings.get(key);
	}
	// Resolve the subagent's per-family tiers from `tier.subagent` ("inherit" =
	// match the parent's live tiers when a live session supplied them, else the
	// subagent's own configured tier.* settings). The result is stamped back onto
	// the snapshot so createAgentSession's tier.* reads pick it up.
	const inheritedTiers =
		inheritedServiceTier === undefined
			? buildServiceTierByFamily(
					baseSettings.get("tier.openai"),
					baseSettings.get("tier.anthropic"),
					baseSettings.get("tier.google"),
				)
			: (inheritedServiceTier ?? {});
	const subagentTiers = resolveSubagentServiceTier(baseSettings.get("tier.subagent"), inheritedTiers);
	snapshot["tier.openai"] = subagentTiers.openai ?? "none";
	snapshot["tier.anthropic"] = subagentTiers.anthropic ?? "none";
	snapshot["tier.google"] = subagentTiers.google ?? "none";
	return Settings.isolated({
		...snapshot,
		// Async jobs and bash auto-backgrounding are inherited from the parent:
		// background jobs are owner-routed to the subagent's own session, and
		// the run driver's quiescence barrier + teardown reap guarantee no
		// owner job outlives the run, so worktree capture/cleanup stays
		// race-free (previously both were force-disabled here).

		// Subagents run headless — there is no UI to confirm prompts against, so
		// the parent task approval is the authorization boundary. Use yolo mode
		// to preserve unattended subagent execution. User `tools.approval` policies still apply.
		"tools.approvalMode": "yolo",
		...overrides,
	});
}

export interface ResolvedSubagentCapabilities {
	childDepth: number;
	atMaxDepth: boolean;
	toolNames?: string[];
	spawns: string;
}

export function resolveSubagentCapabilities(
	agent: AgentDefinition,
	settings: Settings,
	options: { parentDepth?: number; restrictToolNames?: boolean } = {},
): ResolvedSubagentCapabilities {
	const childDepth = (options.parentDepth ?? 0) + 1;
	const maxRecursionDepth = settings.get("task.maxRecursionDepth") ?? 2;
	const atMaxDepth = maxRecursionDepth >= 0 && childDepth >= maxRecursionDepth;

	let toolNames: string[] | undefined;
	if (agent.tools && agent.tools.length > 0) {
		toolNames = agent.tools;
		if (agent.spawns !== undefined && !toolNames.includes("task") && !atMaxDepth) {
			toolNames = [...toolNames, "task"];
		}
	}
	if (atMaxDepth && toolNames?.includes("task")) {
		toolNames = toolNames.filter(name => name !== "task");
	}
	if (toolNames && !options.restrictToolNames && !toolNames.includes("hub")) {
		toolNames = [...toolNames, "hub"];
	}
	if (toolNames?.includes("exec")) {
		const backends = resolveEvalBackends({ settings } as ToolSession);
		const expanded = toolNames.filter(name => name !== "exec");
		if (backends.python || backends.js || backends.ruby || backends.julia) expanded.push("eval");
		expanded.push("bash");
		toolNames = Array.from(new Set(expanded));
	}

	const spawns = atMaxDepth
		? ""
		: agent.spawns === undefined
			? ""
			: agent.spawns === "*"
				? "*"
				: agent.spawns.join(",");
	return { childDepth, atMaxDepth, toolNames, spawns };
}
