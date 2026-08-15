import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// cancel_subagent routes a detached background subagent's run signal through
// the normal abort path (AsyncJobManager.cancel aborts the job's
// AbortController), so the subagent finalizes aborted instead of running to
// completion. Idempotent: unknown/already-finished subagents and jobs owned by
// another agent are no-ops.
describe("AgentSession.cancelSubagent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let manager: AsyncJobManager;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-cancel-subagent-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			agentId: "Main",
			asyncJobManager: manager,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		AsyncJobManager.resetForTests();
		tempDir.removeSync();
	});

	/** Register a task job whose id/agentId is `id`, owned by `ownerId` ("Main" unless overridden). */
	function registerTaskJob(id: string, ownerId = "Main"): string {
		return manager.register(
			"task",
			id,
			async ({ signal }) => {
				await new Promise<void>((resolve) => {
					if (signal.aborted) {
						resolve();
						return;
					}
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return "done";
			},
			{ id, ownerId, agentId: id },
		);
	}

	it("cancels a running background subagent owned by this session's agent", () => {
		const jobId = registerTaskJob("agent-1");
		const job = manager.getJob(jobId)!;
		expect(job.status).toBe("running");
		expect(job.abortController.signal.aborted).toBe(false);

		const cancelled = session!.cancelSubagent("agent-1");

		expect(cancelled).toBe(true);
		expect(manager.getJob(jobId)?.status).toBe("cancelled");
		expect(manager.getJob(jobId)?.abortController.signal.aborted).toBe(true);
	});

	it("is an idempotent no-op for an unknown subagent", () => {
		expect(session!.cancelSubagent("ghost-agent")).toBe(false);
		expect(manager.getRunningJobs()).toHaveLength(0);
	});

	it("does not cancel a job owned by a different agent", () => {
		const jobId = registerTaskJob("agent-2", "OtherAgent");
		expect(session!.cancelSubagent("agent-2")).toBe(false);
		expect(manager.getJob(jobId)?.status).toBe("running");
		expect(manager.getJob(jobId)?.abortController.signal.aborted).toBe(false);
	});
});
