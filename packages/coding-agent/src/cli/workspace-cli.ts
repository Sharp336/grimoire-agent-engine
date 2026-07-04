import {
	WorkspaceBindingRegistry,
	type WorkspaceBinding,
	type WorkspaceBindingPublication,
} from "../session/workspace-binding";

/**
 * Workspace CLI service.
 *
 * The service is intentionally registry-backed and dependency-injected: the CLI
 * layer can render commands, while tests and future runtime wiring provide the
 * authoritative workspace registry and publisher implementations.
 */

type Awaitable<T> = T | Promise<T>;

export type WorkspaceStatus = "running" | "idle" | "parked" | "published" | (string & {});

export interface WorkspaceBranchPublication {
	kind: "branch";
	branchName: string;
	commitSha: string;
	publishedAt: string;
}

export interface WorkspacePublishContract {
	kind: "branch" | (string & {});
	branchName: string;
}

export interface WorkspaceRegistryRecord {
	id: string;
	rootPath: string;
	ownerAgentId: string;
	ownerDisplayName: string;
	status: WorkspaceStatus;
	branchName: string;
	createdAt: string;
	updatedAt: string;
	publication?: WorkspaceBranchPublication;
}

export interface WorkspaceRegistryStore {
	listWorkspaces(): Awaitable<WorkspaceRegistryRecord[]>;
	getWorkspace(id: string): Awaitable<WorkspaceRegistryRecord | undefined>;
	discardWorkspace(id: string): Awaitable<WorkspaceRegistryRecord | undefined>;
	markPublished(
		id: string,
		publication: WorkspaceBranchPublication,
	): Awaitable<WorkspaceRegistryRecord | undefined>;
}

export interface WorkspacePublisher {
	publishBranch(
		workspaceRecord: WorkspaceRegistryRecord,
		contract: WorkspacePublishContract,
	): Promise<WorkspaceBranchPublication>;
}

export interface WorkspaceOwnerView {
	id: string;
	displayName: string;
}

export interface WorkspaceJsonView {
	id: string;
	rootPath: string;
	owner: WorkspaceOwnerView;
	status: WorkspaceStatus;
	branchName: string;
	publication: WorkspaceBranchPublication | null;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceListOptions {
	json?: boolean;
}

export interface WorkspaceListResult {
	workspaces: WorkspaceJsonView[];
}

export interface WorkspaceStatusOptions {
	id: string;
	json?: boolean;
}

export type WorkspaceStatusResult = { workspace: WorkspaceJsonView } | WorkspaceCliError;

export interface WorkspaceDiscardOptions {
	id: string;
	requesterAgentId: string;
}

export interface WorkspaceCleanupOptions {
	requesterAgentId: string;
	statuses: WorkspaceStatus[];
	dryRun?: boolean;
}

export interface WorkspacePublishOptions {
	id: string;
	requesterAgentId: string;
	contract?: WorkspacePublishContract;
}

export type WorkspaceCliErrorCode =
	| "workspace_id_required"
	| "workspace_not_found"
	| "workspace_not_owned"
	| "publish_contract_required"
	| "workspace_publish_failed"
	| "workspace_registry_update_failed"
	| "workspace_registry_unavailable";

export interface WorkspaceCliError {
	ok: false;
	code: WorkspaceCliErrorCode;
	message: string;
}

export interface WorkspaceCleanupRemoved {
	id: string;
	status: WorkspaceStatus;
	rootPath: string;
}

export type WorkspaceCleanupKept =
	| {
			id: string;
			status: WorkspaceStatus;
			reason: "status_not_cleanupable";
	  }
	| {
			id: string;
			status: WorkspaceStatus;
			reason: "workspace_not_owned";
			ownerAgentId: string;
	  };

export interface WorkspaceCleanupResult {
	removed: WorkspaceCleanupRemoved[];
	kept: WorkspaceCleanupKept[];
}

export type WorkspaceDiscardResult =
	| WorkspaceCliError
	| {
			ok: true;
			removed: WorkspaceCleanupRemoved;
	  };

export type WorkspacePublishResult =
	| WorkspaceCliError
	| {
			ok: true;
			workspaceId: string;
			branchName: string;
			commitSha: string;
			publishedAt: string;
	  };

export interface WorkspaceCliService {
	list(options?: WorkspaceListOptions): Promise<WorkspaceListResult>;
	status(options: WorkspaceStatusOptions): Promise<WorkspaceStatusResult>;
	discard(options: WorkspaceDiscardOptions): Promise<WorkspaceDiscardResult>;
	cleanup(options: WorkspaceCleanupOptions): Promise<WorkspaceCleanupResult>;
	publish(options: WorkspacePublishOptions): Promise<WorkspacePublishResult>;
}

export interface CreateWorkspaceCliServiceOptions {
	registry: WorkspaceRegistryStore;
	publisher: WorkspacePublisher;
	now?: () => string;
}

export type WorkspaceAction = "list" | "status" | "discard" | "cleanup" | "publish";

export interface WorkspaceCommandArgs {
	action: WorkspaceAction;
	id?: string;
	requesterAgentId?: string;
	statuses?: WorkspaceStatus[];
	dryRun?: boolean;
	json?: boolean;
	contract?: WorkspacePublishContract;
}

export type WorkspaceCommandResult =
	| WorkspaceListResult
	| WorkspaceStatusResult
	| WorkspaceDiscardResult
	| WorkspaceCleanupResult
	| WorkspacePublishResult;

export interface RunWorkspaceCommandOptions {
	service?: WorkspaceCliService;
	stdout?: Pick<typeof console, "log">;
	stderr?: Pick<typeof console, "error">;
}

const DEFAULT_CLEANUP_STATUSES: WorkspaceStatus[] = ["idle", "parked"];
const DEFAULT_REQUESTER_AGENT_ID = "Main";

export function createWorkspaceCliService(options: CreateWorkspaceCliServiceOptions): WorkspaceCliService {
	return {
		async list(_options = {}) {
			const records = await options.registry.listWorkspaces();
			return { workspaces: records.map(toWorkspaceJsonView) };
		},

		async status(statusOptions) {
			const record = await options.registry.getWorkspace(statusOptions.id);
			if (!record) return workspaceNotFound(statusOptions.id);
			return { workspace: toWorkspaceJsonView(record) };
		},

		async discard(discardOptions) {
			const record = await options.registry.getWorkspace(discardOptions.id);
			const guard = guardWorkspaceOwner(record, discardOptions.id, discardOptions.requesterAgentId);
			if (guard) return guard;

			const removed = await options.registry.discardWorkspace(discardOptions.id);
			if (!removed) return workspaceNotFound(discardOptions.id);
			return {
				ok: true,
				removed: toCleanupRemoved(removed),
			};
		},

		async cleanup(cleanupOptions) {
			const cleanupableStatuses = new Set(cleanupOptions.statuses);
			const removed: WorkspaceCleanupRemoved[] = [];
			const kept: WorkspaceCleanupKept[] = [];
			const records = await options.registry.listWorkspaces();

			for (const record of records) {
				if (record.ownerAgentId !== cleanupOptions.requesterAgentId) {
					kept.push({
						id: record.id,
						status: record.status,
						reason: "workspace_not_owned",
						ownerAgentId: record.ownerAgentId,
					});
					continue;
				}

				if (!cleanupableStatuses.has(record.status)) {
					kept.push({ id: record.id, status: record.status, reason: "status_not_cleanupable" });
					continue;
				}

				if (!cleanupOptions.dryRun) {
					const discarded = await options.registry.discardWorkspace(record.id);
					if (!discarded) {
						kept.push({ id: record.id, status: record.status, reason: "status_not_cleanupable" });
						continue;
					}
				}
				removed.push(toCleanupRemoved(record));
			}

			return { removed, kept };
		},

		async publish(publishOptions) {
			const record = await options.registry.getWorkspace(publishOptions.id);
			const guard = guardWorkspaceOwner(record, publishOptions.id, publishOptions.requesterAgentId);
			if (guard) return guard;

			const contract = publishOptions.contract;
			if (!isExplicitBranchContract(contract)) {
				return {
					ok: false,
					code: "publish_contract_required",
					message: `Publishing workspace ${publishOptions.id} requires an explicit branch contract.`,
				};
			}

			let publication: WorkspaceBranchPublication;
			try {
				publication = await options.publisher.publishBranch(record, contract);
			} catch (error) {
				return {
					ok: false,
					code: "workspace_publish_failed",
					message: `Publishing workspace ${publishOptions.id} failed: ${stringifyError(error)}`,
				};
			}

			const updated = await options.registry.markPublished(publishOptions.id, publication);
			if (!updated) {
				return {
					ok: false,
					code: "workspace_registry_update_failed",
					message: `Published workspace ${publishOptions.id}, but the registry could not be updated.`,
				};
			}

			return {
				ok: true,
				workspaceId: publishOptions.id,
				branchName: publication.branchName,
				commitSha: publication.commitSha,
				publishedAt: publication.publishedAt,
			};
		},
	};
}

export interface CreateDefaultWorkspaceCliServiceOptions {
	registry?: WorkspaceBindingRegistry;
	now?: () => string;
}

export function createDefaultWorkspaceCliService(
	options: CreateDefaultWorkspaceCliServiceOptions = {},
): WorkspaceCliService {
	const registry = options.registry ?? new WorkspaceBindingRegistry();
	return createWorkspaceCliService({
		registry: new WorkspaceBindingRegistryStoreAdapter(registry),
		publisher: new GitWorkspacePublisher(options.now),
		now: options.now,
	});
}

class WorkspaceBindingRegistryStoreAdapter implements WorkspaceRegistryStore {
	constructor(private readonly registry: WorkspaceBindingRegistry) {}

	async listWorkspaces(): Promise<WorkspaceRegistryRecord[]> {
		const bindings = await this.registry.listBindings();
		return Promise.all(bindings.map(binding => bindingToWorkspaceRecord(binding)));
	}

	async getWorkspace(id: string): Promise<WorkspaceRegistryRecord | undefined> {
		const binding = await this.registry.lookupBySessionId(id);
		return binding ? bindingToWorkspaceRecord(binding) : undefined;
	}

	async discardWorkspace(id: string): Promise<WorkspaceRegistryRecord | undefined> {
		const binding = await this.registry.remove(id);
		return binding ? bindingToWorkspaceRecord(binding) : undefined;
	}

	async markPublished(
		id: string,
		publication: WorkspaceBranchPublication,
	): Promise<WorkspaceRegistryRecord | undefined> {
		const binding = await this.registry.markPublished(id, publication);
		return binding ? bindingToWorkspaceRecord(binding) : undefined;
	}
}

class GitWorkspacePublisher implements WorkspacePublisher {
	constructor(private readonly now: (() => string) | undefined) {}

	async publishBranch(
		workspaceRecord: WorkspaceRegistryRecord,
		contract: WorkspacePublishContract,
	): Promise<WorkspaceBranchPublication> {
		if (contract.kind !== "branch") {
			throw new Error(`unsupported publish contract kind: ${contract.kind}`);
		}

		await runGit(workspaceRecord.rootPath, ["branch", "--", contract.branchName, "HEAD"]);
		const commitSha = await runGit(workspaceRecord.rootPath, ["rev-parse", "HEAD"]);
		return {
			kind: "branch",
			branchName: contract.branchName,
			commitSha,
			publishedAt: this.now?.() ?? new Date().toISOString(),
		};
	}
}

async function bindingToWorkspaceRecord(binding: WorkspaceBinding): Promise<WorkspaceRegistryRecord> {
	return {
		id: binding.sessionId,
		rootPath: binding.workspaceRoot,
		ownerAgentId: binding.agentId ?? "Main",
		ownerDisplayName: binding.agentId ?? "Main",
		status: binding.status,
		branchName: await currentBranchName(binding.workspaceRoot),
		createdAt: binding.createdAt,
		updatedAt: binding.lastSeenAt,
		publication: binding.publication ? toWorkspacePublication(binding.publication) : undefined,
	};
}

function toWorkspacePublication(publication: WorkspaceBindingPublication): WorkspaceBranchPublication {
	return {
		kind: "branch",
		branchName: publication.branchName,
		commitSha: publication.commitSha,
		publishedAt: publication.publishedAt,
	};
}

async function currentBranchName(workspaceRoot: string): Promise<string> {
	try {
		const branchName = await runGit(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
		return branchName.length > 0 ? branchName : "(unknown)";
	} catch {
		return "(unknown)";
	}
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		const detail = stderr.trim() || stdout.trim() || `git ${args.join(" ")} exited ${exitCode}`;
		throw new Error(detail);
	}
	return stdout.trim();
}

export async function runWorkspaceCommand(
	cmd: WorkspaceCommandArgs,
	options: RunWorkspaceCommandOptions = {},
): Promise<WorkspaceCommandResult | WorkspaceCliError> {
	const stdout = options.stdout ?? console;
	const stderr = options.stderr ?? console;
	const service = options.service;

	if (!service) {
		const error = workspaceRegistryUnavailable();
		emitWorkspaceResult(error, { json: cmd.json ?? false, stdout, stderr });
		process.exitCode = 1;
		return error;
	}

	let result: WorkspaceCommandResult | WorkspaceCliError;
	switch (cmd.action) {
		case "list":
			result = await service.list({ json: cmd.json });
			break;
		case "status":
			if (!cmd.id) {
				result = workspaceIdRequired("status");
				break;
			}
			result = await service.status({ id: cmd.id, json: cmd.json });
			break;
		case "discard":
			if (!cmd.id) {
				result = workspaceIdRequired("discard");
				break;
			}
			result = await service.discard({
				id: cmd.id,
				requesterAgentId: cmd.requesterAgentId ?? DEFAULT_REQUESTER_AGENT_ID,
			});
			break;
		case "cleanup":
			result = await service.cleanup({
				requesterAgentId: cmd.requesterAgentId ?? DEFAULT_REQUESTER_AGENT_ID,
				statuses: cmd.statuses?.length ? cmd.statuses : DEFAULT_CLEANUP_STATUSES,
				dryRun: cmd.dryRun ?? false,
			});
			break;
		case "publish":
			if (!cmd.id) {
				result = workspaceIdRequired("publish");
				break;
			}
			result = await service.publish({
				id: cmd.id,
				requesterAgentId: cmd.requesterAgentId ?? DEFAULT_REQUESTER_AGENT_ID,
				contract: cmd.contract,
			});
			break;
	}

	emitWorkspaceResult(result, { json: cmd.json ?? false, stdout, stderr, dryRun: cmd.dryRun ?? false });
	if (isWorkspaceCliError(result)) process.exitCode = 1;
	return result;
}

function toWorkspaceJsonView(record: WorkspaceRegistryRecord): WorkspaceJsonView {
	return {
		id: record.id,
		rootPath: record.rootPath,
		owner: {
			id: record.ownerAgentId,
			displayName: record.ownerDisplayName || record.ownerAgentId,
		},
		status: record.status,
		branchName: record.branchName,
		publication: record.publication ? { ...record.publication } : null,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

function toCleanupRemoved(record: WorkspaceRegistryRecord): WorkspaceCleanupRemoved {
	return { id: record.id, status: record.status, rootPath: record.rootPath };
}

function workspaceNotFound(id: string): WorkspaceCliError {
	return {
		ok: false,
		code: "workspace_not_found",
		message: `Workspace ${id} does not exist.`,
	};
}

function workspaceNotOwned(
	id: string,
	ownerAgentId: string,
	requesterAgentId: string,
): WorkspaceCliError {
	return {
		ok: false,
		code: "workspace_not_owned",
		message: `Workspace ${id} is owned by ${ownerAgentId}, not ${requesterAgentId}.`,
	};
}

function workspaceIdRequired(action: WorkspaceAction): WorkspaceCliError {
	return {
		ok: false,
		code: "workspace_id_required",
		message: `Workspace id is required for workspace ${action}.`,
	};
}

function workspaceRegistryUnavailable(): WorkspaceCliError {
	return {
		ok: false,
		code: "workspace_registry_unavailable",
		message: "Workspace registry is not available to this CLI command yet.",
	};
}

function guardWorkspaceOwner(
	record: WorkspaceRegistryRecord | undefined,
	id: string,
	requesterAgentId: string,
): WorkspaceCliError | undefined {
	if (!record) return workspaceNotFound(id);
	if (record.ownerAgentId !== requesterAgentId) return workspaceNotOwned(id, record.ownerAgentId, requesterAgentId);
	return undefined;
}

function isExplicitBranchContract(contract: WorkspacePublishOptions["contract"]): contract is WorkspacePublishContract {
	return contract?.kind === "branch" && typeof contract.branchName === "string" && contract.branchName.length > 0;
}

function isWorkspaceCliError(result: WorkspaceCommandResult | WorkspaceCliError): result is WorkspaceCliError {
	return typeof result === "object" && result !== null && "ok" in result && result.ok === false;
}

function emitWorkspaceResult(
	result: WorkspaceCommandResult | WorkspaceCliError,
	options: {
		json: boolean;
		stdout: Pick<typeof console, "log">;
		stderr: Pick<typeof console, "error">;
		dryRun?: boolean;
	},
): void {
	if (options.json) {
		options.stdout.log(JSON.stringify(result, null, 2));
		return;
	}

	if (isWorkspaceCliError(result)) {
		options.stderr.error(`error: ${result.message}`);
		return;
	}

	if ("workspaces" in result) {
		emitWorkspaceList(result, options.stdout);
		return;
	}
	if ("workspace" in result) {
		emitWorkspaceList({ workspaces: [result.workspace] }, options.stdout);
		return;
	}
	if ("removed" in result && "kept" in result) {
		emitCleanup(result, options.stdout, options.dryRun ?? false);
		return;
	}
	if ("removed" in result) {
		options.stdout.log(`removed ${result.removed.id} (${result.removed.status}) ${result.removed.rootPath}`);
		return;
	}
	if ("workspaceId" in result) {
		options.stdout.log(
			`published ${result.workspaceId} as branch ${result.branchName} at ${result.commitSha} (${result.publishedAt})`,
		);
	}
}

function emitWorkspaceList(result: WorkspaceListResult, stdout: Pick<typeof console, "log">): void {
	if (result.workspaces.length === 0) {
		stdout.log("No workspaces registered.");
		return;
	}
	for (const workspace of result.workspaces) {
		const publication = workspace.publication ? ` published:${workspace.publication.branchName}` : "";
		stdout.log(
			`${workspace.id}\t${workspace.status}\t${workspace.owner.id}\t${workspace.branchName}\t${workspace.rootPath}${publication}`,
		);
	}
}

function emitCleanup(result: WorkspaceCleanupResult, stdout: Pick<typeof console, "log">, dryRun: boolean): void {
	const verb = dryRun ? "would remove" : "removed";
	for (const removed of result.removed) stdout.log(`${verb} ${removed.id} (${removed.status}) ${removed.rootPath}`);
	for (const kept of result.kept) stdout.log(`kept ${kept.id} (${kept.status}) ${kept.reason}`);
	stdout.log(`${result.removed.length} ${verb}; ${result.kept.length} kept`);
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
