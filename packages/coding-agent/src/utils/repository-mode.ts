import * as git from "./git";
import * as jj from "./jj";

export type RepositoryModeSetting = "auto" | "git" | "jj";
export type RepositoryKind = "git" | "jj-git-interop" | "jj";

export type RepositoryModeCapability =
	| "canReadWorkingCopyDiff"
	| "canReadRevDiff"
	| "canReadStatus"
	| "canSingleCommit"
	| "canSplitCommit"
	| "canUseGitInteropMutations"
	| "canUseNativeWorkspaceMutations";

export type RepositoryModeCapabilities = Record<RepositoryModeCapability, boolean>;

export interface RepositoryMode {
	readonly setting: RepositoryModeSetting;
	readonly kind: RepositoryKind;
	readonly capabilities: RepositoryModeCapabilities;
	readonly gitRepository: git.GitRepository | null;
	readonly jjRepository: jj.JjRepository | null;
}

export interface ResolveRepositoryModeOptions {
	readonly detectGit?: (cwd: string) => Promise<git.GitRepository | null>;
	readonly detectJj?: (cwd: string) => Promise<jj.JjRepository | null>;
}

const GIT_CAPABILITIES: RepositoryModeCapabilities = {
	canReadWorkingCopyDiff: true,
	canReadRevDiff: true,
	canReadStatus: true,
	canSingleCommit: true,
	canSplitCommit: true,
	canUseGitInteropMutations: true,
	canUseNativeWorkspaceMutations: false,
};

const JJ_GIT_INTEROP_CAPABILITIES: RepositoryModeCapabilities = {
	canReadWorkingCopyDiff: true,
	canReadRevDiff: true,
	canReadStatus: true,
	canSingleCommit: true,
	canSplitCommit: false,
	canUseGitInteropMutations: true,
	canUseNativeWorkspaceMutations: false,
};

const JJ_CAPABILITIES: RepositoryModeCapabilities = {
	canReadWorkingCopyDiff: true,
	canReadRevDiff: true,
	canReadStatus: true,
	canSingleCommit: true,
	canSplitCommit: false,
	canUseGitInteropMutations: false,
	canUseNativeWorkspaceMutations: false,
};

export async function resolveRepositoryMode(
	cwd: string,
	setting: RepositoryModeSetting = "auto",
	options: ResolveRepositoryModeOptions = {},
): Promise<RepositoryMode> {
	const detectGit = options.detectGit ?? git.repo.resolve;
	const detectJj = options.detectJj ?? jj.repo.resolve;

	if (setting === "git") {
		const gitRepository = await detectGit(cwd);
		if (!gitRepository) throw new Error("Repository mode 'git' requires a Git repository.");
		return buildRepositoryMode(setting, "git", gitRepository, null);
	}

	const jjRepository = await detectJj(cwd);
	if (setting === "jj" && !jjRepository) {
		throw new Error("Repository mode 'jj' requires a JJ workspace.");
	}

	if (jjRepository) {
		const gitRepository = await detectGit(cwd);
		const kind: RepositoryKind = gitRepository ? "jj-git-interop" : "jj";
		return buildRepositoryMode(setting, kind, gitRepository, jjRepository);
	}

	const gitRepository = await detectGit(cwd);
	if (gitRepository) return buildRepositoryMode(setting, "git", gitRepository, null);

	throw new Error("No supported repository mode detected. Expected a Git repository or JJ workspace.");
}

export function assertRepositoryModeCapability(
	mode: RepositoryMode,
	capability: RepositoryModeCapability,
	operation: string,
	supportedAlternative: string,
): void {
	if (mode.capabilities[capability]) return;
	throw new Error(
		`Repository mode '${mode.kind}' does not support ${operation}. Supported alternative: ${supportedAlternative}.`,
	);
}

function buildRepositoryMode(
	setting: RepositoryModeSetting,
	kind: RepositoryKind,
	gitRepository: git.GitRepository | null,
	jjRepository: jj.JjRepository | null,
): RepositoryMode {
	return {
		setting,
		kind,
		capabilities: capabilitiesFor(kind),
		gitRepository,
		jjRepository,
	};
}

function capabilitiesFor(kind: RepositoryKind): RepositoryModeCapabilities {
	if (kind === "git") return GIT_CAPABILITIES;
	if (kind === "jj-git-interop") return JJ_GIT_INTEROP_CAPABILITIES;
	return JJ_CAPABILITIES;
}
