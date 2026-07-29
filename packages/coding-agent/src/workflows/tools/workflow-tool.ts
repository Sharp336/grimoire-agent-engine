import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import workflowPreflightContext from "../../prompts/system/workflow-preflight-context.md" with { type: "text" };
import workflowDescription from "../../prompts/tools/workflow.md" with { type: "text" };
import type { SettledTaskSpawn, TaskDispatchService } from "../../task/dispatch-service";
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import { type WorkflowDispatchOutcome, type WorkflowDispatchRequest, WorkflowRuntime } from "../runtime";
import { SessionWorkflowStore } from "../store";
import type { WorkflowSnapshot, WorkflowToolDetails } from "../types";

const outputSchemaInputSchema = type("object | boolean | string | null");
const workflowNodeSchema = type({
	id: "string",
	agent: "string = 'task'",
	task: "string",
	"needs?": "string[]",
	"outputSchema?": outputSchemaInputSchema.describe(
		"JSON Schema object for this node's result; a string must contain serialized JSON Schema",
	),
	"schemaMode?": '"permissive" | "strict"',
	"isolated?": "boolean",
	"+": "delete",
});

const workflowSchema = type({
	op: type("'create' | 'get' | 'run' | 'resume' | 'retry' | 'cancel'").describe("workflow operation"),
	"id?": type("string").describe("optional stable workflow id for create"),
	"objective?": type("string").describe("workflow objective for create"),
	"nodes?": workflowNodeSchema.array().describe("complete static DAG for create"),
	"node_id?": type("string").describe("failed or interrupted node to retry"),
	"+": "delete",
});

export type WorkflowToolInput = typeof workflowSchema.infer;

function summarize(snapshot: WorkflowSnapshot | null): string {
	if (!snapshot) return "No workflow exists in this session.";
	const counts = new Map<string, number>();
	for (const state of Object.values(snapshot.nodes)) {
		counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
	}
	const countText = [...counts.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([status, count]) => `${count} ${status}`)
		.join(", ");
	const lines = [
		`Workflow ${snapshot.definition.id}: ${snapshot.status}`,
		`Objective: ${snapshot.definition.objective}`,
		`Nodes: ${countText}`,
	];
	for (const node of snapshot.definition.nodes) {
		const state = snapshot.nodes[node.id]!;
		const refs = [state.outputRef, state.historyRef].filter(Boolean).join(", ");
		const detail = refs || state.error;
		lines.push(`- ${node.id}: ${state.status}${detail ? ` — ${detail}` : ""}`);
	}
	return lines.join("\n");
}

export class WorkflowTool implements AgentTool<typeof workflowSchema, WorkflowToolDetails> {
	readonly name = "workflow";
	readonly label = "Workflow";
	readonly summary = "Run a session-durable dependency graph through Task";
	readonly description = prompt.render(workflowDescription);
	readonly parameters = workflowSchema;
	readonly approval = "exec" as const;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly loadMode = "discoverable" as const;
	readonly #session: ToolSession;
	readonly #runtime: WorkflowRuntime;

	private constructor(session: ToolSession, runtime: WorkflowRuntime) {
		this.#session = session;
		this.#runtime = runtime;
	}

	static async createIf(session: ToolSession): Promise<WorkflowTool | null> {
		if (!session.sessionManager || (session.taskDepth ?? 0) !== 0) return null;
		const runtime = await WorkflowRuntime.create({ store: new SessionWorkflowStore(session.sessionManager) });
		return new WorkflowTool(session, runtime);
	}

	async execute(
		toolCallId: string,
		params: WorkflowToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<WorkflowToolDetails>,
	): Promise<AgentToolResult<WorkflowToolDetails>> {
		let snapshot: WorkflowSnapshot | null;
		const runWorkflow = (): Promise<WorkflowSnapshot> => {
			const taskDispatch = this.#requireTaskDispatch();
			return this.#runtime.run(
				(request, runSignal) => this.#dispatchNode(taskDispatch, toolCallId, request, runSignal),
				{
					signal,
					preflight: requests =>
						taskDispatch.assertSettledSpawns(requests.map(request => this.#settledSpawn(request))),
					onChange: current =>
						onUpdate?.({
							content: [{ type: "text", text: summarize(current) }],
							details: { op: params.op, workflow: current },
						}),
				},
			);
		};
		try {
			if (params.op === "create") {
				if (!params.objective?.trim()) throw new ToolError("objective is required when op=create");
				if (!params.nodes) throw new ToolError("nodes is required when op=create");
				const taskDispatch = this.#requireTaskDispatch();
				await taskDispatch.assertSettledSpawns(
					params.nodes.map(node =>
						this.#settledSpawn({
							nodeId: node.id,
							name: node.id,
							agent: node.agent,
							task: node.task,
							context: prompt.render(workflowPreflightContext, {
								objective: params.objective,
								nodeId: node.id,
							}),
							...(Object.hasOwn(node, "outputSchema") ? { outputSchema: node.outputSchema } : {}),
							...(node.schemaMode !== undefined ? { schemaMode: node.schemaMode } : {}),
							...(node.isolated !== undefined ? { isolated: node.isolated } : {}),
						}),
					),
				);
				snapshot = await this.#runtime.createWorkflow({
					id: params.id,
					objective: params.objective,
					nodes: params.nodes,
				});
			} else if (params.op === "get") {
				snapshot = this.#runtime.getSnapshot();
			} else if (params.op === "cancel") {
				snapshot = await this.#runtime.cancel();
			} else if (params.op === "retry") {
				if (!params.node_id?.trim()) throw new ToolError("node_id is required when op=retry");
				await this.#runtime.retryNode(params.node_id.trim());
				snapshot = await runWorkflow();
			} else {
				snapshot = await runWorkflow();
			}
		} catch (error) {
			if (error instanceof ToolError) throw error;
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}

		return {
			content: [{ type: "text", text: summarize(snapshot) }],
			details: { op: params.op, workflow: snapshot },
		};
	}

	#requireTaskDispatch(): TaskDispatchService {
		const taskDispatch = this.#session.taskDispatchService;
		if (!taskDispatch) throw new ToolError("The workflow tool requires the shared Task dispatch service");
		return taskDispatch;
	}

	async #dispatchNode(
		taskDispatch: TaskDispatchService,
		parentToolCallId: string,
		request: WorkflowDispatchRequest,
		signal: AbortSignal,
	): Promise<WorkflowDispatchOutcome> {
		const result = await taskDispatch.executeSettledSpawn(
			`${parentToolCallId}:${request.nodeId}`,
			this.#settledSpawn(request),
			signal,
		);
		const settled = result.details?.results[0];
		const content = result.content.find(part => part.type === "text");
		const error = content?.type === "text" ? content.text : "Task execution failed before producing a settled result";
		return settled ? { result: settled } : { status: "failed", error };
	}

	#settledSpawn(request: WorkflowDispatchRequest): SettledTaskSpawn {
		const item: SettledTaskSpawn["item"] = {
			name: request.name,
			agent: request.agent,
			task: request.task,
		};
		if (Object.hasOwn(request, "outputSchema")) item.outputSchema = request.outputSchema;
		if (request.schemaMode !== undefined) item.schemaMode = request.schemaMode;
		if (request.isolated !== undefined) item.isolated = request.isolated;
		return { context: request.context, item };
	}
}
