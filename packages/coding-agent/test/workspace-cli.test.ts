import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createDefaultWorkspaceCliService,
	createWorkspaceCliService,
	type WorkspaceBranchPublication,
	type WorkspaceCliService,
	type WorkspacePublishContract,
	type WorkspacePublisher,
	type WorkspaceRegistryRecord,
	type WorkspaceRegistryStore,
} from "@oh-my-pi/pi-coding-agent/cli/workspace-cli";
import { WorkspaceBindingRegistry } from "@oh-my-pi/pi-coding-agent/session/workspace-binding";

const NOW = "2026-07-04T12:00:00.000Z";
const createdRoots: string[] = [];

afterEach(async () => {
	await Promise.all(createdRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	createdRoots.push(root);
	return root;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} exited ${exitCode}`);
	}
	return stdout.trim();
}

async function makeGitWorkspace(): Promise<string> {
	const root = await makeTempRoot("omp-workspace-cli-");
	const workspaceRoot = path.join(root, "workspace");
	await fs.mkdir(workspaceRoot, { recursive: true });
	await runGit(workspaceRoot, ["init", "-b", "main"]);
	await fs.writeFile(path.join(workspaceRoot, "README.md"), "# workspace\n");
	await runGit(workspaceRoot, ["add", "README.md"]);
	await runGit(workspaceRoot, ["-c", "user.name=OMP Test", "-c", "user.email=omp@example.invalid", "commit", "-m", "init"]);
	return workspaceRoot;
}


function workspace(overrides: Partial<WorkspaceRegistryRecord> & Pick<WorkspaceRegistryRecord, "id">): WorkspaceRegistryRecord {
	return {
		id: overrides.id,
		rootPath: `/tmp/omp-workspaces/${overrides.id}`,
		ownerAgentId: "Main",
		ownerDisplayName: "Main",
		status: "idle",
		branchName: `agent/${overrides.id}`,
		createdAt: "2026-07-04T10:00:00.000Z",
		updatedAt: "2026-07-04T10:05:00.000Z",
		...overrides,
	};
}

function cloneWorkspace(record: WorkspaceRegistryRecord): WorkspaceRegistryRecord {
	return {
		...record,
		publication: record.publication ? { ...record.publication } : undefined,
	};
}

class FakeWorkspaceRegistry implements WorkspaceRegistryStore {
	#records: WorkspaceRegistryRecord[];
	readonly discardedIds: string[] = [];

	constructor(records: WorkspaceRegistryRecord[]) {
		this.#records = records.map(cloneWorkspace);
	}

	listWorkspaces(): WorkspaceRegistryRecord[] {
		return this.#records.map(cloneWorkspace);
	}

	getWorkspace(id: string): WorkspaceRegistryRecord | undefined {
		const found = this.#records.find(record => record.id === id);
		return found ? cloneWorkspace(found) : undefined;
	}

	discardWorkspace(id: string): WorkspaceRegistryRecord | undefined {
		const index = this.#records.findIndex(record => record.id === id);
		if (index === -1) return undefined;
		const [removed] = this.#records.splice(index, 1);
		this.discardedIds.push(id);
		return cloneWorkspace(removed);
	}

	markPublished(id: string, publication: WorkspaceBranchPublication): WorkspaceRegistryRecord | undefined {
		const record = this.#records.find(candidate => candidate.id === id);
		if (!record) return undefined;
		record.status = "published";
		record.publication = { ...publication };
		record.updatedAt = publication.publishedAt;
		return cloneWorkspace(record);
	}
}

class FakeWorkspacePublisher implements WorkspacePublisher {
	readonly publishedBranches: Array<{ workspaceId: string; branchName: string }> = [];

	async publishBranch(
		workspaceRecord: WorkspaceRegistryRecord,
		contract: WorkspacePublishContract,
	): Promise<WorkspaceBranchPublication> {
		if (contract.kind !== "branch") {
			throw new Error(`unsupported publish contract kind: ${contract.kind}`);
		}
		this.publishedBranches.push({ workspaceId: workspaceRecord.id, branchName: contract.branchName });
		return {
			kind: "branch",
			branchName: contract.branchName,
			commitSha: `commit-${workspaceRecord.id}`,
			publishedAt: NOW,
		};
	}
}

function makeService(records: WorkspaceRegistryRecord[]): {
	service: WorkspaceCliService;
	registry: FakeWorkspaceRegistry;
	publisher: FakeWorkspacePublisher;
} {
	const registry = new FakeWorkspaceRegistry(records);
	const publisher = new FakeWorkspacePublisher();
	return {
		service: createWorkspaceCliService({ registry, publisher, now: () => NOW }),
		registry,
		publisher,
	};
}

describe("workspace CLI service JSON views", () => {
	it("lists workspaces using the registry-backed JSON contract", async () => {
		const { service } = makeService([
			workspace({
				id: "ws-main",
				rootPath: "/repo/.omp/workspaces/ws-main",
				ownerAgentId: "Main",
				ownerDisplayName: "Main agent",
				status: "running",
				branchName: "agent/main-workspace",
				createdAt: "2026-07-04T10:00:00.000Z",
				updatedAt: "2026-07-04T10:30:00.000Z",
			}),
			workspace({
				id: "ws-worker",
				rootPath: "/repo/.omp/workspaces/ws-worker",
				ownerAgentId: "Worker",
				ownerDisplayName: "Worker subagent",
				status: "parked",
				branchName: "agent/worker-workspace",
				createdAt: "2026-07-04T10:01:00.000Z",
				updatedAt: "2026-07-04T10:20:00.000Z",
				publication: {
					kind: "branch",
					branchName: "workspace/worker-ready",
					commitSha: "abc1234",
					publishedAt: "2026-07-04T10:21:00.000Z",
				},
			}),
		]);

		await expect(service.list({ json: true })).resolves.toEqual({
			workspaces: [
				{
					id: "ws-main",
					rootPath: "/repo/.omp/workspaces/ws-main",
					owner: { id: "Main", displayName: "Main agent" },
					status: "running",
					branchName: "agent/main-workspace",
					publication: null,
					createdAt: "2026-07-04T10:00:00.000Z",
					updatedAt: "2026-07-04T10:30:00.000Z",
				},
				{
					id: "ws-worker",
					rootPath: "/repo/.omp/workspaces/ws-worker",
					owner: { id: "Worker", displayName: "Worker subagent" },
					status: "parked",
					branchName: "agent/worker-workspace",
					publication: {
						kind: "branch",
						branchName: "workspace/worker-ready",
						commitSha: "abc1234",
						publishedAt: "2026-07-04T10:21:00.000Z",
					},
					createdAt: "2026-07-04T10:01:00.000Z",
					updatedAt: "2026-07-04T10:20:00.000Z",
				},
			],
		});
	});

	it("returns status for one workspace with the same JSON field names as list", async () => {
		const { service } = makeService([
			workspace({
				id: "ws-review",
				rootPath: "/repo/.omp/workspaces/ws-review",
				ownerAgentId: "ReviewAgent",
				ownerDisplayName: "Review agent",
				status: "idle",
				branchName: "agent/review-workspace",
				createdAt: "2026-07-04T11:00:00.000Z",
				updatedAt: "2026-07-04T11:15:00.000Z",
			}),
		]);

		await expect(service.status({ id: "ws-review", json: true })).resolves.toEqual({
			workspace: {
				id: "ws-review",
				rootPath: "/repo/.omp/workspaces/ws-review",
				owner: { id: "ReviewAgent", displayName: "Review agent" },
				status: "idle",
				branchName: "agent/review-workspace",
				publication: null,
				createdAt: "2026-07-04T11:00:00.000Z",
				updatedAt: "2026-07-04T11:15:00.000Z",
			},
		});
	});
});

describe("workspace CLI service ownership guardrails", () => {
	it("refuses to discard unknown or unowned workspaces without mutating the registry", async () => {
		const cases = [
			{
				name: "unknown workspace",
				id: "ws-missing",
				expected: {
					ok: false,
					code: "workspace_not_found",
					message: "Workspace ws-missing does not exist.",
				},
			},
			{
				name: "workspace owned by another agent",
				id: "ws-worker",
				expected: {
					ok: false,
					code: "workspace_not_owned",
					message: "Workspace ws-worker is owned by Worker, not Main.",
				},
			},
		];

		for (const testCase of cases) {
			const { service, registry } = makeService([
				workspace({ id: "ws-main", ownerAgentId: "Main", ownerDisplayName: "Main", status: "idle" }),
				workspace({ id: "ws-worker", ownerAgentId: "Worker", ownerDisplayName: "Worker", status: "parked" }),
			]);
			const before = registry.listWorkspaces();

			await expect(service.discard({ id: testCase.id, requesterAgentId: "Main" })).resolves.toEqual(
				testCase.expected,
			);

			expect(registry.discardedIds, testCase.name).toEqual([]);
			expect(registry.listWorkspaces(), testCase.name).toEqual(before);
		}
	});

	it("cleanup removes only requester-owned workspaces whose status is explicitly cleanupable", async () => {
		const { service, registry } = makeService([
			workspace({ id: "ws-running", ownerAgentId: "Main", ownerDisplayName: "Main", status: "running" }),
			workspace({ id: "ws-idle", ownerAgentId: "Main", ownerDisplayName: "Main", status: "idle" }),
			workspace({ id: "ws-parked", ownerAgentId: "Main", ownerDisplayName: "Main", status: "parked" }),
			workspace({ id: "ws-worker", ownerAgentId: "Worker", ownerDisplayName: "Worker", status: "parked" }),
		]);

		await expect(
			service.cleanup({ requesterAgentId: "Main", statuses: ["idle", "parked"], dryRun: false }),
		).resolves.toEqual({
			removed: [
				{ id: "ws-idle", status: "idle", rootPath: "/tmp/omp-workspaces/ws-idle" },
				{ id: "ws-parked", status: "parked", rootPath: "/tmp/omp-workspaces/ws-parked" },
			],
			kept: [
				{ id: "ws-running", status: "running", reason: "status_not_cleanupable" },
				{ id: "ws-worker", status: "parked", reason: "workspace_not_owned", ownerAgentId: "Worker" },
			],
		});
		expect(registry.discardedIds).toEqual(["ws-idle", "ws-parked"]);
		expect(registry.listWorkspaces().map(record => record.id)).toEqual(["ws-running", "ws-worker"]);
	});
});

describe("workspace CLI service publish contract", () => {
	it("requires an explicit branch publish contract before creating a branch", async () => {
		const { service, registry, publisher } = makeService([
			workspace({ id: "ws-ready", ownerAgentId: "Main", ownerDisplayName: "Main", status: "idle" }),
		]);

		await expect(service.publish({ id: "ws-ready", requesterAgentId: "Main" })).resolves.toEqual({
			ok: false,
			code: "publish_contract_required",
			message: "Publishing workspace ws-ready requires an explicit branch contract.",
		});
		expect(publisher.publishedBranches).toEqual([]);
		expect(registry.getWorkspace("ws-ready")?.publication).toBeUndefined();

		await expect(
			service.publish({
				id: "ws-ready",
				requesterAgentId: "Main",
				contract: { kind: "branch", branchName: "workspace/ws-ready-review" },
			}),
		).resolves.toEqual({
			ok: true,
			workspaceId: "ws-ready",
			branchName: "workspace/ws-ready-review",
			commitSha: "commit-ws-ready",
			publishedAt: NOW,
		});
		expect(publisher.publishedBranches).toEqual([
			{ workspaceId: "ws-ready", branchName: "workspace/ws-ready-review" },
		]);
		expect(registry.getWorkspace("ws-ready")?.publication).toEqual({
			kind: "branch",
			branchName: "workspace/ws-ready-review",
			commitSha: "commit-ws-ready",
			publishedAt: NOW,
		});
	});
});

describe("default workspace CLI service", () => {
	it("uses the persisted binding registry and publishes a Git branch", async () => {
		const workspaceRoot = await makeGitWorkspace();
		const agentDir = await makeTempRoot("omp-workspace-registry-");
		const registry = new WorkspaceBindingRegistry({ agentDir });
		await registry.register({
			sessionId: "ws-real",
			sessionFile: path.join(agentDir, "sessions", "ws-real.jsonl"),
			workspaceRoot,
			agentId: "Main",
			status: "idle",
			createdAt: "2026-07-04T10:00:00.000Z",
			lastSeenAt: "2026-07-04T10:05:00.000Z",
		});

		const service = createDefaultWorkspaceCliService({ registry, now: () => NOW });
		const headSha = await runGit(workspaceRoot, ["rev-parse", "HEAD"]);

		await expect(service.list({ json: true })).resolves.toEqual({
			workspaces: [
				{
					id: "ws-real",
					rootPath: workspaceRoot,
					owner: { id: "Main", displayName: "Main" },
					status: "idle",
					branchName: "main",
					publication: null,
					createdAt: "2026-07-04T10:00:00.000Z",
					updatedAt: "2026-07-04T10:05:00.000Z",
				},
			],
		});

		await expect(
			service.publish({
				id: "ws-real",
				requesterAgentId: "Main",
				contract: { kind: "branch", branchName: "workspace/ws-real-review" },
			}),
		).resolves.toEqual({
			ok: true,
			workspaceId: "ws-real",
			branchName: "workspace/ws-real-review",
			commitSha: headSha,
			publishedAt: NOW,
		});
		expect(await runGit(workspaceRoot, ["rev-parse", "workspace/ws-real-review"])).toBe(headSha);
		expect((await registry.lookupBySessionId("ws-real"))?.publication).toEqual({
			kind: "branch",
			branchName: "workspace/ws-real-review",
			commitSha: headSha,
			publishedAt: NOW,
		});
	});
});
