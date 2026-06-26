import type { LoopReadinessAssessment, LoopSpec } from "./types";

export function assessLoopReadiness(spec: LoopSpec): LoopReadinessAssessment {
	const issues: string[] = [];
	const warnings: string[] = [];

	if (spec.goal.length === 0) issues.push("loop.goal is required");
	if (spec.nonGoals.length === 0) issues.push("loop.non_goals must list at least one explicit non-goal");
	if (spec.runner.prompt.length === 0) issues.push("loop.runner.prompt is required");
	if (!spec.verifier.separate) {
		issues.push("loop.verifier.separate must be true so implementer and verifier stay split");
	}
	if (!spec.state.runLog) issues.push("loop.state.run_log is required for durable audit history");
	if (spec.level !== "report" && spec.verifier.commands.length === 0) {
		issues.push("loop.verifier.commands must include at least one check for assisted/autonomous loops");
	}
	if (spec.level === "report" && spec.verifier.commands.length > 0) {
		issues.push("loop.verifier.commands must be empty for report loops");
	}
	if (spec.level !== "report" && spec.guardrails.maxIterations === null) {
		issues.push("loop.guardrails.max_iterations is required for assisted/autonomous loops");
	}

	if (spec.scope.paths.length === 0) warnings.push("loop.scope.paths is empty; the loop has no watched scope");
	if (!spec.state.file) warnings.push("loop.state.file is not set; durable handoff context may be weak");
	if (!spec.state.budget && spec.level !== "report") {
		warnings.push("loop.state.budget is not set; budget caps should be explicit before unattended use");
	}
	if (spec.guardrails.maxFilesChanged === null && spec.level !== "report") {
		warnings.push("loop.guardrails.max_files_changed is not set");
	}
	if (spec.guardrails.requireHumanApproval.length === 0 && spec.level === "autonomous") {
		issues.push("loop.guardrails.require_human_approval is required for autonomous loops");
	}
	if (spec.trigger.type === "manual") {
		warnings.push("loop.trigger.type is manual; use cron, launch-agent, or github-actions for recurring runs");
	}

	const score = Math.max(0, 100 - issues.length * 20 - warnings.length * 5);
	return {
		ready: issues.length === 0,
		score,
		issues,
		warnings,
	};
}
