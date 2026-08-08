import { describe, expect, test } from "bun:test";
import {
	getRpcCapabilityManifest,
	getRpcCommandRequiredFeatures,
	RPC_APPLICATION_API_VERSION,
	RPC_COMMAND_DEFINITIONS,
	validateRpcCommand,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-registry";

describe("RPC command registry", () => {
	test("projects every validated definition into a truthful descriptor", () => {
		const manifest = getRpcCapabilityManifest();
		const definitions = Object.entries(RPC_COMMAND_DEFINITIONS);

		expect(manifest.applicationApiVersion).toBe(RPC_APPLICATION_API_VERSION);
		expect(manifest.commands).toHaveLength(definitions.length);

		for (const [name, definition] of definitions) {
			const validation = validateRpcCommand(definition.example);
			expect(validation).toEqual({
				ok: true,
				command: definition.example,
				scheduling: definition.scheduling,
			});
			const capability = manifest.commands.find(descriptor => descriptor.name === name);
			expect(capability).toBeDefined();
			expect(capability?.id).toBe(`rpc.command.${name}`);
			expect(capability?.version).toBe(definition.version);
			expect(capability?.scope).toBe(definition.scope);
			expect(capability?.execution).toBe(definition.execution);
			expect(capability?.concurrencyClass).toBe(definition.concurrencyClass);
			expect(capability?.confirmation).toBe(definition.confirmation);
			expect(capability?.requiredFeatures).toEqual([...definition.requiredFeatures]);
			expect(capability?.inputSchema?.properties.type).toEqual({ const: name });
			expect(capability?.inputSchema?.additionalProperties).toBe(false);
		}
	});

	test("requires correlation ids for every v3 command in schemas and validation", () => {
		for (const [name, definition] of Object.entries(RPC_COMMAND_DEFINITIONS)) {
			if (definition.version !== 3) continue;
			const withoutId = { ...definition.example } as Record<string, unknown>;
			delete withoutId.id;
			expect(validateRpcCommand(withoutId)).toMatchObject({
				ok: false,
				command: name,
				error: 'RPC command field "id" is required',
				code: "invalid_request",
			});
			const capability = getRpcCapabilityManifest().commands.find(candidate => candidate.name === name);
			expect(capability?.inputSchema?.required).toContain("id");
		}
	});

	test("derives nested session invocation scheduling after nested validation", () => {
		expect(
			validateRpcCommand({
				id: "outer-control",
				type: "session_invoke",
				command: { kind: "abort" },
			}),
		).toMatchObject({ ok: true, scheduling: "control" });
		expect(
			validateRpcCommand({
				id: "outer-serial",
				type: "session_invoke",
				command: { kind: "prompt", input: { message: "continue" } },
			}),
		).toMatchObject({ ok: true, scheduling: "serial" });
		expect(
			validateRpcCommand({
				id: "outer-invalid",
				type: "session_invoke",
				command: { kind: "prompt", input: { message: 42 } },
			}),
		).toMatchObject({ ok: false, command: "session_invoke", code: "invalid_request" });
	});

	test("advertises authoritative serial tool inventory reads and update signals in API v2", () => {
		const manifest = getRpcCapabilityManifest();
		expect(manifest.applicationApiVersion).toBe(2);
		expect(RPC_COMMAND_DEFINITIONS.get_tool_inventory.scheduling).toBe("serial");
		expect(manifest.commands.find(command => command.name === "get_tool_inventory")).toMatchObject({
			scope: "session",
			concurrencyClass: "serial",
			availability: "available",
		});
		expect(manifest.events).toContain("tool_inventory_update");
		expect(RPC_COMMAND_DEFINITIONS.set_tool_activation.scheduling).toBe("serial");
		expect(manifest.commands.find(command => command.name === "set_tool_activation")).toMatchObject({
			scope: "session",
			execution: "sync",
			concurrencyClass: "serial",
			availability: "available",
			inputSchema: {
				properties: {
					activate: { type: "array", maxItems: 2048, items: { "x-maxUtf8Bytes": 256 } },
					deactivate: { type: "array", maxItems: 2048, items: { "x-maxUtf8Bytes": 256 } },
				},
				required: ["type"],
			},
		});
	});

	test("advertises tool inventory as unavailable when the current projection is unrepresentable", () => {
		expect(
			getRpcCapabilityManifest({ toolInventoryAvailable: false }).commands.find(
				command => command.name === "get_tool_inventory",
			),
		).toMatchObject({
			availability: "unavailable",
			disabledReason: {
				code: "tool_inventory_unavailable",
			},
		});
	});
	test("advertises every operation, plan, and provider-auth lifecycle event exactly once", () => {
		const events = getRpcCapabilityManifest().events;
		expect(events).toEqual(
			expect.arrayContaining([
				"operation_started",
				"operation_completed",
				"operation_failed",
				"operation_cancelled",
				"session_observation",
				"plan_state_update",
				"plan_approval_request",
				"plan_approval_settled",
				"provider_auth_request",
				"provider_auth_update",
			]),
		);
		expect(new Set(events).size).toBe(events.length);
	});

	test("declares one negotiation requirement for every collaboration operation", () => {
		for (const name of [
			"collaboration_get",
			"collaboration_host",
			"collaboration_join",
			"collaboration_leave",
			"collaboration_revoke",
			"collaboration_rotate",
			"collaboration_acknowledge",
			"collaboration_read_media",
		] as const) {
			expect(getRpcCommandRequiredFeatures(name)).toEqual(["collaboration"]);
		}
	});

	test("advertises bounded context projection reads behind explicit negotiation", () => {
		const manifest = getRpcCapabilityManifest();
		const command = manifest.commands.find(candidate => candidate.name === "context_get");
		expect(command).toMatchObject({
			scope: "session",
			execution: "sync",
			concurrencyClass: "concurrent",
			requiredFeatures: ["context.projection"],
			inputSchema: {
				required: ["type", "id"],
				properties: {
					maxSources: { minimum: 0 },
					maxRelations: { minimum: 0 },
					maxContentBytes: { minimum: 0 },
				},
			},
		});
		expect(getRpcCommandRequiredFeatures("context_get")).toEqual(["context.projection"]);
		expect(
			validateRpcCommand({
				id: "context-request",
				type: "context_get",
				maxSources: 0,
				maxRelations: 0,
				maxContentBytes: 0,
			}),
		).toMatchObject({ ok: true, scheduling: "concurrent" });
	});

	test("advertises bounded queue and owner-scoped job controls", () => {
		const manifest = getRpcCapabilityManifest();
		const enabledManifest = getRpcCapabilityManifest({ features: new Set(["job-control"]) });
		for (const name of ["get_queue", "remove_queued_message", "reorder_queued_message", "clear_queue"]) {
			expect(manifest.commands.find(command => command.name === name)).toMatchObject({
				scope: "session",
				execution: "sync",
				concurrencyClass: "control",
			});
		}
		for (const name of ["list_jobs", "get_job", "cancel_job"]) {
			expect(manifest.commands.find(command => command.name === name)).toMatchObject({
				scope: "agent",
				availability: "conditional",
				requiredFeatures: ["job-control"],
			});
			expect(enabledManifest.commands.find(command => command.name === name)).toMatchObject({
				availability: "available",
				requiredFeatures: ["job-control"],
			});
		}
		expect(manifest.commands.find(command => command.name === "cancel_job")).toMatchObject({
			concurrencyClass: "control",
			confirmation: "required",
			inputSchema: { properties: { jobIds: { maxItems: 64, uniqueItems: true } } },
		});
		expect(manifest.events).toEqual(expect.arrayContaining(["queue_update", "job_update"]));
		expect(
			validateRpcCommand({ type: "cancel_job", jobIds: Array.from({ length: 65 }, (_, i) => `job-${i}`) }),
		).toMatchObject({
			ok: false,
			code: "invalid_request",
		});
	});

	test("requires confirmation for eval, job cancellation, session deletion, and credential removal", () => {
		const manifest = getRpcCapabilityManifest();
		for (const name of ["eval_execute", "cancel_job", "delete_session", "remove_provider_auth"]) {
			expect(manifest.commands.find(command => command.name === name)).toMatchObject({
				confirmation: "required",
			});
		}
	});

	test("evaluates runtime-gated availability on every manifest query", () => {
		const unavailable = getRpcCapabilityManifest();
		const available = getRpcCapabilityManifest({ features: new Set(["subagent-event-bus", "model.fast-mode"]) });

		for (const name of ["set_subagent_subscription", "get_subagents", "get_subagent_messages", "set_fast_mode"]) {
			const conditional = unavailable.commands.find(command => command.name === name);
			const enabled = available.commands.find(command => command.name === name);
			expect(conditional?.availability).toBe("conditional");
			expect(conditional?.disabledReason).toBeUndefined();
			expect(enabled?.availability).toBe("available");
			expect(enabled?.disabledReason).toBeUndefined();
		}
	});

	test("advertises advisor reads as concurrent and mutations as serial", () => {
		const manifest = getRpcCapabilityManifest();
		const read = manifest.commands.find(command => command.name === "get_advisor_state");
		const mutation = manifest.commands.find(command => command.name === "set_advisor_enabled");

		expect(read).toMatchObject({ scope: "session", concurrencyClass: "concurrent" });
		expect(mutation).toMatchObject({ scope: "session", concurrencyClass: "serial" });
		expect(validateRpcCommand({ type: "get_advisor_state" })).toMatchObject({
			ok: true,
			scheduling: "concurrent",
		});
		expect(validateRpcCommand({ type: "set_advisor_enabled", enabled: false })).toMatchObject({
			ok: true,
			scheduling: "serial",
		});
		expect(validateRpcCommand({ type: "get_advisor_state", enabled: true })).toMatchObject({
			ok: false,
			code: "invalid_request",
		});
	});

	test("preserves request ids on invalid and unsupported commands", () => {
		expect(validateRpcCommand({ id: "bad-1", type: "set_model", provider: "anthropic" })).toEqual({
			ok: false,
			id: "bad-1",
			command: "set_model",
			error: 'RPC command field "modelId" is required',
			code: "invalid_request",
		});
		expect(validateRpcCommand({ id: "bad-2", type: "future_command" })).toEqual({
			ok: false,
			id: "bad-2",
			command: "future_command",
			error: "Unknown RPC command: future_command",
			code: "unsupported_command",
		});
		expect(validateRpcCommand({ id: "bad-fast", type: "set_fast_mode", enabled: "yes" })).toEqual({
			ok: false,
			id: "bad-fast",
			command: "set_fast_mode",
			error: 'RPC command field "enabled" must be a boolean',
			code: "invalid_request",
		});
	});

	test("rejects unknown fields and normalizes legacy null optionals", () => {
		expect(validateRpcCommand({ id: "bad-3", type: "get_state", typo: true })).toEqual({
			ok: false,
			id: "bad-3",
			command: "get_state",
			error: 'RPC command field "typo" is not supported',
			code: "invalid_request",
		});
		expect(validateRpcCommand({ id: "ok-1", type: "compact", customInstructions: null })).toEqual({
			ok: true,
			command: { id: "ok-1", type: "compact" },
			scheduling: "serial",
		});
		const prompt = getRpcCapabilityManifest().commands.find(command => command.name === "prompt");
		expect(prompt?.inputSchema?.properties.streamingBehavior).toEqual({
			type: ["string", "null"],
			enum: ["steer", "followUp", null],
		});
	});

	test("advertises the complete session catalog surface with truthful concurrency", () => {
		const manifest = getRpcCapabilityManifest();
		const expected = {
			list_sessions: ["host", "concurrent"],
			get_session_info: ["host", "concurrent"],
			get_session_tree: ["session", "concurrent"],
			select_session_leaf: ["session", "serial"],
			reset_session: ["session", "serial"],
			list_workspace_roots: ["host", "concurrent"],
			resume_session: ["session", "serial"],
			fork_session: ["session", "serial"],
			rename_session: ["host", "serial"],
			delete_session: ["host", "serial"],
		} as const;

		for (const [name, [scope, concurrencyClass]] of Object.entries(expected)) {
			const command = manifest.commands.find(candidate => candidate.name === name);
			expect(command).toMatchObject({
				availability: "available",
				execution: "sync",
				scope,
				concurrencyClass,
			});
		}
	});
	test("advertises validated semantic todo, goal, loop, model-role, and tier controls", () => {
		const manifest = getRpcCapabilityManifest();
		for (const name of [
			"todo_apply",
			"goal_control",
			"checkpoint_control",
			"loop_control",
			"set_model_role",
			"set_service_tier",
		]) {
			expect(manifest.commands.find(command => command.name === name)).toMatchObject({
				scope: "session",
				execution: "sync",
				concurrencyClass: "serial",
			});
		}
		expect(
			validateRpcCommand({ type: "todo_apply", operation: { op: "block", task: "Deploy", reason: "CI" } }),
		).toMatchObject({
			ok: true,
			scheduling: "serial",
		});
		expect(validateRpcCommand({ type: "todo_apply", operation: { op: "invalid" } })).toMatchObject({
			ok: false,
			code: "invalid_request",
		});
		expect(validateRpcCommand({ type: "goal_control", op: "clear_budget" })).toMatchObject({
			ok: true,
			scheduling: "serial",
		});
		expect(validateRpcCommand({ type: "goal_control", op: "set_budget", tokenBudget: 0 })).toMatchObject({
			ok: false,
			code: "invalid_request",
		});
		expect(validateRpcCommand({ type: "set_service_tier", family: "anthropic", tier: null })).toMatchObject({
			ok: true,
			scheduling: "serial",
		});
		expect(validateRpcCommand({ type: "set_service_tier", family: "unknown", tier: "priority" })).toMatchObject({
			ok: false,
			code: "invalid_request",
		});
		expect(validateRpcCommand({ type: "checkpoint_control", op: "rewind", report: "Findings" })).toMatchObject({
			ok: true,
			scheduling: "serial",
		});
		expect(
			validateRpcCommand({
				type: "loop_control",
				op: "enable",
				action: "compact",
				prompt: "Continue",
				limit: { kind: "iterations", iterations: 3 },
			}),
		).toMatchObject({ ok: true, scheduling: "serial" });
		expect(
			validateRpcCommand({
				type: "loop_control",
				op: "enable",
				limit: { kind: "duration", durationMs: 0 },
			}),
		).toMatchObject({ ok: false, code: "invalid_request" });
	});

	test("advertises validated insert, update, move, and reclassification queue controls", () => {
		const manifest = getRpcCapabilityManifest();
		for (const name of ["queue_insert", "queue_update", "queue_move"]) {
			expect(manifest.commands.find(command => command.name === name)).toMatchObject({
				scope: "session",
				execution: "sync",
				concurrencyClass: "control",
			});
		}
		expect(
			validateRpcCommand({ type: "queue_insert", lane: "steering", text: "interrupt", toIndex: 0 }),
		).toMatchObject({
			ok: true,
			scheduling: "control",
		});
		expect(
			validateRpcCommand({ type: "queue_move", entryId: "queue-entry", lane: "followUp", toIndex: 1 }),
		).toMatchObject({ ok: true, scheduling: "control" });
		expect(validateRpcCommand({ type: "queue_update", entryId: "queue-entry", text: "" })).toMatchObject({
			ok: false,
			code: "invalid_request",
		});
	});

	test("advertises typed start, steer, pause, cancel, kill, and revive child-agent controls", () => {
		const commands = getRpcCapabilityManifest({
			features: new Set(["agent-control"]),
		}).commands;
		for (const name of [
			"start_agent",
			"send_agent_message",
			"park_agent",
			"cancel_agent",
			"release_agent",
			"resume_agent",
		]) {
			expect(commands.find(command => command.name === name)).toMatchObject({
				scope: "agent",
				execution: "sync",
				concurrencyClass: "control",
				availability: "available",
			});
		}
		expect(commands.find(command => command.name === "start_agent")?.confirmation).toBe("required");
		expect(validateRpcCommand({ type: "start_agent", task: "Investigate", agent: "scout" })).toMatchObject({
			ok: true,
			scheduling: "control",
		});
	});

	test("advertises bounded semantic action and cancellation controls only when available", () => {
		const unavailable = getRpcCapabilityManifest();
		const available = getRpcCapabilityManifest({ features: new Set(["semantic-rendering"]) });
		for (const name of ["semantic_action", "semantic_cancel"]) {
			expect(unavailable.commands.find(command => command.name === name)).toMatchObject({
				version: 3,
				scope: "session",
				availability: "conditional",
				requiredFeatures: ["semantic-rendering"],
			});
			expect(available.commands.find(command => command.name === name)).toMatchObject({
				availability: "available",
			});
		}
		expect(
			validateRpcCommand({
				id: "action-1",
				type: "semantic_action",
				renderId: "render-1",
				actionId: "apply",
				input: { scope: "focused" },
			}),
		).toMatchObject({ ok: true, scheduling: "serial" });
		expect(
			validateRpcCommand({
				id: "action-2",
				type: "semantic_action",
				renderId: "render-1",
				actionId: "apply",
				input: ["not-an-object"],
			}),
		).toMatchObject({ ok: false, code: "invalid_request" });
		expect(
			validateRpcCommand({
				id: "cancel-1",
				type: "semantic_cancel",
				renderId: "render-1",
				actionId: "apply",
			}),
		).toMatchObject({ ok: true, scheduling: "control" });
	});
});
