import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AsyncJobManager singleton across concurrent top-level sessions", () => {
	const tempDirs: string[] = [];
	// Building a ModelRegistry per session is the dominant cost here: createAgentSession
	// otherwise runs discoverAuthStorage (a fresh AuthStorage DB create+reload) and a
	// background online model refresh for every spawn (~450ms each). The singleton
	// ownership behavior under test is independent of model resolution, so we hand every
	// session one shared, network-free registry built once (~10ms/session instead).
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-async-singleton-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedTempDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedTempDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedTempDir);
	});

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
		AsyncJobManager.resetForTests();
	});

	async function spawnTopLevelSession(extraSettings?: Record<string, unknown>, extensions: ExtensionFactory[] = []) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-singleton-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated({ "bash.autoBackground.enabled": true, ...(extraSettings ?? {}) }),
			disableExtensionDiscovery: true,
			extensions,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
		});
		return session;
	}

	it("keeps the primary session's manager installed after a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			const secondary = await spawnTopLevelSession();
			try {
				// While the secondary is alive the global instance MUST still point at
				// the primary's manager so background tools keep delivering completions
				// to the primary session that owns them.
				expect(AsyncJobManager.instance()).toBe(primaryManager);
			} finally {
				await secondary.dispose();
			}

			// After the secondary disposes, the primary's manager MUST still be the
			// reachable singleton — otherwise the `task` async path errors with
			// "Async execution is enabled but no async job manager is available".
			expect(AsyncJobManager.instance()).toBe(primaryManager);
		} finally {
			await primary.dispose();
		}

		// Once the owning primary session disposes the singleton clears, matching
		// the documented single-owner invariant.
		expect(AsyncJobManager.instance()).toBeUndefined();
	}, 60000);

	it("advertises available harness-pushed progress surfaces under Tool Policy", async () => {
		const session = await spawnTopLevelSession({ "async.enabled": true });
		try {
			const systemPrompt = session.systemPrompt.join("\n\n");
			const toolPolicyIndex = systemPrompt.indexOf("§ Tool Policy");
			const progressIndex = systemPrompt.indexOf("<async-progress>");
			const workflowIndex = systemPrompt.indexOf("§ Workflow");
			expect(toolPolicyIndex).toBeGreaterThanOrEqual(0);
			expect(progressIndex).toBeGreaterThan(toolPolicyIndex);
			expect(progressIndex).toBeLessThan(workflowIndex);
			expect(systemPrompt).toContain("<async-progress>");
			expect(systemPrompt).toContain(
				'Potentially slow finite commands → `bash` with `async: "auto"`; simple known-fast commands omit `async`.',
			);
			expect(systemPrompt).toContain('Use `progress: "wake"` only when pre-exit output may change the next action.');
			expect(systemPrompt).not.toContain("200 ms batches");
			expect(systemPrompt).not.toContain("10-event burst");
			expect(systemPrompt).not.toContain("Every fifth progress update");
			expect(systemPrompt).toContain("Repeated non-actionable progress → NEVER narrate or echo each event.");
			expect(systemPrompt).toContain(
				"Transient burst? Ignore it and await completion. Sustained/chatty? Reduce source verbosity.",
			);
			expect(systemPrompt).toContain("Safe restart? Stop/cancel; relaunch with native quiet/warning-only flags.");
			expect(systemPrompt).toContain("Retune its monitor to `ambient` or `off`.");
			expect(systemPrompt).toContain("Unsafe restart? Let it finish silently.");
			expect(systemPrompt).toContain(
				'Actionable process output → `hub`, `progress: "wake"` (`op: "start"` new; `op: "monitor"` existing).',
			);
			expect(systemPrompt).toContain(
				"NEVER call `hub wait`, follow logs, or block to receive progress or keep the turn alive; use async progress and end the turn instead.",
			);
			expect(systemPrompt).toContain("</async-progress>");
		} finally {
			await session.dispose();
		}
	}, 60000);

	it("advertises only Hub progress when async Bash is disabled", async () => {
		const session = await spawnTopLevelSession({ "async.enabled": false });
		try {
			const systemPrompt = session.systemPrompt.join("\n\n");
			expect(systemPrompt).toContain("<async-progress>");
			expect(systemPrompt).not.toContain("finite commands");
			expect(systemPrompt).not.toContain('`bash` with `async: "auto"`');
			expect(systemPrompt).toContain("Unsafe restart? Let it finish silently.");
			expect(systemPrompt).toContain("Actionable process output");
			expect(systemPrompt).toContain("Transient burst? Ignore it and await completion.");
			expect(systemPrompt).toContain("Repeated non-actionable progress → NEVER narrate or echo each event.");
			expect(systemPrompt).toContain("Retune its monitor");
		} finally {
			await session.dispose();
		}
	}, 60000);

	it("omits push guidance when neither progress surface is available", async () => {
		const session = await spawnTopLevelSession({ "async.enabled": false, "launch.enabled": false });
		try {
			expect(session.systemPrompt.join("\n\n")).not.toContain("<async-progress>");
		} finally {
			await session.dispose();
		}
	}, 60000);

	function overrideBuiltinExtension(name: "bash" | "hub"): ExtensionFactory {
		return pi => {
			pi.registerTool({
				name,
				label: `Custom ${name}`,
				description: `Custom ${name} replacement without async progress parameters.`,
				parameters: type({}),
				approval: "read",
				async execute() {
					return { content: [{ type: "text" as const, text: "custom" }] };
				},
			});
		};
	}

	it("drops async Bash guidance when an extension replaces the built-in bash tool", async () => {
		const session = await spawnTopLevelSession({ "async.enabled": true }, [overrideBuiltinExtension("bash")]);
		try {
			const systemPrompt = session.systemPrompt.join("\n\n");
			// The custom `bash` keeps the name but not the built-in's async/progress
			// schema, so the prompt must not instruct async:"auto"/progress for it.
			expect(systemPrompt).not.toContain('`bash` with `async: "auto"`');
			expect(systemPrompt).not.toContain("finite commands");
			// Hub guidance is unaffected by the bash override.
			expect(systemPrompt).toContain("<async-progress>");
			expect(systemPrompt).toContain("Actionable process output");
		} finally {
			await session.dispose();
		}
	}, 60000);

	it("drops Hub progress guidance when an extension replaces the built-in hub tool", async () => {
		const session = await spawnTopLevelSession({ "async.enabled": true }, [overrideBuiltinExtension("hub")]);
		try {
			const systemPrompt = session.systemPrompt.join("\n\n");
			expect(systemPrompt).not.toContain("Actionable process output");
			expect(systemPrompt).not.toContain("Retune its monitor");
			// Bash guidance is unaffected by the hub override.
			expect(systemPrompt).toContain("<async-progress>");
			expect(systemPrompt).toContain('`bash` with `async: "auto"`');
		} finally {
			await session.dispose();
		}
	}, 60000);

	it("does not cancel the primary session's running jobs when a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			// Register a long-running job on the primary's manager under the
			// MAIN_AGENT_ID owner — the same owner the secondary would inherit by
			// default. The secondary's dispose-time `cancelOwnAsyncJobs` must NOT
			// cancel this job (issue #1923).
			const release = Promise.withResolvers<string>();
			const jobId = primaryManager!.register(
				"bash",
				"sleep",
				async ({ signal }) => {
					const aborted = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await Promise.race([release.promise, aborted.promise]);
					return signal.aborted ? "aborted" : "completed";
				},
				{ ownerId: "Main" },
			);
			expect(primary.getAsyncJobSnapshot()?.running.some(job => job.id === jobId)).toBe(true);

			const secondary = await spawnTopLevelSession();
			try {
				expect(secondary.getAsyncJobSnapshot()).toBeNull();
			} finally {
				await secondary.dispose();
			}

			const job = primaryManager!.getJob(jobId);
			expect(job?.status).toBe("running");

			release.resolve("done");
			await primaryManager!.waitForAll();
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("exposes the owning session's jobs through a production extension context", async () => {
		let observedSnapshot: AsyncJobSnapshot | null | undefined;
		const snapshotExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "capture_async_job_snapshot",
				label: "Capture async job snapshot",
				description: "Capture the session-owned async job snapshot for this test.",
				parameters: type({}),
				approval: "read",
				async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
					observedSnapshot = ctx.getAsyncJobSnapshot();
					return { content: [{ type: "text", text: "captured" }] };
				},
			});
		};
		const session = await spawnTopLevelSession(undefined, [snapshotExtension]);
		const manager = AsyncJobManager.instance();
		expect(manager).toBeDefined();
		const release = Promise.withResolvers<string>();
		const jobId = manager!.register("bash", "extension snapshot test", async () => release.promise, {
			ownerId: "Main",
		});

		try {
			const snapshotTool = session.getToolByName("capture_async_job_snapshot");
			expect(snapshotTool).toBeDefined();
			await snapshotTool!.execute("call-snapshot", {});

			expect(observedSnapshot?.running.some(job => job.id === jobId)).toBe(true);
		} finally {
			release.resolve("done");
			await manager!.waitForAll();
			await session.dispose();
		}
	}, 60000);

	it("refuses async bash from a secondary session instead of routing it to the primary's manager", async () => {
		const primary = await spawnTopLevelSession({ "async.enabled": true });
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();
			const primaryJobCountBefore = primaryManager!.getAllJobs().length;

			const secondary = await spawnTopLevelSession({ "async.enabled": true });
			try {
				const bashTool = secondary.getToolByName("bash");
				expect(bashTool).toBeDefined();
				await expect(bashTool!.execute("call-1", { command: "echo hi", async: true })).rejects.toThrow(
					/Async job manager unavailable/,
				);
			} finally {
				await secondary.dispose();
			}

			// The secondary's failed async attempt must not have leaked a job into
			// the primary's manager.
			expect(primaryManager!.getAllJobs().length).toBe(primaryJobCountBefore);
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("clears a manager installed before a top-level session startup failure takes ownership", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-startup-failure-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				settings: Settings.isolated({ "bash.autoBackground.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry: sharedModelRegistry,
				systemPrompt: () => {
					throw new Error("forced startup failure");
				},
			}),
		).rejects.toThrow("forced startup failure");

		expect(AsyncJobManager.instance()).toBeUndefined();

		const replacement = await spawnTopLevelSession();
		try {
			expect(AsyncJobManager.instance()).toBeDefined();
			expect(replacement.getAsyncJobSnapshot()).not.toBeNull();
		} finally {
			await replacement.dispose();
		}
	}, 60000);
});
