import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	artifactsDirsFromRegistry,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as planHandoff from "@oh-my-pi/pi-coding-agent/plan-mode/plan-handoff";
import { runWithRemoteRuntime } from "@oh-my-pi/pi-coding-agent/remote-runtime/scope";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import {
	buildStructuredSubagentRecoveryHint,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	type StructuredSubagentBackendContext,
	StructuredSubagentError,
	type StructuredSubagentRequest,
	type StructuredSubagentResult,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "ast_grep"],
	output: { type: "object", properties: { agent: { type: "boolean" } } },
};

function session(
	options: {
		planMode?: boolean;
		outputSchema?: unknown;
		maxDepth?: number;
		isolationMode?: "none" | "worktree";
		isolationApply?: boolean;
		modelRoles?: Record<string, string>;
	} = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		outputSchema: options.outputSchema,
		settings: Settings.isolated({
			"task.maxRecursionDepth": options.maxDepth ?? 2,
			"task.isolation.mode": options.isolationMode ?? "none",
			"task.enableLsp": true,
			...(options.modelRoles ? { modelRoles: options.modelRoles } : {}),
			...(options.isolationApply !== undefined ? { "task.isolation.apply": options.isolationApply } : {}),
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getPlanModeState: () => (options.planMode ? { enabled: true } : undefined),
	} as unknown as ToolSession;
}

function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		...overrides,
	};
}

function result(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: '{"ok":true}',
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function remoteResult(context: StructuredSubagentBackendContext): StructuredSubagentResult {
	const completed = result();
	completed.id = context.request.identity?.id ?? completed.id;
	completed.index = context.request.index ?? 0;
	completed.agent = context.policy.agent.name;
	completed.agentSource = context.policy.agent.source;
	completed.task = context.request.assignment;
	completed.assignment = context.request.assignment;
	completed.output = '{"agent":true}';
	if (context.outputSchema.source !== "none") {
		completed.structuredOutput = {
			source: context.outputSchema.source,
			mode: context.outputSchema.mode,
			status: "valid",
			data: { agent: true },
		};
	}
	return {
		result: completed,
		policy: context.policy,
		mergeSummary: "",
		changesApplied: null,
		artifactsDir: "remote-artifacts",
		temporaryArtifacts: false,
	};
}

function mockDiscovery(agent: AgentDefinition = AGENT): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
});

describe("structured subagent primitive", () => {
	it("uses caller, agent, then session schemas in precedence order", async () => {
		mockDiscovery();
		const callerSchema = { type: "object", properties: { caller: { type: "string" } } };
		const caller = await resolveEffectiveSubagentPolicy(
			request({ outputSchema: callerSchema, schemaMode: "strict" }),
		);
		expect(caller.schema).toEqual({
			schema: callerSchema,
			source: "caller",
			mode: "strict",
			outputSchemaOverridesAgent: true,
		});

		const agent = await resolveEffectiveSubagentPolicy(
			request({ session: session({ outputSchema: { session: true } }) }),
		);
		expect(agent.schema.source).toBe("agent");
		expect(agent.schema.schema).toBe(AGENT.output);

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const inheritedSession = session({ outputSchema: { session: true } });
		inheritedSession.outputSchemaMode = "strict";
		const inherited = await resolveEffectiveSubagentPolicy(request({ session: inheritedSession }));
		expect(inherited.schema).toMatchObject({ source: "session", mode: "strict", outputSchemaOverridesAgent: false });
	});

	it("gives task and eval invocations identical blocked-agent preflight errors", async () => {
		const previous = Bun.env.PI_BLOCKED_AGENT;
		Bun.env.PI_BLOCKED_AGENT = "worker";
		try {
			const discover = vi.spyOn(discoveryModule, "discoverAgents");
			const taskRequest = request();
			const evalRequest = request({ session: taskRequest.session, invocationKind: "eval" });
			const messages: string[] = [];
			for (const candidate of [taskRequest, evalRequest]) {
				try {
					await resolveEffectiveSubagentPolicy(candidate);
				} catch (error) {
					expect(error).toBeInstanceOf(StructuredSubagentError);
					messages.push((error as Error).message);
				}
			}
			expect(messages).toEqual([
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
			]);
			expect(discover).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete Bun.env.PI_BLOCKED_AGENT;
			else Bun.env.PI_BLOCKED_AGENT = previous;
		}
	});

	it("attenuates plan-mode agents and rejects mutable isolation controls before discovery", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ planMode: true }), enableLsp: true, enableIrc: true }),
		);
		expect(policy.effectiveAgent.tools).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(policy.effectiveAgent.spawns).toBeUndefined();
		expect(policy.enableLsp).toBe(false);
		expect(policy.enableIrc).toBe(false);

		vi.restoreAllMocks();
		const discover = vi.spyOn(discoveryModule, "discoverAgents");
		await expect(
			resolveEffectiveSubagentPolicy(
				request({ session: session({ planMode: true }), isolation: { requested: false } }),
			),
		).rejects.toThrow("isolation, apply, and merge controls are unavailable in plan mode");
		expect(discover).not.toHaveBeenCalled();
	});
	it("propagates a custom thinking-suffixed role alias through policy, dispatch, and settlement", async () => {
		const customAgent = { ...AGENT, model: ["@reviewer:high"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return { ...result(), modelRole: options.modelRole };
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, agent: "worker", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBe("reviewer");
		expect(dispatched[0]?.modelRole).toBe("reviewer");
		expect(settled.result.modelRole).toBe("reviewer");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("derives modelRole from the raw selector source in request, override, definition order", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const roleSession = session({
			modelRoles: {
				request: "openai/gpt-4o",
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		roleSession.settings.override("task.agentModelOverrides", { worker: "@override" });

		const requestPolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession, model: "@request" }));
		expect(requestPolicy.modelRole).toBe("request");

		const overridePolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession }));
		expect(overridePolicy.modelRole).toBe("override");

		const concreteOverrideSession = session({
			modelRoles: {
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		concreteOverrideSession.settings.override("task.agentModelOverrides", { worker: "openai/gpt-4o" });
		const concreteOverridePolicy = await resolveEffectiveSubagentPolicy(
			request({ session: concreteOverrideSession }),
		);
		expect(concreteOverridePolicy.modelRole).toBeUndefined();

		const definitionPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ modelRoles: { definition: "openai/gpt-4o" } }) }),
		);
		expect(definitionPolicy.modelRole).toBe("definition");
	});
	it("falls through an empty request selector to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession, model: "" }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("falls through an empty configured override to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });
		childSession.settings.override("task.agentModelOverrides", { worker: "" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});
	it("falls through a configured alias that expands to no patterns", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { empty: "", definition: "openai/gpt-4o" } });
		childSession.settings.override("task.agentModelOverrides", { worker: "@empty" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("does not assign a role when a child uses an explicit model selector", async () => {
		mockDiscovery();
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, model: "openai/gpt-4o", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBeUndefined();
		expect(dispatched[0]?.modelRole).toBeUndefined();
		expect(settled.result.modelRole).toBeUndefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("dispatches remote execution after normalization without touching local artifacts, leases, or executors", async () => {
		const order: string[] = [];
		vi.spyOn(discoveryModule, "discoverAgents").mockImplementation(async () => {
			order.push("discovery");
			return { agents: [AGENT], projectAgentsDir: null };
		});
		const mkdir = vi.spyOn(fs, "mkdir");
		const localRun = vi.spyOn(executorModule, "runSubprocess");
		const isolatedRun = vi.spyOn(isolationRunner, "runIsolatedSubprocess");
		const prepareIsolation = vi.spyOn(isolationRunner, "prepareIsolationContext");
		const loadPlan = vi.spyOn(planHandoff, "loadOverallPlanReference");
		const childSession = session();
		let sessionFileCalls = 0;
		childSession.getSessionFile = () => {
			sessionFileCalls++;
			return null;
		};
		let received: StructuredSubagentBackendContext | undefined;
		const schema = {
			type: "object",
			properties: { agent: { type: "boolean" } },
			required: ["agent"],
			additionalProperties: false,
		};
		const accept = vi.fn();
		const discard = vi.fn();
		const backend = {
			run: async (context: StructuredSubagentBackendContext) => {
				order.push("remote");
				received = context;
				return remoteResult(context);
			},
			accept,
			discard,
		};

		const settled = await runStructuredSubagent(
			request({
				session: childSession,
				assignment: "  Inspect the target.  ",
				context: "  Shared context.  ",
				agent: " worker ",
				outputSchema: schema,
				schemaMode: "strict",
				identity: { label: "  Remote Worker  " },
			}),
			{ execution: "remote", backend },
		);

		expect(order).toEqual(["discovery", "remote"]);
		expect(received?.request).toMatchObject({
			assignment: "Inspect the target.",
			context: "Shared context.",
			agent: "worker",
			schemaMode: "strict",
			identity: { label: "Remote Worker" },
			index: 0,
			isolation: { requested: false, merge: "patch", apply: true },
		});
		expect(received?.outputSchema).toBe(received?.policy.schema);
		expect(received?.outputSchema.schema).toBe(schema);
		expect(settled.result.structuredOutput).toMatchObject({ status: "valid", data: { agent: true } });
		expect(accept).toHaveBeenCalledTimes(1);
		expect(discard).not.toHaveBeenCalled();
		expect(sessionFileCalls).toBe(0);
		expect(childSession.agentOutputManager).toBeUndefined();
		expect(mkdir).not.toHaveBeenCalled();
		expect(loadPlan).not.toHaveBeenCalled();
		expect(prepareIsolation).not.toHaveBeenCalled();
		expect(localRun).not.toHaveBeenCalled();
		expect(isolatedRun).not.toHaveBeenCalled();
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("does not dispatch the remote backend when effective-schema preflight rejects", async () => {
		mockDiscovery();
		const remoteRun = vi.fn(async (context: StructuredSubagentBackendContext) => remoteResult(context));

		await expect(
			runStructuredSubagent(request({ outputSchema: false, schemaMode: "strict" }), {
				execution: "remote",
				backend: { run: remoteRun },
			}),
		).rejects.toThrow("Invalid strict caller output schema");

		expect(remoteRun).not.toHaveBeenCalled();
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("fails closed when remote execution is selected without a backend", async () => {
		mockDiscovery();
		const localRun = vi.spyOn(executorModule, "runSubprocess");
		const isolatedRun = vi.spyOn(isolationRunner, "runIsolatedSubprocess");

		const settled = await runStructuredSubagent(request(), { execution: "remote" });

		expect(settled.result).toMatchObject({
			exitCode: 1,
			error: "Remote structured subagent backend is unavailable.",
		});
		expect(settled.temporaryArtifacts).toBe(false);
		expect(settled.artifactsDir).toBe("");
		expect(localRun).not.toHaveBeenCalled();
		expect(isolatedRun).not.toHaveBeenCalled();
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("converts a rejected remote execution into an error result without local fallback", async () => {
		mockDiscovery();
		const localRun = vi.spyOn(executorModule, "runSubprocess");
		const isolatedRun = vi.spyOn(isolationRunner, "runIsolatedSubprocess");
		const backend = {
			run: async () => {
				throw new Error("remote unavailable");
			},
		};

		const settled = await runStructuredSubagent(request(), { execution: "remote", backend });

		expect(settled.result).toMatchObject({
			exitCode: 1,
			error: "Remote structured subagent execution failed: remote unavailable",
		});
		expect(localRun).not.toHaveBeenCalled();
		expect(isolatedRun).not.toHaveBeenCalled();
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("propagates cancellation to the remote backend and settles as aborted", async () => {
		mockDiscovery();
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const pending = Promise.withResolvers<StructuredSubagentResult>();
		let receivedSignal: AbortSignal | undefined;
		const discard = vi.fn();
		const backend = {
			run: (context: StructuredSubagentBackendContext) => {
				receivedSignal = context.signal;
				started.resolve();
				return pending.promise;
			},
			discard,
		};

		const execution = runStructuredSubagent(request({ signal: controller.signal }), {
			execution: "remote",
			backend,
		});
		await started.promise;
		controller.abort(new Error("remote cancellation"));
		const settled = await execution;

		expect(receivedSignal).toBe(controller.signal);
		expect(settled.result).toMatchObject({
			exitCode: 1,
			aborted: true,
			abortReason: "remote cancellation",
			error: "remote cancellation",
		});
		expect(discard).toHaveBeenCalledTimes(1);
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("fails closed on a malformed remote result without local fallback", async () => {
		mockDiscovery();
		const localRun = vi.spyOn(executorModule, "runSubprocess");
		const isolatedRun = vi.spyOn(isolationRunner, "runIsolatedSubprocess");
		const discard = vi.fn();
		const backend = {
			run: async (context: StructuredSubagentBackendContext) => {
				const malformed = remoteResult(context);
				malformed.result.structuredOutput = {
					source: context.outputSchema.source,
					mode: context.outputSchema.mode,
					status: "valid",
					data: { agent: "not-a-boolean" },
				};
				return malformed;
			},
			discard,
		};

		const settled = await runStructuredSubagent(request(), { execution: "remote", backend });

		expect(settled.result.exitCode).toBe(1);
		expect(settled.result.error).toContain("Remote structured subagent backend returned a malformed result");
		expect(discard).toHaveBeenCalledTimes(1);
		expect(localRun).not.toHaveBeenCalled();
		expect(isolatedRun).not.toHaveBeenCalled();
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("fails closed when a remote result changes a preallocated agent id", async () => {
		mockDiscovery();
		const localRun = vi.spyOn(executorModule, "runSubprocess");
		const backend = {
			run: async (context: StructuredSubagentBackendContext) => {
				const mismatched = remoteResult(context);
				mismatched.result.id = "DifferentAgent";
				return mismatched;
			},
		};

		const settled = await runStructuredSubagent(request({ identity: { id: "ReservedAgent" } }), {
			execution: "remote",
			backend,
		});

		expect(settled.result.exitCode).toBe(1);
		expect(settled.result.error).toContain("result id does not match the normalized preallocated id");
		expect(localRun).not.toHaveBeenCalled();
	});

	it("rejects successful strict invalid and unavailable remote schema results", async () => {
		mockDiscovery();
		for (const status of ["invalid", "unavailable"] as const) {
			const backend = {
				run: async (context: StructuredSubagentBackendContext) => {
					const malformed = remoteResult(context);
					malformed.result.exitCode = 0;
					malformed.result.stderr = "";
					malformed.result.structuredOutput = {
						source: context.outputSchema.source,
						mode: "strict",
						status,
						error: `${status} schema result`,
					};
					return malformed;
				},
			};

			const settled = await runStructuredSubagent(request({ schemaMode: "strict" }), {
				execution: "remote",
				backend,
			});

			expect(settled.result.exitCode).toBe(1);
			expect(settled.result.error).toContain(
				"strict invalid or unavailable structuredOutput must be a failed schema_violation",
			);
		}
	});

	it("keeps explicit local execution on the native executor when a backend is injected", async () => {
		mockDiscovery();
		const remoteRun = vi.fn(async (context: StructuredSubagentBackendContext) => remoteResult(context));
		const localRun = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result());

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }), {
			execution: "local",
			backend: { run: remoteRun },
		});

		expect(localRun).toHaveBeenCalledTimes(1);
		expect(remoteRun).not.toHaveBeenCalled();
		expect(settled.temporaryArtifacts).toBe(true);
		expect(path.basename(settled.artifactsDir)).toStartWith("omp-task-");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("forces every structured launch through the scoped sealed backend without local fallback", async () => {
		mockDiscovery();
		const remoteRun = vi.fn(async (context: StructuredSubagentBackendContext) => remoteResult(context));
		const localRun = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result());

		const settled = await runWithRemoteRuntime(
			{
				subagentBackend: { run: remoteRun },
				registryBackend: {} as never,
				peerTransport: {} as never,
			},
			() =>
				runStructuredSubagent(request(), {
					execution: "local",
					backend: { run: async () => Promise.reject(new Error("must not run")) },
				}),
		);

		expect(settled.result.exitCode).toBe(0);
		expect(remoteRun).toHaveBeenCalledTimes(1);
		expect(localRun).not.toHaveBeenCalled();
	});

	it("leases temporary artifacts for a retained invocation and registers them for agent URLs", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			expect(await fs.stat(options.artifactsDir ?? "")).toBeDefined();
			return result();
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.temporaryArtifacts).toBe(true);
		expect(artifactsDir).toBe(settled.artifactsDir);
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(settled.result.structuredOutput).toMatchObject({
			source: "agent",
			mode: "permissive",
			data: { ok: true },
		});
		expect(path.basename(settled.artifactsDir)).toStartWith("omp-task-");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("uses identical non-plan LSP and IRC policy for task and eval invocations", async () => {
		mockDiscovery();
		const taskPolicy = await resolveEffectiveSubagentPolicy(request());
		const evalPolicy = await resolveEffectiveSubagentPolicy(request({ invocationKind: "eval" }));

		expect(evalPolicy.enableLsp).toBe(taskPolicy.enableLsp);
		expect(evalPolicy.enableIrc).toBe(taskPolicy.enableIrc);
	});

	it("rejects an invalid caller schema before executor dispatch in both modes", async () => {
		mockDiscovery();
		const dispatch = vi.spyOn(executorModule, "runSubprocess");

		for (const schemaMode of ["permissive", "strict"] as const) {
			await expect(runStructuredSubagent(request({ outputSchema: false, schemaMode }))).rejects.toThrow(
				schemaMode === "strict"
					? "Invalid strict caller output schema: boolean false schema rejects all outputs"
					: "Invalid caller output schema: boolean false schema rejects all outputs",
			);
		}
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("does not return unavailable structured metadata without an effective schema", async () => {
		const unstructuredAgent = { ...AGENT, output: undefined };
		mockDiscovery(unstructuredAgent);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			const completed = result();
			completed.structuredOutput = { source: "none", mode: "permissive", status: "unavailable" };
			return completed;
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));

		expect(settled.result).not.toHaveProperty("structuredOutput");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("keeps invalid inherited schemas permissive but rejects them when session strict mode is inherited", async () => {
		const invalidAgent = { ...AGENT, output: false };
		mockDiscovery(invalidAgent);
		expect((await resolveEffectiveSubagentPolicy(request())).schema).toMatchObject({
			source: "agent",
			mode: "permissive",
		});

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const strictSession = session({ outputSchema: false });
		strictSession.outputSchemaMode = "strict";
		await expect(resolveEffectiveSubagentPolicy(request({ session: strictSession }))).rejects.toThrow(
			"Invalid strict effective output schema: boolean false schema rejects all outputs",
		);
	});

	it("persists nested patch text with the compatible recovery path and wording", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-subagent-"));
		const completed = result();
		completed.patchPath = "/recovery/Worker.patch";
		completed.branchName = "omp/task/Worker";
		completed.nestedPatches = [{ relativePath: "sub/nested", patch: "diff --git a/file b/file\n" }];

		const hint = await buildStructuredSubagentRecoveryHint(completed, artifactsDir);
		const nestedPath = path.join(artifactsDir, "Worker.nested-0-sub_nested.patch");

		expect(hint).toContain("Captured patch preserved at /recovery/Worker.patch.");
		expect(hint).toContain(`Captured nested patch preserved at ${nestedPath}.`);
		expect(hint).toContain("Captured branch preserved as omp/task/Worker.");
		expect(await fs.readFile(nestedPath, "utf8")).toBe("diff --git a/file b/file\n");
		await fs.rm(artifactsDir, { recursive: true, force: true });
	});

	it("cleans ephemeral artifacts when isolation setup fails without recovery", async () => {
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockRejectedValue(new Error("not a repository"));

		await expect(
			runStructuredSubagent(
				request({ session: session({ isolationMode: "worktree" }), isolation: { requested: true } }),
			),
		).rejects.toThrow("Isolated subagent execution requires a git repository");
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("reuses a cached output manager across concurrent allocations and sanitizes artifact ids", async () => {
		mockDiscovery();
		const sharedSession = session();
		const ids: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			ids.push(options.id);
			return result();
		});

		const settled = await Promise.all([
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
		]);

		expect(ids.sort()).toEqual(["Worker", "Worker-2"]);
		expect(sharedSession.agentOutputManager).toBeDefined();
		for (const run of settled) await fs.rm(run.artifactsDir, { recursive: true, force: true });
	});

	it("suppresses plan capability sources while preserving non-plan propagation", async () => {
		mockDiscovery();
		const mcpManager = {} as NonNullable<ToolSession["mcpManager"]>;
		const extensionPaths = ["/plugins/example.ts"];
		const customToolPaths = [{ path: "/tools/example.ts", source: "project" }] as unknown as NonNullable<
			ToolSession["customToolPaths"]
		>;
		const planSession = session({ planMode: true });
		Object.assign(planSession, { mcpManager, extensionPaths, customToolPaths });
		const nonPlanSession = session();
		Object.assign(nonPlanSession, { mcpManager, extensionPaths, customToolPaths });
		const mcpDisabledSession = session();
		mcpDisabledSession.enableMCP = false;
		const restrictedSession = session();
		const getApiKey = async () => "exact-account-key";
		Object.assign(restrictedSession, {
			restrictToolNames: true,
			getApiKey,
			mcpManager,
			extensionPaths,
			customToolPaths,
		});
		const options = [] as executorModule.ExecutorOptions[];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});

		const planRun = await runStructuredSubagent(request({ session: planSession, retainArtifacts: true }));
		const nonPlanRun = await runStructuredSubagent(request({ session: nonPlanSession, retainArtifacts: true }));
		const mcpDisabledRun = await runStructuredSubagent(
			request({ session: mcpDisabledSession, retainArtifacts: true }),
		);
		const restrictedRun = await runStructuredSubagent(request({ session: restrictedSession, retainArtifacts: true }));

		expect(options[0]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[0]?.mcpManager).toBeUndefined();
		expect(options[1]).toMatchObject({
			enableMCP: true,
			mcpManager,
			preloadedExtensionPaths: extensionPaths,
			preloadedCustomToolPaths: customToolPaths,
		});
		expect(options[1]?.restrictToolNames).toBe(false);
		expect(options[2]).toMatchObject({ enableMCP: false });
		expect(options[2]?.mcpManager).toBeUndefined();
		expect(options[3]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[3]?.mcpManager).toBeUndefined();
		expect(options[3]?.getApiKey).toBe(getApiKey);
		await fs.rm(planRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(nonPlanRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(mcpDisabledRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(restrictedRun.artifactsDir, { recursive: true, force: true });
	});

	it("unregisters and removes a temporary lease when output ID allocation fails", async () => {
		mockDiscovery();
		const failingSession = session();
		failingSession.agentOutputManager = {
			allocate: async () => {
				throw new Error("allocate failed");
			},
		} as unknown as ToolSession["agentOutputManager"];
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request({ session: failingSession }))).rejects.toThrow(
			"Subagent execution failed: allocate failed",
		);

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("unregisters and removes a temporary lease when plan reference loading fails", async () => {
		mockDiscovery();
		vi.spyOn(planHandoff, "loadOverallPlanReference").mockRejectedValue(new Error("plan unavailable"));
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request())).rejects.toThrow("Subagent execution failed: plan unavailable");

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("cleans failed nonisolated handle artifacts", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		await runStructuredSubagent(request({ invocationKind: "eval", retainArtifacts: true }));

		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir ?? "")).rejects.toThrow();
	});

	it("retains isolated failure artifacts needed for recovery", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed", patchPath: "/recovery/Worker.patch" };
		});

		const settled = await runStructuredSubagent(
			request({ session: session({ isolationMode: "worktree" }), isolation: { requested: true } }),
		);

		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("defaults task isolation to auto-apply and lets config retain artifacts", async () => {
		mockDiscovery();
		const defaultPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ isolationMode: "worktree" }), isolation: { requested: true } }),
		);
		expect(defaultPolicy.applyChanges).toBe(true);

		const capturePolicy = await resolveEffectiveSubagentPolicy(
			request({
				session: session({ isolationMode: "worktree", isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(capturePolicy.applyChanges).toBe(false);

		const evalPolicy = await resolveEffectiveSubagentPolicy(
			request({
				invocationKind: "eval",
				session: session({ isolationMode: "worktree", isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(evalPolicy.applyChanges).toBe(true);
	});

	it("retains successful isolated task artifacts when auto-apply is disabled", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), patchPath: "/recovery/Worker.patch" };
		});
		const merge = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const settled = await runStructuredSubagent(
			request({
				session: session({ isolationMode: "worktree", isolationApply: false }),
				isolation: { requested: true },
			}),
		);

		expect(merge).not.toHaveBeenCalled();
		expect(settled.changesApplied).toBeNull();
		expect(settled.mergeSummary).toContain("/recovery/Worker.patch");
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
});
