import delegatedBoundaryPrompt from "../prompts/system/vibe-delegated-worker-boundary.md" with { type: "text" };

export const VIBE_DELEGATED_WORKER_BOUNDARY = delegatedBoundaryPrompt.trim();
export interface DelegatedSkillDependency {
	type: "dependency_required";
	skill: string;
	args: string;
	execution_owner: "parent_active_session";
	status: "not_run";
	reason: "delegated_worker_boundary";
	dependent_gate: string;
	dependent_artifact: string;
}
export interface SkillDispatchResult {
	type: "skill-dispatch-result/v1";
	skill: string;
	status: "success" | "partial" | "failed";
	evidence: string;
}
export function buildVibeDelegatedAssignment(message: string): string {
	return `${VIBE_DELEGATED_WORKER_BOUNDARY}\n\nAssignment:\n${message}`;
}
export function parseDelegatedSkillDependency(value: string): DelegatedSkillDependency | null {
	try {
		const parsed = JSON.parse(value) as Partial<DelegatedSkillDependency>;
		if (
			parsed.type !== "dependency_required" ||
			typeof parsed.skill !== "string" ||
			parsed.skill.length > 128 ||
			typeof parsed.args !== "string" ||
			parsed.args.length > 2048 ||
			parsed.execution_owner !== "parent_active_session" ||
			parsed.status !== "not_run" ||
			parsed.reason !== "delegated_worker_boundary" ||
			typeof parsed.dependent_gate !== "string" ||
			typeof parsed.dependent_artifact !== "string"
		)
			return null;
		return parsed as DelegatedSkillDependency;
	} catch {
		return null;
	}
}
export function validateSkillDispatchResult(value: unknown, skill: string): SkillDispatchResult | null {
	if (!value || typeof value !== "object") return null;
	const result = value as Partial<SkillDispatchResult>;
	if (
		result.type !== "skill-dispatch-result/v1" ||
		result.skill !== skill ||
		!["success", "partial", "failed"].includes(result.status ?? "") ||
		typeof result.evidence !== "string" ||
		result.evidence.length > 8192
	)
		return null;
	return result as SkillDispatchResult;
}
