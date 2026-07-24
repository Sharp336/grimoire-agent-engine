import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ExtensionRunner,
	loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type CustomTool, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type {
	AgentDefinition,
	ExternalTaskExecutor,
	SingleResult,
	TaskParams,
} from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type } from "arktype";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const managers: AsyncJobManager[] = [];

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	managers.push(manager);
	return manager;
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function createSession(options: {
	executor?: ExternalTaskExecutor;
	manager?: AsyncJobManager;
	settings?: Record<string, unknown>;
	taskDepth?: number;
	spawns?: string | boolean | null;
} = {}): ToolSession {
	return {
		cwd: "/tmp/external-task-cwd",
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.batch": false,
			"task.isolation.mode": "none",
			...options.settings,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		getAgentId: () => "Parent",
		taskDepth: options.taskDepth,
		externalTaskExecutor: options.executor,
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [taskAgent],
		projectAgentsDir: null,
	});
}

function makeNativeResult(id: string, output = "native output"): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "native task",
		assignment: "native assignment",
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	mockDiscovery();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("Task external recipe executor", () => {
	it("keeps native Task identity, schema, and execution unchanged without an executor", async () => {
		let nativeCalls = 0;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			nativeCalls += 1;
			return makeNativeResult(options.id ?? "native");
		});
		const tool = await TaskTool.create(createSession());
		const wire = toolWireSchema(tool) as { properties?: Record<string, unknown>; anyOf?: unknown };

		expect(tool.name).toBe("task");
		expect(tool.label).toBe("Task");
		expect(wire.properties?.task).toBeDefined();
		expect(wire.anyOf).toBeUndefined();

		const result = await tool.execute("native-call", { task: "Do native work." });
		expect(nativeCalls).toBe(1);
		expect(result.details?.results[0]?.agent).toBe("task");
		expect(firstText(result)).toContain("native output");
	});

	it("exposes a discriminated recipe schema and routes one item through the registered executor", async () => {
		let request: Parameters<ExternalTaskExecutor["start"]>[0] | undefined;
		const executor: ExternalTaskExecutor = {
			discriminator: "recipe",
			async start(input) {
				request = input;
				await input.onProgress({ message: "external progress" });
				return {
					result: Promise.resolve({ output: "external output", exitCode: 0 }),
					abort() {},
				};
			},
		};
		const tool = await TaskTool.create(createSession({ executor }));
		const wire = toolWireSchema(tool) as {
			anyOf?: Array<{ properties?: Record<string, unknown>; required?: string[] }>;
		};
		expect(wire.anyOf?.some(branch => branch.properties?.recipe !== undefined)).toBe(true);
		expect(wire.anyOf?.some(branch => branch.properties?.agent !== undefined)).toBe(true);
		expect(tool.description).toContain("Hub send/park/revive");

		const updates: string[] = [];
		const result = await tool.execute(
			"recipe-call",
			{ recipe: "release-check", task: "Run the release checks." },
			undefined,
			update => {
				updates.push(firstText(update));
			},
		);

		expect(request?.recipe).toBe("release-check");
		expect(request?.assignment).toBe("Run the release checks.");
		expect(request?.context).toBeUndefined();
		expect(request?.cwd).toBe("/tmp/external-task-cwd");
		expect(request?.signal).toBeInstanceOf(AbortSignal);
		expect(updates).toContain("external progress");
		expect(result.details?.results[0]).toMatchObject({ agent: "recipe", output: "external output", exitCode: 0 });
		expect(firstText(result)).toContain("external output");
	});

	it("fans out a mixed native/recipe batch concurrently and preserves input ordering", async () => {
		const started: string[] = [];
		let active = 0;
		let maxActive = 0;
		const release = Promise.withResolvers<void>();
		const enter = async (kind: string) => {
			started.push(kind);
			active += 1;
			maxActive = Math.max(maxActive, active);
			if (started.length === 2) release.resolve();
			await release.promise;
			active -= 1;
		};
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await enter("native");
			return makeNativeResult(options.id ?? "native", "native mixed output");
		});
		const executor: ExternalTaskExecutor = {
			discriminator: "recipe",
			start(input) {
				return {
					result: (async () => {
						await enter("recipe");
						expect(input.context).toBe("shared context");
						return { output: "recipe mixed output", exitCode: 0 };
					})(),
					abort() {},
				};
			},
		};
		const tool = await TaskTool.create(
			createSession({ executor, settings: { "task.batch": true, "task.maxConcurrency": 2 } }),
		);
		const result = await tool.execute("mixed-call", {
			context: "shared context",
			tasks: [
				{ name: "Native", agent: "task", task: "Do native work." },
				{ name: "Recipe", recipe: "external-work", task: "Do external work." },
			],
		} as TaskParams);

		expect(started.sort()).toEqual(["native", "recipe"]);
		expect(maxActive).toBe(2);
		expect(result.details?.results.map(item => item.id)).toEqual(["Native", "Recipe"]);
		expect(result.details?.results.map(item => item.output)).toEqual([
			"native mixed output",
			"recipe mixed output",
		]);
	});

	it("propagates cancellation to abort() and does not settle before cleanup completes", async () => {
		const started = Promise.withResolvers<void>();
		const cleanupStarted = Promise.withResolvers<void>();
		const releaseCleanup = Promise.withResolvers<void>();
		const neverSettles = Promise.withResolvers<never>();
		let abortCalled = false;
		let cleanupComplete = false;
		let capturedSignal: AbortSignal | undefined;
		const executor: ExternalTaskExecutor = {
			discriminator: "recipe",
			start(input) {
				capturedSignal = input.signal;
				started.resolve();
				return {
					result: neverSettles.promise,
					async abort() {
						abortCalled = true;
						cleanupStarted.resolve();
						await releaseCleanup.promise;
						cleanupComplete = true;
					},
				};
			},
		};
		const tool = await TaskTool.create(createSession({ executor }));
		const controller = new AbortController();
		const pending = tool.execute(
			"cancel-call",
			{ recipe: "long-running", task: "Wait until cancelled." },
			controller.signal,
		);
		await started.promise;
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		controller.abort(new Error("cancelled by test"));
		await cleanupStarted.promise;
		expect(settled).toBe(false);
		expect(cleanupComplete).toBe(false);
		releaseCleanup.resolve();
		const result = await pending;

		expect(capturedSignal?.aborted).toBe(true);
		expect(abortCalled).toBe(true);
		expect(cleanupComplete).toBe(true);
		expect(result.details?.results[0]).toMatchObject({ aborted: true, abortReason: "cancelled by test" });
	});

	it("keeps external jobs in Task async lifecycle without claiming Hub agent parity", async () => {
		const executor: ExternalTaskExecutor = {
			discriminator: "recipe",
			start() {
				return {
					result: Promise.resolve({ output: "async external output", exitCode: 0 }),
					abort() {},
				};
			},
		};
		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ executor, manager, settings: { "async.enabled": true } }),
		);
		const result = await tool.execute("async-recipe", {
			name: "ExternalJob",
			recipe: "async-work",
			task: "Run externally.",
		});
		const text = firstText(result);
		expect(text).toContain("do not support Hub send, park, or revive");
		expect(text).not.toContain("DM `ExternalJob`");
		const job = manager.getJob("ExternalJob");
		expect(job).toBeDefined();
		await job!.promise;
		expect(job!.status).toBe("completed");
	});

	it("fails clearly for absent executors, mutual exclusivity, model overrides, and typed schemas", async () => {
		const absent = await TaskTool.create(createSession());
		expect(firstText(await absent.execute("absent", { recipe: "missing", task: "Work." }))).toContain(
			"no external Task executor is registered",
		);
		expect(absent.parameters({ recipe: "missing", task: "Work." }) instanceof type.errors).toBe(true);
		const absentBatch = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const absentBatchParams = {
			context: "shared",
			tasks: [{ recipe: "missing", task: "Work." }],
		};
		expect(absentBatch.parameters(absentBatchParams) instanceof type.errors).toBe(true);
		expect(firstText(await absentBatch.execute("absent-batch", absentBatchParams))).toContain(
			"no external Task executor is registered",
		);

		let starts = 0;
		const executor: ExternalTaskExecutor = {
			discriminator: "recipe",
			start() {
				starts += 1;
				return { result: Promise.resolve({ output: "unexpected", exitCode: 0 }), abort() {} };
			},
		};
		const tool = await TaskTool.create(createSession({ executor }));
		const cases: Array<{ params: TaskParams; message: string }> = [
			{ params: { agent: "task", recipe: "r", task: "Work." }, message: "cannot set both `agent` and `recipe`" },
			{ params: { recipe: "r", task: "Work.", model: "p/m" }, message: "model overrides are not supported" },
			{
				params: { recipe: "r", task: "Work.", outputSchema: { type: "object" } },
				message: "typed output schemas are not supported",
			},
			{
				params: { recipe: "r", task: "Work.", schemaMode: "strict" },
				message: "typed output schemas are not supported",
			},
		];
		const batchTool = await TaskTool.create(createSession({ executor, settings: { "task.batch": true } }));
		for (const unsupported of [
			{ model: "p/m" },
			{ outputSchema: { type: "object" } },
			{ schemaMode: "strict" as const },
			{ isolated: true },
		]) {
			expect(
				batchTool.parameters({
					context: "shared",
					tasks: [{ recipe: "r", task: "Work.", ...unsupported }],
				}) instanceof type.errors,
			).toBe(true);
		}
		for (const [index, testCase] of cases.entries()) {
			expect(firstText(await tool.execute(`unsupported-${index}`, testCase.params))).toContain(testCase.message);
		}
		expect(starts).toBe(0);
	});

	it("blocks recipe execution at the parent's max task depth like native spawns", async () => {
		let starts = 0;
		const executor: ExternalTaskExecutor = {
			discriminator: "recipe",
			start() {
				starts += 1;
				return { result: Promise.resolve({ output: "unexpected", exitCode: 0 }), abort() {} };
			},
		};
		const tool = await TaskTool.create(createSession({ executor, taskDepth: 2 }));
		const result = await tool.execute("depth-blocked", { recipe: "r", task: "Work." });
		expect(firstText(result)).toContain("Cannot spawn another agent at task depth 2");
		expect(starts).toBe(0);
	});

	it("blocks recipe execution when the parent's spawns are disabled", async () => {
		let starts = 0;
		const executor: ExternalTaskExecutor = {
			discriminator: "recipe",
			start() {
				starts += 1;
				return { result: Promise.resolve({ output: "unexpected", exitCode: 0 }), abort() {} };
			},
		};
		const tool = await TaskTool.create(createSession({ executor, spawns: false }));
		const result = await tool.execute("spawns-disabled", { recipe: "r", task: "Work." });
		expect(firstText(result)).toContain("Cannot spawn 'recipe'. Allowed: none (spawns disabled for this agent)");
		expect(starts).toBe(0);
	});

	it("blocks recipe execution when the parent's spawn allowlist excludes recipe", async () => {
		let starts = 0;
		const executor: ExternalTaskExecutor = {
			discriminator: "recipe",
			start() {
				starts += 1;
				return { result: Promise.resolve({ output: "unexpected", exitCode: 0 }), abort() {} };
			},
		};
		const tool = await TaskTool.create(createSession({ executor, spawns: "scout,task" }));
		const result = await tool.execute("allowlist-blocked", { recipe: "r", task: "Work." });
		expect(firstText(result)).toContain("Cannot spawn 'recipe'. Allowed: scout,task");
		expect(starts).toBe(0);
	});

	it("blocks a batch recipe item at async preflight under the same containment gate", async () => {
		let starts = 0;
		const executor: ExternalTaskExecutor = {
			discriminator: "recipe",
			start() {
				starts += 1;
				return { result: Promise.resolve({ output: "unexpected", exitCode: 0 }), abort() {} };
			},
		};
		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				executor,
				manager,
				spawns: false,
				settings: { "async.enabled": true, "task.batch": true },
			}),
		);
		const result = await tool.execute("batch-depth-blocked", {
			context: "shared",
			tasks: [{ recipe: "r", task: "Work." }],
		} as TaskParams);
		expect(firstText(result)).toContain("Cannot spawn 'recipe'. Allowed: none (spawns disabled for this agent)");
		expect(starts).toBe(0);
	});

	it("settles within the bounded cleanup window when executor.start() never settles", async () => {
		vi.useFakeTimers();
		try {
			const startCalled = Promise.withResolvers<void>();
			const executor: ExternalTaskExecutor = {
				discriminator: "recipe",
				async start() {
					startCalled.resolve();
					return await new Promise<never>(() => {});
				},
			};
			const tool = await TaskTool.create(createSession({ executor }));
			const controller = new AbortController();
			const pending = tool.execute(
				"stuck-start",
				{ recipe: "hung-start", task: "Wait." },
				controller.signal,
			);
			await startCalled.promise;
			controller.abort(new Error("cancelled during hung start"));
			// Lets `requestAbort`'s wait for the already-resolved `startInvoked`
			// gate settle so its bounded wait on the (never-settling) `start()`
			// promise is actually constructed before the clock advances past it.
			await flushMicrotasks();
			vi.advanceTimersByTime(5000); // EXTERNAL_TASK_ABORT_CLEANUP_TIMEOUT_MS
			const result = await pending;
			expect(result.details?.results[0]).toMatchObject({
				aborted: true,
				abortReason: "cancelled during hung start",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts a still-starting executor once start() eventually produces a handle", async () => {
		const startCalled = Promise.withResolvers<void>();
		const releaseStart = Promise.withResolvers<void>();
		let abortCalled = false;
		const executor: ExternalTaskExecutor = {
			discriminator: "recipe",
			async start() {
				startCalled.resolve();
				await releaseStart.promise;
				return {
					result: new Promise<never>(() => {}),
					async abort() {
						abortCalled = true;
					},
				};
			},
		};
		const tool = await TaskTool.create(createSession({ executor }));
		const controller = new AbortController();
		const pending = tool.execute(
			"slow-start",
			{ recipe: "slow-start", task: "Wait." },
			controller.signal,
		);
		await startCalled.promise;
		controller.abort(new Error("cancelled during start"));
		// `start()` is still awaiting `releaseStart` — nothing to abort yet, and
		// this check runs before any microtask could have produced a handle.
		expect(abortCalled).toBe(false);
		releaseStart.resolve();
		const result = await pending;
		expect(abortCalled).toBe(true);
		expect(result.details?.results[0]).toMatchObject({
			aborted: true,
			abortReason: "cancelled during start",
		});
	});

	it("applies task.maxRuntimeMs as a wall-clock bound for external recipe execution", async () => {
		vi.useFakeTimers();
		try {
			let abortCalled = false;
			const executor: ExternalTaskExecutor = {
				discriminator: "recipe",
				start() {
					return {
						result: new Promise<never>(() => {}),
						async abort() {
							abortCalled = true;
						},
					};
				},
			};
			const tool = await TaskTool.create(createSession({ executor, settings: { "task.maxRuntimeMs": 50 } }));
			const pending = tool.execute("runtime-capped", { recipe: "slow-work", task: "Run forever." });
			// Lets execution reach the synchronous `setTimeout(..., 50)` call
			// (past the async `outputManager.allocate()` step) before the clock
			// advances past it.
			await flushMicrotasks();
			vi.advanceTimersByTime(50);
			const result = await pending;
			expect(abortCalled).toBe(true);
			expect(result.details?.results[0]?.aborted).toBe(true);
			expect(result.details?.results[0]?.abortReason).toContain("runtime limit exceeded");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("extension registration plumbing", () => {
	const executor: ExternalTaskExecutor = {
		discriminator: "recipe",
		start() {
			return { result: Promise.resolve({ output: "registered output", exitCode: 0 }), abort() {} };
		},
	};

	it("registers one executor without registering a task tool and rejects duplicate registrations", async () => {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			api => api.registerTaskExecutor(executor),
			"/tmp",
			new EventBus(),
			runtime,
			"one-executor",
		);
		expect(extension.externalTaskExecutor?.executor).toBe(executor);
		expect(extension.tools.has("task")).toBe(false);

		await expect(
			loadExtensionFromFactory(
				api => {
					api.registerTaskExecutor(executor);
					api.registerTaskExecutor(executor);
				},
				"/tmp",
				new EventBus(),
				runtime,
				"duplicate-in-one-extension",
			),
		).rejects.toThrow("registered more than one external Task executor");
	});

	it("rejects duplicate executors across extensions without load-order precedence", async () => {
		const runtime = new ExtensionRuntime();
		const first = await loadExtensionFromFactory(
			api => api.registerTaskExecutor(executor),
			"/tmp",
			new EventBus(),
			runtime,
			"first-extension",
		);
		const second = await loadExtensionFromFactory(
			api => api.registerTaskExecutor(executor),
			"/tmp",
			new EventBus(),
			runtime,
			"second-extension",
		);
		const runner = new ExtensionRunner(
			[first, second],
			runtime,
			"/tmp",
			{} as never,
			{} as never,
		);
		expect(() => runner.getExternalTaskExecutor()).toThrow(
			'Multiple external Task executors registered for discriminator "recipe"',
		);
	});

	it("keeps the native task tool when an extension also registers a tool named task", async () => {
		using tempDir = TempDir.createSync("@omp-external-task-sdk-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		let replacementCalls = 0;
		let session: AgentSession | undefined;
		try {
			const created = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(),
				modelRegistry,
				settings: Settings.isolated({
					"async.enabled": false,
					"task.batch": false,
					"task.isolation.mode": "none",
					"tools.approvalMode": "yolo",
				}),
				extensions: [api => {
					api.registerTaskExecutor(executor);
					api.registerTool({
						name: "task",
						description: "must not replace native Task",
						label: "Replacement task",
						parameters: api.zod.object({ task: api.zod.string() }),
						async execute() {
							replacementCalls += 1;
							return { content: [{ type: "text", text: "replacement tool ran" }] };
						},
					});
				}],
				enableLsp: false,
				enableMCP: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
			});
			session = created.session;
			const task = session.getToolByName("task");
			expect(task?.name).toBe("task");
			expect(task?.label).toBe("Task");
			const result = await task!.execute("sdk-recipe", {
				recipe: "registered",
				task: "Use the registered executor.",
			} as never);
			expect(firstText(result)).toContain("registered output");
			expect(firstText(result)).not.toContain("replacement tool ran");
			expect(replacementCalls).toBe(0);
		} finally {
			await session?.dispose();
			authStorage.close();
		}
	}, 20_000);

	it("keeps the native task tool when an SDK customTools entry is also named task", async () => {
		using tempDir = TempDir.createSync("@omp-external-task-sdk-customtools-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		let replacementCalls = 0;
		let session: AgentSession | undefined;
		const replacementTool = {
			name: "task",
			label: "Replacement task",
			description: "must not replace native Task",
			parameters: type({ task: "string" }),
			async execute() {
				replacementCalls += 1;
				return { content: [{ type: "text", text: "replacement tool ran" }] };
			},
		} satisfies CustomTool;
		try {
			const created = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(),
				modelRegistry,
				settings: Settings.isolated({
					"async.enabled": false,
					"task.batch": false,
					"task.isolation.mode": "none",
					"tools.approvalMode": "yolo",
				}),
				extensions: [api => api.registerTaskExecutor(executor)],
				customTools: [replacementTool],
				enableLsp: false,
				enableMCP: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
			});
			session = created.session;
			const task = session.getToolByName("task");
			expect(task?.name).toBe("task");
			expect(task?.label).toBe("Task");
			const result = await task!.execute("sdk-recipe-customtools", {
				recipe: "registered",
				task: "Use the registered executor.",
			} as never);
			expect(firstText(result)).toContain("registered output");
			expect(firstText(result)).not.toContain("replacement tool ran");
			expect(replacementCalls).toBe(0);
		} finally {
			await session?.dispose();
			authStorage.close();
		}
	}, 20_000);
});
