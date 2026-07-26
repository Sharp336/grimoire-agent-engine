import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreeDir, hashPath, isEnoent } from "@oh-my-pi/pi-utils";
import type { GitStatusSummary, GitWorktreeEntry } from "../utils/git";
import * as git from "../utils/git";
import type {
	MissionFeatureSpec,
	MissionFeatureWorkspaceDescriptor,
	MissionIssue,
	MissionPauseReason,
	MissionRepositoryState,
	MissionState,
	MissionValidatorWorkspaceDescriptor,
	MissionWorkerHandoff,
	MissionWorkspaceDescriptor,
} from "./types";

const LOCAL_BRANCH_PREFIX = "refs/heads/";

export type MissionWorkspaceConflict = {
	kind: "pause";
	reason: Extract<MissionPauseReason, "workspace_conflict">;
	descriptorId: string;
	featureId: string;
	path: string;
	branch?: string;
	expectedHead?: string;
	actualHead?: string | null;
	detail: string;
};

export type MissionIntegrationDiverged = {
	kind: "pause";
	reason: Extract<MissionPauseReason, "integration_diverged">;
	featureId: string;
	integrationBranch: string;
	expectedOldHead: string;
	newHead: string;
	actualHead: string | null;
};

export type MissionPartialHandoff = {
	kind: "partial_handoff";
	issues: MissionIssue[];
	featureBranchHead: string | null;
};

export type MissionReconcileResult =
	| { kind: "ready"; descriptor: MissionWorkspaceDescriptor }
	| MissionWorkspaceConflict;

export type MissionAdvanceIntegrationResult =
	| { kind: "advanced"; repository: MissionRepositoryState }
	| { kind: "already_applied"; repository: MissionRepositoryState }
	| MissionPartialHandoff
	| MissionIntegrationDiverged;

export class MissionWorkspaceError extends Error {
	override readonly name = "MissionWorkspaceError";
}

function assertNever(value: never, message: string): never {
	throw new MissionWorkspaceError(`${message}: ${JSON.stringify(value)}`);
}

export function toLocalBranchRef(branchName: string): string {
	return branchName.startsWith(LOCAL_BRANCH_PREFIX) ? branchName : `${LOCAL_BRANCH_PREFIX}${branchName}`;
}

function workspaceSegment(repoRoot: string, missionId: string, featureId: string): string {
	return `mission-${hashPath(repoRoot)}-${missionId}-${featureId}`;
}

function featureBranchName(missionId: string, featureId: string): string {
	return `omp/mission/${missionId}/feature/${featureId}`;
}

function featureWorkspaceId(missionId: string, featureId: string): string {
	return `feature:${missionId}:${featureId}`;
}

function validatorWorkspaceId(missionId: string, featureId: string): string {
	return `validator:${missionId}:${featureId}`;
}

function requireRepository(mission: MissionState): MissionRepositoryState {
	if (!mission.repository) {
		throw new MissionWorkspaceError(`Mission "${mission.id}" has no repository state`);
	}
	return mission.repository;
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.stat(targetPath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

function samePath(left: string, right: string): boolean {
	return path.resolve(left) === path.resolve(right);
}

function findWorktreeEntry(entries: readonly GitWorktreeEntry[], targetPath: string): GitWorktreeEntry | undefined {
	return entries.find(entry => samePath(entry.path, targetPath));
}

/** A checkout with no staged, unstaged or untracked change. */
export function isCleanSummary(summary: GitStatusSummary | null): boolean {
	return summary !== null && summary.staged === 0 && summary.unstaged === 0 && summary.untracked === 0;
}

function sameCommitList(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

function blockingIssue(description: string, evidence?: string, featureId?: string): MissionIssue {
	return {
		severity: "blocking",
		description,
		...(evidence !== undefined ? { evidence } : {}),
		...(featureId !== undefined ? { affectedFeatureIds: [featureId] } : {}),
	};
}

function workspaceConflict(
	descriptor: MissionWorkspaceDescriptor,
	detail: string,
	extra: {
		branch?: string;
		expectedHead?: string;
		actualHead?: string | null;
	} = {},
): MissionWorkspaceConflict {
	return {
		kind: "pause",
		reason: "workspace_conflict",
		descriptorId: descriptor.id,
		featureId: descriptor.featureId,
		path: descriptor.path,
		detail,
		...(extra.branch !== undefined ? { branch: extra.branch } : {}),
		...(extra.expectedHead !== undefined ? { expectedHead: extra.expectedHead } : {}),
		...(extra.actualHead !== undefined ? { actualHead: extra.actualHead } : {}),
	};
}

function integrationDiverged(
	descriptor: MissionFeatureWorkspaceDescriptor,
	repository: MissionRepositoryState,
	expectedOldHead: string,
	newHead: string,
	actualHead: string | null,
): MissionIntegrationDiverged {
	return {
		kind: "pause",
		reason: "integration_diverged",
		featureId: descriptor.featureId,
		integrationBranch: repository.integrationBranch,
		expectedOldHead,
		newHead,
		actualHead,
	};
}

async function ensureWorktreeParent(worktreePath: string): Promise<void> {
	await fs.mkdir(path.dirname(worktreePath), { recursive: true });
}

async function createFeatureWorkspace(repoRoot: string, descriptor: MissionFeatureWorkspaceDescriptor): Promise<void> {
	const branchRef = toLocalBranchRef(descriptor.branch);
	const branchHead = await git.ref.resolve(repoRoot, branchRef);
	if (branchHead === null) {
		await git.branch.create(repoRoot, descriptor.branch, descriptor.baseSha);
	} else if (branchHead !== descriptor.baseSha) {
		throw new MissionWorkspaceError(
			`Feature branch ${descriptor.branch} already exists at ${branchHead}, expected ${descriptor.baseSha}`,
		);
	}
	await ensureWorktreeParent(descriptor.path);
	await git.worktree.add(repoRoot, descriptor.path, descriptor.branch);
}

async function createValidatorWorkspace(
	repoRoot: string,
	descriptor: MissionValidatorWorkspaceDescriptor,
): Promise<void> {
	await ensureWorktreeParent(descriptor.path);
	await git.worktree.add(repoRoot, descriptor.path, descriptor.head, { detach: true });
}

function isExactFeatureWorktree(entry: GitWorktreeEntry, descriptor: MissionFeatureWorkspaceDescriptor): boolean {
	return !entry.detached && entry.branch === toLocalBranchRef(descriptor.branch);
}

function isExactValidatorWorktree(entry: GitWorktreeEntry, descriptor: MissionValidatorWorkspaceDescriptor): boolean {
	return entry.detached && entry.head === descriptor.head;
}

/**
 * Crash-recoverable native-git workspace manager for missions.
 * Reserve is pure path/branch computation; only materialize/reconcile/advance/release mutate git.
 */
export class MissionWorkspaceManager {
	async reserveFeature(
		ownerSessionId: string,
		mission: MissionState,
		feature: MissionFeatureSpec,
	): Promise<MissionFeatureWorkspaceDescriptor> {
		const repository = requireRepository(mission);
		const branch = featureBranchName(mission.id, feature.id);
		const worktreePath = getWorktreeDir(workspaceSegment(repository.repoRoot, mission.id, feature.id));
		return {
			id: featureWorkspaceId(mission.id, feature.id),
			kind: "feature",
			ownerSessionId,
			repoRoot: repository.repoRoot,
			path: worktreePath,
			featureId: feature.id,
			phase: "reserved",
			branch,
			baseSha: repository.integrationHead,
		};
	}

	async reserveValidator(
		ownerSessionId: string,
		mission: MissionState,
		featureId: string,
	): Promise<MissionValidatorWorkspaceDescriptor> {
		const repository = requireRepository(mission);
		const worktreePath = getWorktreeDir(workspaceSegment(repository.repoRoot, mission.id, featureId));
		return {
			id: validatorWorkspaceId(mission.id, featureId),
			kind: "validator",
			ownerSessionId,
			repoRoot: repository.repoRoot,
			path: worktreePath,
			featureId,
			phase: "reserved",
			head: repository.integrationHead,
		};
	}

	async materialize(descriptor: MissionWorkspaceDescriptor): Promise<MissionWorkspaceDescriptor> {
		if (descriptor.phase === "ready") {
			return descriptor;
		}

		return git.withRepoLock(descriptor.repoRoot, async () => {
			switch (descriptor.kind) {
				case "feature": {
					await createFeatureWorkspace(descriptor.repoRoot, descriptor);
					return { ...descriptor, phase: "ready" };
				}
				case "validator": {
					await createValidatorWorkspace(descriptor.repoRoot, descriptor);
					return { ...descriptor, phase: "ready" };
				}
				default:
					return assertNever(descriptor, "Unknown workspace descriptor kind");
			}
		});
	}

	async reconcile(
		descriptor: MissionWorkspaceDescriptor,
		hasChildTranscript: boolean,
	): Promise<MissionReconcileResult> {
		return git.withRepoLock(descriptor.repoRoot, async () => {
			switch (descriptor.kind) {
				case "feature":
					return this.#reconcileFeature(descriptor, hasChildTranscript);
				case "validator":
					return this.#reconcileValidator(descriptor, hasChildTranscript);
				default:
					return assertNever(descriptor, "Unknown workspace descriptor kind");
			}
		});
	}

	async advanceIntegration(
		repository: MissionRepositoryState,
		descriptor: MissionFeatureWorkspaceDescriptor,
		handoff: MissionWorkerHandoff,
	): Promise<MissionAdvanceIntegrationResult> {
		return git.withRepoLock(descriptor.repoRoot, async () => {
			const summary = await git.status.summary(descriptor.path);
			if (!isCleanSummary(summary)) {
				return {
					kind: "partial_handoff",
					featureBranchHead: null,
					issues: [
						blockingIssue(
							"Feature workspace is dirty; handoff cannot be accepted",
							summary === null
								? "git.status.summary failed"
								: `staged=${summary.staged} unstaged=${summary.unstaged} untracked=${summary.untracked}`,
							descriptor.featureId,
						),
					],
				};
			}

			const branchRef = toLocalBranchRef(descriptor.branch);
			const featureBranchHead = await git.ref.resolve(descriptor.repoRoot, branchRef);
			if (featureBranchHead === null) {
				return {
					kind: "partial_handoff",
					featureBranchHead: null,
					issues: [
						blockingIssue(
							`Feature branch "${descriptor.branch}" is not resolvable`,
							undefined,
							descriptor.featureId,
						),
					],
				};
			}

			const ancestorOk = await git.ref.isAncestor(descriptor.repoRoot, descriptor.baseSha, featureBranchHead);
			if (!ancestorOk) {
				return {
					kind: "partial_handoff",
					featureBranchHead,
					issues: [
						blockingIssue(
							"Feature branch head is not a descendant of workspace baseSha",
							`baseSha=${descriptor.baseSha} head=${featureBranchHead}`,
							descriptor.featureId,
						),
					],
				};
			}

			const commits = await git.revList.range(descriptor.repoRoot, descriptor.baseSha, descriptor.branch);
			if (!sameCommitList(commits, handoff.commits)) {
				return {
					kind: "partial_handoff",
					featureBranchHead,
					issues: [
						blockingIssue(
							"Feature commit list does not match handoff.commits",
							`expected=${handoff.commits.join(",") || "(empty)"} actual=${commits.join(",") || "(empty)"}`,
							descriptor.featureId,
						),
					],
				};
			}

			const expectedOldHead = descriptor.baseSha;
			const newHead = featureBranchHead;
			const integrationRef = toLocalBranchRef(repository.integrationBranch);
			const integrationWorktree = (await git.worktree.list(descriptor.repoRoot)).find(
				entry => !entry.detached && entry.branch === integrationRef,
			);
			if (integrationWorktree && !isCleanSummary(await git.status.summary(integrationWorktree.path))) {
				return {
					kind: "partial_handoff",
					featureBranchHead,
					issues: [
						blockingIssue(
							"Integration worktree is dirty; integration branch cannot be advanced",
							undefined,
							descriptor.featureId,
						),
					],
				};
			}
			const synchronizeIntegrationWorktree = async (): Promise<void> => {
				if (integrationWorktree) {
					await git.reset(integrationWorktree.path, { hard: true, target: newHead });
				}
			};

			const ancestryToNew = await git.ref.isAncestor(descriptor.repoRoot, expectedOldHead, newHead);
			if (!ancestryToNew) {
				return {
					kind: "partial_handoff",
					featureBranchHead,
					issues: [
						blockingIssue(
							"Integration advance requires expectedOldHead to be an ancestor of newHead",
							`expectedOldHead=${expectedOldHead} newHead=${newHead}`,
							descriptor.featureId,
						),
					],
				};
			}

			let actualHead = await git.ref.resolve(descriptor.repoRoot, integrationRef);
			if (actualHead === newHead) {
				await synchronizeIntegrationWorktree();
				return {
					kind: "already_applied",
					repository: { ...repository, integrationHead: newHead },
				};
			}
			if (actualHead !== expectedOldHead) {
				return integrationDiverged(descriptor, repository, expectedOldHead, newHead, actualHead);
			}

			const updated = await git.ref.update(descriptor.repoRoot, integrationRef, newHead, expectedOldHead);
			if (updated) {
				await synchronizeIntegrationWorktree();
				return {
					kind: "advanced",
					repository: { ...repository, integrationHead: newHead },
				};
			}

			// CAS lost: restore semantics — retry while still at expectedOldHead;
			// equality with newHead means already-applied; anything else diverged.
			actualHead = await git.ref.resolve(descriptor.repoRoot, integrationRef);
			if (actualHead === newHead) {
				await synchronizeIntegrationWorktree();
				return {
					kind: "already_applied",
					repository: { ...repository, integrationHead: newHead },
				};
			}
			if (actualHead === expectedOldHead) {
				const retried = await git.ref.update(descriptor.repoRoot, integrationRef, newHead, expectedOldHead);
				if (retried) {
					await synchronizeIntegrationWorktree();
					return {
						kind: "advanced",
						repository: { ...repository, integrationHead: newHead },
					};
				}
				actualHead = await git.ref.resolve(descriptor.repoRoot, integrationRef);
				if (actualHead === newHead) {
					await synchronizeIntegrationWorktree();
					return {
						kind: "already_applied",
						repository: { ...repository, integrationHead: newHead },
					};
				}
				if (actualHead === expectedOldHead) {
					throw new MissionWorkspaceError(
						`Integration CAS failed twice while ${repository.integrationBranch} remained at ${expectedOldHead}`,
					);
				}
			}
			return integrationDiverged(descriptor, repository, expectedOldHead, newHead, actualHead);
		});
	}

	async release(descriptor: MissionWorkspaceDescriptor): Promise<void> {
		await git.withRepoLock(descriptor.repoRoot, () => this.#removeWorkspace(descriptor));
	}

	async releaseIfEmpty(descriptor: MissionWorkspaceDescriptor): Promise<boolean> {
		return git.withRepoLock(descriptor.repoRoot, async () => {
			switch (descriptor.kind) {
				case "feature":
					return this.#releaseFeatureIfEmpty(descriptor);
				case "validator":
					return this.#releaseValidatorIfEmpty(descriptor);
				default:
					return assertNever(descriptor, "Unknown workspace descriptor kind");
			}
		});
	}

	async #reconcileFeature(
		descriptor: MissionFeatureWorkspaceDescriptor,
		hasChildTranscript: boolean,
	): Promise<MissionReconcileResult> {
		const repoRoot = descriptor.repoRoot;
		const branchRef = toLocalBranchRef(descriptor.branch);
		const entries = await git.worktree.list(repoRoot);
		const entry = findWorktreeEntry(entries, descriptor.path);
		const onDisk = await pathExists(descriptor.path);
		const refSha = await git.ref.resolve(repoRoot, branchRef);

		if (entry && !isExactFeatureWorktree(entry, descriptor)) {
			return workspaceConflict(descriptor, "Worktree path is registered to an unowned or mismatched branch", {
				branch: descriptor.branch,
				expectedHead: descriptor.baseSha,
				actualHead: entry.head ?? null,
			});
		}
		if (entry && !onDisk) {
			if (hasChildTranscript) {
				return workspaceConflict(
					descriptor,
					"Registered feature workspace path is missing while a child transcript exists",
					{
						branch: descriptor.branch,
					},
				);
			}
			await git.worktree.prune(repoRoot);
			await createFeatureWorkspace(repoRoot, descriptor);
			return { kind: "ready", descriptor: { ...descriptor, phase: "ready" } };
		}
		if (!entry && onDisk) {
			return workspaceConflict(descriptor, "Workspace path exists on disk but is not a registered worktree", {
				branch: descriptor.branch,
			});
		}
		if (refSha === null) {
			if (entry) {
				return workspaceConflict(descriptor, "Feature worktree exists without its owned branch ref", {
					branch: descriptor.branch,
					actualHead: entry.head ?? null,
				});
			}
			if (hasChildTranscript) {
				return workspaceConflict(descriptor, "Missing feature workspace path/ref but a child transcript exists", {
					branch: descriptor.branch,
				});
			}
			await createFeatureWorkspace(repoRoot, descriptor);
			return { kind: "ready", descriptor: { ...descriptor, phase: "ready" } };
		}
		if (!entry) {
			if (hasChildTranscript) {
				return workspaceConflict(
					descriptor,
					"Owned feature ref exists but path is missing while a child transcript exists",
					{ branch: descriptor.branch, expectedHead: refSha },
				);
			}
			await ensureWorktreeParent(descriptor.path);
			await git.worktree.add(repoRoot, descriptor.path, descriptor.branch);
			return { kind: "ready", descriptor: { ...descriptor, phase: "ready" } };
		}
		return { kind: "ready", descriptor: { ...descriptor, phase: "ready" } };
	}

	async #reconcileValidator(
		descriptor: MissionValidatorWorkspaceDescriptor,
		hasChildTranscript: boolean,
	): Promise<MissionReconcileResult> {
		const repoRoot = descriptor.repoRoot;
		const entries = await git.worktree.list(repoRoot);
		const entry = findWorktreeEntry(entries, descriptor.path);
		const onDisk = await pathExists(descriptor.path);

		if (entry && !isExactValidatorWorktree(entry, descriptor)) {
			return workspaceConflict(descriptor, "Validator worktree is unowned, attached, or at the wrong head", {
				expectedHead: descriptor.head,
				actualHead: entry.head ?? null,
			});
		}
		if (entry && !onDisk) {
			if (hasChildTranscript) {
				return workspaceConflict(
					descriptor,
					"Registered validator workspace path is missing while a child transcript exists",
					{
						expectedHead: descriptor.head,
					},
				);
			}
			await git.worktree.prune(repoRoot);
			await createValidatorWorkspace(repoRoot, descriptor);
			return { kind: "ready", descriptor: { ...descriptor, phase: "ready" } };
		}
		if (!entry && onDisk) {
			return workspaceConflict(descriptor, "Validator path exists on disk but is not a registered worktree", {
				expectedHead: descriptor.head,
			});
		}
		if (!entry) {
			if (hasChildTranscript) {
				return workspaceConflict(descriptor, "Missing validator workspace path while a child transcript exists", {
					expectedHead: descriptor.head,
				});
			}
			await createValidatorWorkspace(repoRoot, descriptor);
			return { kind: "ready", descriptor: { ...descriptor, phase: "ready" } };
		}
		return { kind: "ready", descriptor: { ...descriptor, phase: "ready" } };
	}

	/**
	 * Non-forcible removal for either workspace kind. `{ force: false }` makes git
	 * refuse a worktree holding uncommitted work, and a path that is not a registered
	 * worktree is never deleted — unowned state is preserved, never reclaimed. Only a
	 * feature owns a branch; a validator worktree is detached at a recorded head.
	 */
	async #removeWorkspace(descriptor: MissionWorkspaceDescriptor): Promise<void> {
		const entries = await git.worktree.list(descriptor.repoRoot);
		const entry = findWorktreeEntry(entries, descriptor.path);
		if (entry) {
			const owned =
				descriptor.kind === "feature"
					? isExactFeatureWorktree(entry, descriptor)
					: isExactValidatorWorktree(entry, descriptor);
			if (!owned) {
				throw new MissionWorkspaceError(`Refusing to remove unowned worktree at ${descriptor.path}`);
			}
			await git.worktree.remove(descriptor.repoRoot, descriptor.path, { force: false });
		} else if (await pathExists(descriptor.path)) {
			throw new MissionWorkspaceError(
				`Refusing to remove unowned path at ${descriptor.path} during ${descriptor.kind} release`,
			);
		}
		if (descriptor.kind === "feature") {
			await git.branch.tryDelete(descriptor.repoRoot, descriptor.branch);
		}
	}

	async #releaseFeatureIfEmpty(descriptor: MissionFeatureWorkspaceDescriptor): Promise<boolean> {
		const repoRoot = descriptor.repoRoot;
		const branchRef = toLocalBranchRef(descriptor.branch);
		const entries = await git.worktree.list(repoRoot);
		const entry = findWorktreeEntry(entries, descriptor.path);
		const onDisk = await pathExists(descriptor.path);
		const head = await git.ref.resolve(repoRoot, branchRef);

		if (!entry && !onDisk && head === null) {
			return true;
		}

		if (entry && !isExactFeatureWorktree(entry, descriptor)) {
			return false;
		}
		if (!entry && onDisk) {
			return false;
		}
		// Branch must still equal base; missing branch with a live worktree is partial.
		if (entry && (head === null || head !== descriptor.baseSha)) {
			return false;
		}
		if (!entry && head !== null && head !== descriptor.baseSha) {
			return false;
		}

		if (entry) {
			const summary = await git.status.summary(descriptor.path);
			if (!isCleanSummary(summary)) {
				return false;
			}
			await git.worktree.remove(repoRoot, descriptor.path, { force: false });
		}

		if (head !== null) {
			const deleted = await git.branch.tryDelete(repoRoot, descriptor.branch, { force: false });
			if (!deleted) {
				return false;
			}
		}

		return true;
	}

	async #releaseValidatorIfEmpty(descriptor: MissionValidatorWorkspaceDescriptor): Promise<boolean> {
		const repoRoot = descriptor.repoRoot;
		const entries = await git.worktree.list(repoRoot);
		const entry = findWorktreeEntry(entries, descriptor.path);
		const onDisk = await pathExists(descriptor.path);

		if (!entry && !onDisk) {
			return true;
		}
		if (!entry && onDisk) {
			return false;
		}
		if (!entry || !isExactValidatorWorktree(entry, descriptor)) {
			return false;
		}

		const summary = await git.status.summary(descriptor.path);
		if (!isCleanSummary(summary)) {
			return false;
		}

		await git.worktree.remove(repoRoot, descriptor.path, { force: false });
		return true;
	}
}
