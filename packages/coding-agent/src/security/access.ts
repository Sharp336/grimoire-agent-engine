import * as path from "node:path";
import type { SourceMeta } from "../capability/types";
import * as git from "../utils/git";
import { loadManagedPolicy, resolveCapabilityDecision } from "./policy";
import type { EffectiveCapabilityDecision, ManagedPolicy, SecurityCapability, WorkspaceTrustRecord } from "./types";
import { WorkspaceTrustStore } from "./workspace-trust";

export interface WorkspaceSecurityContext {
	readonly cwd: string;
	readonly repoRoot: string | null;
	readonly policy: ManagedPolicy | null;
	readonly workspaceTrust: WorkspaceTrustRecord | null;
}

export interface WorkspaceCapabilityRequest {
	readonly cwd: string;
	readonly capability: SecurityCapability;
	readonly action: string;
}

export interface CodeLoadCapabilityRequest {
	readonly cwd: string;
	readonly targetPath: string;
	readonly action: string;
	readonly sourceLevel?: SourceMeta["level"];
}

export async function loadWorkspaceSecurityContext(cwd: string): Promise<WorkspaceSecurityContext> {
	const repoRoot = await git.repo.root(cwd);
	const policyResult = await loadManagedPolicy();
	const policy = policyResult.status === "loaded" ? policyResult.policy : null;
	const trustStore = new WorkspaceTrustStore();
	const workspaceTrust = await trustStore.get({
		workspacePath: cwd,
		repoRoot: repoRoot ?? undefined,
		match: policy?.document.workspaceTrust?.match ?? "repo-root-hash",
	});
	return {
		cwd,
		repoRoot,
		policy,
		workspaceTrust,
	};
}

export async function resolveWorkspaceCapabilityDecision(request: {
	readonly cwd: string;
	readonly capability: SecurityCapability;
}): Promise<EffectiveCapabilityDecision> {
	const context = await loadWorkspaceSecurityContext(request.cwd);
	return resolveCapabilityDecision({
		capability: request.capability,
		policy: context.policy,
		workspaceTrust: context.workspaceTrust,
	});
}

export async function assertWorkspaceCapabilityAllowed(
	request: WorkspaceCapabilityRequest,
): Promise<EffectiveCapabilityDecision> {
	const decision = await resolveWorkspaceCapabilityDecision(request);
	if (decision.decision !== "allow") {
		throw new Error(formatCapabilityBlockMessage(request.action, decision));
	}
	return decision;
}

export async function assertCodeLoadAllowed(request: CodeLoadCapabilityRequest): Promise<EffectiveCapabilityDecision> {
	const capability = classifyCodeLoadCapability(request);
	return assertWorkspaceCapabilityAllowed({
		cwd: request.cwd,
		capability,
		action: request.action,
	});
}

export function classifyCodeLoadCapability(request: {
	readonly cwd: string;
	readonly targetPath: string;
	readonly repoRoot?: string | null;
	readonly sourceLevel?: SourceMeta["level"];
}): SecurityCapability {
	if (request.sourceLevel === "project") {
		return "project-code-load";
	}
	if (request.sourceLevel === "user") {
		return "user-code-load";
	}
	const workspaceRoot = request.repoRoot ?? request.cwd;
	return pathIsWithin(request.targetPath, workspaceRoot) ? "project-code-load" : "user-code-load";
}

export function formatCapabilityBlockMessage(action: string, decision: EffectiveCapabilityDecision): string {
	if (decision.decision === "confirm") {
		return `${action} requires explicit approval for capability \`${decision.capability}\`, but confirmation flows are not enabled yet.`;
	}
	return `${action} is blocked by security policy for capability \`${decision.capability}\` (source: ${decision.source}).`;
}

function pathIsWithin(targetPath: string, rootPath: string): boolean {
	const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
