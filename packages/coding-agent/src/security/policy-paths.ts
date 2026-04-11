import * as path from "node:path";

export const MANAGED_POLICY_OVERRIDE_ENV_VAR = "OH_OMP_POLICY_PATH";

export type ManagedPolicyPathSource = "override" | "system";

export interface ManagedPolicyPathCandidate {
	readonly path: string;
	readonly source: ManagedPolicyPathSource;
}

export interface ManagedPolicyPathOptions {
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
}

export function getSystemManagedPolicyPath(options: ManagedPolicyPathOptions = {}): string {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	if (platform === "darwin") {
		return path.join("/Library/Application Support", "oh-omp", "policy.yml");
	}
	if (platform === "win32") {
		const programData = env.ProgramData ?? env.PROGRAMDATA ?? "C:\\ProgramData";
		return path.win32.join(programData, "oh-omp", "policy.yml");
	}
	return path.join("/etc", "oh-omp", "policy.yml");
}

export function getManagedPolicyPathCandidates(options: ManagedPolicyPathOptions = {}): ManagedPolicyPathCandidate[] {
	const env = options.env ?? process.env;
	const overridePath = env[MANAGED_POLICY_OVERRIDE_ENV_VAR]?.trim();
	const candidates: ManagedPolicyPathCandidate[] = [];
	if (overridePath) {
		candidates.push({
			path: path.resolve(overridePath),
			source: "override",
		});
	}
	candidates.push({
		path: getSystemManagedPolicyPath(options),
		source: "system",
	});
	return candidates;
}
