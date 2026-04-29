import { resolveToCwd } from "../tools/path-utils";
import * as git from "../utils/git";
import type { CustomEntry, SessionManager } from "./session-manager";

export const REPO_DIFF_SNAPSHOT_CUSTOM_TYPE = "repo-diff-snapshot";

export type RepoDiffSnapshotKind = "manual" | "session-start";

export interface RepoDiffSnapshotData {
	version: 1;
	commit: string;
	createdAt: string;
	headCommit: string | null;
	kind: RepoDiffSnapshotKind;
	label: string;
	ref: string;
	sourceRef?: string;
	repoRoot: string;
	tree: string;
}

export interface RepoDiffSnapshotRecord {
	data: RepoDiffSnapshotData;
	entryId: string;
	timestamp: string;
}

export interface CreateRepoDiffSnapshotOptions {
	kind?: RepoDiffSnapshotKind;
	label?: string;
	signal?: AbortSignal;
}

function isRepoDiffSnapshotData(value: unknown): value is RepoDiffSnapshotData {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	return (
		data.version === 1 &&
		(data.kind === "manual" || data.kind === "session-start") &&
		typeof data.label === "string" &&
		typeof data.repoRoot === "string" &&
		typeof data.tree === "string" &&
		typeof data.commit === "string" &&
		typeof data.ref === "string" &&
		typeof data.createdAt === "string" &&
		(typeof data.headCommit === "string" || data.headCommit === null) &&
		(data.sourceRef === undefined || typeof data.sourceRef === "string")
	);
}

function isRepoDiffSnapshotEntry(
	entry: CustomEntry,
): entry is CustomEntry<RepoDiffSnapshotData> & { data: RepoDiffSnapshotData } {
	return entry.customType === REPO_DIFF_SNAPSHOT_CUSTOM_TYPE && isRepoDiffSnapshotData(entry.data);
}

function normalizeSnapshotLabel(label: string | undefined, kind: RepoDiffSnapshotKind): string {
	const trimmed = label?.trim();
	if (trimmed) return trimmed;
	return kind === "session-start" ? "session-start" : "manual";
}

type SnapshotMetadata = Pick<RepoDiffSnapshotData, "commit" | "headCommit" | "ref" | "repoRoot" | "sourceRef" | "tree">;

function appendRepoDiffSnapshotRecord(
	sessionManager: SessionManager,
	snapshot: SnapshotMetadata,
	kind: RepoDiffSnapshotKind,
	label: string,
): RepoDiffSnapshotRecord {
	const data: RepoDiffSnapshotData = {
		version: 1,
		commit: snapshot.commit,
		createdAt: new Date().toISOString(),
		headCommit: snapshot.headCommit,
		kind,
		label,
		ref: snapshot.ref,
		...(snapshot.sourceRef ? { sourceRef: snapshot.sourceRef } : {}),
		repoRoot: snapshot.repoRoot,
		tree: snapshot.tree,
	};
	const entryId = sessionManager.appendCustomEntry(REPO_DIFF_SNAPSHOT_CUSTOM_TYPE, data);
	return { data, entryId, timestamp: data.createdAt };
}
export function getRepoDiffSnapshots(sessionManager: SessionManager, repoRoot?: string): RepoDiffSnapshotRecord[] {
	const records: RepoDiffSnapshotRecord[] = [];
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "custom" || !isRepoDiffSnapshotEntry(entry)) continue;
		if (repoRoot && entry.data.repoRoot !== repoRoot) continue;
		records.push({ data: entry.data, entryId: entry.id, timestamp: entry.timestamp });
	}
	return records;
}

async function resolveSnapshotRepoRoots(cwds: readonly string[]): Promise<string[]> {
	const repoRoots: string[] = [];
	const seen = new Set<string>();
	for (const cwd of cwds) {
		const repoRoot = await git.repo.root(cwd);
		if (!repoRoot || seen.has(repoRoot)) continue;
		seen.add(repoRoot);
		repoRoots.push(repoRoot);
	}
	return repoRoots;
}

export async function createRepoDiffSnapshot(
	sessionManager: SessionManager,
	cwd: string,
	options: CreateRepoDiffSnapshotOptions = {},
): Promise<RepoDiffSnapshotRecord | null> {
	const kind = options.kind ?? "manual";
	const label = normalizeSnapshotLabel(options.label, kind);
	const snapshot = await git.snapshot.create(cwd, { label, signal: options.signal });
	if (!snapshot) return null;
	return appendRepoDiffSnapshotRecord(sessionManager, snapshot, kind, label);
}

export async function createRepoDiffSnapshotAt(
	sessionManager: SessionManager,
	repoRoot: string,
	ref?: string,
	options: CreateRepoDiffSnapshotOptions = {},
): Promise<RepoDiffSnapshotRecord | null> {
	const targetPath = resolveToCwd(repoRoot, sessionManager.getCwd());
	const repository = await git.repo.resolve(targetPath);
	if (!repository) {
		throw new Error(`Repository is not a Git repository: ${targetPath}.`);
	}
	const resolvedRepoRoot = repository.repoRoot;
	const kind = options.kind ?? "manual";
	const label = normalizeSnapshotLabel(options.label, kind);
	const trimmedRef = ref?.trim();
	if (ref !== undefined && !trimmedRef) {
		throw new Error("Git ref cannot be empty.");
	}
	if (!trimmedRef) {
		return createRepoDiffSnapshot(sessionManager, resolvedRepoRoot, { ...options, kind, label });
	}
	const snapshot = await git.snapshot.resolveRef(resolvedRepoRoot, trimmedRef, {
		label,
		signal: options.signal,
	});
	return appendRepoDiffSnapshotRecord(sessionManager, snapshot, kind, label);
}

export async function createRepoDiffSnapshots(
	sessionManager: SessionManager,
	cwds: readonly string[],
	options: CreateRepoDiffSnapshotOptions = {},
): Promise<RepoDiffSnapshotRecord[]> {
	const repoRoots = await resolveSnapshotRepoRoots(cwds);
	const snapshots: RepoDiffSnapshotRecord[] = [];
	for (const repoRoot of repoRoots) {
		const snapshot = await createRepoDiffSnapshot(sessionManager, repoRoot, options);
		if (snapshot) snapshots.push(snapshot);
	}
	return snapshots;
}

export async function createRepoDiffSnapshotsForKnownRepositories(
	sessionManager: SessionManager,
	preferredCwds: readonly string[],
	options: CreateRepoDiffSnapshotOptions = {},
): Promise<RepoDiffSnapshotRecord[]> {
	const preferredRepoRoots = await resolveSnapshotRepoRoots(preferredCwds);
	const knownRepoRoots = getRepoDiffSnapshots(sessionManager).map(record => record.data.repoRoot);
	return createRepoDiffSnapshots(sessionManager, [...preferredRepoRoots, ...knownRepoRoots], options);
}

export async function ensureSessionStartRepoDiffSnapshot(
	sessionManager: SessionManager,
	cwd: string,
	options: Pick<CreateRepoDiffSnapshotOptions, "signal"> & { force?: boolean } = {},
): Promise<RepoDiffSnapshotRecord | null> {
	const repoRoot = await git.repo.root(cwd);
	if (!repoRoot) return null;
	if (!options.force) {
		const existing = getRepoDiffSnapshots(sessionManager, repoRoot).find(
			record => record.data.kind === "session-start",
		);
		if (existing) return existing;
	}
	return createRepoDiffSnapshot(sessionManager, repoRoot, {
		kind: "session-start",
		label: "session-start",
		signal: options.signal,
	});
}

export async function ensureSessionStartRepoDiffSnapshots(
	sessionManager: SessionManager,
	cwds: readonly string[],
	options: Pick<CreateRepoDiffSnapshotOptions, "signal"> & { force?: boolean } = {},
): Promise<RepoDiffSnapshotRecord[]> {
	const repoRoots = await resolveSnapshotRepoRoots(cwds);
	const snapshots: RepoDiffSnapshotRecord[] = [];
	for (const repoRoot of repoRoots) {
		const snapshot = await ensureSessionStartRepoDiffSnapshot(sessionManager, repoRoot, options);
		if (snapshot) snapshots.push(snapshot);
	}
	return snapshots;
}

async function resolveSnapshotRepoRoot(snapshot: RepoDiffSnapshotRecord, signal?: AbortSignal): Promise<string> {
	const repoRoot = await git.repo.root(snapshot.data.repoRoot, signal);
	if (!repoRoot) {
		throw new Error(`Snapshot repository is not available: ${snapshot.data.repoRoot}.`);
	}
	if (repoRoot !== snapshot.data.repoRoot) {
		throw new Error(`Snapshot repository root changed: ${snapshot.data.repoRoot} resolves to ${repoRoot}.`);
	}
	return repoRoot;
}

export async function diffRepoFromSnapshot(
	snapshot: RepoDiffSnapshotRecord,
	options: git.SnapshotDiffOptions = {},
): Promise<string> {
	const repoRoot = await resolveSnapshotRepoRoot(snapshot, options.signal);
	return git.snapshot.diff(repoRoot, snapshot.data.tree, options);
}

export async function diffRepoBetweenSnapshots(
	baseSnapshot: RepoDiffSnapshotRecord,
	headSnapshot: RepoDiffSnapshotRecord,
	options: git.SnapshotDiffOptions = {},
): Promise<string> {
	if (baseSnapshot.data.repoRoot !== headSnapshot.data.repoRoot) {
		throw new Error(
			`Snapshot comparison crosses repositories: ${baseSnapshot.data.repoRoot} vs ${headSnapshot.data.repoRoot}.`,
		);
	}
	const repoRoot = await resolveSnapshotRepoRoot(baseSnapshot, options.signal);
	return git.diff(repoRoot, {
		base: baseSnapshot.data.tree,
		head: headSnapshot.data.tree,
		nameOnly: options.nameOnly,
		signal: options.signal,
		stat: options.stat,
	});
}

export function isDefaultRepoDiffSnapshotSelector(selector: string | undefined): boolean {
	const normalized = selector?.trim();
	return (
		!normalized ||
		normalized === "latest" ||
		normalized === "last" ||
		normalized === "session" ||
		normalized === "session-start" ||
		normalized === "start"
	);
}

export function selectRepoDiffSnapshot(
	snapshots: readonly RepoDiffSnapshotRecord[],
	selector: string | undefined,
): RepoDiffSnapshotRecord | null {
	if (snapshots.length === 0) return null;
	const normalized = selector?.trim();
	if (!normalized || normalized === "latest" || normalized === "last") return snapshots[snapshots.length - 1] ?? null;
	if (normalized === "session" || normalized === "session-start" || normalized === "start") {
		return snapshots.findLast(snapshot => snapshot.data.kind === "session-start") ?? null;
	}
	return (
		snapshots.find(snapshot => snapshot.entryId === normalized) ??
		snapshots.find(snapshot => snapshot.entryId.startsWith(normalized)) ??
		snapshots.find(snapshot => snapshot.data.label === normalized) ??
		snapshots.find(snapshot => snapshot.data.label.toLowerCase() === normalized.toLowerCase()) ??
		null
	);
}

export function selectRepoDiffSnapshotForActiveRepo(
	snapshots: readonly RepoDiffSnapshotRecord[],
	selector: string | undefined,
	activeRepoRoot: string | null | undefined,
): RepoDiffSnapshotRecord | null {
	const selectableSnapshots =
		activeRepoRoot && isDefaultRepoDiffSnapshotSelector(selector)
			? snapshots.filter(snapshot => snapshot.data.repoRoot === activeRepoRoot)
			: snapshots;
	return selectRepoDiffSnapshot(selectableSnapshots, selector);
}
